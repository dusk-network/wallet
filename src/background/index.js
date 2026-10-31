// Background service worker entry.

import { clearVault, createVault, loadVault, unlockVault } from "../shared/vault.js";
import {
  approveOrigin,
  clearAllPermissions,
  clearPermissions,
  getPermissionForOrigin,
  getPermissions,
  revokeOrigin,
} from "../shared/permissions.js";
import { getSettings, normalizeAutoLock, setSettings } from "../shared/settings.js";
import { storage, STORAGE_KEYS } from "../shared/storage.js";
import { ERROR_CODES, rpcError } from "../shared/errors.js";
import { applyTxDefaults } from "../shared/txDefaults.js";
import { networkNameFromNodeUrl } from "../shared/network.js";
import { isAllowedDappOrigin } from "../shared/securityPolicy.js";
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
import { bindPendingWallet, cancelPendingApprovals, getPending, resolvePendingDecision } from "./pending.js";
import { approvalRecipientName, keepEngineNameCheck, siteNames } from "./siteNames.js";
import {
  broadcastChainChangedAll,
  broadcastProfilesChangedAll,
  broadcastWalletChanged,
  bindPortsForSenderOrigin,
  registerDappPort,
  registerStorageChangeForwarder,
} from "./dappEvents.js";
import { siteWalletId } from "./siteWallet.js";

