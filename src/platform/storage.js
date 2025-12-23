import { isExtensionRuntime, isTauriRuntime } from "./runtime.js";

// Promise-based storage adapter with a chrome.storage-like surface:
// - get(keys)
// - set(items)
// - remove(keys)
// - clear()
//
// In the extension we use chrome.storage.local.
// In Tauri we use @tauri-apps/plugin-store.
// In plain web we fall back to localStorage.

function safeLocalStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function encode(value) {
  // localStorage only stores strings, keep type fidelity via JSON.
  return JSON.stringify(value);
}

function decode(str) {
  if (str == null) return undefined;
  try {
    return JSON.parse(str);
  } catch {
    // If the value wasn't JSON, return raw string.
    return str;
  }
}

/**
 * LocalStorage adapter with chrome.storage.get semantics.
 */
const localStorageAdapter = {
  /** @param {string|string[]|Object|null} keys */
  async get(keys) {
    const ls = safeLocalStorage();
    if (!ls) return {};

    // null/undefined => return everything
    if (keys == null) {
      const out = {};
      for (let i = 0; i < ls.length; i++) {
        const k = ls.key(i);
        if (!k) continue;
        out[k] = decode(ls.getItem(k));
      }
      return out;
    }

    // string => return that key
    if (typeof keys === "string") {
      const v = decode(ls.getItem(keys));
      return v === undefined ? {} : { [keys]: v };
    }

    // array => return those keys
    if (Array.isArray(keys)) {
      const out = {};
      for (const k of keys) {
        const v = decode(ls.getItem(k));
        if (v !== undefined) out[k] = v;
      }
      return out;
    }

    // object => treat as defaults
    if (keys && typeof keys === "object") {
      const out = {};
      for (const [k, defaultValue] of Object.entries(keys)) {
        const v = decode(ls.getItem(k));
        out[k] = v === undefined ? defaultValue : v;
      }
      return out;
    }

    return {};
  },

  /** @param {Object} items */
  async set(items) {
    const ls = safeLocalStorage();
    if (!ls) return;
    if (!items || typeof items !== "object") return;
    for (const [k, v] of Object.entries(items)) {
      ls.setItem(k, encode(v));
    }
  },

  /** @param {string|string[]} keys */
  async remove(keys) {
    const ls = safeLocalStorage();
    if (!ls) return;
    if (typeof keys === "string") {
      ls.removeItem(keys);
      return;
    }
    if (Array.isArray(keys)) {
      for (const k of keys) ls.removeItem(k);
    }
  },

  async clear() {
    const ls = safeLocalStorage();
    if (!ls) return;
    ls.clear();
  },
};

/**
 * Chrome extension adapter.
 */
const chromeStorageAdapter = {
  /** @param {string|string[]|Object|null} keys */
  get(keys) {
    return new Promise((resolve) => {
      chrome.storage.local.get(keys ?? null, (items) => resolve(items));
    });
  },

  /** @param {Object} items */
  set(items) {
    return new Promise((resolve) => {
      chrome.storage.local.set(items, () => resolve());
    });
  },

  /** @param {string|string[]} keys */
  remove(keys) {
    return new Promise((resolve) => {
      chrome.storage.local.remove(keys, () => resolve());
    });
  },

  clear() {
    return new Promise((resolve) => {
      chrome.storage.local.clear(() => resolve());
    });
  },
};

/**
 * Tauri Store adapter.
 *
 * NOTE: We dynamically import the plugin so the extension bundle doesn't hard
 * depend on any tauri packages.
 */
const TAURI_STORE_FILE = "dusk-wallet.store.json";

let tauriStorePromise = null;
let tauriQueue = Promise.resolve();

async function getTauriStore() {
  if (!tauriStorePromise) {
    tauriStorePromise = (async () => {
      const { load } = await import("@tauri-apps/plugin-store");
      // We explicitly save so we can batch multiple mutations.
      return await load(TAURI_STORE_FILE, { autoSave: false });
    })();
  }
  return tauriStorePromise;
}

/**
 * Serialize store operations to avoid stale saves when multiple set/remove
 * calls happen close together.
 */
function withTauriStore(fn) {
  const next = tauriQueue.then(async () => {
    const store = await getTauriStore();
    return await fn(store);
  });

  // Ensure the queue keeps flowing even if an operation throws.
  tauriQueue = next.catch(() => undefined);

  return next;
}

const tauriStoreAdapter = {
  /** @param {string|string[]|Object|null} keys */
  async get(keys) {
    return withTauriStore(async (store) => {
      // Build a map of all values once. It keeps the implementation simple and
      // avoids relying on optional helper methods such as `has`.
      const all = Object.fromEntries(await store.entries());

      // null/undefined => return everything
      if (keys == null) {
        return all;
      }

      // string => return that key
      if (typeof keys === "string") {
        return Object.prototype.hasOwnProperty.call(all, keys)
          ? { [keys]: all[keys] }
          : {};
      }

      // array => return those keys
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) {
          if (Object.prototype.hasOwnProperty.call(all, k)) out[k] = all[k];
        }
        return out;
      }

      // object => treat as defaults
      if (keys && typeof keys === "object") {
        const out = {};
        for (const [k, defaultValue] of Object.entries(keys)) {
          out[k] = Object.prototype.hasOwnProperty.call(all, k)
            ? all[k]
            : defaultValue;
        }
        return out;
      }

      return {};
    });
  },

  /** @param {Object} items */
  async set(items) {
    if (!items || typeof items !== "object") return;
    return withTauriStore(async (store) => {
      for (const [k, v] of Object.entries(items)) {
        // Mirror chrome.storage semantics: undefined effectively means delete.
        if (v === undefined) {
          await store.delete(k);
        } else {
          await store.set(k, v);
        }
      }
      await store.save();
    });
  },

  /** @param {string|string[]} keys */
  async remove(keys) {
    return withTauriStore(async (store) => {
      if (typeof keys === "string") {
        await store.delete(keys);
        await store.save();
        return;
      }
      if (Array.isArray(keys)) {
        for (const k of keys) await store.delete(k);
        await store.save();
      }
    });
  },

  async clear() {
    return withTauriStore(async (store) => {
      await store.clear();
      await store.save();
    });
  },
};

export const kv = isExtensionRuntime()
  ? chromeStorageAdapter
  : isTauriRuntime()
    ? tauriStoreAdapter
    : localStorageAdapter;
