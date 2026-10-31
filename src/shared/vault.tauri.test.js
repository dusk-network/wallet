import { beforeEach, describe, expect, it, vi } from "vitest";
import recorded from "./fixtures/vault-v1-stronghold.json";

// The desktop vault, in a Stronghold snapshot: from the one main (fae81af)
// made (fixtures/vault-v1-stronghold.json, recorded against fakeTauri.js),
// to a key per wallet.
const tauri = await vi.hoisted(async () => (await import("./fixtures/fakeTauri.js")).fakeTauri());
const kv = vi.hoisted(() => ({ items: {} }));

vi.mock("@tauri-apps/plugin-stronghold", () => tauri.stronghold);
vi.mock("@tauri-apps/plugin-fs", () => tauri.fs);
vi.mock("@tauri-apps/api/path", () => tauri.path);
vi.mock("../platform/runtime.js", () => ({ isTauriRuntime: () => true, isExtensionRuntime: () => false }));
vi.mock("./storage.js", () => ({
  storage: {
    get: async (keys) =>
      typeof keys === "string"
        ? keys in kv.items ? { [keys]: structuredClone(kv.items[keys]) } : {}
        : Array.isArray(keys)
        ? Object.fromEntries(keys.filter((k) => k in kv.items).map((k) => [k, structuredClone(kv.items[k])]))
        : Object.fromEntries(Object.entries(keys).map(([k, d]) => [k, k in kv.items ? structuredClone(kv.items[k]) : d])),
    set: async (items) => Object.assign(kv.items, structuredClone(items)),
    remove: async (keys) => {
      for (const k of [keys].flat()) delete kv.items[k];
    },
  },
  STORAGE_KEYS: { VAULT: "dusk_vault_v1", VAULT_V2: "dusk_vault_v2", UNLOCK_GUARD: "dusk_unlock_guard_v1" },
}));

const SNAPSHOT = "/app-data/dusk-wallet.hold";
const OTHER = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const keysOf = () => Object.keys(tauri.files.get(SNAPSHOT).clients["dusk-wallet"]).sort();
const text = (bytes) => new TextDecoder().decode(Uint8Array.from(bytes));
const phrases = (res) => res.wallets.map((w) => w.mnemonic);

async function restart() {
  vi.resetModules();
  return await import("./vault.js");
}

function startFromMain() {
  tauri.files.clear();
  for (const [path, file] of Object.entries(recorded.files)) tauri.files.set(path, structuredClone(file));
  kv.items = structuredClone(recorded.kv);
}

