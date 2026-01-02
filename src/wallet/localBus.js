// Local (in-process) message handler implementing a subset of the extension
// background message API.
//
// This lets the same UI (popup/full) run without chrome.runtime messaging,
// which is how we reuse it in Tauri desktop/mobile.

import { createVault, loadVault, unlockVault } from "../shared/vault.js";
import { getSettings, setSettings } from "../shared/settings.js";
import { applyTxDefaults } from "../shared/txDefaults.js";
import { networkNameFromNodeUrl } from "../shared/network.js";
import { ERROR_CODES, rpcError } from "../shared/errors.js";
import {
  configure,
  getAccounts,
  getAddresses,
  getPublicBalance,
  getShieldedBalance,
  getShieldedStatus,
  isUnlocked,
  lock,
  sendTransaction,
  setShieldedCheckpointNow,
  startShieldedSync,
  unlockWithMnemonic,
} from "../shared/walletEngine.js";

// Prevent users from accidentally triggering expensive vault / stronghold
// operations multiple times (e.g. double-clicking "Create wallet" while
// Argon2 + snapshot encryption is running).
let unlockInFlight = null;
let createWalletInFlight = null;

function serializeError(err) {
  return {
    code: err?.code ?? ERROR_CODES.INTERNAL,
    message: err?.message ?? String(err),
    data: err?.data,
  };
}

async function ensureEngineConfigured() {
  const settings = await getSettings();
  configure({
    nodeUrl: settings.nodeUrl,
    proverUrl: settings.proverUrl,
    archiverUrl: settings.archiverUrl,
  });
  return settings;
}

function engineStatus() {
  return {
    isUnlocked: isUnlocked(),
    accounts: isUnlocked() ? getAccounts() : [],
  };
}

/**
 * @param {any} message
 */
