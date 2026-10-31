// A stand-in for the Tauri plugins the desktop vault uses
// (@tauri-apps/plugin-stronghold, plugin-fs and api/path), for tests:
// snapshot files kept in memory, each sealed with its password; one loaded
// instance per snapshot, as the plugin keeps them (loading again replaces it,
// unloading ends it); a store's changes kept only by save().

export const APP_DATA = "/app-data";

export function fakeTauri() {
  const files = new Map();
  const loaded = new Map();
  // Tests set these to fail a step: hooks.save(path), hooks.load(path).
  const hooks = { save: null, load: null };

  const live = (path) => {
    const state = loaded.get(path);
    if (!state) throw new Error("stronghold not loaded");
    return state;
  };

  class Store {
    constructor(path, client) {
      this.path = path;
      this.client = client;
    }
    async get(key) {
      const value = live(this.path).clients[this.client]?.[key];
      return value ? Uint8Array.from(value) : null;
    }
    async insert(key, value) {
      live(this.path).clients[this.client][key] = Array.from(value);
    }
    async remove(key) {
      const client = live(this.path).clients[this.client];
      const value = client[key];
      delete client[key];
      return value ? Uint8Array.from(value) : null;
    }
  }

  class Client {
    constructor(path, name) {
      this.path = path;
      this.name = name;
    }
    getStore() {
      return new Store(this.path, this.name);
    }
  }

  class Stronghold {
    constructor(path) {
      this.path = path;
    }
    static async load(path, password) {
      await hooks.load?.(path);
      const file = files.get(path);
      if (file && file.password !== password) throw new Error("BadFileKey");
      loaded.set(path, structuredClone(file ?? { password, clients: {} }));
      return new Stronghold(path);
    }
    async unload() {
      loaded.delete(this.path);
    }
    async loadClient(name) {
      if (!live(this.path).clients[name]) throw new Error("client not found");
      return new Client(this.path, name);
    }
    async createClient(name) {
      live(this.path).clients[name] ??= {};
      return new Client(this.path, name);
    }
    async save() {
      await hooks.save?.(this.path);
      files.set(this.path, structuredClone(live(this.path)));
    }
  }

  const BaseDirectory = { AppData: 14 };
  return {
    files,
    loaded,
    hooks,
    stronghold: { Stronghold },
    fs: {
      BaseDirectory,
      exists: async (file) => files.has(`${APP_DATA}/${file}`),
      remove: async (file) => {
        if (!files.delete(`${APP_DATA}/${file}`)) throw new Error("No such file or directory (os error 2)");
      },
    },
    path: {
      appDataDir: async () => APP_DATA,
      join: async (...parts) => parts.join("/"),
    },
  };
}
