// Background service worker entry.

import { createVault, loadVault, unlockVault } from "../shared/vault.js";
import { getPermissionForOrigin } from "../shared/permissions.js";
import { getSettings, setSettings } from "../shared/settings.js";
import { ERROR_CODES, rpcError } from "../shared/errors.js";
import { TX_KIND } from "../shared/constants.js";
import { applyTxDefaults } from "../shared/txDefaults.js";
import { detectPresetIdFromNodeUrl, networkNameFromNodeUrl } from "../shared/network.js";
import { NETWORK_PRESETS } from "../shared/networkPresets.js";

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
  broadcastAccountsChangedAll,
  broadcastChainChangedAll,
  bindPortsForSenderOrigin,
  registerDappPort,
  registerStorageChangeForwarder,
} from "./dappEvents.js";

import {
  notifyTxSubmitted,
  notifyTxExecuted,
  registerTxNotificationHandlers,
} from "./txNotify.js";
import { getTxMeta, patchTxMeta, putTxMeta, listTxs } from "../shared/txStore.js";
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
      broadcastAccountsChangedAll().catch(() => {});
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

// Dapp provider ports (push events: accountsChanged, chainChanged, ...).
ext?.runtime?.onConnect?.addListener((port) => {
  if (port?.name === "DUSK_DAPP_PORT") {
    registerDappPort(port);
  }
});

// Keep provider state in sync even if storage is mutated from extension pages.
registerStorageChangeForwarder();

function getOriginFromSender(sender) {
  // sender.url for content scripts contains full URL of the page
  try {
    if (sender?.url) return new URL(sender.url).origin;
  } catch {
    // ignore
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
        const origin = message.origin || getOriginFromSender(sender);

        // User-initiated dApp interaction counts as activity.
        updateActivity();

        // Ensure any dApp port(s) opened from this tab are bound to the same
        // origin so provider push events (connect/chainChanged/...) work
        // reliably.
        bindPortsForSenderOrigin(sender, origin);

        const id = message.id;
        const result = await handleRpc(origin, message.request);
        sendResponse({ id, result });
        return;
      }

      // Offscreen notifies us when a tx gets executed (best-effort).
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
            error: ok ? undefined : error || undefined,
          });

          notifyTxExecuted({ hash, origin, ok, error, nodeUrl }).catch(() => {});
        } catch {
          // Still notify even if metadata lookup fails.
          notifyTxExecuted({ hash, origin: "Wallet", ok, error }).catch(() => {});
        }

        // Also broadcast to any open UI views so they can show a toast.
        try {
          runtimeSendMessage({
            type: "DUSK_UI_TX_STATUS",
            hash,
            ok,
            error,
          }).catch(() => {});
        } catch {
          // ignore
        }

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
        const status = await getEngineStatus();
        sendResponse({
          rid: message.rid,
          kind: entry.kind,
          origin: entry.origin,
          params: entry.params,
          hasVault: Boolean(vault),
          isUnlocked: status.isUnlocked,
          accounts: status.accounts,
        });
        return;
      }

      // UI wants to unlock
      if (message?.type === "DUSK_UI_UNLOCK") {
        const password = message.password;
        const mnemonic = await unlockVault(password);

        await ensureEngineConfigured();
        const result = await engineCall("engine_unlock", { mnemonic }, { timeoutMs: 15000 });

        // result is expected to contain accounts, if not, ask status.
        const accounts = Array.isArray(result?.accounts)
          ? result.accounts
          : (await getEngineStatus()).accounts;

        // Reset activity timer and ensure auto-lock alarm is running.
        updateActivity();
        setupAutoLockAlarm().catch(console.error);

        // Notify dApps that accounts are now available.
        broadcastAccountsChangedAll().catch(() => {});

        sendResponse({ ok: true, accounts });
        return;
      }

      // UI wants to lock
      if (message?.type === "DUSK_UI_LOCK") {
        await engineCall("engine_lock");

        // Notify dApps that accounts are no longer available.
        broadcastAccountsChangedAll().catch(() => {});
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

        // Recent activity (transaction list). This is used by the Home +
        // Activity screens to provide MetaMask-like feedback instead of
        // ephemeral toasts.
        let txs = [];
        try {
          txs = await listTxs({ nodeUrl: settings.nodeUrl });
        } catch {
          txs = [];
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
          try {
            await ensureEngineConfigured();
            addresses = (await engineCall("dusk_getAddresses")) ?? [];
          } catch {
            // ignore
          }

          try {
            await ensureEngineConfigured();
            balance = await engineCall("dusk_getPublicBalance");
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
          nodeUrl: settings.nodeUrl,
          proverUrl: settings.proverUrl,
          archiverUrl: settings.archiverUrl,
          autoLockTimeoutMinutes: settings.autoLockTimeoutMinutes ?? 5,
          networkName: networkNameFromNodeUrl(settings.nodeUrl),
          networkStatus,
          activeOrigin,
          activeConnected,
          txs,
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
            await putTxMeta(hash, {
              origin: "Wallet",
              nodeUrl,
              kind,
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
