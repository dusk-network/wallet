import { describe, it, expect, vi, beforeEach } from "vitest";
import fixtures from "./fixtures/vault-v1.json";

// v1 vaults as main (fae81af) made them, with its createVault: public BIP39
// test phrases, never a real wallet's.
const { twelve, twentyfour } = fixtures;
const OTHER = "legal winner thank year wave sausage worth useful legal winner thank yellow";

let store = {};
// Storage steps that fail, each once: "set:dusk_vault_v2" for the next write of
// that key, "get:dusk_vault_v2@3" for its third read since failAt. A crash or a
// full disk at that step.
let failing = [];
const counts = new Map();
function failAt(...specs) {
  counts.clear();
  failing = specs.map((spec) => {
    const [name, at] = spec.split("@");
    return { name, at: at ? Number(at) : null };
  });
}
// A read that answers something else once, by key: storage that lost a write.
let corruptRead = new Map();
// Objects read back with their keys sorted, as Chrome's storage hands them back.
let sortedReads = false;
const sortKeys = (value) =>
  Array.isArray(value)
    ? value.map(sortKeys)
    : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]))
    : value;

const keysOf = (keys) => (typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys ?? {}));
function fail(op, keys) {
  for (const key of keysOf(keys)) {
    const name = `${op}:${key}`;
    const n = (counts.get(name) ?? 0) + 1;
    counts.set(name, n);
    const i = failing.findIndex((f) => f.name === name && (f.at ?? n) === n);
    if (i >= 0) {
      failing.splice(i, 1);
      throw new Error(`storage ${op} failed`);
    }
  }
}

vi.mock("./storage.js", () => {
  return {
    storage: {
      get: vi.fn(async (keys) => {
        fail("get", keys);
        const read = (key) => {
          if (corruptRead.has(key)) {
            const value = corruptRead.get(key);
            corruptRead.delete(key);
            return structuredClone(value);
          }
          return sortedReads ? sortKeys(structuredClone(store[key])) : structuredClone(store[key]);
        };
        if (keys == null) return structuredClone(store);
        if (typeof keys === "string") {
          return store[keys] === undefined ? {} : { [keys]: read(keys) };
        }
        if (Array.isArray(keys)) {
          return Object.fromEntries(keys.filter((key) => store[key] !== undefined).map((key) => [key, read(key)]));
        }
        if (typeof keys === "object") {
          return Object.fromEntries(
            Object.entries(keys).map(([key, fallback]) => [key, store[key] === undefined ? fallback : read(key)])
          );
        }
        return {};
      }),
      set: vi.fn(async (obj) => {
        fail("set", obj);
        Object.assign(store, structuredClone(obj));
      }),
      remove: vi.fn(async (keys) => {
        fail("remove", keys);
        for (const key of keysOf(keys)) delete store[key];
      }),
    },
    STORAGE_KEYS: {
      VAULT: "dusk_vault_v1",
      VAULT_V2: "dusk_vault_v2",
      UNLOCK_GUARD: "dusk_unlock_guard_v1",
    },
  };
});

vi.mock("../platform/runtime.js", () => ({
  isTauriRuntime: () => false,
}));

const V1 = "dusk_vault_v1";
const V2 = "dusk_vault_v2";
const GUARD = "dusk_unlock_guard_v1";
const hasWebCrypto = typeof globalThis.crypto?.subtle !== "undefined";
const sealed = ({ data, iv, salt, iterations }) => ({ data, iv, salt, iterations });
const phrases = (res) => res.wallets.map((w) => w.mnemonic);

// A fresh module, as a new service worker after a crash or an update gets.
async function restart() {
  vi.resetModules();
  return await import("./vault.js");
}

function startWithV1(fixture) {
  store = { [V1]: structuredClone(fixture.vault) };
}

// No wrong-password wait carried from one step of a test to the next.
const clearGuard = () => delete store[GUARD];

