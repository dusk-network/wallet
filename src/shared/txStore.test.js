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

  it("keeps execution evidence observed before submission metadata", async () => {
    const { getTxMeta, patchTxMeta, putTxMeta } = await import("./txStore.js");
    await patchTxMeta("hash-early", { status: "failed", error: "OutOfGas", executedAt: 10 });
    await putTxMeta("hash-early", {
      origin: "Wallet",
      nodeUrl: "https://testnet.nodes.dusk.network",
      kind: "transfer",
      submittedAt: 1,
      status: "submitted",
    });

    await expect(getTxMeta("hash-early")).resolves.toMatchObject({
      origin: "Wallet",
      status: "failed",
      error: "OutOfGas",
    });
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
});