import {
  notifyTxSubmitted,
  notifyTxExecuted,
  registerTxNotificationHandlers,
} from "./txNotify.js";
import { getAccountNames } from "../shared/accountNames.js";
import { clearContacts, contactsStore, keepOnlyContactsOf, moveLegacyContacts } from "../shared/contactsStore.js";
import {
  getTxEpoch,
  getTxMeta,
  patchTxMeta as patchStored,
  putTxMeta,
  listTxs,
} from "../shared/txStore.js";
import { submittedTxMeta, walletSendFields } from "../shared/txRecord.js";
import { beginReset, clearWalletData, endReset, finishPendingReset, finishReset } from "../shared/walletReset.js";
import { engineContactsVault, handleUiCommand } from "../wallet/uiCommands.js";
import { handleWalletCommand, keepWalletShown, walletsShown } from "../wallet/walletCommands.js";
import { getWalletDirectory } from "../shared/wallets.js";
import {
  getNetworkStatus,
  checkAllEndpoints,
  readChainId,
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
  "dusk_signTypedData",
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

// Every wallet the vault opened: `walletKey`'s unlocked, the others kept in
// the engine for a switch without the password.
async function unlockEngine(wallets, walletKey) {
  try {
    return await engineCall(
      "engine_unlock",
      { wallets, walletKey },
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

// Another wallet unlocked, or one added or removed: pages draw again.
async function emitUiWalletChanged() {
  try {
    await runtimeSendMessage({ type: "DUSK_UI_WALLET_CHANGED" });
  } catch {
    // ignore
  }
}

// The store's reset count an engine event carries: its send's (see engine/runtime.js).
const eventEpoch = (message) => (Number.isInteger(message?.epoch) ? message.epoch : undefined);

/**
 * @param {string} hash
 * @param {{ preserveRemoved?: boolean, epoch?: number }} [opts] - `epoch`: the
 *   store's reset count when the work began; after a reset since, nothing is kept
 */
async function reconcileTxPresence(hash, { preserveRemoved = false, epoch } = {}) {
  const meta = await getTxMeta(hash);
  // Nothing kept to reconcile: cleared by a reset, or never this wallet's.
  if (!meta) return { status: "unknown", origin: "Wallet", nodeUrl: "", error: "" };
  const patchTxMeta = (h, patch) => patchStored(h, patch, { epoch });
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

      // Switch, add, remove and rename wallets, and change the password.
      const walletAnswer = await handleWalletCommand(message, {
        engineCall,
        ensureEngineConfigured,
        getEngineStatus: getEngineStatusStrict,
        lock: () => lockWallet("remove"),
        beforeSwitch: () => cancelPendingApprovals(null, "Wallet changed"),
        afterSwitch: async ({ oldPerms, oldStatus }) => {
          await updateActivity();
          broadcastWalletChanged(oldPerms, oldStatus).catch(() => {});
          emitUiWalletChanged().catch(() => {});
        },
      });
      if (walletAnswer) {
        sendResponse(walletAnswer);
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

      // The engine's .dusk name checks, kept here: Chrome's offscreen
      // document has no storage.
      if (message?.type === "DUSK_NAME_CHECKED") {
        sendResponse({ ok: await keepEngineNameCheck(message, sender) });
        return;
      }

      // Offscreen notifies us when a tx lifecycle event is observed (best-effort).
      if (message?.type === "DUSK_TX_EXECUTED") {
        const hash = String(message.hash ?? "");
        const epoch = eventEpoch(message);
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
          await patchStored(
            hash,
            {
              status: observedStatus,
              executedAt: now,
              lastCheckedAt: now,
              error: observedOk ? undefined : observedError || undefined,
              reservationStatus: isShieldedTxMeta(meta) ? "spent" : meta?.reservationStatus,
              reservationUpdatedAt: isShieldedTxMeta(meta) ? now : meta?.reservationUpdatedAt,
            },
            { epoch }
          );
          reconciled = await reconcileTxPresence(hash, { epoch });
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
        const reconciled = await reconcileTxPresence(hash, { preserveRemoved: true, epoch: eventEpoch(message) });
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
        const epoch = eventEpoch(message);
        const reason = message.reason ? String(message.reason) : "watcher_timeout";
        const meta = await getTxMeta(hash);
        const now = Date.now();

        const preserveRemoved =
          meta?.status === "removed" || meta?.recoveryReason === "removed_unconfirmed";
        await patchStored(
          hash,
          {
            status: meta?.status === "removed" ? "removed" : "unknown",
            lastCheckedAt: now,
            reservationStatus:
              meta?.status === "removed" || !isShieldedTxMeta(meta)
                ? meta?.reservationStatus
                : "pending",
            recoveryReason: preserveRemoved ? meta?.recoveryReason : reason,
          },
          { epoch }
        );

        const reconciled = await reconcileTxPresence(hash, { preserveRemoved, epoch });
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

        const epoch = await getTxEpoch();
        const meta = await getTxMeta(hash);
        const reconciled = await reconcileTxPresence(hash, {
          preserveRemoved:
            meta?.status === "removed" || meta?.recoveryReason === "removed_unconfirmed",
          epoch,
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
        // The request's wallet, or none: its window never shows another.
        if (status.isUnlocked && !bindPendingWallet(message.rid, String(status.accounts?.[0] ?? ""))) {
          sendResponse(null);
          return;
        }
        const perm = await getPermissionForOrigin(entry.origin, await siteWalletId(status));

        let accountNames = {};
        try {
          const walletId = status?.isUnlocked ? String(status?.accounts?.[0] ?? "").trim() : "";
          accountNames = walletId ? await getAccountNames(walletId) : {};
        } catch {
          accountNames = {};
        }

        // The profiles' .dusk names checked lately, so the approval shows
        // them from its first paint. It never waits for a lookup.
        const accounts = status?.isUnlocked && Array.isArray(status.accounts) ? status.accounts : [];
        const names = await siteNames(String(settings?.nodeUrl ?? ""), accounts);

        // The saved contacts, so a request to send names a recipient the
        // user saved from its first paint, as it names the profiles. They
        // open only while the wallet is unlocked.
        let contacts = [];
        if (entry.kind === "send_tx" && status.isUnlocked) {
          try {
            contacts = (await contactsStore(engineContactsVault(engineCall)).list()).map(({ name, address }) => ({ name, address }));
          } catch {
            contacts = [];
          }
        }

        sendResponse({
          rid: message.rid,
          kind: entry.kind,
          origin: entry.origin,
          params: entry.params,
          // The wallet's network, for the approval's header, by the chain ID its node gave.
          nodeUrl: String(settings?.nodeUrl ?? ""),
          chainId: settings?.chainId ?? null,
          networkName: networkNameFromNodeUrl(String(settings?.nodeUrl ?? "")),
          hasVault: Boolean(vault),
          isUnlocked: status.isUnlocked,
          accounts: status.accounts,
          addresses: status.addresses,
          accountCount: settings?.accountCount ?? 1,
          selectedAccountIndex: status.selectedAccountIndex ?? settings?.selectedAccountIndex ?? 0,
          accountNames,
          duskNames: Object.fromEntries(accounts.filter((a) => names.has(a)).map((a) => [a, names.get(a)])),
          contacts,
          permissionAccountIndex:
            perm && perm.accountIndex !== undefined && perm.accountIndex !== null
              ? Number(perm.accountIndex) || 0
              : null,
        });
        return;
      }

      // The .dusk name of the recipient of a site's request to send, which
      // its approval asks for once it shows.
      if (message?.type === "DUSK_UI_RECIPIENT_NAME") {
        sendResponse({ ok: true, result: await approvalRecipientName(getPending(message.rid), message.recipient) });
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

          // Every wallet the password opens (v1's vault moved over first),
          // the one unlocked last unlocked again.
          const { wallets } = await unlockVault(password);
          await ensureEngineConfigured();
          const result = await unlockEngine(wallets, (await getWalletDirectory().catch(() => ({}))).active);
          await keepWalletShown(result);
          // Contacts kept in plain text before they were encrypted move into
          // this wallet's record now. Unlocking doesn't wait on a failure:
          // the next read of the contacts moves them.
          await moveLegacyContacts(engineContactsVault(engineCall)).catch(() => {});
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
          await beginReset();
          await clearAllPermissions();
          await clearVault();
          // Nothing of the old wallet stays: its transactions, shielded notes
          // and history. A store that can't be cleared fails the reset and
          // keeps it pending (walletReset.js).
          await finishReset();
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
          }, String(status.accounts[0] ?? ""));
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
          }, String(accounts[0] ?? ""));
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
          await revokeOrigin(origin, await siteWalletId());
        });
        sendResponse({ ok: true });
        return;
      }

      if (message?.type === "DUSK_UI_CLEAR_PERMISSIONS") {
        // The wallet's own sites: another wallet's stay connected to it.
        await withStorageLock(WALLET_LIFECYCLE_LOCK, async () => {
          cancelPendingApprovals(null, "Sites disconnected");
          await clearPermissions(await siteWalletId());
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
          // A reset that couldn't clear the old wallet's data finishes first.
          const { pending, keepContactsOf } = await finishPendingReset();
          if (keepContactsOf) {
            // A restore cut short before its vault: its wallet's contacts
            // stay if this is that wallet, and go if it's another.
            await ensureEngineConfigured();
            await keepOnlyContactsOf(await engineCall("engine_walletId", { mnemonic: String(mnemonic) }, { timeoutMs: 120_000 }));
          } else {
            // A new wallet starts with no contacts: any kept here are another's.
            await clearContacts();
          }

          const wallet = await createVault(mnemonic, password);
          if (pending) await endReset();
          await ensureEngineConfigured();
          const result = await unlockEngine([{ ...wallet, mnemonic: String(mnemonic) }], wallet.id);
          await keepWalletShown(result);
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

      // A forgotten password: the wallet restored from its recovery phrase in
      // place of the one here. Nothing goes until the phrase has made its
      // wallet; then the vault, sites, history and notes are replaced as
      // Reset does, and of the contacts only that wallet's stay.
      if (message?.type === "DUSK_UI_RESTORE_WALLET") {
        const accounts = await withStorageLock(WALLET_LIFECYCLE_LOCK, async () => {
          const { mnemonic, password } = message;
          if (!mnemonic || !password) {
            throw rpcError(ERROR_CODES.INVALID_PARAMS, "mnemonic and password required");
          }
          if ((await getEngineStatusStrict())?.isUnlocked) {
            throw rpcError(ERROR_CODES.UNAUTHORIZED, "Lock the wallet first");
          }
          await ensureEngineConfigured();
          const walletId = await engineCall("engine_walletId", { mnemonic: String(mnemonic) }, { timeoutMs: 120_000 });

          await lockWallet("restore");
          // Noted with the wallet it makes until that wallet's vault is: cut
          // short in between, the next wallet made here keeps those contacts
          // only if it's the same one.
          await beginReset({ keepContactsOf: walletId });
          await clearAllPermissions();
          await clearWalletData({ keepContactsOf: walletId });
          await clearVault();
          const restored = await createVault(mnemonic, password);
          await endReset();
          const result = await unlockEngine([{ ...restored, mnemonic: String(mnemonic) }], restored.id);
          await keepWalletShown(result);
          await updateActivity();
          setupAutoLockAlarm().catch(console.error);
          broadcastProfilesChangedAll().catch(() => {});
          emitUiLockState(true, "restore").catch(() => {});
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

        // The node's chain ID, which names its network, kept with it (null
        // while it can't be read: the next status check asks again).
        const chainId = await readChainId(nodeUrl);

        await withStorageLock(WALLET_LIFECYCLE_LOCK, async () => {
          cancelPendingApprovals(null, "Network changed");
          // Reset network status when endpoints change (will be checked in background)
          await resetNetworkStatus();

          // Store endpoints (prover/archiver may be inferred inside setSettings
          // when omitted).
          const nextSettings = await setSettings({
            nodeUrl,
            chainId,
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
        const timeout = normalizeAutoLock(message.autoLockTimeoutMinutes ?? 0);
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
        // The wallet the sites, transactions and arrivals shown are of.
        const walletId = await siteWalletId(status);

        const activeOrigin =
          typeof message.origin === "string" && message.origin.length
            ? message.origin
            : null;
        const activeConnected = activeOrigin
          ? Boolean(await getPermissionForOrigin(activeOrigin, walletId))
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
          const perms = await getPermissions(walletId);
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
          txs = status?.isUnlocked ? await listTxs({ nodeUrl: settings.nodeUrl, walletId }) : [];
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

        // The node's network, by the chain ID kept with it (settings.js).
        const { chainId } = settings;

        // Get network status and check if we need to refresh it
        let networkStatus = await getNetworkStatus();
        if (isStatusStale(networkStatus, 30000)) {
          // Kick off a background check (don't await). A node whose chain ID
          // wasn't read yet gets it there: the popup is told to draw again.
          checkAllEndpoints({
            nodeUrl: settings.nodeUrl,
            proverUrl: settings.proverUrl,
            archiverUrl: settings.archiverUrl,
          })
            .then(async () => {
              const now = await getSettings();
              if (now.nodeUrl === settings.nodeUrl && now.chainId !== chainId) {
                await runtimeSendMessage({ type: "DUSK_UI_NETWORK_CHANGED" }).catch(() => {});
              }
            })
            .catch(() => {});
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
          autoLockTimeoutMinutes: settings.autoLockTimeoutMinutes ?? 15,
          customGas: settings.customGas ?? null,
          nftMetadataEnabled: settings.nftMetadataEnabled !== false,
          ipfsGateway: settings.ipfsGateway ?? "",
          hideBalances: settings.hideBalances === true,
          chainId,
          networkName: networkNameFromNodeUrl(settings.nodeUrl),
          networkStatus,
          activeOrigin,
          activeConnected,
          txs,
          accountNames,
          // Each wallet the switcher shows, and the one unlocked.
          wallets: await walletsShown(status).catch(() => []),
          walletKey: status.isUnlocked ? status.walletKey ?? "" : "",
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
        // Sent from the wallet unlocked as it goes, the one its Review was on
        // (`walletId`): a switch, lock or reset waits for it, as for a site's.
        const { status, txEpoch, baseParams, result } = await withStorageLock(WALLET_LIFECYCLE_LOCK, async () => {
          const status = await getEngineStatus();
          if (!status.isUnlocked) {
            throw rpcError(ERROR_CODES.UNAUTHORIZED, "Wallet locked");
          }
          const expected = String(message.walletId ?? "");
          if (expected && expected !== String(status.accounts?.[0] ?? "")) {
            throw rpcError(ERROR_CODES.UNAUTHORIZED, "The wallet changed while you reviewed it.");
          }
          // What this send and its watcher keep is dropped after a reset meanwhile.
          const txEpoch = await getTxEpoch();
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
          const result = await engineCall("dusk_sendTransaction", { ...baseParams, txEpoch });
          return { status, txEpoch, baseParams, result };
        });

        // Persist metadata (see rpc.js comments).
        const hash = result?.hash ?? "";
        try {
          const settings = await getSettings();
          const nodeUrl = settings?.nodeUrl ?? "";

          if (hash) {
            // The profile that paid: a stake's own may not be the one selected.
            const profileIndex =
              baseParams?.profileIndex !== undefined && baseParams?.profileIndex !== null
                ? Number(baseParams.profileIndex) || 0
                : status?.selectedAccountIndex !== undefined && status?.selectedAccountIndex !== null
                ? Number(status.selectedAccountIndex) || 0
                : Number(settings?.selectedAccountIndex ?? 0) || 0;
            await putTxMeta(
              hash,
              submittedTxMeta(baseParams, { walletId: String(status?.accounts?.[0] ?? ""), origin: "Wallet", nodeUrl, profileIndex, nullifiers: result?.nullifiers }, walletSendFields(baseParams, message)),
              { epoch: txEpoch }
            );
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
