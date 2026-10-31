import { afterEach, beforeEach, describe, expect, it } from "vitest";

function makeLocalStorage() {
  const store = new Map();
  return {
    get length() {
      return store.size;
    },
    key(i) {
      return Array.from(store.keys())[i] ?? null;
    },
    getItem(k) {
      return store.get(String(k)) ?? null;
    },
    setItem(k, v) {
      store.set(String(k), String(v));
    },
    removeItem(k) {
      store.delete(String(k));
    },
    clear() {
      store.clear();
    },
  };
}

describe("txStore", () => {
  let prevLocalStorage = null;

  beforeEach(() => {
    prevLocalStorage = globalThis.localStorage ?? null;
    globalThis.localStorage = makeLocalStorage();
  });

  afterEach(() => {
    if (prevLocalStorage) globalThis.localStorage = prevLocalStorage;
    else delete globalThis.localStorage;
  });

  it("preserves expanded lifecycle and Phoenix reservation fields", async () => {
    const { getTxMeta, listTxs, patchTxMeta, putTxMeta } = await import("./txStore.js");

    await putTxMeta("hash-1", {
      origin: "Wallet",
      nodeUrl: "https://testnet.nodes.dusk.network",
      kind: "transfer",
      privacy: "shielded",
      pendingNullifiers: ["aa", "bb"],
      reservationStatus: "pending",
      reservationUpdatedAt: 10,
      submittedAt: 1,
      status: "submitted",
    });

    await patchTxMeta("hash-1", {
      status: "mempool",
      mempoolSeenAt: 20,
      lastCheckedAt: 20,
    });

    await patchTxMeta("hash-1", {
      status: "unknown",
      recoveryReason: "watcher_timeout",
      lastCheckedAt: 30,
    });

    const meta = await getTxMeta("hash-1");
    expect(meta).toMatchObject({
      status: "unknown",
      privacy: "shielded",
      pendingNullifiers: ["aa", "bb"],
      reservationStatus: "pending",
      recoveryReason: "watcher_timeout",
      mempoolSeenAt: 20,
      lastCheckedAt: 30,
    });

    const txs = await listTxs();
    expect(txs[0]).toMatchObject({ hash: "hash-1", status: "unknown" });
  });

  it("keeps early execution evidence when the activity store is full", async () => {
    const { getTxMeta, listTxs, patchTxMeta, putTxMeta } = await import("./txStore.js");
    for (let i = 0; i < 50; i++) {
      await putTxMeta(`hash-${i}`, { submittedAt: i, status: "submitted" });
    }

    await patchTxMeta("hash-early", { status: "failed", error: "OutOfGas", executedAt: 100 });
    await putTxMeta("hash-early", {
      origin: "Wallet",
      nodeUrl: "https://testnet.nodes.dusk.network",
      kind: "transfer",
      privacy: "shielded",
      pendingNullifiers: ["aa"],
      reservationStatus: "pending",
      reservationUpdatedAt: 90,
      submittedAt: 90,
      status: "submitted",
    });

    await expect(getTxMeta("hash-early")).resolves.toMatchObject({
      origin: "Wallet",
      status: "failed",
      error: "OutOfGas",
      pendingNullifiers: ["aa"],
      reservationStatus: "spent",
      reservationUpdatedAt: 100,
    });
    await expect(listTxs()).resolves.toHaveLength(50);
  });

  it("clears stale removal evidence when the transaction returns", async () => {
    const { getTxMeta, patchTxMeta, putTxMeta } = await import("./txStore.js");
    await putTxMeta("hash-removed", {
      submittedAt: 1,
      status: "removed",
      recoveryReason: "removed",
      removedAt: 10,
    });

    await patchTxMeta("hash-removed", { status: "mempool" });
    let meta = await getTxMeta("hash-removed");
    expect(meta.recoveryReason).toBeUndefined();
    expect(meta.removedAt).toBeUndefined();

    await patchTxMeta("hash-removed", {
      status: "removed",
      recoveryReason: "removed",
      removedAt: 20,
    });
    await patchTxMeta("hash-removed", { status: "executed", executedAt: 30 });
    meta = await getTxMeta("hash-removed");
    expect(meta.status).toBe("executed");
    expect(meta.recoveryReason).toBeUndefined();
    expect(meta.removedAt).toBeUndefined();
  });

  it("does not downgrade terminal execution evidence", async () => {
    const { getTxMeta, patchTxMeta, putTxMeta } = await import("./txStore.js");
    await putTxMeta("hash-terminal", {
      status: "failed",
      error: "OutOfGas",
      executedAt: 10,
      reservationStatus: "spent",
      reservationUpdatedAt: 10,
      submittedAt: 1,
    });

    await patchTxMeta("hash-terminal", {
      status: "removed",
      error: undefined,
      reservationStatus: "recoverable",
      reservationUpdatedAt: 20,
      removedAt: 20,
    });

    const meta = await getTxMeta("hash-terminal");
    expect(meta).toMatchObject({
      status: "failed",
      error: "OutOfGas",
      executedAt: 10,
      reservationStatus: "spent",
      reservationUpdatedAt: 10,
    });
    expect(meta.removedAt).toBeUndefined();
  });

  it("drops what work begun before a reset writes after it", async () => {
    const { clearTxs, getTxEpoch, listTxs, patchTxMeta, putTxMeta } = await import("./txStore.js");
    const before = await getTxEpoch();
    await clearTxs();
    // A send and its watcher from before the reset.
    await putTxMeta("hash-old", { submittedAt: 1, status: "submitted" }, { epoch: before });
    await patchTxMeta("hash-old", { status: "executed", executedAt: 2 }, { epoch: before });
    await expect(listTxs()).resolves.toEqual([]);
    // The new wallet's own, from after it.
    const after = await getTxEpoch();
    expect(after).toBe(before + 1);
    await putTxMeta("hash-new", { submittedAt: 3, status: "submitted" }, { epoch: after });
    await patchTxMeta("hash-new", { status: "executed" }, { epoch: after });
    await expect(listTxs()).resolves.toMatchObject([{ hash: "hash-new", status: "executed" }]);
  });

  it("forgets every transaction when the wallet is reset", async () => {
    const { clearTxs, listTxs, putTxMeta } = await import("./txStore.js");
    await putTxMeta("hash-a", { status: "submitted", submittedAt: 1 });
    await putTxMeta("hash-b", { status: "executed", submittedAt: 2 });
    await clearTxs();
    expect(await listTxs()).toEqual([]);
  });

  it("lists each wallet's own transactions, and keeps the newest 50 of each", async () => {
    const { listTxs, putTxMeta } = await import("./txStore.js");
    for (let i = 0; i < 55; i++) await putTxMeta(`w1-${i}`, { walletId: "w1", nodeUrl: "n", submittedAt: 100 + i, status: "submitted" });
    await putTxMeta("w2-0", { walletId: "w2", nodeUrl: "n", submittedAt: 1, status: "submitted" });

    const one = await listTxs({ nodeUrl: "n", walletId: "w1" });
    expect(one).toHaveLength(50);
    expect(one.at(-1).hash).toBe("w1-5");
    // The other wallet's oldest isn't pushed out by the first's newer ones.
    await expect(listTxs({ walletId: "w2" })).resolves.toMatchObject([{ hash: "w2-0" }]);
    // A locked wallet lists none.
    await expect(listTxs({ walletId: "" })).resolves.toEqual([]);
  });

  it("makes the records from before its wallet's own, and nothing that's only part of one", async () => {
    const { adoptLegacyTxs, forgetTxs, listTxs, patchTxMeta, putTxMeta } = await import("./txStore.js");
    await putTxMeta("old-a", { nodeUrl: "n", kind: "transfer", submittedAt: 1, status: "executed" });
    await putTxMeta("old-b", { nodeUrl: "n", kind: "transfer", submittedAt: 2, status: "submitted" });
    await putTxMeta("w2-a", { walletId: "w2", nodeUrl: "n", submittedAt: 3, status: "submitted" });
    await forgetTxs(["old-gone"]);
    // A late watcher's write for a send no record holds.
    await patchTxMeta("stray", { status: "executed" });

    await expect(adoptLegacyTxs("w1")).resolves.toBe(2);
    await expect(listTxs({ walletId: "w1" })).resolves.toMatchObject([{ hash: "old-b" }, { hash: "old-a" }]);
    await expect(listTxs({ walletId: "w2" })).resolves.toMatchObject([{ hash: "w2-a" }]);
    await expect(adoptLegacyTxs("w2")).resolves.toBe(0);
  });

  it("forgets a removed wallet's transactions and no other's, and keeps the reset count", async () => {
    const { forgetWalletTxs, getTxEpoch, listTxs, putTxMeta } = await import("./txStore.js");
    const epoch = await getTxEpoch();
    await putTxMeta("w1-a", { walletId: "w1", submittedAt: 1, status: "submitted" });
    await putTxMeta("w2-a", { walletId: "w2", submittedAt: 2, status: "submitted" });

    await forgetWalletTxs("w1");
    await expect(listTxs({ walletId: "w1" })).resolves.toEqual([]);
    await expect(listTxs({ walletId: "w2" })).resolves.toMatchObject([{ hash: "w2-a" }]);
    await expect(getTxEpoch()).resolves.toBe(epoch);
    // The other wallet's send still writes.
    await putTxMeta("w2-b", { walletId: "w2", submittedAt: 3, status: "submitted" }, { epoch });
    await expect(listTxs({ walletId: "w2" })).resolves.toHaveLength(2);
  });
});
