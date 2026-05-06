// Inpage provider injected into dApp pages.
//
// The provider itself is still EIP-1193-like (`request`, events, state props),
// but discovery is no longer based on a shared `window.dusk` singleton.
// Instead, wallets announce themselves through the Dusk discovery events:
// - `dusk:requestProvider`
// - `dusk:announceProvider`

(function () {
  if (window.duskWallet) {
    return;
  }

  const DUSK_REQUEST_PROVIDER_EVENT = "dusk:requestProvider";
  const DUSK_ANNOUNCE_PROVIDER_EVENT = "dusk:announceProvider";

  const pending = new Map();
  const listeners = new Map();

  const state = {
    profiles: [],
    chainId: null,
    isAuthorized: false,
  };

  const walletInfo = Object.freeze({
    uuid: "wallet.dusk.extension",
    name: "Dusk Wallet",
    icon:
      "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' x2='1' y1='0' y2='1'%3E%3Cstop stop-color='%237aa2ff'/%3E%3Cstop offset='1' stop-color='%2333d1ff'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='64' height='64' rx='18' fill='%23070b14'/%3E%3Cpath d='M21 16h12.5c11.2 0 18.5 6.5 18.5 16s-7.3 16-18.5 16H21V16Zm11.4 24c6.5 0 10.6-3.1 10.6-8s-4.1-8-10.6-8h-2.7v16h2.7Z' fill='url(%23g)'/%3E%3C/svg%3E",
    rdns: "network.dusk.wallet",
  });

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

  function setProfiles(next, { emitEvent } = {}) {
    const arr = Array.isArray(next) ? next : [];
    if (shallowArrayEq(state.profiles, arr)) {
      state.profiles = arr;
      return;
    }
    state.profiles = arr;
    if (emitEvent) emit("profilesChanged", arr);
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

  function isConnected() {
    return true;
  }

  const provider = {
    isDusk: true,
    request,
    on,
    once,
    removeListener,
    off: removeListener,
    removeAllListeners,
    isConnected,
    get chainId() {
      return state.chainId;
    },
    get profiles() {
      return state.profiles;
    },
    get isAuthorized() {
      return state.isAuthorized;
    },
  };

  function announce() {
    window.dispatchEvent(
      new CustomEvent(DUSK_ANNOUNCE_PROVIDER_EVENT, {
        detail: {
          info: walletInfo,
          provider,
        },
      })
    );
  }

  window.addEventListener(DUSK_REQUEST_PROVIDER_EVENT, announce);

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.target !== "DUSK_EXTENSION") return;

    if (msg.type === "DUSK_PROVIDER_STATE" && msg.state) {
      const st = msg.state;
      setChainId(st.chainId, { emitEvent: false });
      setProfiles(st.profiles, { emitEvent: false });
      setAuthorized(Boolean(st.isConnected), { emitEvent: false });
      return;
    }

    if (msg.type === "DUSK_PROVIDER_EVENT") {
      const name = msg.name;
      const data = msg.data;
      if (name === "profilesChanged") {
        setProfiles(data, { emitEvent: true });
        return;
      }
      if (name === "chainChanged") {
        setChainId(data, { emitEvent: true });
        return;
      }
      if (name === "connect") {
        if (data && typeof data.chainId === "string") {
          setChainId(data.chainId, { emitEvent: false });
        }
        setAuthorized(true, { emitEvent: true, data });
        return;
      }
      if (name === "disconnect") {
        setProfiles([], { emitEvent: true });
        setAuthorized(false, { emitEvent: true, data });
        return;
      }

      emit(name, data);
      return;
    }

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

    const m = entry.method;
    if (m === "dusk_requestProfiles" && Array.isArray(result)) {
      setProfiles(result, { emitEvent: true });
    }
    if (m === "dusk_profiles" && Array.isArray(result)) {
      setProfiles(result, { emitEvent: false });
    }
    if (m === "dusk_chainId") {
      setChainId(result, { emitEvent: false });
    }
    if (m === "dusk_disconnect") {
      setProfiles([], { emitEvent: true });
      setAuthorized(false, { emitEvent: true, data: { code: 4900, message: "Disconnected" } });
    }
  });

  // Wallet-specific namespace for debugging / internal use only.
  window.duskWallet = provider;

  // Announce immediately so already-listening dApps can discover the provider,
  // and listen for future discovery requests so load order does not matter.
  announce();
})();
