// Background service worker entry.

import { createVault, loadVault, unlockVault } from "../shared/vault.js";
import { getPermissionForOrigin } from "../shared/permissions.js";
import { getSettings, setSettings } from "../shared/settings.js";
import { ERROR_CODES, rpcError } from "../shared/errors.js";
import { applyTxDefaults } from "../shared/txDefaults.js";
import { networkNameFromNodeUrl } from "../shared/network.js";

import {
  engineCall,
  ensureEngineConfigured,
  getEngineStatus,
  invalidateEngineConfig,
} from "./offscreen.js";
import { handleRpc } from "./rpc.js";
import { getPending, resolvePendingDecision } from "./pending.js";
import {
  broadcastAccountsChangedAll,
  broadcastChainChangedAll,
  bindPortsForSenderOrigin,
  registerDappPort,
  registerStorageChangeForwarder,
} from "./dappEvents.js";

import { notifyTxSubmitted, registerTxNotificationHandlers } from "./txNotify.js";

registerTxNotificationHandlers();

// Open the full wallet view on first install (MetaMask-style onboarding).
chrome.runtime.onInstalled.addListener((details) => {
  if (details?.reason !== "install") return;
  try {
    const url = chrome.runtime.getURL("full.html");
    chrome.tabs.create({ url });
  } catch {
    // ignore
  }
});

// Dapp provider ports (push events: accountsChanged, chainChanged, ...).
chrome.runtime.onConnect.addListener((port) => {
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
// Message bus
// ------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Engine calls are handled by offscreen.js. Do not respond here.
  if (message?.type === "DUSK_ENGINE_CALL") {
    return false;
  }

  (async () => {
    try {
      // RPC messages from contentScript
      if (message?.type === "DUSK_RPC_REQUEST") {
        const origin = message.origin || getOriginFromSender(sender);

        // Ensure any dApp port(s) opened from this tab are bound to the same
        // origin so provider push events (connect/chainChanged/...) work
        // reliably.
        bindPortsForSenderOrigin(sender, origin);

        const id = message.id;
        const result = await handleRpc(origin, message.request);
        sendResponse({ id, result });
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
        const result = await engineCall("engine_unlock", { mnemonic });

        // result is expected to contain accounts, if not, ask status.
        const accounts = Array.isArray(result?.accounts)
          ? result.accounts
          : (await getEngineStatus()).accounts;

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
        try {
          // eslint-disable-next-line no-new
          new URL(nodeUrl);
        } catch {
          throw rpcError(ERROR_CODES.INVALID_PARAMS, "Invalid node URL");
        }

        await setSettings({ nodeUrl });

        // Force the engine to pick up the new config immediately.
        invalidateEngineConfig();
        await ensureEngineConfigured();

        // Notify dApps that the chain has changed.
        broadcastChainChangedAll().catch(() => {});

        sendResponse({
          ok: true,
          nodeUrl,
          networkName: networkNameFromNodeUrl(nodeUrl),
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
        }

        sendResponse({
          hasVault: Boolean(vault),
          isUnlocked: status.isUnlocked,
          accounts: status.accounts,
          addresses,
          balance,
          balanceError,
          nodeUrl: settings.nodeUrl,
          networkName: networkNameFromNodeUrl(settings.nodeUrl),
          activeOrigin,
          activeConnected,
        });
        return;
      }

      // UI initiated transaction (from the wallet popup)
      if (message?.type === "DUSK_UI_SEND_TX") {
        const status = await getEngineStatus();
        if (!status.isUnlocked) {
          throw rpcError(ERROR_CODES.UNAUTHORIZED, "Wallet locked");
        }
        await ensureEngineConfigured();
        // Apply standard gas defaults for wallet initiated transactions.
        const baseParams = applyTxDefaults(message.params ?? {});
        const result = await engineCall("dusk_sendTransaction", baseParams);
        try {
          await notifyTxSubmitted({ hash: result?.hash ?? "", origin: "Wallet" });
        } catch {
          // ignore
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
