import {
  configure,
  getAccounts,
  getAddresses,
  getCachedGasPrice,
  getGasPrice,
  getSelectedAccountIndex,
  getPublicBalance,
  encodeDrc20Input,
  decodeDrc20Input,
  encodeDrc721Input,
  decodeDrc721Input,
  getDrc20Metadata,
  getDrc20Balance,
  getDrc721Metadata,
  getDrc721OwnerOf,
  getDrc721TokenUri,
  getMinimumStake,
  getStakeInfo,
  getShieldedBalance,
  getShieldedStatus,
  isUnlocked,
  lock,
  sendTransaction,
  selectAccountIndex,
  signAuth,
  signMessage,
  setShieldedCheckpointNow,
  startShieldedSync,
  waitTxExecuted,
  unlockWithMnemonic,
  preloadProtocolDriver,
  setEngineDebugHook,
} from "../shared/walletEngine.js";

import { ERROR_CODES } from "../shared/errors.js";
import { getExtensionApi, runtimeSendMessage } from "../platform/extensionApi.js";

function serializeError(err) {
  return {
    code: err?.code ?? ERROR_CODES.INTERNAL,
    message: err?.message ?? String(err),
    data: err?.data,
  };
}

// ---------------------------------------------------------------------------
// Tx tracking (MetaMask-style)
// ---------------------------------------------------------------------------

const activeTxWatches = new Set();
const ext = getExtensionApi();
let enginePreloadError = null;
let enginePreloadDone = false;

function engineDebugEnabled() {
  try {
    return (
      globalThis.__DUSK_ENGINE_DEBUG__ === true ||
      globalThis.localStorage?.getItem?.("dusk_engine_debug") === "1"
    );
  } catch {
    return false;
  }
}

setEngineDebugHook((payload) => {
  if (!engineDebugEnabled()) return;
  try {
    runtimeSendMessage(
      {
        type: "DUSK_ENGINE_PROGRESS",
        payload,
      },
      { allowLastError: true }
    ).catch(() => {});
  } catch {
    // ignore
  }
});

function inferTxOk(executedEvent) {
  // The exact shape depends on w3sper/node versions.
  // Common patterns:
  // - { err: ... }
  // - { error: ... }
  // - { success: false }
  try {
    if (!executedEvent || typeof executedEvent !== "object") return true;
    if (executedEvent.success === false) return false;
    if (executedEvent.err) return false;
    if (executedEvent.error) return false;
    if (executedEvent.result?.err) return false;
    if (executedEvent.result?.error) return false;
    return true;
  } catch {
    return true;
  }
}

function inferTxError(executedEvent) {
  try {
    if (!executedEvent || typeof executedEvent !== "object") return "";
    const err =
      executedEvent.err ??
      executedEvent.error ??
      executedEvent.result?.err ??
      executedEvent.result?.error;
    if (!err) return "";
    if (typeof err === "string") return err;
    if (typeof err?.message === "string") return err.message;
    return JSON.stringify(err);
  } catch {
    return "";
  }
}

async function watchTxExecuted(hash) {
  if (!hash || typeof hash !== "string") return;
  if (activeTxWatches.has(hash)) return;
  activeTxWatches.add(hash);

  try {
    const executedEvent = await waitTxExecuted(hash, { timeoutMs: 180_000 });
    const ok = inferTxOk(executedEvent);
    const error = ok ? "" : inferTxError(executedEvent);

    try {
      await runtimeSendMessage({
        type: "DUSK_TX_EXECUTED",
        hash,
        ok,
        error,
      });
    } catch {
      // ignore
    }

    // After a tx is processed, reconcile shielded state so pending phoenix
    // nullifiers get cleared/marked spent and balances update quickly.
    startShieldedSync({ force: false }).catch(() => {});
  } catch (e) {
    // A watcher timeout/error is not a transaction failure. The tx may still
    // be in the mempool, and Phoenix nullifiers must remain reserved until
    // execution/sync proves the spend or a deliberate pending-clear path exists.
    void e;
  } finally {
    activeTxWatches.delete(hash);
  }
}

