// Bridge messages between the inpage provider (window) and the extension background.
//
// This file implements two flows:
// 1) Request/response RPC (`window.postMessage` -> `runtime.sendMessage`)
// 2) Provider event push via a long-lived `Port` (accountsChanged, chainChanged, ...)

// NOTE: MV3 content scripts run as classic scripts, not modules. Keep this file
// free of static `import` statements so the bundled output doesn't include them.

const ext =
  typeof globalThis !== "undefined"
    ? globalThis.browser ?? globalThis.chrome ?? null
    : null;

const isPromiseApi =
  typeof globalThis !== "undefined" && ext != null && ext === globalThis.browser;

function callApi(fn, args = [], thisArg, { allowLastError = false } = {}) {
  if (!fn) {
    return Promise.reject(new Error("Extension API unavailable"));
  }

  if (isPromiseApi) {
    try {
      return Promise.resolve(fn.apply(thisArg ?? ext, args));
    } catch (err) {
      return Promise.reject(err);
    }
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(result);
    };

    try {
      const result = fn.apply(thisArg ?? ext, [
        ...args,
        (cbResult) => {
          const err = ext?.runtime?.lastError;
          if (err && !allowLastError) {
            finish(err);
            return;
          }
          finish(null, cbResult);
        },
      ]);

      if (result && typeof result.then === "function") {
        result.then(
          (value) => finish(null, value),
          (err) => finish(err)
        );
      }
    } catch (err) {
      finish(err);
    }
  });
}

function runtimeGetURL(path) {
  try {
    return ext?.runtime?.getURL ? ext.runtime.getURL(String(path ?? "")) : "";
  } catch {
    return "";
  }
}

function runtimeSendMessage(message, options) {
  return callApi(ext?.runtime?.sendMessage, [message], ext?.runtime, options);
}

const EXTENSION_TARGET =
  typeof __DUSK_TARGET__ !== "undefined" ? __DUSK_TARGET__ : "chrome";
const IS_FIREFOX = EXTENSION_TARGET === "firefox";

/** @type {any | null} */
let dappPort = null;

const extApi = ext;

function injectInpageIfNeeded() {
  if (!IS_FIREFOX) return;
  if (!extApi?.runtime?.getURL) return;

  try {
    const existing = document.getElementById("dusk-inpage");
    if (existing) return;

    const script = document.createElement("script");
    script.id = "dusk-inpage";
    script.type = "module";
    script.src = runtimeGetURL("inpage.js");
    (document.head || document.documentElement).appendChild(script);
    script.addEventListener("load", () => {
      try {
        script.remove();
      } catch {
        // ignore
      }
    });
  } catch {
    // ignore
  }
}

injectInpageIfNeeded();

function sendHello(port) {
  // Best-effort hello used to bind the port to a web origin.
  // This is idempotent and safe to send multiple times.
  try {
    port.postMessage({ type: "DUSK_DAPP_HELLO", origin: window.location.origin });
  } catch {
    // ignore
  }
}

function forwardToInpage(payload) {
  try {
    window.postMessage(
      { target: "DUSK_EXTENSION", ...payload },
      window.location.origin
    );
  } catch {
    // ignore
  }
}

function ensurePort() {
  // If the port already exists, re-send HELLO to be robust to missed messages.
  if (dappPort) {
    sendHello(dappPort);
    return dappPort;
  }

  try {
    if (!extApi?.runtime?.connect) return null;
    dappPort = extApi.runtime.connect({ name: "DUSK_DAPP_PORT" });
  } catch {
    dappPort = null;
    return null;
  }

  dappPort.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== "object") return;

    // Forward provider state snapshot
    if (msg.type === "DUSK_PROVIDER_STATE") {
      forwardToInpage({ type: "DUSK_PROVIDER_STATE", state: msg.state });
      return;
    }

    // Forward provider push events
    if (msg.type === "DUSK_PROVIDER_EVENT") {
      forwardToInpage({ type: "DUSK_PROVIDER_EVENT", name: msg.name, data: msg.data });
    }
  });

  dappPort.onDisconnect.addListener(() => {
    dappPort = null;
  });

  sendHello(dappPort);

  return dappPort;
}

window.addEventListener("message", (event) => {
  // Only accept messages from the same window
  if (event.source !== window) return;
  const msg = event.data;
  if (!msg || msg.target !== "DUSK_EXTENSION") return;

  // Lazy-subscribe to push events when the dApp registers listeners.
  if (msg.type === "DUSK_PROVIDER_SUBSCRIBE") {
    ensurePort();
    return;
  }

  // RPC requests from the inpage provider.
  if (msg.type !== "DUSK_RPC_REQUEST") return;

  ensurePort();

  const id = msg.id;
  const request = msg.request;

  runtimeSendMessage({
    type: "DUSK_RPC_REQUEST",
    id,
    origin: window.location.origin,
    request,
  })
    .then((response) => {
      const payload = {
        target: "DUSK_EXTENSION",
        type: "DUSK_RPC_RESPONSE",
        id,
        response,
      };

      window.postMessage(payload, window.location.origin);
    })
    .catch((err) => {
      const payload = {
        target: "DUSK_EXTENSION",
        type: "DUSK_RPC_RESPONSE",
        id,
        response: { error: { code: 4900, message: err?.message ?? String(err) } },
      };

      window.postMessage(payload, window.location.origin);
    });
});
