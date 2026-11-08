// Bridge messages between the inpage provider (window) and the extension background.
//
// This file implements two flows:
// 1) Request/response RPC (`window.postMessage` -> `runtime.sendMessage`)
// 2) Provider event push via a long-lived `Port` (profilesChanged, chainChanged, ...)

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

function isValidRequestId(id) {
  return typeof id === "string" && id.length > 0 && id.length <= 128;
}

const EXTENSION_TARGET =
  typeof __DUSK_TARGET__ !== "undefined" ? __DUSK_TARGET__ : "chrome";
const IS_FIREFOX = EXTENSION_TARGET === "firefox";
const DUSK_WALLET_ID = "wallet.dusk.extension";
const DUSK_BRIDGE_TARGET = "DUSK_WALLET_EXTENSION";
const INPAGE_SCRIPT_ID = "dusk-wallet-inpage";

/** @type {any | null} */
let dappPort = null;

const extApi = ext;

function injectInpageIfNeeded() {
  if (!IS_FIREFOX) return;
  if (!extApi?.runtime?.getURL) return;

  try {
    const existing = document.getElementById(INPAGE_SCRIPT_ID);
    if (existing) return;

    const script = document.createElement("script");
    script.id = INPAGE_SCRIPT_ID;
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
      { target: DUSK_BRIDGE_TARGET, ...payload, walletId: DUSK_WALLET_ID },
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

// The person's presses on the page, as the browser marks them (trusted, which
// no page's own event is): a hand-over takes one, so one press opens one Send
// however often the page asks during it.
let presses = 0;
let pressesTaken = 0;
for (const type of ["pointerdown", "keydown"]) {
  window.addEventListener(type, (event) => {
    if (event?.isTrusted === true) presses += 1;
  }, { capture: true, passive: true });
}

// Whether the page had a press of the person's as it handed a request over,
// one no hand-over took yet, and as the browser says, where it says.
function takePress() {
  const fresh = presses > pressesTaken;
  pressesTaken = presses;
  return fresh && globalThis.navigator?.userActivation?.isActive !== false;
}

// The wallet's answer to a site's request. Firefox for Android stops the
// wallet's background a while after Firefox leaves the screen, and a request
// waiting for its approval then gets no answer at all (or Chrome's "message
// port closed"): asked again (`resume`), the request takes up the approval
// still open (background/pending.js), or hears plainly that it can't, within
// the 5 minutes an approval waits. Never no answer, which a site reads as one.
const RESUME_FOR_MS = 6 * 60_000;
const NO_ANSWER = /out of scope|receiving end does not exist|message port closed|disconnected|message manager|context invalidated/i;

async function answerOf(message) {
  const until = Date.now() + RESUME_FOR_MS;
  for (let resume = false; ; resume = true) {
    try {
      const response = await runtimeSendMessage(resume ? { ...message, resume: true } : message);
      if (response !== undefined) return response;
    } catch (err) {
      if (!NO_ANSWER.test(String(err?.message ?? err))) throw err;
    }
    if (Date.now() > until) {
      return { error: { code: 4900, message: "The wallet stopped before it answered. Check its Activity before you try again." } };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

window.addEventListener("message", (event) => {
  // Only accept messages from the same window
  if (event.source !== window) return;
  const msg = event.data;
  if (!msg || msg.target !== DUSK_BRIDGE_TARGET) return;
  if (msg.walletId !== DUSK_WALLET_ID) return;

  // Lazy-subscribe to push events when the dApp registers listeners.
  if (msg.type === "DUSK_PROVIDER_SUBSCRIBE") {
    ensurePort();
    return;
  }

  // RPC requests from the inpage provider.
  if (msg.type !== "DUSK_RPC_REQUEST") return;

  const id = msg.id;
  if (!isValidRequestId(id)) return;

  ensurePort();

  const request = msg.request;

  answerOf({
    type: "DUSK_RPC_REQUEST",
    id,
    origin: window.location.origin,
    request,
    // Whether the page had a press of the person's as it asked: a hand-over takes one.
    ...(request?.method === "dusk_openPaymentLink" ? { pressed: takePress() } : {}),
  })
    .then((response) => {
      const payload = {
        target: DUSK_BRIDGE_TARGET,
        walletId: DUSK_WALLET_ID,
        type: "DUSK_RPC_RESPONSE",
        id,
        response,
      };

      window.postMessage(payload, window.location.origin);
    })
    .catch((err) => {
      const payload = {
        target: DUSK_BRIDGE_TARGET,
        walletId: DUSK_WALLET_ID,
        type: "DUSK_RPC_RESPONSE",
        id,
        response: { error: { code: 4900, message: err?.message ?? String(err) } },
      };

      window.postMessage(payload, window.location.origin);
    });
});
