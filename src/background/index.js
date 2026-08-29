// Background service worker entry.

import { clearVault, createVault, loadVault, unlockVault } from "../shared/vault.js";
import {
  approveOrigin,
  clearPermissions,
  getPermissionForOrigin,
  getPermissions,
  revokeOrigin,
} from "../shared/permissions.js";
import { getSettings, setSettings } from "../shared/settings.js";
import { storage, STORAGE_KEYS } from "../shared/storage.js";
import { ERROR_CODES, rpcError } from "../shared/errors.js";
import { TX_KIND } from "../shared/constants.js";
import { applyTxDefaults } from "../shared/txDefaults.js";
import { networkNameFromNodeUrl } from "../shared/network.js";
import { isAllowedDappOrigin } from "../shared/securityPolicy.js";
import { bytesToHex } from "../shared/bytes.js";
import { classifyTxPresence, finalizedTxMetadata } from "../shared/txLifecycle.js";
import { WALLET_LIFECYCLE_LOCK, withStorageLock } from "../shared/storageLock.js";

import {
  engineCall,
  ensureEngineConfigured,
  getEngineStatus,
  getEngineStatusStrict,
  invalidateEngineConfig,
  handleEngineReady,
} from "./engineHost.js";
import { handleRpc } from "./rpc.js";
import { cancelPendingApprovals, getPending, resolvePendingDecision } from "./pending.js";
import {
  broadcastChainChangedAll,
  broadcastProfilesChangedAll,
  bindPortsForSenderOrigin,
  registerDappPort,
  registerStorageChangeForwarder,
} from "./dappEvents.js";

import {
  notifyTxSubmitted,
  notifyTxExecuted,
  registerTxNotificationHandlers,
} from "./txNotify.js";
import { getAccountNames } from "../shared/accountNames.js";
import { getTxMeta, patchTxMeta, putTxMeta, listTxs } from "../shared/txStore.js";
import { handleUiCommand } from "../wallet/uiCommands.js";
import {
  getNetworkStatus,
  checkAllEndpoints,
  resetNetworkStatus,
  isStatusStale,
} from "../shared/networkStatus.js";
import {
  alarmsClear,
  getExtensionApi,
  runtimeGetURL,
  runtimeSendMessage,
  storageSessionGet,
  storageSessionRemove,
  storageSessionSet,
  tabsCreate,
} from "../platform/extensionApi.js";

registerTxNotificationHandlers();

const ext = getExtensionApi();

// ------------------------------
// Auto-lock timer
// ------------------------------
const AUTO_LOCK_ALARM_NAME = "dusk_auto_lock_check";
const AUTO_LOCK_ACTIVITY_KEY = STORAGE_KEYS.AUTO_LOCK_ACTIVITY;
const DAPP_ACTIVITY_METHODS = new Set([
  "dusk_sendTransaction",
  "dusk_watchAsset",
  "dusk_signMessage",
  "dusk_signAuth",
]);

/** Last activity timestamp cache; persisted storage survives worker restarts. */
let lastActivityTimestamp = 0;

