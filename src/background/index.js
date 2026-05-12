// Background service worker entry.

import { createVault, loadVault, unlockVault } from "../shared/vault.js";
import { approveOrigin, getPermissionForOrigin, getPermissions } from "../shared/permissions.js";
import { getSettings, setSettings } from "../shared/settings.js";
import { ERROR_CODES, rpcError } from "../shared/errors.js";
import { TX_KIND } from "../shared/constants.js";
import { applyTxDefaults } from "../shared/txDefaults.js";
import { detectPresetIdFromNodeUrl, networkNameFromNodeUrl } from "../shared/network.js";
import { NETWORK_PRESETS } from "../shared/networkPresets.js";
import { bytesToHex } from "../shared/bytes.js";
import { classifyTxPresence } from "../shared/txLifecycle.js";

import {
  engineCall,
  ensureEngineConfigured,
  getEngineStatus,
  invalidateEngineConfig,
  handleEngineReady,
} from "./engineHost.js";
import { handleRpc } from "./rpc.js";
import { getPending, resolvePendingDecision } from "./pending.js";
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
import {
  getWatchedAssets,
  watchToken,
  unwatchToken,
  watchNft,
  unwatchNft,
} from "../shared/assetsStore.js";
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
  tabsCreate,
} from "../platform/extensionApi.js";

registerTxNotificationHandlers();

const ext = getExtensionApi();

// ------------------------------
// Auto-lock timer
// ------------------------------
const AUTO_LOCK_ALARM_NAME = "dusk_auto_lock_check";

/** Last activity timestamp in memory (reset on unlock, updated on activity). */
let lastActivityTimestamp = 0;

/** Update activity timestamp to prevent auto-lock. */
function updateActivity() {
  lastActivityTimestamp = Date.now();
}

