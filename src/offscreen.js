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
  waitTxExecuted,
  unlockWithMnemonic,
} from "./shared/walletEngine.js";

import { ERROR_CODES } from "./shared/errors.js";

// ---------------------------------------------------------------------------
// Debug: fetch tracer (offscreen)
// ---------------------------------------------------------------------------
const DEBUG_NET = true;

// We do NOT log request bodies (prover payloads can be sensitive).
function installFetchTracer() {
  if (globalThis.__DUSK_FETCH_TRACER_INSTALLED__) return;
  globalThis.__DUSK_FETCH_TRACER_INSTALLED__ = true;

  const origFetch = globalThis.fetch?.bind(globalThis);
  if (!origFetch) return;

  let seq = 0;

  globalThis.fetch = async (input, init = {}) => {
    const id = ++seq;

    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input?.url;
    const method =
      init?.method ||
      (typeof input === "object" && input && "method" in input ? input.method : "GET") ||
      "GET";

    const signal =
      init?.signal ||
      (typeof input === "object" && input && "signal" in input ? input.signal : undefined);

    const body = init && "body" in init ? init.body : undefined;
    const bodySize =
      typeof body === "string"
        ? body.length
        : body instanceof ArrayBuffer
          ? body.byteLength
          : body && typeof body === "object" && "byteLength" in body
            ? body.byteLength
            : null;

    const started = performance.now();

    console.groupCollapsed(`[fetch #${id}] ${method} ${url}`);
    console.log("request", { method, url, bodySize, aborted: !!signal?.aborted });

    try {
      const res = await origFetch(input, init);
      const durMs = Math.round(performance.now() - started);
      const ct = res.headers?.get?.("content-type") || "";

      console.log("response", { status: res.status, ok: res.ok, durMs, ct });

      // If not OK, try to show a small preview (clone to avoid consuming the body)
      if (!res.ok) {
        try {
          if (ct.includes("json") || ct.includes("text")) {
            const preview = await res.clone().text();
            console.warn("error preview", preview.slice(0, 1200));
          }
        } catch (e) {
          console.warn("could not read error body", e);
        }
      }

      console.groupEnd();
      return res;
    } catch (e) {
      const durMs = Math.round(performance.now() - started);
      console.error("fetch threw", {
        durMs,
        name: e?.name,
        message: e?.message,
        aborted: !!signal?.aborted,
      });
      console.error(e);
      console.groupEnd();
      throw e;
    }
  };
}

if (DEBUG_NET) {
  try { installFetchTracer(); } catch (e) { console.warn("Fetch tracer install failed", e); }
}

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
    const err = executedEvent.err ?? executedEvent.error ?? executedEvent.result?.err ?? executedEvent.result?.error;
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
      chrome.runtime.sendMessage({
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
    // Still send a best-effort message so the UI can react.
    try {
      chrome.runtime.sendMessage({
        type: "DUSK_TX_EXECUTED",
        hash,
        ok: false,
        error: e?.message ?? String(e),
      });
    } catch {
      // ignore
    }
  } finally {
    activeTxWatches.delete(hash);
  }
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

          // Fire-and-forget: start shielded sync in the background.
          startShieldedSync().catch(() => {});
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