// Real PBKDF2 at 900,000 iterations, often a dozen per test: slow under load.
(hasWebCrypto ? describe : describe.skip)("vault", { timeout: 30_000 }, () => {
  beforeEach(() => {
    store = {};
    failAt();
    corruptRead = new Map();
    sortedReads = false;
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("creates a vault with one wallet, sealed with v1's parameters", async () => {
    const vault = await restart();
    const wallet = await vault.createVault(twelve.mnemonic, "password123");

    expect(wallet).toEqual({ id: expect.stringMatching(/^[0-9a-f]{32}$/), n: 1 });
    expect(store[V1]).toBeUndefined();
    const [entry] = store[V2].wallets;
    expect(store[V2]).toEqual({ version: 2, wallets: [entry] });
    expect(entry).toMatchObject({ id: wallet.id, n: 1, iterations: 900_000 });
    expect(atob(entry.salt)).toHaveLength(32);
    expect(atob(entry.iv)).toHaveLength(12);
    expect(JSON.stringify(store)).not.toContain("abandon");
  });

  it("refuses to create a vault over one that's here", async () => {
    const vault = await restart();
    await vault.createVault(twelve.mnemonic, "password123");
    const before = structuredClone(store);
    await expect(vault.createVault(OTHER, "password123")).rejects.toThrow(/already exists/i);
    startWithV1(twelve);
    await expect(vault.createVault(OTHER, "password123")).rejects.toThrow(/already exists/i);
    expect(store[V1]).toEqual(twelve.vault);
    expect(before[V2]).toBeTruthy();
  });

  it("unlocks every wallet with the right password", async () => {
    const vault = await restart();
    const { id } = await vault.createVault(twelve.mnemonic, "password123");
    await expect(vault.unlockVault("password123")).resolves.toEqual({ wallets: [{ id, n: 1, mnemonic: twelve.mnemonic }] });
  });

  it("rejects wrong password and rate limits subsequent attempts", async () => {
    const vault = await restart();
    await vault.createVault(twelve.mnemonic, "password123");

    await expect(vault.unlockVault("wrong-password")).rejects.toThrow(/incorrect password/i);
    await expect(vault.unlockVault("password123")).rejects.toThrow(/too many attempts/i);
  });

  it("serializes concurrent unlock attempts before updating backoff", async () => {
    const vault = await restart();
    await vault.createVault(twelve.mnemonic, "password123");

    const attempts = await Promise.allSettled([vault.unlockVault("wrong-one"), vault.unlockVault("wrong-two")]);

    expect(attempts.map((attempt) => attempt.reason?.message)).toEqual([
      "Incorrect password",
      expect.stringMatching(/too many attempts/i),
    ]);
    expect(store[GUARD].failures).toBe(1);
  });

  it("returns a generic decrypt failure for wrong passwords without vault detail", async () => {
    const vault = await restart();
    await vault.createVault(twelve.mnemonic, "password123");

    const error = await vault.unlockVault("wrong-password").catch((err) => err);
    expect(error.message).toBe("Incorrect password");
    expect(error.message).not.toMatch(/decrypt|crypto|aes|gcm|salt|iv|data|abandon/i);
  });

  it("persists unlock rate limits across module reloads", async () => {
    let vault = await restart();
    await vault.createVault(twelve.mnemonic, "password123");
    await expect(vault.unlockVault("wrong-password")).rejects.toThrow(/incorrect password/i);
    expect(store[GUARD]?.failures).toBe(1);
    expect(store[GUARD]?.nextAllowedAt).toBeGreaterThan(Date.now());

    vault = await restart();
    await expect(vault.unlockVault("password123")).rejects.toThrow(/too many attempts/i);
  });

  it("preserves unsupported vault formats", async () => {
    const legacy = { data: "x", iv: "y", salt: "z" };
    store = { [V1]: structuredClone(legacy) };
    let vault = await restart();
    await expect(vault.unlockVault("password123")).rejects.toThrow(/unsupported vault format/i);
    expect(store).toEqual({ [V1]: legacy });

    // A v2 this version can't read stays as it is too.
    store = { [V2]: { version: 3, phrases: "?" } };
    vault = await restart();
    await expect(vault.unlockVault(twelve.password)).rejects.toThrow(/unsupported vault format/i);
    expect(store).toEqual({ [V2]: { version: 3, phrases: "?" } });
  });

  it("opens v1's phrase beside a v2 it can't read, and changes neither", async () => {
    for (const unreadable of [{ version: 3, phrases: "?" }, { version: 2, wallets: "?" }]) {
      store = { [V2]: structuredClone(unreadable), [V1]: structuredClone(twelve.vault) };
      const vault = await restart();
      await expect(vault.unlockVault(twelve.password).then(phrases)).resolves.toEqual([twelve.mnemonic]);
      expect(store).toEqual({ [V2]: unreadable, [V1]: twelve.vault });
      await expect(vault.addVaultWallet(OTHER, twelve.password)).rejects.toThrow(/unsupported vault format/i);
      await expect(vault.changeVaultPassword(twelve.password, "another password")).rejects.toThrow(/unsupported vault format/i);
      expect(store).toEqual({ [V2]: unreadable, [V1]: twelve.vault });
    }
  });

  it("clears every wallet, v1's too, and the unlock guard", async () => {
    const vault = await restart();
    await vault.createVault(twelve.mnemonic, "password123");
    store[V1] = structuredClone(twentyfour.vault);
    store[GUARD] = { failures: 2, nextAllowedAt: Date.now() + 5_000 };
    store.dusk_settings_v1 = { nodeUrl: "x" };

    await vault.clearVault();

    expect(store).toEqual({ dusk_settings_v1: { nodeUrl: "x" } });
    await expect(vault.unlockVault("password123")).rejects.toThrow(/no wallet vault/i);
  });

  describe("the move from v1, from vaults main made", () => {
    it.each([["12 words", twelve], ["24 words and a password with spaces and accents", twentyfour]])(
      "moves %s on unlock: v1's record copied as it is, then v1 gone",
      async (_name, fixture) => {
        startWithV1(fixture);
        let vault = await restart();
        const { wallets } = await vault.unlockVault(fixture.password);

        expect(wallets).toEqual([{ id: expect.stringMatching(/^v1-[0-9a-f]{32}$/), n: 1, mnemonic: fixture.mnemonic }]);
        expect(store[V1]).toBeUndefined();
        expect(store[V2]).toEqual({ version: 2, wallets: [{ id: wallets[0].id, n: 1, ...fixture.vault }] });

        // And again, as the next service worker unlocks it.
        vault = await restart();
        await expect(vault.unlockVault(fixture.password)).resolves.toEqual({ wallets });
      }
    );

    it("moves where storage hands records back with their keys sorted, as Chrome's does", async () => {
      sortedReads = true;
      startWithV1(twentyfour);
      let vault = await restart();
      const { wallets } = await vault.unlockVault(twentyfour.password);
      expect(store[V1]).toBeUndefined();
      expect(store[V2].wallets).toEqual([{ id: wallets[0].id, n: 1, ...twentyfour.vault }]);
      // And every change after it reads back as written too.
      const added = await vault.addVaultWallet(OTHER, twentyfour.password);
      await vault.changeVaultPassword(twentyfour.password, "another password");
      await vault.removeVaultWallet(added.id, "another password");
      vault = await restart();
      expect(phrases(await vault.unlockVault("another password"))).toEqual([twentyfour.mnemonic]);
    });

    it("moves nothing with a wrong password, then moves on the right one", async () => {
      startWithV1(twelve);
      let vault = await restart();
      await expect(vault.unlockVault("password124")).rejects.toThrow("Incorrect password");
      await expect(vault.unlockVault(" password123")).rejects.toThrow(/too many attempts/i);
      expect(store[V1]).toEqual(twelve.vault);
      expect(store[V2]).toBeUndefined();
      expect(store[GUARD].failures).toBe(1);

      clearGuard();
      vault = await restart();
      await expect(vault.unlockVault(" password123")).rejects.toThrow("Incorrect password");
      clearGuard();
      expect(phrases(await vault.unlockVault(twelve.password))).toEqual([twelve.mnemonic]);
      expect(store[V1]).toBeUndefined();
      expect(store[GUARD]).toBeUndefined();
    });

    // Each step of the move cut short: the unlock still opens the phrase, from
    // v1, and the next unlock finishes the move. A storage write itself is
    // whole or not at all. The move reads v2 (2nd read), writes it, reads it
    // back (3rd read), then removes v1.
    it.each([
      ["writing v2", ["set:dusk_vault_v2"]],
      ["reading v2 back", ["get:dusk_vault_v2@3"]],
      ["reading v2 back, and putting it back as it was", ["get:dusk_vault_v2@3", "remove:dusk_vault_v2"]],
      ["removing v1", ["remove:dusk_vault_v1"]],
    ])("still unlocks when the move stops at %s, and finishes next time", async (_step, steps) => {
      startWithV1(twelve);
      let vault = await restart();
      failAt(...steps);

      expect(phrases(await vault.unlockVault(twelve.password))).toEqual([twelve.mnemonic]);
      expect(failing).toEqual([]);
      expect(store[V1]).toEqual(twelve.vault);

      failAt();
      vault = await restart();
      const { wallets } = await vault.unlockVault(twelve.password);
      expect(phrases({ wallets })).toEqual([twelve.mnemonic]);
      expect(store[V1]).toBeUndefined();
      expect(store[V2].wallets).toEqual([{ id: wallets[0].id, n: 1, ...twelve.vault }]);
    });

    it("leaves v1 as it was when the first read fails", async () => {
      startWithV1(twelve);
      const vault = await restart();
      failAt("get:dusk_vault_v1");
      await expect(vault.unlockVault(twelve.password)).rejects.toThrow("storage get failed");
      expect(store).toEqual({ [V1]: twelve.vault });
    });

    it("keeps v1 when v2 doesn't read back as written, and moves it the next time", async () => {
      startWithV1(twentyfour);
      let vault = await restart();
      corruptRead.set(V2, { version: 2, wallets: [] });

      expect(phrases(await vault.unlockVault(twentyfour.password))).toEqual([twentyfour.mnemonic]);
      expect(store[V1]).toEqual(twentyfour.vault);
      expect(store[V2]).toBeUndefined();

      vault = await restart();
      expect(phrases(await vault.unlockVault(twentyfour.password))).toEqual([twentyfour.mnemonic]);
      expect(store[V1]).toBeUndefined();
      expect(store[V2].wallets).toEqual([expect.objectContaining(twentyfour.vault)]);
    });

    it("puts v1's record over a copy of it that doesn't open", async () => {
      startWithV1(twelve);
      let vault = await restart();
      const { wallets } = await vault.unlockVault(twelve.password);
      store[V1] = structuredClone(twelve.vault);
      store[V2].wallets[0].data = btoa("not the phrase, sealed");

      vault = await restart();
      await expect(vault.unlockVault(twelve.password)).resolves.toEqual({ wallets });
      expect(store[V1]).toBeUndefined();
      expect(store[V2].wallets).toEqual([{ id: wallets[0].id, n: 1, ...twelve.vault }]);
    });

    it("moves nothing twice: v1's phrase in v2 already, under another wallet, goes once", async () => {
      // An older version, back for a while, made v1 again with the same phrase.
      let vault = await restart();
      const { id } = await vault.createVault(twelve.mnemonic, twelve.password);
      store[V1] = structuredClone(twelve.vault);

      vault = await restart();
      await expect(vault.unlockVault(twelve.password)).resolves.toEqual({ wallets: [{ id, n: 1, mnemonic: twelve.mnemonic }] });
      expect(store[V1]).toBeUndefined();
      expect(store[V2].wallets).toHaveLength(1);
    });

    it("keeps a wallet another password seals as it is, and adds v1's beside it", async () => {
      // v2 from this version under one password, then v1 from an older one under another.
      let vault = await restart();
      const first = await vault.createVault(OTHER, "an older password");
      const kept = structuredClone(store[V2].wallets[0]);
      store[V1] = structuredClone(twentyfour.vault);

      vault = await restart();
      const { wallets } = await vault.unlockVault(twentyfour.password);
      expect(wallets).toEqual([{ id: expect.stringMatching(/^v1-/), n: 2, mnemonic: twentyfour.mnemonic }]);
      expect(store[V1]).toBeUndefined();
      expect(store[V2].wallets).toEqual([kept, { id: wallets[0].id, n: 2, ...twentyfour.vault }]);
      // Each password still opens its own.
      await expect(vault.unlockVault("an older password")).resolves.toEqual({ wallets: [{ ...first, mnemonic: OTHER }] });
    });
  });

  describe("wallets", () => {
    async function twoWallets() {
      const vault = await restart();
      const first = await vault.createVault(twelve.mnemonic, "password123");
      const second = await vault.addVaultWallet(OTHER, "password123");
      return { vault, first, second };
    }

    it("adds a wallet under the same password, leaving the others as they are", async () => {
      const vault = await restart();
      const first = await vault.createVault(twelve.mnemonic, "password123");
      const before = structuredClone(store[V2].wallets[0]);

      const second = await vault.addVaultWallet(OTHER, "password123");

      expect(second).toEqual({ id: expect.stringMatching(/^[0-9a-f]{32}$/), n: 2 });
      expect(store[V2].wallets[0]).toEqual(before);
      expect(JSON.stringify(store)).not.toContain("legal winner");
      await expect(vault.unlockVault("password123")).resolves.toEqual({
        wallets: [
          { ...first, mnemonic: twelve.mnemonic },
          { ...second, mnemonic: OTHER },
        ],
      });
    });

    it("adds to a vault moved from v1, the moved wallet as main made it", async () => {
      startWithV1(twentyfour);
      const vault = await restart();
      await vault.addVaultWallet(OTHER, twentyfour.password);

      expect(store[V1]).toBeUndefined();
      expect(store[V2].wallets[0]).toMatchObject({ n: 1, ...twentyfour.vault });
      expect(phrases(await vault.unlockVault(twentyfour.password))).toEqual([twentyfour.mnemonic, OTHER]);
    });

    it("refuses a recovery phrase that's here already, however it's spaced, and writes nothing", async () => {
      const { vault } = await twoWallets();
      const before = structuredClone(store);

      for (const phrase of [twelve.mnemonic, `  ${OTHER.replaceAll(" ", "   ")}\n`]) {
        await expect(vault.addVaultWallet(phrase, "password123")).rejects.toThrow(vault.DUPLICATE_PHRASE);
      }
      expect(vault.DUPLICATE_PHRASE).toBe("This recovery phrase is already in your wallet.");
      expect(store).toEqual(before);
    });

    it("refuses a wallet with a wrong password, and counts it", async () => {
      const vault = await restart();
      await vault.createVault(twelve.mnemonic, "password123");
      const before = structuredClone(store[V2]);

      await expect(vault.addVaultWallet(OTHER, "password12")).rejects.toThrow("Incorrect password");
      expect(store[V2]).toEqual(before);
      expect(store[GUARD].failures).toBe(1);
    });

    it("puts the vault back when a new wallet doesn't read back", async () => {
      const vault = await restart();
      await vault.createVault(twelve.mnemonic, "password123");
      const before = structuredClone(store[V2]);
      // The read after the write answers the vault from before it.
      const real = (await import("./storage.js")).storage.get.getMockImplementation();
      let reads = 0;
      (await import("./storage.js")).storage.get.mockImplementation(async (keys) => {
        if (keys === V2 && ++reads === 2) return { [V2]: structuredClone(before) };
        return real(keys);
      });

      await expect(vault.addVaultWallet(OTHER, "password123")).rejects.toThrow(/couldn't be saved/);
      expect(store[V2]).toEqual(before);
    });

    it("removes one wallet with its password, and touches nothing of the others", async () => {
      const { vault, first, second } = await twoWallets();
      const third = await vault.addVaultWallet(twentyfour.mnemonic, "password123");
      const kept = store[V2].wallets.filter((w) => w.id !== second.id).map((w) => structuredClone(w));

      await expect(vault.removeVaultWallet(second.id, "wrong password")).rejects.toThrow("Incorrect password");
      expect(store[V2].wallets).toHaveLength(3);
      expect(store[GUARD].failures).toBe(1);
      clearGuard();

      await vault.removeVaultWallet(second.id, "password123");
      expect(store[V2].wallets).toEqual(kept);
      // Numbers stay with their wallet; the next one gets a new number.
      await expect(vault.unlockVault("password123")).resolves.toEqual({
        wallets: [
          { ...first, mnemonic: twelve.mnemonic },
          { ...third, n: 3, mnemonic: twentyfour.mnemonic },
        ],
      });
      await expect(vault.addVaultWallet(OTHER, "password123")).resolves.toMatchObject({ n: 4 });
    });

    it("never removes the only wallet, or one that isn't here", async () => {
      const vault = await restart();
      const only = await vault.createVault(twelve.mnemonic, "password123");
      const before = structuredClone(store);

      await expect(vault.removeVaultWallet(only.id, "password123")).rejects.toThrow(/only wallet/i);
      await expect(vault.removeVaultWallet("not-a-wallet", "password123")).rejects.toThrow(/isn't here/i);
      expect(store).toEqual(before);
    });

    it("changes the password: every phrase sealed again, the old password opening none", async () => {
      const { vault, first, second } = await twoWallets();
      const before = structuredClone(store[V2].wallets);

      await expect(vault.changeVaultPassword("password12", "new password")).rejects.toThrow("Incorrect password");
      expect(store[V2].wallets).toEqual(before);
      clearGuard();

      await vault.changeVaultPassword("password123", "a new password, é");
      const after = store[V2].wallets;
      expect(after.map(({ id, n }) => ({ id, n }))).toEqual([first, second]);
      for (const [i, entry] of after.entries()) {
        expect(entry.iterations).toBe(900_000);
        expect(entry.salt).not.toBe(before[i].salt);
        expect(entry.data).not.toBe(before[i].data);
      }
      await expect(vault.unlockVault("password123")).rejects.toThrow("Incorrect password");
      clearGuard();
      expect(phrases(await vault.unlockVault("a new password, é"))).toEqual([twelve.mnemonic, OTHER]);
    });

    it("changes the password of a vault moved from v1", async () => {
      startWithV1(twelve);
      const vault = await restart();
      await vault.changeVaultPassword(twelve.password, "another one");
      expect(store[V1]).toBeUndefined();
      expect(phrases(await vault.unlockVault("another one"))).toEqual([twelve.mnemonic]);
    });

    it("leaves a phrase another password seals as it is when the password changes", async () => {
      let vault = await restart();
      await vault.createVault(OTHER, "an older password");
      const kept = structuredClone(store[V2].wallets[0]);
      store[V1] = structuredClone(twelve.vault);
      vault = await restart();
      await vault.changeVaultPassword(twelve.password, "new password");

      expect(store[V2].wallets[0]).toEqual(kept);
      expect(phrases(await vault.unlockVault("new password"))).toEqual([twelve.mnemonic]);
      expect(phrases(await vault.unlockVault("an older password"))).toEqual([OTHER]);
    });

    it("adds and changes only with the password that opens every wallet unlocked", async () => {
      // One wallet under another password (a vault set up again after a
      // downgrade), v1's under the password it was unlocked with.
      let vault = await restart();
      await vault.createVault(OTHER, "an older password");
      store[V1] = structuredClone(twelve.vault);
      vault = await restart();
      const [unlocked] = (await vault.unlockVault(twelve.password)).wallets;
      const before = structuredClone(store);
      const held = [unlocked.id];

      await expect(vault.addVaultWallet(twentyfour.mnemonic, "an older password", { held })).rejects.toThrow("Incorrect password");
      clearGuard();
      await expect(vault.changeVaultPassword("an older password", "new password", { held })).rejects.toThrow("Incorrect password");
      clearGuard();
      expect(store).toEqual(before);

      await vault.addVaultWallet(twentyfour.mnemonic, twelve.password, { held });
      expect(phrases(await vault.unlockVault(twelve.password))).toEqual([twelve.mnemonic, twentyfour.mnemonic]);
    });

    it("puts the old vault back when the new password's vault doesn't read back", async () => {
      const { vault } = await twoWallets();
      const before = structuredClone(store[V2]);
      // The read after the write answers the vault from before it.
      const storage = (await import("./storage.js")).storage;
      const real = storage.get.getMockImplementation();
      let reads = 0;
      storage.get.mockImplementation(async (keys) => {
        if (keys === V2 && ++reads === 2) return { [V2]: structuredClone(before) };
        return real(keys);
      });

      await expect(vault.changeVaultPassword("password123", "new password")).rejects.toThrow(/couldn't be saved/);
      expect(store[V2]).toEqual(before);
      storage.get.mockImplementation(real);
      expect(phrases(await vault.unlockVault("password123"))).toEqual([twelve.mnemonic, OTHER]);
    });

    it("puts the old vault back when reading the new password's vault back fails", async () => {
      const { vault } = await twoWallets();
      const before = structuredClone(store[V2]);
      // The open reads v2 twice; the third read is the one after the write.
      failAt("get:dusk_vault_v2@3");
      await expect(vault.changeVaultPassword("password123", "new password")).rejects.toThrow(/couldn't be saved/);
      expect(store[V2]).toEqual(before);
    });

    it("refuses changes while v1 is still to move, so a removed wallet can't come back", async () => {
      startWithV1(twelve);
      const vault = await restart();
      failAt("set:dusk_vault_v2");
      await expect(vault.changeVaultPassword(twelve.password, "new password")).rejects.toThrow(/couldn't be saved/);
      expect(store[V1]).toEqual(twelve.vault);
      expect(store[V2]).toBeUndefined();
    });
  });
});
