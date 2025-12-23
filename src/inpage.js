// Inpage provider injected into dApp pages.
//
// Exposes window.dusk.request({ method, params }) similar to MetaMask's EIP-1193.
// Additionally supports MetaMask-style push events:
// - accountsChanged
// - chainChanged
// - connect / disconnect
//
// NOTE: Dusk isn't EVM. The provider follows an EIP-1193-like interface
// (request + events) but methods are Dusk-prefixed (dusk_*).
// In theory we could map to `eth_*` where applicable.

(function () {
  if (window.dusk) {
    return;
  }

  const pending = new Map();
  const listeners = new Map();

  const state = {
    accounts: [],
    chainId: null,
    selectedAddress: null,
    isAuthorized: false,
  };

  function shallowArrayEq(a, b) {
    if (a === b) return true;
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  function emit(event, ...args) {
    const ls = listeners.get(event);
    if (!ls || !ls.length) return;
    for (const fn of ls) {
      try {
        fn(...args);
      } catch (e) {
        console.error("Dusk provider listener error", e);
      }
    }
  }

  function ensurePushSubscribed() {
    try {
      window.postMessage(
        { target: "DUSK_EXTENSION", type: "DUSK_PROVIDER_SUBSCRIBE" },
        window.location.origin
      );
    } catch {
      // ignore
    }
  }

  function on(event, handler) {
    if (typeof handler !== "function") return;
    const ls = listeners.get(event) || [];
    ls.push(handler);
    listeners.set(event, ls);

    // Lazy subscription: only open a background port when the site actually
    // registers for events (or does its first request).
    ensurePushSubscribed();
  }

  function once(event, handler) {
    if (typeof handler !== "function") return;
    const wrapped = (...args) => {
      removeListener(event, wrapped);
      handler(...args);
    };
    on(event, wrapped);
  }

  function removeListener(event, handler) {
    const ls = listeners.get(event) || [];
    listeners.set(
      event,
      ls.filter((fn) => fn !== handler)
    );
  }

  function removeAllListeners(event) {
    if (typeof event === "string") listeners.delete(event);
    else listeners.clear();
  }

  function setAccounts(next, { emitEvent } = {}) {
    const arr = Array.isArray(next) ? next : [];
    if (shallowArrayEq(state.accounts, arr)) {
      state.accounts = arr;
      state.selectedAddress = arr[0] ?? null;
      return;
    }
    state.accounts = arr;
    state.selectedAddress = arr[0] ?? null;
    if (emitEvent) emit("accountsChanged", arr);
  }

  function setChainId(next, { emitEvent } = {}) {
    const v = typeof next === "string" ? next : null;
    if (state.chainId === v) {
      state.chainId = v;
      return;
    }
    state.chainId = v;
    if (emitEvent && v) emit("chainChanged", v);
  }

  function setAuthorized(next, { emitEvent, data } = {}) {
    const v = Boolean(next);
    if (state.isAuthorized === v) {
      state.isAuthorized = v;
      return;
    }
    state.isAuthorized = v;
    if (emitEvent) {
      if (v) emit("connect", data);
      else emit("disconnect", data);
    }
  }

  async function request({ method, params } = {}) {
    if (!method || typeof method !== "string") {
      throw new Error("Invalid request: method must be a string");
    }

    // Opening a port is cheap enough and enables push events.
    ensurePushSubscribed();

    const id =
      (crypto.randomUUID && crypto.randomUUID()) ||
      String(Date.now()) + Math.random();

    const msg = {
      target: "DUSK_EXTENSION",
      type: "DUSK_RPC_REQUEST",
      id,
      request: { method, params },
    };

    const p = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, method });
    });

    window.postMessage(msg, window.location.origin);

    return p;
  }

  // Legacy MetaMask convenience
  function enable() {
    // Use the Dusk method name to avoid implying EVM compatibility.
    return request({ method: "dusk_requestAccounts" });
  }

  function isConnected() {
    // Provider transport is the extension injection, if this code is running,
    // we're connected to the extension.
    return true;
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.target !== "DUSK_EXTENSION") return;

    // Background -> content script -> inpage: state snapshot
    if (msg.type === "DUSK_PROVIDER_STATE" && msg.state) {
      const st = msg.state;
      setChainId(st.chainId, { emitEvent: false });
      setAccounts(st.accounts, { emitEvent: false });
      return;
    }

    // Background -> content script -> inpage: provider push event
    if (msg.type === "DUSK_PROVIDER_EVENT") {
      const name = msg.name;
      const data = msg.data;
      if (name === "accountsChanged") {
        setAccounts(data, { emitEvent: true });
        return;
      }
      if (name === "chainChanged") {
        setChainId(data, { emitEvent: true });
        return;
      }
      if (name === "connect") {
        // connect payload: { chainId }
        if (data && typeof data.chainId === "string") {
          setChainId(data.chainId, { emitEvent: false });
        }
        setAuthorized(true, { emitEvent: true, data });
        return;
      }
      if (name === "disconnect") {
        // disconnect payload: { code, message }
        setAccounts([], { emitEvent: true });
        setAuthorized(false, { emitEvent: true, data });
        return;
      }

      // Pass through unknown events (future-proof)
      emit(name, data);
      return;
    }

    // RPC response
    if (msg.type !== "DUSK_RPC_RESPONSE") return;

    const { id, response } = msg;
    const entry = pending.get(id);
    if (!entry) return;

    pending.delete(id);

    if (response?.error) {
      const err = new Error(response.error.message || "Dusk request failed");
      err.code = response.error.code;
      err.data = response.error.data;
      entry.reject(err);
      return;
    }

    const result = response?.result !== undefined ? response.result : response;
    entry.resolve(result);

    // Update local state for known methods.
    // (Events will still come from push, but this keeps provider properties fresh
    // even if listeners aren't registered.)
    const m = entry.method;
    if (m === "dusk_requestAccounts" && Array.isArray(result)) {
      setAccounts(result, { emitEvent: true });
    }
    if (m === "dusk_accounts" && Array.isArray(result)) {
      setAccounts(result, { emitEvent: false });
    }
    if (m === "dusk_chainId") {
      setChainId(result, { emitEvent: false });
    }
    if (m === "dusk_disconnect") {
      setAccounts([], { emitEvent: true });
      setAuthorized(false, { emitEvent: true, data: { code: 4900, message: "Disconnected" } });
    }
  });

  // Minimal provider surface
  window.dusk = {
    isDusk: true,
    request,
    enable,
    on,
    once,
    removeListener,
    off: removeListener,
    removeAllListeners,
    isConnected,
    // MetaMask-ish properties
    get chainId() {
      return state.chainId;
    },
    get selectedAddress() {
      return state.selectedAddress;
    },
    get isAuthorized() {
      return state.isAuthorized;
    },
  };
})();
