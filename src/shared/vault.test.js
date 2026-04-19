import { describe, it, expect, vi, beforeEach } from "vitest";

let store = {};

vi.mock("./storage.js", () => {
  return {
    storage: {
      get: vi.fn(async (keys) => {
        if (keys == null) return { ...store };
        if (typeof keys === "string") {
          return store[keys] === undefined ? {} : { [keys]: store[keys] };
        }
        if (Array.isArray(keys)) {
          return Object.fromEntries(keys.filter((key) => store[key] !== undefined).map((key) => [key, store[key]]));
        }
        if (typeof keys === "object") {
          return Object.fromEntries(
            Object.entries(keys).map(([key, fallback]) => [
              key,
              store[key] === undefined ? fallback : store[key],
            ])
          );
        }
        return {};
      }),
      set: vi.fn(async (obj) => {
        Object.assign(store, obj);
      }),
      remove: vi.fn(async (keys) => {
        if (Array.isArray(keys)) {
          keys.forEach((key) => {
            delete store[key];
          });
          return;
        }
        delete store[keys];
      }),
    },
    STORAGE_KEYS: {
      VAULT: "dusk_vault_v1",
      UNLOCK_GUARD: "dusk_unlock_guard_v1",
    },
    __resetStore: () => {
      store = {};
    },
    __getStore: () => store,
  };
});

vi.mock("../platform/runtime.js", () => ({
  isTauriRuntime: () => false,
}));

const hasWebCrypto = typeof globalThis.crypto?.subtle !== "undefined";

async function loadVaultModule() {
  const storageMod = await import("./storage.js");
  const vaultMod = await import("./vault.js");
  return { storageMod, vaultMod };
}

(hasWebCrypto ? describe : describe.skip)("vault", () => {
  beforeEach(async () => {
    vi.resetModules();
    const { storageMod } = await loadVaultModule();
    storageMod.__resetStore();
    vi.clearAllMocks();
  });

  it("creates a vault and stores encrypted payload", async () => {
    const { storageMod, vaultMod } = await loadVaultModule();

    const mnemonic = "test seed phrase";
    const password = "password123";

    const ok = await vaultMod.createVault(mnemonic, password);
    expect(ok).toBe(true);

    const stored = storageMod.__getStore()[storageMod.STORAGE_KEYS.VAULT];
    expect(stored).toBeTruthy();
    expect(typeof stored.iterations).toBe("number");
    expect(stored.iterations).toBeGreaterThanOrEqual(900_000);
  });

  it("unlocks vault with correct password", async () => {
    const { vaultMod } = await loadVaultModule();

    const mnemonic = "test seed phrase";
    const password = "password123";

    await vaultMod.createVault(mnemonic, password);
    const res = await vaultMod.unlockVault(password);
    expect(res).toBe(mnemonic);
  });

  it("rejects wrong password and rate limits subsequent attempts", async () => {
    const { vaultMod } = await loadVaultModule();

    const mnemonic = "test seed phrase";
    const password = "password123";

    await vaultMod.createVault(mnemonic, password);

    await expect(vaultMod.unlockVault("wrong-password")).rejects.toThrow(/incorrect password/i);

    await expect(vaultMod.unlockVault(password)).rejects.toThrow(/too many attempts/i);
  });

  it("persists unlock rate limits across module reloads", async () => {
    let { storageMod, vaultMod } = await loadVaultModule();

    const mnemonic = "test seed phrase";
    const password = "password123";

    await vaultMod.createVault(mnemonic, password);
    await expect(vaultMod.unlockVault("wrong-password")).rejects.toThrow(/incorrect password/i);

    const guardBeforeReload = storageMod.__getStore()[storageMod.STORAGE_KEYS.UNLOCK_GUARD];
    expect(guardBeforeReload?.failures).toBe(1);
    expect(guardBeforeReload?.nextAllowedAt).toBeGreaterThan(Date.now());

    vi.resetModules();
    ({ vaultMod } = await loadVaultModule());

    await expect(vaultMod.unlockVault(password)).rejects.toThrow(/too many attempts/i);
  });

  it("removes unsupported vault formats", async () => {
    const { storageMod, vaultMod } = await loadVaultModule();

    const legacy = { data: "x", iv: "y", salt: "z" };
    await storageMod.storage.set({ [storageMod.STORAGE_KEYS.VAULT]: legacy });

    await expect(vaultMod.unlockVault("password123")).rejects.toThrow(/unsupported vault format/i);
    expect(storageMod.storage.remove).toHaveBeenCalledWith([
      storageMod.STORAGE_KEYS.VAULT,
      storageMod.STORAGE_KEYS.UNLOCK_GUARD,
    ]);
  });

  it("clears vault from storage", async () => {
    const { storageMod, vaultMod } = await loadVaultModule();

    await storageMod.storage.set({ [storageMod.STORAGE_KEYS.VAULT]: { foo: "bar" } });
    await storageMod.storage.set({
      [storageMod.STORAGE_KEYS.UNLOCK_GUARD]: { failures: 2, nextAllowedAt: Date.now() + 5_000 },
    });
    await vaultMod.clearVault();

    const stored = storageMod.__getStore()[storageMod.STORAGE_KEYS.VAULT];
    const guard = storageMod.__getStore()[storageMod.STORAGE_KEYS.UNLOCK_GUARD];
    expect(stored).toBeUndefined();
    expect(guard).toBeUndefined();
  });
});