export async function localSend(message) {
  try {
    // UI wants to unlock
    if (message?.type === "DUSK_UI_UNLOCK") {
      // Fast path: if the engine is already unlocked, do not re-load the vault.
      // This helps onboarding flows where we may have just created/imported a
      // wallet and already unlocked it locally.
      if (isUnlocked()) {
        return { ok: true, accounts: getAccounts() };
      }

      // Coalesce multiple unlock clicks into one expensive vault decrypt.
      if (unlockInFlight) {
        return await unlockInFlight;
      }

      unlockInFlight = (async () => {
        const password = message.password;
        const mnemonic = await unlockVault(password);
        await ensureEngineConfigured();
        // Unlock uses the decrypted mnemonic.
        await unlockWithMnemonic(mnemonic);
        return { ok: true, accounts: getAccounts() };
      })();

      try {
        return await unlockInFlight;
      } finally {
        unlockInFlight = null;
      }
    }

    // UI wants to lock
    if (message?.type === "DUSK_UI_LOCK") {
      lock();
      return { ok: true };
    }

    // UI creates/imports wallet
    if (message?.type === "DUSK_UI_CREATE_WALLET") {
      // Coalesce multiple create/import clicks into one Stronghold write.
      if (createWalletInFlight) {
        return await createWalletInFlight;
      }

      createWalletInFlight = (async () => {
        const { mnemonic, password } = message;
        if (!mnemonic || !password) {
          throw rpcError(ERROR_CODES.INVALID_PARAMS, "mnemonic and password required");
        }
        await createVault(mnemonic, password);
        // UX improvement for local runtimes (Tauri/mobile/desktop): immediately
        // unlock the engine with the provided mnemonic. This avoids an extra
        // round-trip to Stronghold and makes onboarding feel instant.
        await ensureEngineConfigured();
        await unlockWithMnemonic(String(mnemonic));
        return { ok: true, accounts: getAccounts() };
      })();

      try {
        return await createWalletInFlight;
      } finally {
        createWalletInFlight = null;
      }
    }

    // Optional: set a shielded checkpoint to "now" after creating a fresh wallet.
    if (message?.type === "DUSK_UI_SET_SHIELDED_CHECKPOINT_NOW") {
      const status = engineStatus();
      if (!status.isUnlocked) {
        throw rpcError(ERROR_CODES.UNAUTHORIZED, "Wallet locked");
      }
      await ensureEngineConfigured();
      const res = await setShieldedCheckpointNow({ profileIndex: 0 });
      return { ok: true, result: { bookmark: res.bookmark, block: res.block } };
    }

    // UI checks status
    if (message?.type === "DUSK_UI_STATUS") {
      const vault = await loadVault();
      const status = engineStatus();
      return {
        hasVault: Boolean(vault),
        isUnlocked: status.isUnlocked,
        accounts: status.accounts,
      };
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
      try {
        // eslint-disable-next-line no-new
        new URL(nodeUrl);
      } catch {
        throw rpcError(ERROR_CODES.INVALID_PARAMS, "Invalid node URL");
      }

      if (proverUrl) {
        try {
          // eslint-disable-next-line no-new
          new URL(proverUrl);
        } catch {
          throw rpcError(ERROR_CODES.INVALID_PARAMS, "Invalid prover URL");
        }
      }
      if (archiverUrl) {
        try {
          // eslint-disable-next-line no-new
          new URL(archiverUrl);
        } catch {
          throw rpcError(ERROR_CODES.INVALID_PARAMS, "Invalid archiver URL");
        }
      }

      const nextSettings = await setSettings({
        nodeUrl,
        ...(proverUrl ? { proverUrl } : {}),
        ...(archiverUrl ? { archiverUrl } : {}),
      });
      // Apply immediately.
      configure({
        nodeUrl: nextSettings.nodeUrl,
        proverUrl: nextSettings.proverUrl,
        archiverUrl: nextSettings.archiverUrl,
      });

      return {
        ok: true,
        nodeUrl: nextSettings.nodeUrl,
        proverUrl: nextSettings.proverUrl,
        archiverUrl: nextSettings.archiverUrl,
        networkName: networkNameFromNodeUrl(nextSettings.nodeUrl),
      };
    }

    // UI asks for overview data (network + addresses + balance)
    if (message?.type === "DUSK_UI_OVERVIEW") {
      const vault = await loadVault();
      const settings = await ensureEngineConfigured();
      const status = engineStatus();

      const activeOrigin = null;
      const activeConnected = null;

      let addresses = [];
      let balance = null;
      let balanceError = null;

      let shieldedBalance = null;
      let shieldedSync = null;
      let shieldedError = null;

      if (status.isUnlocked) {
        try {
          addresses = getAddresses() ?? [];
        } catch {
          // ignore
        }

        try {
          const bal = await getPublicBalance();
          balance = { nonce: bal.nonce.toString(), value: bal.value.toString() };
        } catch (e) {
          balanceError = e?.message ?? String(e);
        }

        try {
          // Kick off incremental sync (non-blocking)
          await startShieldedSync({ force: false });
        } catch {
          // ignore
        }

        try {
          shieldedSync = getShieldedStatus();
        } catch {
          shieldedSync = null;
        }

        try {
          const sb = await getShieldedBalance();
          shieldedBalance = {
            value: sb.value?.toString?.() ?? String(sb.value),
            spendable: sb.spendable?.toString?.() ?? String(sb.spendable),
          };
        } catch (e) {
          shieldedError = e?.message ?? String(e);
        }
      }

      return {
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
        networkName: networkNameFromNodeUrl(settings.nodeUrl),
        activeOrigin,
        activeConnected,
      };
    }

    // UI initiated transaction (from the wallet popup)
    if (message?.type === "DUSK_UI_SEND_TX") {
      const status = engineStatus();
      if (!status.isUnlocked) {
        throw rpcError(ERROR_CODES.UNAUTHORIZED, "Wallet locked");
      }

      await ensureEngineConfigured();
      const baseParams = applyTxDefaults(message.params ?? {});
      const result = await sendTransaction(baseParams);
      return {
        ok: true,
        result: {
          hash: result.hash,
          nonce: result.nonce?.toString?.() ?? String(result.nonce),
        },
      };
    }

    return { ok: false, error: "Unknown message" };
  } catch (err) {
    return { error: serializeError(err) };
  }
}