function normalizeActivityTimestamp(value) {
  const raw = value && typeof value === "object" ? value.lastActivityAt : value;
  const n = Number(raw ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function readStoredActivityTimestamp() {
  try {
    const items = await storageSessionGet(AUTO_LOCK_ACTIVITY_KEY);
    return normalizeActivityTimestamp(items?.[AUTO_LOCK_ACTIVITY_KEY]);
  } catch {
    // fall back below
  }
  try {
    const items = await storage.get(AUTO_LOCK_ACTIVITY_KEY);
    return normalizeActivityTimestamp(items?.[AUTO_LOCK_ACTIVITY_KEY]);
  } catch {
    return 0;
  }
}

async function writeStoredActivityTimestamp(timestamp) {
  const record = { lastActivityAt: timestamp };
  try {
    await storageSessionSet({ [AUTO_LOCK_ACTIVITY_KEY]: record });
    return;
  } catch {
    // fall back below
  }
  try {
    await storage.set({ [AUTO_LOCK_ACTIVITY_KEY]: record });
  } catch {
    // Best effort; the in-memory timestamp still protects this worker instance.
  }
}

async function removeStoredActivityTimestamp() {
  try {
    await storageSessionRemove(AUTO_LOCK_ACTIVITY_KEY);
    return;
  } catch {
    // fall back below
  }
  try {
    await storage.remove(AUTO_LOCK_ACTIVITY_KEY);
  } catch {
    // ignore
  }
}

async function readActivityTimestamp() {
  if (lastActivityTimestamp > 0) return lastActivityTimestamp;
  lastActivityTimestamp = await readStoredActivityTimestamp();
  return lastActivityTimestamp;
}

/** Update activity timestamp to prevent auto-lock. */
async function updateActivity(timestamp = Date.now()) {
  lastActivityTimestamp = timestamp;
  await writeStoredActivityTimestamp(timestamp);
}

async function clearActivity() {
  lastActivityTimestamp = 0;
  await removeStoredActivityTimestamp();
}

async function ensureActivityTimestamp() {
  const current = await readActivityTimestamp();
  if (current > 0) return current;
  const now = Date.now();
  await updateActivity(now);
  return now;
}

async function lockWallet(reason) {
  await engineCall("engine_lock");
  if ((await getEngineStatusStrict())?.isUnlocked) throw new Error("Wallet lock did not complete");
  cancelPendingApprovals();
  await clearActivity();
  broadcastProfilesChangedAll().catch(() => {});
  emitUiLockState(false, reason).catch(() => {});
}

async function unlockEngine(mnemonic) {
  try {
    return await engineCall(
      "engine_unlock",
      { mnemonic },
      { timeoutMs: 120_000 }
    );
  } catch (error) {
    await engineCall("engine_lock");
    if ((await getEngineStatusStrict())?.isUnlocked) {
      throw new Error("Wallet lock did not complete after unlock failure");
    }
    throw error;
  }
}

async function ensureActivityTimestampIfUnlocked() {
  const status = await getEngineStatus();
  if (!status?.isUnlocked) return 0;
  return await ensureActivityTimestamp();
}

async function prepareDappActivityContext(request) {
  const method = String(request?.method ?? "");
  if (method !== "dusk_switchNetwork") return null;
  try {
    const settings = await getSettings();
    return { nodeUrl: String(settings?.nodeUrl ?? "") };
  } catch {
    return { nodeUrl: "" };
  }
}

async function updateDappActivity(request, context = null) {
  const method = String(request?.method ?? "");
  if (!DAPP_ACTIVITY_METHODS.has(method)) {
    if (method !== "dusk_switchNetwork") return;
    const beforeNodeUrl = String(context?.nodeUrl ?? "");
    const afterNodeUrl = String((await getSettings())?.nodeUrl ?? "");
    if (!beforeNodeUrl || !afterNodeUrl || beforeNodeUrl === afterNodeUrl) return;
  }
  const status = await getEngineStatus();
  if (!status?.isUnlocked) return;
  await updateActivity();
}

function nullifierHexes(value) {
  const out = [];
  for (const n of Array.isArray(value) ? value : []) {
    try {
      if (typeof n === "string") {
        const hex = n.trim();
        if (/^[0-9a-fA-F]+$/.test(hex)) out.push(hex.toLowerCase());
        continue;
      }
      const u8 = n instanceof Uint8Array ? n : new Uint8Array(n);
      const hex = bytesToHex(u8);
      if (hex) out.push(hex);
    } catch {
      // ignore invalid nullifier shapes
    }
  }
  return out;
}

function isShieldedTxMeta(meta) {
  return (
    String(meta?.privacy ?? "") === "shielded" ||
    (Array.isArray(meta?.pendingNullifiers) && meta.pendingNullifiers.length > 0)
  );
}

async function emitUiTxStatus(payload) {
  try {
    await runtimeSendMessage({
      type: "DUSK_UI_TX_STATUS",
      ...payload,
    });
  } catch {
    // ignore
  }
}

async function emitUiLockState(isUnlocked, reason = "") {
  try {
    await runtimeSendMessage({
      type: "DUSK_UI_LOCK_STATE",
      isUnlocked: Boolean(isUnlocked),
      reason: String(reason ?? ""),
    });
  } catch {
    // ignore
  }
}

async function reconcileTxPresence(hash, { preserveRemoved = false } = {}) {
  const meta = await getTxMeta(hash);
  const settings = await getSettings();
  const nodeUrl = meta?.nodeUrl ?? settings?.nodeUrl ?? "";
  const origin = meta?.origin ?? "Wallet";
  const now = Date.now();
  const terminalStatus = meta?.status === "executed" || meta?.status === "failed"
    ? meta.status
    : "";

  if (!nodeUrl && terminalStatus) {
    await patchTxMeta(hash, { lastCheckedAt: now });
    return {
      status: terminalStatus,
      ok: terminalStatus === "executed",
      origin,
      nodeUrl,
      error: meta?.error || "",
    };
  }

  if (!nodeUrl) {
    const status = preserveRemoved ? meta?.status ?? "unknown" : "unknown";
    await patchTxMeta(hash, {
      status,
      lastCheckedAt: now,
      recoveryReason: "node_url_missing",
    });
    return { status, origin, nodeUrl, error: "node_url_missing" };
  }

  const presence = await classifyTxPresence(nodeUrl, hash) ?? {
    state: "unavailable",
    error: "reconciliation_unavailable",
  };
  if (presence.state === "executed_success") {
    const finalized = finalizedTxMetadata(presence.tx);
    const failed = terminalStatus === "failed";
    await patchTxMeta(hash, {
      ...finalized,
      status: failed ? "failed" : "executed",
      error: failed ? meta?.error : undefined,
      executedAt: now,
      lastCheckedAt: now,
      reservationStatus: isShieldedTxMeta(meta) ? "spent" : meta?.reservationStatus,
      reservationUpdatedAt: isShieldedTxMeta(meta) ? now : meta?.reservationUpdatedAt,
    });
    return {
      status: failed ? "failed" : "executed",
      ok: !failed,
      origin,
      nodeUrl,
      error: failed ? meta?.error || "" : "",
      ...finalized,
    };
  }

  if (presence.state === "executed_failed") {
    const finalized = finalizedTxMetadata(presence.tx);
    await patchTxMeta(hash, {
      ...finalized,
      status: "failed",
      error: presence.error || undefined,
      executedAt: now,
      lastCheckedAt: now,
      reservationStatus: isShieldedTxMeta(meta) ? "spent" : meta?.reservationStatus,
      reservationUpdatedAt: isShieldedTxMeta(meta) ? now : meta?.reservationUpdatedAt,
    });
    return {
      status: "failed",
      ok: false,
      origin,
      nodeUrl,
      error: presence.error || "",
      ...finalized,
    };
  }

  if (terminalStatus) {
    await patchTxMeta(hash, { lastCheckedAt: now });
    return {
      status: terminalStatus,
      ok: terminalStatus === "executed",
      origin,
      nodeUrl,
      error: meta?.error || "",
    };
  }

  if (presence.state === "mempool") {
    await patchTxMeta(hash, {
      status: "mempool",
      error: undefined,
      mempoolSeenAt: now,
      lastCheckedAt: now,
      reservationStatus: isShieldedTxMeta(meta) ? "pending" : meta?.reservationStatus,
    });
    return { status: "mempool", origin, nodeUrl };
  }

  if (presence.state === "not_found") {
    const confirmedRemoved = preserveRemoved && (
      meta?.recoveryReason === "removed_unconfirmed" || meta?.status === "removed"
    );
    const status = confirmedRemoved ? "removed" : "unknown";
    await patchTxMeta(hash, {
      status,
      lastCheckedAt: now,
      recoveryReason: preserveRemoved
        ? confirmedRemoved ? "removed" : "removed_unconfirmed"
        : "not_found",
      reservationStatus: confirmedRemoved && isShieldedTxMeta(meta)
        ? "recoverable"
        : meta?.reservationStatus,
      removedAt: confirmedRemoved ? now : meta?.removedAt,
      reservationUpdatedAt:
        confirmedRemoved && isShieldedTxMeta(meta) ? now : meta?.reservationUpdatedAt,
    });
    return { status, origin, nodeUrl };
  }

  const confirmedRemoved = preserveRemoved && meta?.status === "removed";
  const status = confirmedRemoved ? "removed" : "unknown";
  await patchTxMeta(hash, {
    status,
    lastCheckedAt: now,
    recoveryReason: preserveRemoved
      ? confirmedRemoved ? "removed" : "removed_unconfirmed"
      : presence.error || "reconciliation_unavailable",
  });
  return {
    status,
    origin,
    nodeUrl,
    error: presence.error || "reconciliation_unavailable",
  };
}

/** Start or restart the auto-lock alarm based on current settings. */
async function setupAutoLockAlarm() {
  const settings = await getSettings();
  const timeout = settings.autoLockTimeoutMinutes ?? 0;

  // Clear any existing alarm first.
  await alarmsClear(AUTO_LOCK_ALARM_NAME);

  if (timeout > 0) {
    // Check every minute (or half the timeout if smaller).
    const periodInMinutes = Math.max(0.5, Math.min(1, timeout / 2));
    ext?.alarms?.create(AUTO_LOCK_ALARM_NAME, { periodInMinutes });
  }
}

/** Handle auto-lock alarm: check if wallet should be locked due to inactivity. */
async function handleAutoLockAlarm() {
  const settings = await getSettings();
  const timeout = settings.autoLockTimeoutMinutes ?? 0;

  if (timeout <= 0) return; // Auto-lock disabled.

  const status = await getEngineStatus();
  if (!status?.isUnlocked) return; // Already locked.

  const lastActivityAt = await readActivityTimestamp();
  if (!lastActivityAt) {
    await updateActivity();
    return;
  }

  const elapsed = Date.now() - lastActivityAt;
  const timeoutMs = timeout * 60 * 1000;

  if (elapsed >= timeoutMs) {
    console.log("[Dusk] Auto-locking wallet due to inactivity.");
    try {
      await withStorageLock(WALLET_LIFECYCLE_LOCK, () => lockWallet("auto_lock"));
    } catch (e) {
      console.error("[Dusk] Auto-lock failed:", e);
    }
  }
}

// Listen for alarms.
ext?.alarms?.onAlarm?.addListener((alarm) => {
  if (alarm.name === AUTO_LOCK_ALARM_NAME) {
    handleAutoLockAlarm().catch(console.error);
  }
});

// Initialize auto-lock alarm on startup.
setupAutoLockAlarm().catch(console.error);

// Open the full wallet view on first install (MetaMask-style onboarding).
ext?.runtime?.onInstalled?.addListener((details) => {
  if (details?.reason !== "install") return;
  try {
    const url = runtimeGetURL("full.html");
    tabsCreate({ url }).catch(() => {});
  } catch {
    // ignore
  }
});

// Dapp provider ports (push events: profilesChanged, chainChanged, ...).
ext?.runtime?.onConnect?.addListener((port) => {
  if (port?.name === "DUSK_DAPP_PORT") {
    registerDappPort(port);
  }
});

// Keep provider state in sync even if storage is mutated from extension pages.
registerStorageChangeForwarder();

function getOriginFromSender(sender) {
  // sender.url for content scripts contains the full page URL. Some browser
  // contexts omit it but still expose tab.url/pendingUrl.
  const candidates = [];
  if (sender?.url) candidates.push(sender.url);
  if (sender?.tab?.url) candidates.push(sender.tab.url);
  if (sender?.tab?.pendingUrl) candidates.push(sender.tab.pendingUrl);

  for (const candidate of candidates) {
    try {
      const origin = new URL(candidate).origin;
      if (
        origin.startsWith("http://") ||
        origin.startsWith("https://")
      ) {
        return origin;
      }
    } catch {
      // ignore
    }
  }
  return "";
}

// ------------------------------
// Message bus
// ------------------------------
ext?.runtime?.onMessage?.addListener((message, sender, sendResponse) => {
  // Engine calls are handled by offscreen.js. Do not respond here.
  if (message?.type === "DUSK_ENGINE_CALL") {
    return false;
  }

  if (message?.type === "DUSK_ENGINE_READY") {
    handleEngineReady?.(message);
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "DUSK_ENGINE_PROGRESS") {
    try {
      if (globalThis.__DUSK_ENGINE_DEBUG__ === true) {
        console.log("[engine]", message.payload);
      }
    } catch {
      // ignore
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "DUSK_ENGINE_PING") {
    return false;
  }

  (async () => {
    try {
      const common = await handleUiCommand(message, {
        engineCall,
        ensureEngineConfigured,
        getEngineStatus,
      });
      if (common) {
        sendResponse(common);
        return;
      }

      // UI heartbeat to reset auto-lock timer.
      if (message?.type === "DUSK_UI_ACTIVITY") {
        const rid = String(message.rid ?? "");
        if (rid && !getPending(rid)) {
          sendResponse({ ok: false });
          return;
        }
        await updateActivity();
        sendResponse({ ok: true });
        return;
      }

      // RPC messages from contentScript
      if (message?.type === "DUSK_RPC_REQUEST") {
        const origin = getOriginFromSender(sender) || message.origin || "";

        // Ensure any dApp port(s) opened from this tab are bound to the same
        // origin so provider push events (connect/chainChanged/...) work
        // reliably.
        if (isAllowedDappOrigin(origin)) {
          bindPortsForSenderOrigin(sender, origin);
        }

        const id = message.id;
        const activityContext = await prepareDappActivityContext(message.request);
        const result = await handleRpc(origin, message.request);
        await updateDappActivity(message.request, activityContext);
        sendResponse({ id, result });
        return;
      }

      // Offscreen notifies us when a tx lifecycle event is observed (best-effort).
      if (message?.type === "DUSK_TX_EXECUTED") {
        const hash = String(message.hash ?? "");
        const observedOk = message.ok !== false;
        const observedError = message.error ? String(message.error) : "";
        const observedStatus = observedOk ? "executed" : "failed";
        let reconciled = {
          status: observedStatus,
          origin: "Wallet",
          nodeUrl: "",
          error: observedError,
        };
        sendResponse({ ok: true });

        try {
          const meta = await getTxMeta(hash);
          const now = Date.now();
          await patchTxMeta(hash, {
            status: observedStatus,
            executedAt: now,
            lastCheckedAt: now,
            error: observedOk ? undefined : observedError || undefined,
            reservationStatus: isShieldedTxMeta(meta) ? "spent" : meta?.reservationStatus,
            reservationUpdatedAt: isShieldedTxMeta(meta) ? now : meta?.reservationUpdatedAt,
          });
          reconciled = await reconcileTxPresence(hash);
        } catch {
          // Execution notifications remain best-effort when storage is unavailable.
        }

        const finalStatus = ["executed", "failed"].includes(reconciled.status)
          ? reconciled.status
          : observedStatus;
        const ok = finalStatus === "executed";
        const error = ok ? "" : reconciled.error || observedError;
        notifyTxExecuted({
          hash,
          origin: reconciled.origin,
          ok,
          error,
          nodeUrl: reconciled.nodeUrl,
        }).catch(() => {});
        emitUiTxStatus({ hash, ...reconciled, status: finalStatus, ok, error }).catch(() => {});
        return;
      }

      if (message?.type === "DUSK_TX_REMOVED") {
        const hash = String(message.hash ?? "");
        const reconciled = await reconcileTxPresence(hash, { preserveRemoved: true });
        emitUiTxStatus({
          hash,
          status: reconciled.status || "removed",
          ok: reconciled.status === "executed" ? true : undefined,
          error: reconciled.error,
        }).catch(() => {});
        sendResponse({ ok: true });
        return;
      }

      if (message?.type === "DUSK_TX_UNKNOWN") {
        const hash = String(message.hash ?? "");
        const reason = message.reason ? String(message.reason) : "watcher_timeout";
        const meta = await getTxMeta(hash);
        const now = Date.now();

        const preserveRemoved =
          meta?.status === "removed" || meta?.recoveryReason === "removed_unconfirmed";
        await patchTxMeta(hash, {
          status: meta?.status === "removed" ? "removed" : "unknown",
          lastCheckedAt: now,
          reservationStatus:
            meta?.status === "removed" || !isShieldedTxMeta(meta)
              ? meta?.reservationStatus
              : "pending",
          recoveryReason: preserveRemoved ? meta?.recoveryReason : reason,
        });

        const reconciled = await reconcileTxPresence(hash, { preserveRemoved });
        emitUiTxStatus({
          hash,
          status: reconciled.status || "unknown",
          ok: reconciled.status === "executed" ? true : reconciled.status === "failed" ? false : undefined,
          error: reconciled.error,
        }).catch(() => {});
        sendResponse({ ok: true });
        return;
      }

      if (message?.type === "DUSK_UI_RECHECK_TX") {
        const hash = String(message.hash ?? "").trim();
        if (!hash) {
          throw rpcError(ERROR_CODES.INVALID_PARAMS, "hash is required");
        }

        const meta = await getTxMeta(hash);
        const reconciled = await reconcileTxPresence(hash, {
          preserveRemoved:
            meta?.status === "removed" || meta?.recoveryReason === "removed_unconfirmed",
        });
        emitUiTxStatus({
          hash,
          status: reconciled.status || meta?.status || "unknown",
          ok: reconciled.status === "executed" ? true : reconciled.status === "failed" ? false : undefined,
          error: reconciled.error,
        }).catch(() => {});
        sendResponse({ ok: true, result: reconciled });
        return;
      }

      // UI asks for pending request details
      if (message?.type === "DUSK_GET_PENDING") {
        const entry = getPending(message.rid);
        if (!entry) {
          sendResponse(null);
          return;
        }

        const vault = await loadVault();
        const settings = await getSettings();
        const status = await getEngineStatus();
        const perm = await getPermissionForOrigin(entry.origin);

        let accountNames = {};
        try {
          const walletId = status?.isUnlocked ? String(status?.accounts?.[0] ?? "").trim() : "";
          accountNames = walletId ? await getAccountNames(walletId) : {};
        } catch {
          accountNames = {};
        }

        sendResponse({
          rid: message.rid,
          kind: entry.kind,
          origin: entry.origin,
          params: entry.params,
          hasVault: Boolean(vault),
          isUnlocked: status.isUnlocked,
          accounts: status.accounts,
          accountCount: settings?.accountCount ?? 1,
          selectedAccountIndex: status.selectedAccountIndex ?? settings?.selectedAccountIndex ?? 0,
          accountNames,
          permissionAccountIndex:
            perm && perm.accountIndex !== undefined && perm.accountIndex !== null
              ? Number(perm.accountIndex) || 0
              : null,
        });
        return;
      }

      // UI wants to unlock
      if (message?.type === "DUSK_UI_UNLOCK") {
        const password = message.password;
        const accounts = await withStorageLock(WALLET_LIFECYCLE_LOCK, async () => {
          const current = await getEngineStatusStrict();
          if (current?.isUnlocked) {
            await updateActivity();
            setupAutoLockAlarm().catch(console.error);
            return current.accounts ?? [];
          }

          const mnemonic = await unlockVault(password);
          await ensureEngineConfigured();
          const result = await unlockEngine(mnemonic);
          await updateActivity();
          setupAutoLockAlarm().catch(console.error);
          broadcastProfilesChangedAll().catch(() => {});
          emitUiLockState(true, "unlock").catch(() => {});
          return Array.isArray(result?.accounts)
            ? result.accounts
            : (await getEngineStatusStrict()).accounts;
        });

        sendResponse({ ok: true, accounts });
        return;
      }

      // UI wants to lock
      if (message?.type === "DUSK_UI_LOCK") {
        await withStorageLock(WALLET_LIFECYCLE_LOCK, () => lockWallet("manual_lock"));
        sendResponse({ ok: true });
        return;
      }

      if (message?.type === "DUSK_UI_RESET_WALLET") {
        await withStorageLock(WALLET_LIFECYCLE_LOCK, async () => {
          await lockWallet("reset");
          await clearPermissions();
          await clearVault();
        });
        sendResponse({ ok: true });
        return;
      }

      // UI changes which account is exposed to a connected origin.
      if (message?.type === "DUSK_UI_SET_ORIGIN_ACCOUNT") {
        const origin = String(message.origin ?? "").trim();
        const accountIndex = Number(message.accountIndex);
        if (!origin) {
          throw rpcError(ERROR_CODES.INVALID_PARAMS, "origin is required");
        }
        if (!Number.isFinite(accountIndex) || accountIndex < 0) {
          throw rpcError(ERROR_CODES.INVALID_PARAMS, "accountIndex must be a non-negative number");
        }

        const settings = await getSettings();
        const maxIndex = Math.max(0, Number(settings?.accountCount ?? 1) - 1);
        const clamped = Math.min(Math.floor(accountIndex), maxIndex);

        await withStorageLock(WALLET_LIFECYCLE_LOCK, async () => {
          const status = await getEngineStatusStrict();
          if (!status.isUnlocked) {
            throw rpcError(ERROR_CODES.UNAUTHORIZED, "Wallet locked");
          }
          const account = Array.isArray(status.accounts) ? status.accounts[clamped] : "";
          if (!account) {
            throw rpcError(ERROR_CODES.INVALID_PARAMS, "Account is not available");
          }
          cancelPendingApprovals(origin, "Connected profile changed");
          await approveOrigin(origin, {
            profileId: `account:${clamped}:${account}`,
            accountIndex: clamped,
            grants: { publicAccount: true, shieldedReceiveAddress: false },
          });
        });
        sendResponse({ ok: true });
        return;
      }

      // UI connects the active tab origin to the currently selected account.
      if (message?.type === "DUSK_UI_CONNECT_ORIGIN") {
        const origin = String(message.origin ?? "").trim();
        if (!origin) {
          throw rpcError(ERROR_CODES.INVALID_PARAMS, "origin is required");
        }

        await withStorageLock(WALLET_LIFECYCLE_LOCK, async () => {
          const status = await getEngineStatusStrict();
          if (!status.isUnlocked) {
            throw rpcError(ERROR_CODES.UNAUTHORIZED, "Wallet locked");
          }

          const accounts = Array.isArray(status.accounts) ? status.accounts : [];
          const idxRaw =
            status.selectedAccountIndex !== undefined && status.selectedAccountIndex !== null
              ? Number(status.selectedAccountIndex)
              : Number((await getSettings())?.selectedAccountIndex ?? 0);
          const idx = Math.max(
            0,
            Math.min(Math.floor(idxRaw) || 0, Math.max(0, accounts.length - 1))
          );
          const account = accounts[idx] ?? "";
          if (!account) {
            throw rpcError(ERROR_CODES.UNAUTHORIZED, "No wallet profile is available");
          }

          cancelPendingApprovals(origin, "Connected profile changed");
          await approveOrigin(origin, {
            profileId: `account:${idx}:${account}`,
            accountIndex: idx,
            grants: { publicAccount: true, shieldedReceiveAddress: false },
          });
        });
        sendResponse({ ok: true });
        return;
      }

      // UI disconnects the active tab origin.
      if (message?.type === "DUSK_UI_DISCONNECT_ORIGIN") {
        const origin = String(message.origin ?? "").trim();
        if (!origin) {
          throw rpcError(ERROR_CODES.INVALID_PARAMS, "origin is required");
        }

        await withStorageLock(WALLET_LIFECYCLE_LOCK, async () => {
          cancelPendingApprovals(origin, "Site disconnected");
          await revokeOrigin(origin);
        });
        sendResponse({ ok: true });
        return;
      }

      if (message?.type === "DUSK_UI_CLEAR_PERMISSIONS") {
        await withStorageLock(WALLET_LIFECYCLE_LOCK, async () => {
          cancelPendingApprovals(null, "Sites disconnected");
          await clearPermissions();
        });
        sendResponse({ ok: true });
        return;
      }

      // UI creates/imports and unlocks a wallet as one serialized lifecycle operation.
      if (message?.type === "DUSK_UI_CREATE_WALLET") {
        const accounts = await withStorageLock(WALLET_LIFECYCLE_LOCK, async () => {
          const { mnemonic, password } = message;
          if (!mnemonic || !password) {
            throw rpcError(ERROR_CODES.INVALID_PARAMS, "mnemonic and password required");
          }
          if (await loadVault()) {
            throw rpcError(ERROR_CODES.UNAUTHORIZED, "Reset the existing wallet before replacing it");
          }
          if ((await getEngineStatusStrict())?.isUnlocked) {
            throw rpcError(ERROR_CODES.UNAUTHORIZED, "Lock or reset the current wallet first");
          }

          await createVault(mnemonic, password);
          await ensureEngineConfigured();
          const result = await unlockEngine(String(mnemonic));
          await updateActivity();
          setupAutoLockAlarm().catch(console.error);
          broadcastProfilesChangedAll().catch(() => {});
          emitUiLockState(true, "create").catch(() => {});
          return Array.isArray(result?.accounts)
            ? result.accounts
            : (await getEngineStatusStrict()).accounts;
        });

        sendResponse({ ok: true, accounts });
        return;
      }

      // UI checks status
      if (message?.type === "DUSK_UI_STATUS") {
        const vault = await loadVault();
        const status = await getEngineStatus();
        sendResponse({
          hasVault: Boolean(vault),
          isUnlocked: status.isUnlocked,
          accounts: status.accounts,
        });
        return;
      }

      // UI switches network by setting a new node URL
      if (message?.type === "DUSK_UI_SET_NODE_URL") {
        const nodeUrl = String(message?.nodeUrl ?? "").trim();
        const proverUrl =
          message?.proverUrl !== undefined && message?.proverUrl !== null
            ? String(message.proverUrl).trim()
            : "";
        const archiverUrl =
          message?.archiverUrl !== undefined && message?.archiverUrl !== null
            ? String(message.archiverUrl).trim()
            : "";

        // Only validate URL format (not reachability) - we accept any URL
        // and do background polling for status.
        try {
          // eslint-disable-next-line no-new
          new URL(nodeUrl);
        } catch {
          throw rpcError(ERROR_CODES.INVALID_PARAMS, "Invalid node URL format");
        }

        // Optional validation for explicit prover/archiver URLs.
        if (proverUrl) {
          try {
            // eslint-disable-next-line no-new
            new URL(proverUrl);
          } catch {
            throw rpcError(ERROR_CODES.INVALID_PARAMS, "Invalid prover URL format");
          }
        }
        if (archiverUrl) {
          try {
            // eslint-disable-next-line no-new
            new URL(archiverUrl);
          } catch {
            throw rpcError(ERROR_CODES.INVALID_PARAMS, "Invalid archiver URL format");
          }
        }

        await withStorageLock(WALLET_LIFECYCLE_LOCK, async () => {
          cancelPendingApprovals(null, "Network changed");
          // Reset network status when endpoints change (will be checked in background)
          await resetNetworkStatus();

          // Store endpoints (prover/archiver may be inferred inside setSettings
          // when omitted).
          const nextSettings = await setSettings({
            nodeUrl,
            ...(proverUrl ? { proverUrl } : {}),
            ...(archiverUrl ? { archiverUrl } : {}),
          });

          // Force the engine to pick up the new config immediately.
          // We no longer roll back on failure - the UI will show offline status.
          try {
            invalidateEngineConfig();
            await ensureEngineConfigured();
          } catch {
            // Engine config failed, but we still save the settings.
            // The UI will show offline status via polling.
          }

          // Notify dApps that the chain has changed.
          broadcastChainChangedAll().catch(() => {});

          // Kick off a background status check (don't await).
          checkAllEndpoints({
            nodeUrl: nextSettings.nodeUrl,
            proverUrl: nextSettings.proverUrl,
            archiverUrl: nextSettings.archiverUrl,
          }).catch(() => {});

          sendResponse({
            ok: true,
            nodeUrl: nextSettings.nodeUrl,
            proverUrl: nextSettings.proverUrl,
            archiverUrl: nextSettings.archiverUrl,
            networkName: networkNameFromNodeUrl(nextSettings.nodeUrl),
          });
        });
        return;
      }

      // UI sets auto-lock timeout
      if (message?.type === "DUSK_UI_SET_AUTO_LOCK") {
        const timeout = Number(message.autoLockTimeoutMinutes ?? 0);
        await setSettings({ autoLockTimeoutMinutes: timeout });
        if (timeout > 0) {
          await ensureActivityTimestampIfUnlocked();
        } else {
          await clearActivity();
        }
        await setupAutoLockAlarm();
        sendResponse({ ok: true, autoLockTimeoutMinutes: timeout });
        return;
      }

      // UI approves or rejects a pending request
      if (message?.type === "DUSK_PENDING_DECISION") {
        const res = resolvePendingDecision(message);
        sendResponse(res);
        return;
      }

      // UI asks for overview data (network + addresses + balance)
      if (message?.type === "DUSK_UI_OVERVIEW") {
        const vault = await loadVault();
        const settings = await getSettings();
        const status = await getEngineStatus();

        const activeOrigin =
          typeof message.origin === "string" && message.origin.length
            ? message.origin
            : null;
        const activeConnected = activeOrigin
          ? Boolean(await getPermissionForOrigin(activeOrigin))
          : null;

        let addresses = [];
        let balance = null;
        let balanceError = null;

        let shieldedBalance = null;
        let shieldedSync = null;
        let shieldedError = null;

        // Connected sites (for settings UI)
        let permissions = null;
        try {
          const perms = await getPermissions();
          permissions = Object.entries(perms ?? {})
            .map(([o, p]) => ({
              origin: o,
              accountIndex: Number(p?.accountIndex ?? 0) || 0,
              connectedAt: Number(p?.connectedAt ?? 0) || 0,
            }))
            .sort((a, b) => a.origin.localeCompare(b.origin));
        } catch {
          permissions = null;
        }

        // Recent activity (transaction list). This is used by the dashboard
        // to provide MetaMask-like feedback instead of
        // ephemeral toasts.
        let txs = [];
        try {
          txs = await listTxs({ nodeUrl: settings.nodeUrl });
        } catch {
          txs = [];
        }

        // Account names (stored per walletId, which is profile 0 account).
        let accountNames = {};
        try {
          const walletId = status?.isUnlocked ? String(status?.accounts?.[0] ?? "").trim() : "";
          accountNames = walletId ? await getAccountNames(walletId) : {};
        } catch {
          accountNames = {};
        }

        // Get network status and check if we need to refresh it
        let networkStatus = await getNetworkStatus();
        if (isStatusStale(networkStatus, 30000)) {
          // Kick off a background check (don't await)
          checkAllEndpoints({
            nodeUrl: settings.nodeUrl,
            proverUrl: settings.proverUrl,
            archiverUrl: settings.archiverUrl,
          }).catch(() => {});
        }

        if (status.isUnlocked) {
          let publicBalanceAvailable = false;

          try {
            await ensureEngineConfigured();
            addresses = (await engineCall("dusk_getAddresses")) ?? [];
          } catch {
            // ignore
          }

          try {
            await ensureEngineConfigured();
            balance = await engineCall("dusk_getPublicBalance");
            publicBalanceAvailable = true;
          } catch (e) {
            balanceError = e?.message ?? String(e);
          }
          // Shielded Phase 1: surface status + (optionally) kick off an incremental sync.
          const fallbackShieldedStatus = {
            state: "idle",
            progress: 0,
            notes: 0,
            cursorBookmark: "0",
            cursorBlock: "0",
            lastError: "",
            updatedAt: 0,
          };

          try {
            await ensureEngineConfigured();
            shieldedSync = await engineCall("dusk_getShieldedStatus");
          } catch {
            shieldedSync = fallbackShieldedStatus;
          }

          if (publicBalanceAvailable) {
            try {
              await ensureEngineConfigured();
              const st = shieldedSync?.state;
              const age = Date.now() - Number(shieldedSync?.updatedAt || 0);
              const shouldAuto =
                st === "idle" ||
                st === "error" ||
                (st === "done" && age > 30_000);

              if (shouldAuto) {
                // Fire-and-forget: don't await, avoid slowing down overview.
                engineCall("dusk_syncShielded", { force: false }).catch(() => {});
              }
            } catch {
              // ignore
            }

            try {
              await ensureEngineConfigured();
              shieldedBalance = await engineCall("dusk_getShieldedBalance");
            } catch (e) {
              shieldedError = e?.message ?? String(e);
            }
          } else {
            shieldedError = balanceError;
          }
        }

        sendResponse({
          hasVault: Boolean(vault),
          isUnlocked: status.isUnlocked,
          accounts: status.accounts,
          addresses,
          balance,
          balanceError,
          shieldedBalance,
          shieldedSync,
          shieldedError,
          selectedAccountIndex: status.selectedAccountIndex ?? settings.selectedAccountIndex ?? 0,
          accountCount: settings.accountCount ?? 1,
          permissions,
          nodeUrl: settings.nodeUrl,
          proverUrl: settings.proverUrl,
          archiverUrl: settings.archiverUrl,
          autoLockTimeoutMinutes: settings.autoLockTimeoutMinutes ?? 5,
          nftMetadataEnabled: settings.nftMetadataEnabled !== false,
          ipfsGateway: settings.ipfsGateway ?? "",
          networkName: networkNameFromNodeUrl(settings.nodeUrl),
          networkStatus,
          activeOrigin,
          activeConnected,
          txs,
          accountNames,
        });
        return;
      }

      // UI requests a network status check
      if (message?.type === "DUSK_UI_CHECK_NETWORK") {
        const settings = await getSettings();
        const status = await checkAllEndpoints({
          nodeUrl: settings.nodeUrl,
          proverUrl: settings.proverUrl,
          archiverUrl: settings.archiverUrl,
        });
        sendResponse({ ok: true, networkStatus: status });
        return;
      }

      // UI initiated transaction (from the wallet popup)
      if (message?.type === "DUSK_UI_SEND_TX") {
        const status = await getEngineStatus();
        if (!status.isUnlocked) {
          throw rpcError(ERROR_CODES.UNAUTHORIZED, "Wallet locked");
        }
        await ensureEngineConfigured();
        // Fetch live gas price from node (cached for 30s) to use as default.
        let dynamicPrice;
        try {
          const gasData = await engineCall("dusk_getCachedGasPrice");
          dynamicPrice = gasData?.median;
        } catch {
          // Ignore errors, will fall back to static default
        }
        // Apply standard gas defaults for wallet initiated transactions.
        const baseParams = applyTxDefaults(message.params ?? {}, { dynamicPrice });
        const result = await engineCall("dusk_sendTransaction", baseParams);

        // Persist metadata (see rpc.js comments).
        const hash = result?.hash ?? "";
        const kind = String(baseParams?.kind ?? "");
        try {
          const settings = await getSettings();
          const nodeUrl = settings?.nodeUrl ?? "";

          if (hash) {
            const pendingNullifiers = nullifierHexes(result?.nullifiers);
            await putTxMeta(hash, {
              origin: "Wallet",
              nodeUrl,
              kind,
              privacy: baseParams?.privacy ? String(baseParams.privacy) : undefined,
              profileIndex:
                baseParams?.profileIndex !== undefined && baseParams?.profileIndex !== null
                  ? Number(baseParams.profileIndex) || 0
                  : status?.selectedAccountIndex !== undefined && status?.selectedAccountIndex !== null
                  ? Number(status.selectedAccountIndex) || 0
                  : Number(settings?.selectedAccountIndex ?? 0) || 0,
              ownerProfileIndex:
                baseParams?.ownerProfileIndex !== undefined && baseParams?.ownerProfileIndex !== null
                  ? Number(baseParams.ownerProfileIndex) || 0
                  : undefined,
              payment: baseParams?.payment ? String(baseParams.payment) : undefined,
              asset:
                message?.asset && typeof message.asset === "object"
                  ? message.asset
                  : undefined,
              // Helpful fields for the Activity list UI
              to: baseParams?.to ? String(baseParams.to) : undefined,
              amount:
                baseParams?.amount !== undefined && baseParams?.amount !== null
                  ? String(baseParams.amount)
                  : undefined,
              deposit:
                baseParams?.deposit !== undefined && baseParams?.deposit !== null
                  ? String(baseParams.deposit)
                  : undefined,
              contractId:
                kind === TX_KIND.CONTRACT_CALL && baseParams?.contractId
                  ? String(baseParams.contractId)
                  : undefined,
              fnName:
                kind === TX_KIND.CONTRACT_CALL && baseParams?.fnName
                  ? String(baseParams.fnName)
                  : undefined,
              gasLimit: baseParams?.gas?.limit != null ? String(baseParams.gas.limit) : undefined,
              gasPrice: baseParams?.gas?.price != null ? String(baseParams.gas.price) : undefined,
              pendingNullifiers,
              reservationStatus: pendingNullifiers.length ? "pending" : undefined,
              reservationUpdatedAt: pendingNullifiers.length ? Date.now() : undefined,
              submittedAt: Date.now(),
              status: "submitted",
            });
          }

          await notifyTxSubmitted({ hash, origin: "Wallet", nodeUrl });
        } catch {
          notifyTxSubmitted({ hash, origin: "Wallet" }).catch(() => {});
        }
        const publicResult = { hash };
        if (result?.nonce !== undefined && result?.nonce !== null) {
          publicResult.nonce = result.nonce?.toString?.() ?? String(result.nonce);
        }
        sendResponse({ ok: true, result: publicResult });
        return;
      }

      // Fallback
      sendResponse({ ok: false, error: "Unknown message" });
    } catch (err) {
      const code = err?.code ?? ERROR_CODES.INTERNAL;
      const messageText = err?.message ?? String(err);
      sendResponse({ error: { code, message: messageText, data: err?.data } });
    }
  })();

  // Keep the message channel open for async sendResponse.
  return true;
});