ext?.runtime?.onMessage?.addListener((message, _sender, sendResponse) => {
  if (!message) return;

  if (message.type === "DUSK_ENGINE_PING") {
    sendResponse({
      ok: true,
      ready: enginePreloadDone && !enginePreloadError,
      error: enginePreloadError?.message ?? "",
    });
    return true;
  }

  if (message.type !== "DUSK_ENGINE_CALL") return;

  (async () => {
    try {
      const { id, method, params } = message;

      switch (method) {
        case "engine_config":
          configure(params ?? {});
          sendResponse({ id, result: true });
          return;

        case "engine_status":
          sendResponse({
            id,
            result: {
              isUnlocked: isUnlocked(),
              accounts: isUnlocked() ? getAccounts() : [],
              addresses: isUnlocked() ? getAddresses() : [],
              selectedAccountIndex: isUnlocked() ? getSelectedAccountIndex() : 0,
            },
          });
          return;

        case "engine_unlock": {
          const mnemonic = params?.mnemonic;
          if (!mnemonic || typeof mnemonic !== "string") {
            throw Object.assign(new Error("mnemonic is required"), {
              code: ERROR_CODES.INVALID_PARAMS,
            });
          }
          await unlockWithMnemonic(mnemonic);
          sendResponse({ id, result: { accounts: getAccounts() } });

          // Fire-and-forget: start shielded sync in the background.
          startShieldedSync().catch(() => {});
          return;
        }

        case "engine_lock":
          lock();
          sendResponse({ id, result: true });
          return;

        case "engine_selectAccount": {
          const res = await selectAccountIndex(params ?? {});
          sendResponse({ id, result: res });
          return;
        }

        case "dusk_getAddresses":
          sendResponse({ id, result: isUnlocked() ? getAddresses() : [] });
          return;

        case "dusk_getPublicBalance": {
          const bal = await getPublicBalance(params ?? {});
          sendResponse({
            id,
            result: { nonce: bal.nonce.toString(), value: bal.value.toString() },
          });
          return;
        }

        case "dusk_getMinimumStake": {
          const min = await getMinimumStake();
          sendResponse({ id, result: String(min) });
          return;
        }

        case "dusk_getStakeInfo": {
          const info = await getStakeInfo(params ?? {});
          // Serialize bigints for structured clone stability.
          sendResponse({
            id,
            result: {
              amount: info?.amount
                ? {
                    value: info.amount.value?.toString?.() ?? String(info.amount.value),
                    locked: info.amount.locked?.toString?.() ?? String(info.amount.locked),
                    eligibility: info.amount.eligibility?.toString?.() ?? String(info.amount.eligibility),
                    total: info.amount.total?.toString?.() ?? String(info.amount.total),
                  }
                : null,
              reward: info?.reward?.toString?.() ?? String(info?.reward ?? 0),
              faults: Number(info?.faults ?? 0) || 0,
              hardFaults: Number(info?.hardFaults ?? 0) || 0,
            },
          });
          return;
        }

        case "dusk_encodeDrc20Input": {
          const out = await encodeDrc20Input(params ?? {});
          sendResponse({ id, result: out });
          return;
        }

        case "dusk_decodeDrc20Input": {
          const out = await decodeDrc20Input(params ?? {});
          sendResponse({ id, result: out });
          return;
        }

        case "dusk_encodeDrc721Input": {
          const out = await encodeDrc721Input(params ?? {});
          sendResponse({ id, result: out });
          return;
        }

        case "dusk_decodeDrc721Input": {
          const out = await decodeDrc721Input(params ?? {});
          sendResponse({ id, result: out });
          return;
        }

        case "dusk_getDrc20Metadata": {
          const out = await getDrc20Metadata(params ?? {});
          sendResponse({ id, result: out });
          return;
        }

        case "dusk_getDrc20Balance": {
          const out = await getDrc20Balance(params ?? {});
          sendResponse({ id, result: String(out) });
          return;
        }

        case "dusk_getDrc721Metadata": {
          const out = await getDrc721Metadata(params ?? {});
          sendResponse({ id, result: out });
          return;
        }

        case "dusk_getDrc721OwnerOf": {
          const out = await getDrc721OwnerOf(params ?? {});
          sendResponse({ id, result: out });
          return;
        }

        case "dusk_getDrc721TokenUri": {
          const out = await getDrc721TokenUri(params ?? {});
          sendResponse({ id, result: String(out) });
          return;
        }

        case "dusk_estimateGas": {
          const result = await getGasPrice(params ?? {});
          sendResponse({ id, result });
          return;
        }

        case "dusk_getCachedGasPrice": {
          const result = await getCachedGasPrice(params ?? {});
          sendResponse({ id, result });
          return;
        }

        case "dusk_getShieldedStatus": {
          sendResponse({ id, result: getShieldedStatus() });
          return;
        }

        case "dusk_syncShielded": {
          const res = await startShieldedSync(params ?? {});
          sendResponse({ id, result: res });
          return;
        }

        case "dusk_setShieldedCheckpointNow": {
          const res = await setShieldedCheckpointNow(params ?? {});
          sendResponse({ id, result: res });
          return;
        }

        case "dusk_getShieldedBalance": {
          const bal = await getShieldedBalance();
          // The address-balance shape is { value, spendable }.
          const value = bal?.value ?? 0n;
          const spendable = bal?.spendable ?? value;
          sendResponse({
            id,
            result: {
              value: value.toString(),
              spendable: spendable.toString(),
            },
          });
          return;
        }

        case "dusk_sendTransaction": {
          const result = await sendTransaction(params ?? {});

          // Keep the provider response simple, always return the tx hash,
          // and only include a nonce when it exists (public tx).
          const resp = { hash: result.hash };
          if (result.nonce !== undefined && result.nonce !== null) {
            resp.nonce = result.nonce?.toString?.() ?? String(result.nonce);
          }
          sendResponse({
            id,
            result: resp,
          });

          // Fire-and-forget: wait for EXECUTED and notify background so it can
          // show a final notification + explorer link.
          watchTxExecuted(result?.hash).catch(() => {});
          return;
        }

        case "dusk_signMessage": {
          const result = await signMessage(params ?? {});
          sendResponse({ id, result });
          return;
        }

        case "dusk_signAuth": {
          const result = await signAuth(params ?? {});
          sendResponse({ id, result });
          return;
        }

        default:
          throw Object.assign(new Error(`Unknown engine method: ${method}`), {
            code: ERROR_CODES.METHOD_NOT_FOUND,
          });
      }
    } catch (err) {
      sendResponse({ id: message?.id, error: serializeError(err) });
    }
  })();

  return true;
});

// Notify background that the engine page is ready to accept calls.
(async () => {
  try {
    await preloadProtocolDriver();
  } catch (err) {
    enginePreloadError = err;
  } finally {
    enginePreloadDone = true;
  }

  runtimeSendMessage(
    {
      type: "DUSK_ENGINE_READY",
      ok: !enginePreloadError,
      error: enginePreloadError?.message ?? "",
    },
    { allowLastError: true }
  ).catch(() => {});
})();
