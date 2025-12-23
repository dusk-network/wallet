import {
  configure,
  getAccounts,
  getAddresses,
  getPublicBalance,
  isUnlocked,
  lock,
  sendTransaction,
  transfer,
  unlockWithMnemonic,
} from "./shared/walletEngine.js";

import { ERROR_CODES } from "./shared/errors.js";

function serializeError(err) {
  return {
    code: err?.code ?? ERROR_CODES.INTERNAL,
    message: err?.message ?? String(err),
    data: err?.data,
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "DUSK_ENGINE_CALL") return;

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
          return;
        }

        case "engine_lock":
          lock();
          sendResponse({ id, result: true });
          return;

        case "dusk_getAddresses":
          sendResponse({ id, result: isUnlocked() ? getAddresses() : [] });
          return;

        case "dusk_getPublicBalance": {
          const bal = await getPublicBalance();
          sendResponse({
            id,
            result: { nonce: bal.nonce.toString(), value: bal.value.toString() },
          });
          return;
        }

        case "dusk_sendTransaction": {
          const result = await sendTransaction(params ?? {});
          sendResponse({
            id,
            result: {
              hash: result.hash,
              nonce: result.nonce?.toString?.() ?? String(result.nonce),
            },
          });
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