describe("desktop vault (Stronghold)", () => {
  beforeEach(() => {
    tauri.files.clear();
    tauri.loaded.clear();
    tauri.hooks.save = null;
    tauri.hooks.load = null;
    kv.items = {};
  });

  it("moves main's one phrase to a key of its own on unlock, then removes main's key", async () => {
    startFromMain();
    let vault = await restart();
    expect(await vault.loadVault()).toEqual({ kind: "stronghold" });

    const { wallets } = await vault.unlockVault(recorded.password);

    expect(wallets).toEqual([{ id: "v1-desktop", n: 1, mnemonic: recorded.mnemonic }]);
    expect(keysOf()).toEqual([`wallet:${wallets[0].id}`, "wallets"]);
    expect(text(tauri.files.get(SNAPSHOT).clients["dusk-wallet"][`wallet:${wallets[0].id}`])).toBe(recorded.mnemonic);
    expect(tauri.loaded.size).toBe(0);

    vault = await restart();
    await expect(vault.unlockVault(recorded.password)).resolves.toEqual({ wallets });
  });

  it("moves nothing with a wrong password", async () => {
    startFromMain();
    const vault = await restart();
    await expect(vault.unlockVault("not it")).rejects.toThrow("Incorrect password");
    expect(tauri.files.get(SNAPSHOT)).toEqual(recorded.files[SNAPSHOT]);
    expect(kv.items.dusk_unlock_guard_v1.failures).toBe(1);
  });

  it.each([
    ["saving the moved phrase", 1],
    ["saving the removal of main's key", 2],
  ])("still unlocks when the move stops at %s, and finishes next time", async (_step, failAt) => {
    startFromMain();
    let vault = await restart();
    let saves = 0;
    tauri.hooks.save = async () => {
      if (++saves === failAt) throw new Error("disk full");
    };

    // The same wallet each time, as the move is tried again.
    expect((await vault.unlockVault(recorded.password)).wallets).toEqual([{ id: "v1-desktop", n: 1, mnemonic: recorded.mnemonic }]);
    expect(keysOf()).toContain("mnemonic");

    tauri.hooks.save = null;
    vault = await restart();
    const { wallets } = await vault.unlockVault(recorded.password);
    expect(wallets).toEqual([{ id: "v1-desktop", n: 1, mnemonic: recorded.mnemonic }]);
    expect(keysOf()).toEqual(["wallet:v1-desktop", "wallets"]);
  });

  it("adds a wallet, refuses one that's here, and removes one: a key each", async () => {
    startFromMain();
    const vault = await restart();
    const [first] = (await vault.unlockVault(recorded.password)).wallets;

    const second = await vault.addVaultWallet(OTHER, recorded.password);
    expect(second).toEqual({ id: expect.any(String), n: 2 });
    expect(keysOf()).toEqual([`wallet:${first.id}`, `wallet:${second.id}`, "wallets"].sort());
    await expect(vault.addVaultWallet(` ${recorded.mnemonic} `, recorded.password)).rejects.toThrow(vault.DUPLICATE_PHRASE);
    await expect(vault.addVaultWallet("legal winner", "wrong")).rejects.toThrow("Incorrect password");
    delete kv.items.dusk_unlock_guard_v1;

    await vault.removeVaultWallet(first.id, recorded.password);
    expect(keysOf()).toEqual([`wallet:${second.id}`, "wallets"]);
    expect(await vault.unlockVault(recorded.password)).toEqual({ wallets: [{ ...second, mnemonic: OTHER }] });
    await expect(vault.removeVaultWallet(second.id, recorded.password)).rejects.toThrow(/only wallet/i);
  });

  it("puts the wallets back when an added or removed one doesn't load back, and says when that's not sure", async () => {
    startFromMain();
    const vault = await restart();
    const [first] = (await vault.unlockVault(recorded.password)).wallets;
    const shut = (from, to = from) => {
      let loads = 0;
      tauri.hooks.load = async () => {
        loads += 1;
        if (loads >= from && loads <= to) throw new Error("device busy");
      };
    };

    // The open loads once, the change twice: saved, then loaded again.
    shut(3);
    await expect(vault.addVaultWallet(OTHER, recorded.password)).rejects.toThrow("couldn't be saved");
    expect(keysOf()).toEqual(["wallet:v1-desktop", "wallets"]);
    tauri.hooks.load = null;
    const second = await vault.addVaultWallet(OTHER, recorded.password);

    shut(3);
    await expect(vault.removeVaultWallet(first.id, recorded.password)).rejects.toThrow("couldn't be saved");
    tauri.hooks.load = null;
    expect(phrases(await vault.unlockVault(recorded.password))).toEqual([recorded.mnemonic, OTHER]);

    shut(3, Infinity);
    await expect(vault.removeVaultWallet(first.id, recorded.password)).rejects.toThrow(
      "The wallet vault couldn't be checked. Lock the wallet and unlock it again."
    );
    expect(kv.items.dusk_unlock_guard_v1).toBeUndefined();
    tauri.hooks.load = null;
    expect(await vault.unlockVault(recorded.password)).toEqual({ wallets: [{ ...second, mnemonic: OTHER }] });
  });

  it("makes a new vault with a key for its wallet, and Reset removes it all", async () => {
    const vault = await restart();
    const wallet = await vault.createVault(OTHER, "pw");
    expect(keysOf()).toEqual([`wallet:${wallet.id}`, "wallets"]);
    expect(kv.items.dusk_vault_v1).toEqual({ kind: "stronghold" });

    await vault.clearVault();
    expect(tauri.files.size).toBe(0);
    expect(kv.items).toEqual({});
  });

  it("doesn't change the password in place", async () => {
    startFromMain();
    const vault = await restart();
    await expect(vault.changeVaultPassword(recorded.password, "new")).rejects.toThrow(/isn't available/);
    expect(tauri.files.get(SNAPSHOT)).toEqual(recorded.files[SNAPSHOT]);
  });
});