function nullifierHexes(value) {
  const out = [];
  for (const n of Array.isArray(value) ? value : []) {
    try {
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

async function reconcileTxPresence(hash, { preserveRemoved = false } = {}) {
  const meta = await getTxMeta(hash);
  const settings = await getSettings();
  const nodeUrl = meta?.nodeUrl ?? settings?.nodeUrl ?? "";
  const origin = meta?.origin ?? "Wallet";
  const now = Date.now();

  if (!nodeUrl) {
    await patchTxMeta(hash, {
      status: preserveRemoved ? "removed" : "unknown",
      lastCheckedAt: now,
      recoveryReason: "node_url_missing",
    });
    return { status: preserveRemoved ? "removed" : "unknown", origin, nodeUrl, error: "node_url_missing" };
  }

  const presence = await classifyTxPresence(nodeUrl, hash);
  if (presence.state === "executed_success") {
    await patchTxMeta(hash, {
      status: "executed",
      error: undefined,
      executedAt: now,
      lastCheckedAt: now,
    });
    return { status: "executed", ok: true, origin, nodeUrl };
  }

  if (presence.state === "executed_failed") {
    await patchTxMeta(hash, {
      status: "failed",
      error: presence.error || undefined,
      executedAt: now,
      lastCheckedAt: now,
    });
    return { status: "failed", ok: false, origin, nodeUrl, error: presence.error || "" };
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
    const status = preserveRemoved ? "removed" : "unknown";
    await patchTxMeta(hash, {
      status,
      lastCheckedAt: now,
      recoveryReason: preserveRemoved ? "removed" : "not_found",
      reservationStatus: preserveRemoved && isShieldedTxMeta(meta)
        ? "recoverable"
        : meta?.reservationStatus,
    });
    return { status, origin, nodeUrl };
  }

  await patchTxMeta(hash, {
    status: preserveRemoved ? "removed" : "unknown",
    lastCheckedAt: now,
    recoveryReason: presence.error || "reconciliation_unavailable",
  });
  return {
    status: preserveRemoved ? "removed" : "unknown",
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

  const elapsed = Date.now() - lastActivityTimestamp;
  const timeoutMs = timeout * 60 * 1000;

  if (elapsed >= timeoutMs) {
    console.log("[Dusk] Auto-locking wallet due to inactivity.");
    try {
      await engineCall("engine_lock");
      broadcastProfilesChangedAll().catch(() => {});
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
// Endpoint helpers
// ------------------------------

function inferEndpointsFromNodeUrl(nodeUrl) {
  const id = detectPresetIdFromNodeUrl(nodeUrl);
  const preset = NETWORK_PRESETS.find((p) => p.id === id) ?? null;
  if (preset && preset.id !== "custom") {
    return {
      proverUrl: preset.proverUrl || nodeUrl,
      archiverUrl: preset.archiverUrl || nodeUrl,
    };
  }
  return {
    proverUrl: nodeUrl,
    archiverUrl: nodeUrl,
  };
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
      // UI heartbeat to reset auto-lock timer.
      if (message?.type === "DUSK_UI_ACTIVITY") {
        updateActivity();
        sendResponse({ ok: true });
        return;
      }

      // RPC messages from contentScript
      if (message?.type === "DUSK_RPC_REQUEST") {
        const origin = getOriginFromSender(sender) || message.origin || "";

        // Ensure any dApp port(s) opened from this tab are bound to the same
        // origin so provider push events (connect/chainChanged/...) work
        // reliably.
        bindPortsForSenderOrigin(sender, origin);

        const id = message.id;
        const result = await handleRpc(origin, message.request);
        sendResponse({ id, result });
        return;
      }

      // Offscreen notifies us when a tx lifecycle event is observed (best-effort).
      if (message?.type === "DUSK_TX_EXECUTED") {
        const hash = String(message.hash ?? "");
        const ok = message.ok !== false; // default true
        const error = message.error ? String(message.error) : "";

        try {
          const meta = await getTxMeta(hash);
          const origin = meta?.origin ?? "Wallet";
          const nodeUrl = meta?.nodeUrl ?? (await getSettings())?.nodeUrl ?? "";

          await patchTxMeta(hash, {
            status: ok ? "executed" : "failed",
            executedAt: Date.now(),
            lastCheckedAt: Date.now(),
            error: ok ? undefined : error || undefined,
          });

          notifyTxExecuted({ hash, origin, ok, error, nodeUrl }).catch(() => {});
        } catch {
          // Still notify even if metadata lookup fails.
          notifyTxExecuted({ hash, origin: "Wallet", ok, error }).catch(() => {});
        }

        // Also broadcast to any open UI views so they can show a toast.
        emitUiTxStatus({
          hash,
          status: ok ? "executed" : "failed",
          ok,
          error,
        }).catch(() => {});

        sendResponse({ ok: true });
        return;
      }

      if (message?.type === "DUSK_TX_REMOVED") {
        const hash = String(message.hash ?? "");
        const reason = message.reason ? String(message.reason) : "removed";
        const meta = await getTxMeta(hash);
        const now = Date.now();

        await patchTxMeta(hash, {
          status: "removed",
          removedAt: now,
          lastCheckedAt: now,
          reservationStatus: isShieldedTxMeta(meta) ? "recoverable" : meta?.reservationStatus,
          reservationUpdatedAt: isShieldedTxMeta(meta) ? now : meta?.reservationUpdatedAt,
          recoveryReason: reason,
        });

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

        await patchTxMeta(hash, {
          status: "unknown",
          lastCheckedAt: now,
          reservationStatus: isShieldedTxMeta(meta) ? "pending" : meta?.reservationStatus,
          recoveryReason: reason,
        });

        const reconciled = await reconcileTxPresence(hash);
        emitUiTxStatus({
          hash,
          status: reconciled.status || "unknown",
          ok: reconciled.status === "executed" ? true : reconciled.status === "failed" ? false : undefined,
          error: reconciled.error,
        }).catch(() => {});
        sendResponse({ ok: true });
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
        const mnemonic = await unlockVault(password);

        await ensureEngineConfigured();
        const result = await engineCall(
          "engine_unlock",
          { mnemonic },
          { timeoutMs: 120_000 }
        );

        // result is expected to contain accounts, if not, ask status.
        const accounts = Array.isArray(result?.accounts)
          ? result.accounts
          : (await getEngineStatus()).accounts;

        // Reset activity timer and ensure auto-lock alarm is running.
        updateActivity();
        setupAutoLockAlarm().catch(console.error);

        // Notify dApps that profiles are now available.
        broadcastProfilesChangedAll().catch(() => {});

        sendResponse({ ok: true, accounts });
        return;
      }

      // UI wants to lock
      if (message?.type === "DUSK_UI_LOCK") {
        await engineCall("engine_lock");

        // Notify dApps that profiles are no longer available.
        broadcastProfilesChangedAll().catch(() => {});
        sendResponse({ ok: true });
        return;
      }

      // UI selects a different local account (profile index)
      if (message?.type === "DUSK_UI_SET_ACCOUNT_INDEX") {
        const status = await getEngineStatus();
        if (!status.isUnlocked) {
          throw rpcError(ERROR_CODES.UNAUTHORIZED, "Wallet locked");
        }

        const idx = Number(message.index);
        if (!Number.isFinite(idx) || idx < 0) {
          throw rpcError(ERROR_CODES.INVALID_PARAMS, "index must be a non-negative number");
        }

        const settings = await getSettings();
        const maxIndex = Math.max(0, Number(settings?.accountCount ?? 1) - 1);
        const clamped = Math.min(Math.floor(idx), maxIndex);

        await setSettings({ selectedAccountIndex: clamped });
        await ensureEngineConfigured();
        const res = await engineCall("engine_selectAccount", { index: clamped });
        sendResponse({ ok: true, result: res });
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

        const status = await getEngineStatus();
        const account = Array.isArray(status?.accounts) ? status.accounts[clamped] : "";
        await approveOrigin(origin, {
          profileId: `account:${clamped}:${account || ""}`,
          accountIndex: clamped,
          grants: { publicAccount: true, shieldedReceiveAddress: false },
        });
        sendResponse({ ok: true });
        return;
      }

      // UI creates/imports wallet
      if (message?.type === "DUSK_UI_CREATE_WALLET") {
        const { mnemonic, password } = message;
        if (!mnemonic || !password) {
          throw rpcError(
            ERROR_CODES.INVALID_PARAMS,
            "mnemonic and password required"
          );
        }
        await createVault(mnemonic, password);
        // Do not auto-unlock, keep locked until user unlocks.
        sendResponse({ ok: true });
        return;
      }

      // Optional: after creating a brand new wallet, set a shielded checkpoint
      // to "now" so we don't sync from genesis for shielded notes.
      if (message?.type === "DUSK_UI_SET_SHIELDED_CHECKPOINT_NOW") {
        const status = await getEngineStatus();
        if (!status.isUnlocked) {
          throw rpcError(ERROR_CODES.UNAUTHORIZED, "Wallet locked");
        }
        await ensureEngineConfigured();
        const res = await engineCall("dusk_setShieldedCheckpointNow", {
          profileIndex: 0,
        });
        sendResponse({ ok: true, result: res });
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

        // Compute the effective endpoints the engine will use (mirrors the
        // inference logic in shared/settings.js).
        const inferred = inferEndpointsFromNodeUrl(nodeUrl);
        const effectiveProverUrl = proverUrl || inferred.proverUrl;
        const effectiveArchiverUrl = archiverUrl || inferred.archiverUrl;

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
        return;
      }

      // UI sets auto-lock timeout
      if (message?.type === "DUSK_UI_SET_AUTO_LOCK") {
        const timeout = Number(message.autoLockTimeoutMinutes ?? 0);
        await setSettings({ autoLockTimeoutMinutes: timeout });
        await setupAutoLockAlarm();
        sendResponse({ ok: true, autoLockTimeoutMinutes: timeout });
        return;
      }

      // UI sets NFT metadata privacy settings
      if (message?.type === "DUSK_UI_SET_NFT_SETTINGS") {
        const ipfsGateway = String(message.ipfsGateway ?? "");
        // Keep accepting the message shape so older UIs don't break, but force
        // metadata/media fetching to remain disabled until we have a trusted
        // proxy/indexer path.
        const next = await setSettings({ nftMetadataEnabled: false, ipfsGateway });
        sendResponse({
          ok: true,
          nftMetadataEnabled: false,
          ipfsGateway: next.ipfsGateway ?? "",
        });
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

        // Recent activity (transaction list). This is used by the Home +
        // Activity screens to provide MetaMask-like feedback instead of
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

      // UI fetches minimum stake requirement (Lux, u64 string).
      if (message?.type === "DUSK_UI_GET_MINIMUM_STAKE") {
        const status = await getEngineStatus();
        if (!status.isUnlocked) {
          throw rpcError(ERROR_CODES.UNAUTHORIZED, "Wallet locked");
        }
        await ensureEngineConfigured();
        const result = await engineCall("dusk_getMinimumStake");
        sendResponse({ ok: true, result });
        return;
      }

      // UI fetches current stake info for a profile.
      if (message?.type === "DUSK_UI_GET_STAKE_INFO") {
        const status = await getEngineStatus();
        if (!status.isUnlocked) {
          throw rpcError(ERROR_CODES.UNAUTHORIZED, "Wallet locked");
        }
        await ensureEngineConfigured();
        const profileIndex =
          Number.isFinite(Number(message.profileIndex)) && Number(message.profileIndex) >= 0
            ? Math.floor(Number(message.profileIndex))
            : Number(status.selectedAccountIndex ?? 0) || 0;
        const result = await engineCall("dusk_getStakeInfo", { profileIndex });
        sendResponse({ ok: true, result });
        return;
      }

      // UI fetches cached gas price stats for UX (recommended gas buttons).
      if (message?.type === "DUSK_UI_GET_CACHED_GAS_PRICE") {
        await ensureEngineConfigured();
        const result = await engineCall("dusk_getCachedGasPrice");
        sendResponse({ ok: true, result });
        return;
      }

      // --- Assets (DRC20 / DRC721) ----------------------------------------
      if (message?.type === "DUSK_UI_ASSETS_GET") {
        const status = await getEngineStatus();
        if (!status.isUnlocked) {
          throw rpcError(ERROR_CODES.UNAUTHORIZED, "Wallet locked");
        }
        const settings = await getSettings();
        const walletId = String(status?.accounts?.[0] ?? "").trim();
        if (!walletId) throw rpcError(ERROR_CODES.INTERNAL, "Wallet ID unavailable");
        const profileIndex =
          Number.isFinite(Number(message.profileIndex)) && Number(message.profileIndex) >= 0
            ? Math.floor(Number(message.profileIndex))
            : Number(status.selectedAccountIndex ?? 0) || 0;
        const result = await getWatchedAssets(walletId, settings.nodeUrl, profileIndex);
        sendResponse({ ok: true, result });
        return;
      }

      if (message?.type === "DUSK_UI_ASSETS_WATCH_TOKEN") {
        const status = await getEngineStatus();
        if (!status.isUnlocked) {
          throw rpcError(ERROR_CODES.UNAUTHORIZED, "Wallet locked");
        }
        const settings = await getSettings();
        const walletId = String(status?.accounts?.[0] ?? "").trim();
        if (!walletId) throw rpcError(ERROR_CODES.INTERNAL, "Wallet ID unavailable");
        const profileIndex =
          Number.isFinite(Number(message.profileIndex)) && Number(message.profileIndex) >= 0
            ? Math.floor(Number(message.profileIndex))
            : Number(status.selectedAccountIndex ?? 0) || 0;
        const result = await watchToken(walletId, settings.nodeUrl, profileIndex, message?.token);
        sendResponse({ ok: true, result });
        return;
      }

      if (message?.type === "DUSK_UI_ASSETS_UNWATCH_TOKEN") {
        const status = await getEngineStatus();
        if (!status.isUnlocked) {
          throw rpcError(ERROR_CODES.UNAUTHORIZED, "Wallet locked");
        }
        const settings = await getSettings();
        const walletId = String(status?.accounts?.[0] ?? "").trim();
        if (!walletId) throw rpcError(ERROR_CODES.INTERNAL, "Wallet ID unavailable");
        const profileIndex =
          Number.isFinite(Number(message.profileIndex)) && Number(message.profileIndex) >= 0
            ? Math.floor(Number(message.profileIndex))
            : Number(status.selectedAccountIndex ?? 0) || 0;
        const result = await unwatchToken(
          walletId,
          settings.nodeUrl,
          profileIndex,
          message?.contractId
        );
        sendResponse({ ok: true, result });
        return;
      }

      if (message?.type === "DUSK_UI_ASSETS_WATCH_NFT") {
        const status = await getEngineStatus();
        if (!status.isUnlocked) {
          throw rpcError(ERROR_CODES.UNAUTHORIZED, "Wallet locked");
        }
        const settings = await getSettings();
        const walletId = String(status?.accounts?.[0] ?? "").trim();
        if (!walletId) throw rpcError(ERROR_CODES.INTERNAL, "Wallet ID unavailable");
        const profileIndex =
          Number.isFinite(Number(message.profileIndex)) && Number(message.profileIndex) >= 0
            ? Math.floor(Number(message.profileIndex))
            : Number(status.selectedAccountIndex ?? 0) || 0;
        const result = await watchNft(walletId, settings.nodeUrl, profileIndex, message?.nft);
        sendResponse({ ok: true, result });
        return;
      }

      if (message?.type === "DUSK_UI_ASSETS_UNWATCH_NFT") {
        const status = await getEngineStatus();
        if (!status.isUnlocked) {
          throw rpcError(ERROR_CODES.UNAUTHORIZED, "Wallet locked");
        }
        const settings = await getSettings();
        const walletId = String(status?.accounts?.[0] ?? "").trim();
        if (!walletId) throw rpcError(ERROR_CODES.INTERNAL, "Wallet ID unavailable");
        const profileIndex =
          Number.isFinite(Number(message.profileIndex)) && Number(message.profileIndex) >= 0
            ? Math.floor(Number(message.profileIndex))
            : Number(status.selectedAccountIndex ?? 0) || 0;
        const result = await unwatchNft(
          walletId,
          settings.nodeUrl,
          profileIndex,
          message?.contractId,
          message?.tokenId
        );
        sendResponse({ ok: true, result });
        return;
      }

      if (message?.type === "DUSK_UI_DRC20_GET_METADATA") {
        const status = await getEngineStatus();
        if (!status.isUnlocked) {
          throw rpcError(ERROR_CODES.UNAUTHORIZED, "Wallet locked");
        }
        await ensureEngineConfigured();
        const result = await engineCall("dusk_getDrc20Metadata", { contractId: message?.contractId });
        sendResponse({ ok: true, result });
        return;
      }

      if (message?.type === "DUSK_UI_DRC20_GET_BALANCE") {
        const status = await getEngineStatus();
        if (!status.isUnlocked) {
          throw rpcError(ERROR_CODES.UNAUTHORIZED, "Wallet locked");
        }
        await ensureEngineConfigured();
        const profileIndex =
          Number.isFinite(Number(message.profileIndex)) && Number(message.profileIndex) >= 0
            ? Math.floor(Number(message.profileIndex))
            : Number(status.selectedAccountIndex ?? 0) || 0;
        const result = await engineCall("dusk_getDrc20Balance", {
          contractId: message?.contractId,
          profileIndex,
        });
        sendResponse({ ok: true, result: String(result ?? "0") });
        return;
      }

      if (message?.type === "DUSK_UI_DRC20_ENCODE_INPUT") {
        const status = await getEngineStatus();
        if (!status.isUnlocked) {
          throw rpcError(ERROR_CODES.UNAUTHORIZED, "Wallet locked");
        }
        await ensureEngineConfigured();
        const result = await engineCall("dusk_encodeDrc20Input", {
          fnName: message?.fnName,
          args: message?.args,
        });
        sendResponse({ ok: true, result });
        return;
      }

      if (message?.type === "DUSK_UI_DRC20_DECODE_INPUT") {
        const status = await getEngineStatus();
        if (!status.isUnlocked) {
          throw rpcError(ERROR_CODES.UNAUTHORIZED, "Wallet locked");
        }
        await ensureEngineConfigured();
        const result = await engineCall("dusk_decodeDrc20Input", {
          fnName: message?.fnName,
          fnArgs: message?.fnArgs,
        });
        sendResponse({ ok: true, result });
        return;
      }

      if (message?.type === "DUSK_UI_DRC721_GET_METADATA") {
        const status = await getEngineStatus();
        if (!status.isUnlocked) {
          throw rpcError(ERROR_CODES.UNAUTHORIZED, "Wallet locked");
        }
        await ensureEngineConfigured();
        const result = await engineCall("dusk_getDrc721Metadata", { contractId: message?.contractId });
        sendResponse({ ok: true, result });
        return;
      }

      if (message?.type === "DUSK_UI_DRC721_OWNER_OF") {
        const status = await getEngineStatus();
        if (!status.isUnlocked) {
          throw rpcError(ERROR_CODES.UNAUTHORIZED, "Wallet locked");
        }
        await ensureEngineConfigured();
        const result = await engineCall("dusk_getDrc721OwnerOf", {
          contractId: message?.contractId,
          tokenId: message?.tokenId,
        });
        sendResponse({ ok: true, result });
        return;
      }

      if (message?.type === "DUSK_UI_DRC721_TOKEN_URI") {
        const status = await getEngineStatus();
        if (!status.isUnlocked) {
          throw rpcError(ERROR_CODES.UNAUTHORIZED, "Wallet locked");
        }
        await ensureEngineConfigured();
        const result = await engineCall("dusk_getDrc721TokenUri", {
          contractId: message?.contractId,
          tokenId: message?.tokenId,
        });
        sendResponse({ ok: true, result: String(result ?? "") });
        return;
      }

      if (message?.type === "DUSK_UI_DRC721_DECODE_INPUT") {
        const status = await getEngineStatus();
        if (!status.isUnlocked) {
          throw rpcError(ERROR_CODES.UNAUTHORIZED, "Wallet locked");
        }
        await ensureEngineConfigured();
        const result = await engineCall("dusk_decodeDrc721Input", {
          fnName: message?.fnName,
          fnArgs: message?.fnArgs,
        });
        sendResponse({ ok: true, result });
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
                status?.selectedAccountIndex !== undefined && status?.selectedAccountIndex !== null
                  ? Number(status.selectedAccountIndex) || 0
                  : Number(settings?.selectedAccountIndex ?? 0) || 0,
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
        sendResponse({ ok: true, result });
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
