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

    // A new wallet waits for it.
    await expect(reset.finishPendingReset()).rejects.toThrow("couldn't be cleared");
    fail.shielded = false;
    await reset.finishPendingReset();
    expect(await pending()).toBe(false);
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
    await reset.finishPendingReset();
    expect(await txs.listTxs()).toHaveLength(1);
  });
});
