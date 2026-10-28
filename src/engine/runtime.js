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
  getSozuStatus,
  getMinimumStake,
  getStakeInfo,
  getStakeOwnerStatus,
  getShieldedBalance,
  getShieldedHistory,
  getShieldedStatus,
  isUnlocked,
  lock,
  openContactsRecords,
  sealContactsRecord,
  sendTransaction,
  selectAccountIndex,
  signAuth,
  signMessage,
  signTypedData,
  setShieldedCheckpointNow,
  startShieldedSync,
  waitTxExecuted,
  waitTxRemoved,
  unlockWithMnemonic,
  walletIdOf,
  preloadProtocolDriver,
  setEngineDebugHook,
} from "../shared/walletEngine.js";

import { ERROR_CODES } from "../shared/errors.js";
import { serializeError, serializeStakeInfo } from "../shared/transport.js";
import { bytesToTransportHex, normalizeNullifiers } from "../shared/bytes.js";
import { keepPrimaryNamesWith, lookupPrimaryName, lookupRecipientName } from "../shared/duskNames.js";
import {
  executionEventError,
  executionEventOk,
  waitForTxExecution,
} from "../shared/txExecution.js";
import { getExtensionApi, runtimeSendMessage } from "../platform/extensionApi.js";

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

// `epoch`: the wallet's transaction-store reset count when the send began,
// passed back with each event so the background keeps nothing of it after a
// reset (txStore.js).
async function watchTxExecuted(hash, epoch) {
  if (!hash || typeof hash !== "string") return;
  if (activeTxWatches.has(hash)) return;
  activeTxWatches.add(hash);

  try {
    const timeoutMs = 180_000;
    const removedWatcher = waitTxRemoved(hash, { timeoutMs })
      .catch((e) => {
        if (/removed watcher not available/i.test(String(e?.message ?? e))) {
          return new Promise(() => {});
        }
        throw e;
      });
    const event = await waitForTxExecution(
      waitTxExecuted(hash, { timeoutMs }),
      removedWatcher,
      async (removedEvent) => {
        try {
          await runtimeSendMessage({
            type: "DUSK_TX_REMOVED",
            epoch,
            hash,
            reason: executionEventError(removedEvent) || "removed",
          });
        } catch {
          // ignore
        }
      }
    );

    const ok = executionEventOk(event);
    const error = ok ? "" : executionEventError(event);

    try {
      await runtimeSendMessage({
        type: "DUSK_TX_EXECUTED",
        epoch,
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
    try {
      await runtimeSendMessage({
        type: "DUSK_TX_UNKNOWN",
        epoch,
        hash,
        reason: /timed out/i.test(String(e?.message ?? e))
          ? "watcher_timeout"
          : "watcher_unavailable",
      });
    } catch {
      // ignore
    }
  } finally {
    activeTxWatches.delete(hash);
  }
}

// Chrome's offscreen document has no storage, so the background keeps the
// engine's .dusk name checks, from Firefox's engine page too.
keepPrimaryNamesWith((nodeUrl, account, name) =>
  runtimeSendMessage({ type: "DUSK_NAME_CHECKED", nodeUrl, account, name }).catch(() => {})
);

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

        // The wallet a restore's phrase makes, before anything is replaced.
        case "engine_walletId":
          sendResponse({ id, result: await walletIdOf(params?.mnemonic) });
          return;

        case "engine_selectAccount": {
          const res = await selectAccountIndex(params ?? {});
          sendResponse({ id, result: res });
          return;
        }

        case "engine_checkNames": {
          // Checks the .dusk names of the wallet's own accounts again for
          // sites; each answer goes to the background (DUSK_NAME_CHECKED).
          const own = isUnlocked() ? getAccounts() : [];
          const accounts = Array.isArray(params?.accounts) ? params.accounts : [];
          await Promise.all(
            accounts
              .filter((account) => own.includes(account))
              .map((account) => lookupPrimaryName(account, { nodeUrl: params?.nodeUrl }))
          );
          sendResponse({ id, result: true });
          return;
        }

        // The contacts' key stays here: the background, which keeps the
        // records, asks for them opened and sealed (contactsStore.js).
        case "engine_contactsOpen":
          sendResponse({ id, result: await openContactsRecords(params?.records) });
          return;

        case "engine_contactsSeal":
          sendResponse({ id, result: await sealContactsRecord(params?.text) });
          return;

        case "engine_recipientName": {
          // The .dusk name of the recipient of a site's request to send, for
          // its approval. It isn't kept: the names kept are the wallet's own.
          const name = await lookupRecipientName(params?.recipient, { nodeUrl: params?.nodeUrl });
          sendResponse({ id, result: name });
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
          // Serialize bigints for structured clone stability.
          sendResponse({ id, result: serializeStakeInfo(await getStakeInfo(params ?? {})) });
          return;
        }

        case "dusk_getStakeOwnerStatus": {
          const result = await getStakeOwnerStatus(params ?? {});
          sendResponse({ id, result });
          return;
        }

        case "dusk_encodeDrc20Input": {
          const out = await encodeDrc20Input(params ?? {});
          sendResponse({ id, result: bytesToTransportHex(out) });
          return;
        }

        case "dusk_decodeDrc20Input": {
          const out = await decodeDrc20Input(params ?? {});
          sendResponse({ id, result: out });
          return;
        }

        case "dusk_encodeDrc721Input": {
          const out = await encodeDrc721Input(params ?? {});
          sendResponse({ id, result: bytesToTransportHex(out) });
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

        case "dusk_getSozuStatus": {
          const out = await getSozuStatus(params ?? {});
          sendResponse({ id, result: out });
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

        case "dusk_getShieldedHistory": {
          sendResponse({ id, result: await getShieldedHistory() });
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
          const { txEpoch, ...sendParams } = params ?? {};
          const result = await sendTransaction(sendParams);

          // Keep the provider response simple, always return the tx hash,
          // and only include a nonce when it exists (public tx).
          const resp = { hash: result.hash };
          const pendingNullifiers = normalizeNullifiers(result?.nullifiers);
          if (pendingNullifiers.length) resp.nullifiers = pendingNullifiers;
          if (result.nonce !== undefined && result.nonce !== null) {
            resp.nonce = result.nonce?.toString?.() ?? String(result.nonce);
          }
          sendResponse({
            id,
            result: resp,
          });

          // Fire-and-forget: wait for EXECUTED and notify background so it can
          // show a final notification + explorer link.
          watchTxExecuted(result?.hash, Number.isInteger(txEpoch) ? txEpoch : undefined).catch(() => {});
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

        case "dusk_signTypedData": {
          const result = await signTypedData(params ?? {});
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
