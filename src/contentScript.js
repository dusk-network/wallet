// Bridge messages between the inpage provider (window) and the extension background.
//
// This file implements two flows:
// 1) Request/response RPC (`window.postMessage` -> `chrome.runtime.sendMessage`)
// 2) Provider event push via a long-lived `Port` (accountsChanged, chainChanged, ...)

/** @type {chrome.runtime.Port | null} */
let dappPort = null;

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
    dappPort = chrome.runtime.connect({ name: "DUSK_DAPP_PORT" });
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

  chrome.runtime.sendMessage(
    {
      type: "DUSK_RPC_REQUEST",
      id,
      origin: window.location.origin,
      request,
    },
    (response) => {
      const le = chrome.runtime.lastError;
      const payload = {
        target: "DUSK_EXTENSION",
        type: "DUSK_RPC_RESPONSE",
        id,
        response: le
          ? { error: { code: 4900, message: le.message } }
          : response,
      };

      window.postMessage(payload, window.location.origin);
    }
  );
});
