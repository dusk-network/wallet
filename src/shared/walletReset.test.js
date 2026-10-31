import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The shielded cache's clear, made to fail on demand.
const fail = vi.hoisted(() => ({ shielded: false }));
vi.mock("./shieldedStore.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    clearShieldedStore: async () => {
      if (fail.shielded) throw new Error("IndexedDB is gone");
      return actual.clearShieldedStore();
    },
  };
});

function memoryStorage() {
  const store = new Map();
  return {
    get length() {
      return store.size;
    },
    key: (i) => [...store.keys()][i] ?? null,
    getItem: (k) => store.get(String(k)) ?? null,
    setItem: (k, v) => store.set(String(k), String(v)),
    removeItem: (k) => store.delete(String(k)),
    clear: () => store.clear(),
  };
}

let reset;
let txs;
let activity;

beforeEach(async () => {
  vi.stubGlobal("localStorage", memoryStorage());
  fail.shielded = false;
  reset = await import("./walletReset.js");
  txs = await import("./txStore.js");
  activity = await import("./activityStore.js");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const pending = async () => {
  const { storage, STORAGE_KEYS } = await import("./storage.js");
  return Boolean((await storage.get(STORAGE_KEYS.RESET_PENDING))[STORAGE_KEYS.RESET_PENDING]);
};

describe("walletReset", () => {
  it("clears the old wallet's data and ends the reset", async () => {
    await txs.putTxMeta("aa".repeat(32), { status: "executed", submittedAt: 1 });
    await reset.beginReset();
    expect(await pending()).toBe(true);
    await reset.finishReset();
    expect(await txs.listTxs()).toEqual([]);
    expect(await pending()).toBe(false);
  });

  it("keeps the contacts of a wallet restored in place of the old one, and only those", async () => {
    const { storage, STORAGE_KEYS } = await import("./storage.js");
    const { contactsNamespace } = await import("./contactsCrypto.js");
    const [mine, theirs] = await Promise.all([contactsNamespace("acct-restored"), contactsNamespace("acct-other")]);
    await storage.set({ [STORAGE_KEYS.CONTACTS]: { [mine]: { v: 1 }, [theirs]: { v: 1 } } });
    await reset.beginReset();
    await reset.finishReset({ keepContactsOf: "acct-restored" });
    expect((await storage.get(STORAGE_KEYS.CONTACTS))[STORAGE_KEYS.CONTACTS]).toEqual({ [mine]: { v: 1 } });
    // A plain reset keeps none.
    await reset.finishReset();
    expect(await storage.get(STORAGE_KEYS.CONTACTS)).toEqual({});
  });

  it("tries every store when one can't be cleared, fails, and stays pending until it can", async () => {
    const owner = activity.activityOwnerKey("testnet", "acct");
    await txs.putTxMeta("aa".repeat(32), { status: "executed", submittedAt: 1 });
    await activity.commitActivityStep(owner, [{ hash: "bb".repeat(32), blockHeight: 1 }], () => ({ covered: [] }));
    fail.shielded = true;
    await reset.beginReset();
    await expect(reset.finishReset()).rejects.toThrow("couldn't be cleared");
    // The others were cleared all the same.
    expect(await txs.listTxs()).toEqual([]);
    expect(await activity.listActivityEntries(owner)).toEqual([]);
    expect(await pending()).toBe(true);

    // A new wallet waits for it; the reset ends once that wallet's vault is made.
    await expect(reset.finishPendingReset()).rejects.toThrow("couldn't be cleared");
    fail.shielded = false;
    await expect(reset.finishPendingReset()).resolves.toEqual({ pending: true, keepContactsOf: null });
    expect(await pending()).toBe(true);
    await reset.endReset();
    expect(await pending()).toBe(false);
  });

  it("notes the wallet a restore makes until its vault is, so a restore cut short keeps only that wallet's contacts", async () => {
    const { storage, STORAGE_KEYS } = await import("./storage.js");
    const { contactsNamespace } = await import("./contactsCrypto.js");
    const [mine, theirs] = await Promise.all([contactsNamespace("acct-restored"), contactsNamespace("acct-other")]);
    await storage.set({ [STORAGE_KEYS.CONTACTS]: { [mine]: { v: 1 }, [theirs]: { v: 1 } } });
    await reset.beginReset({ keepContactsOf: "acct-restored" });
    await reset.clearWalletData({ keepContactsOf: "acct-restored" });
    // Cut short here, before the vault: still noted, with its wallet.
    expect(await pending()).toBe(true);
    // The next wallet made here learns which, and keeps only that wallet's contacts meanwhile.
    await storage.set({ [STORAGE_KEYS.CONTACTS]: { [mine]: { v: 1 }, [theirs]: { v: 1 } } });
    await expect(reset.finishPendingReset()).resolves.toEqual({ pending: true, keepContactsOf: "acct-restored" });
    expect((await storage.get(STORAGE_KEYS.CONTACTS))[STORAGE_KEYS.CONTACTS]).toEqual({ [mine]: { v: 1 } });
    expect(await pending()).toBe(true);
  });

  it("deletes the contacts: every wallet's record and any plain copy from before", async () => {
    const { storage, STORAGE_KEYS } = await import("./storage.js");
    await storage.set({
      [STORAGE_KEYS.CONTACTS]: { place: { v: 1, iv: "aXY=", data: "ZGF0YQ==" } },
      [STORAGE_KEYS.ADDRESS_BOOK]: { 1: { id: "1", name: "Alice (landlord, private)", address: "addr" } },
    });
    await reset.beginReset();
    await reset.finishReset();
    expect(await storage.get([STORAGE_KEYS.CONTACTS, STORAGE_KEYS.ADDRESS_BOOK])).toEqual({});
    expect(await pending()).toBe(false);
  });

  it("does nothing more for a wallet made without a pending reset", async () => {
    await txs.putTxMeta("aa".repeat(32), { status: "executed", submittedAt: 1 });
    await expect(reset.finishPendingReset()).resolves.toEqual({ pending: false, keepContactsOf: null });
    expect(await txs.listTxs()).toHaveLength(1);
  });

  it("forgets a removed wallet's data, and nothing of another's", async () => {
    const { storage, STORAGE_KEYS } = await import("./storage.js");
    const permissions = await import("./permissions.js");
    const names = await import("./accountNames.js");
    const assets = await import("./assetsStore.js");
    const arrivals = await import("./bridgeArrival.js");
    const notes = await import("./shieldedStore.js");
    const { contactsNamespace } = await import("./contactsCrypto.js");
    const wallets = { gone: ["gone0", "gone1"], kept: ["kept0", "kept1"] };
    const epoch = await txs.getTxEpoch();
    for (const [w, accounts] of Object.entries(wallets)) {
      const id = accounts[0];
      await permissions.approveOrigin("https://site.example", { profileId: `account:0:${id}`, accountIndex: 0 }, id);
      await txs.putTxMeta(`${w}-tx`, { walletId: id, status: "executed", submittedAt: 1 });
      await arrivals.keepArrivals({ [`${w}-deposit`]: { hash: `0x${"ab".repeat(32)}`, at: 1 } }, epoch, id);
      await names.setAccountName(id, 0, `${w} label`);
      await assets.watchToken(id, "https://testnet.nodes.dusk.network", 0, { contractId: `0x${"cd".repeat(32)}`, name: "T", symbol: "T", decimals: 0 });
      await notes.putShieldedMeta("testnet", id, 1, { cursorBlock: "5" });
      await activity.commitActivityStep(activity.activityOwnerKey("testnet", accounts[1]), [{ hash: `${w}`.padEnd(64, "0"), blockHeight: 1 }], () => ({ covered: [] }));
      await activity.putShieldedHistoryRecord(`testnet::${id}::0`, { entries: [] });
    }
    const [gonePlace, keptPlace] = await Promise.all([contactsNamespace("gone0"), contactsNamespace("kept0")]);
    await storage.set({ [STORAGE_KEYS.CONTACTS]: { [gonePlace]: { v: 1 }, [keptPlace]: { v: 1 } } });

    await expect(reset.forgetWalletData({ walletId: "gone0", accounts: wallets.gone })).resolves.toBe(true);

    await expect(permissions.getPermissions("gone0")).resolves.toEqual({});
    await expect(permissions.getPermissions("kept0")).resolves.toHaveProperty(["https://site.example"]);
    await expect(txs.listTxs({ walletId: "gone0" })).resolves.toEqual([]);
    await expect(txs.listTxs({ walletId: "kept0" })).resolves.toHaveLength(1);
    await arrivals.loadArrivals("kept0");
    expect(arrivals.keptArrivals().has("kept-deposit")).toBe(true);
    await arrivals.loadArrivals("gone0");
    expect(arrivals.keptArrivals().size).toBe(0);
    await expect(names.getAccountNames("gone0")).resolves.toEqual({});
    await expect(names.getAccountNames("kept0")).resolves.toEqual({ 0: "kept label" });
    await expect(assets.getWatchedAssets("gone0", "https://testnet.nodes.dusk.network", 0)).resolves.toEqual({ tokens: [], nfts: [] });
    expect((await assets.getWatchedAssets("kept0", "https://testnet.nodes.dusk.network", 0)).tokens).toHaveLength(1);
    expect((await storage.get(STORAGE_KEYS.CONTACTS))[STORAGE_KEYS.CONTACTS]).toEqual({ [keptPlace]: { v: 1 } });
    await expect(notes.getShieldedMeta("testnet", "gone0", 1)).resolves.toBeNull();
    await expect(notes.getShieldedMeta("testnet", "kept0", 1)).resolves.toMatchObject({ cursorBlock: "5" });
    await expect(activity.listActivityEntries(activity.activityOwnerKey("testnet", "gone1"))).resolves.toEqual([]);
    await expect(activity.listActivityEntries(activity.activityOwnerKey("testnet", "kept1"))).resolves.toHaveLength(1);
    await expect(activity.getShieldedHistoryRecord("testnet::gone0::0")).resolves.toBeNull();
    await expect(activity.getShieldedHistoryRecord("testnet::kept0::0")).resolves.toMatchObject({ entries: [] });
    // Nothing of a reset: the stores' reset counts stay.
    await expect(txs.getTxEpoch()).resolves.toBe(epoch);
  });

  it("forgets the wallets' names and the one unlocked last with a reset", async () => {
    const wallets = await import("./wallets.js");
    await wallets.noteActiveWallet("key-1", { walletId: "acct", accounts: ["acct", "acct1"] });
    await wallets.setWalletName("key-1", "Savings");
    await reset.finishReset();
    await expect(wallets.getWalletDirectory()).resolves.toEqual({ active: "", wallets: {} });
  });
});
