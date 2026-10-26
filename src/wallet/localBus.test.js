import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const engine = vi.hoisted(() => ({ sendTransaction: vi.fn(), unlocked: true }));

// The wallet engine without the network: a transfer just gets its hash.
vi.mock("../shared/walletEngine.js", () => ({
  // What the local bus maps commands to when it loads.
  ...Object.fromEntries(
    [
      "getMinimumStake",
      "getStakeInfo",
      "getStakeOwnerStatus",
      "getSozuStatus",
      "getDrc20Metadata",
      "getDrc20Balance",
      "encodeDrc20Input",
      "decodeDrc20Input",
      "getDrc721Metadata",
      "getDrc721OwnerOf",
      "getDrc721TokenUri",
      "decodeDrc721Input",
      "setShieldedCheckpointNow",
      "getShieldedHistory",
      "selectAccountIndex",
    ].map((name) => [name, vi.fn()])
  ),
  configure: vi.fn(),
  isUnlocked: () => engine.unlocked,
  lock: () => {
    engine.unlocked = false;
  },
  getAccounts: () => ["acct0"],
  getSelectedAccountIndex: () => 0,
  getCachedGasPrice: vi.fn(async () => ({ median: "1" })),
  sendTransaction: engine.sendTransaction,
  // Execution is never seen here.
  waitTxExecuted: () => new Promise(() => {}),
  waitTxRemoved: () => new Promise(() => {}),
  startShieldedSync: vi.fn(async () => {}),
}));

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

const ACCOUNT =
  "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927";

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
  engine.sendTransaction.mockReset();
  engine.unlocked = true;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("local sends", () => {
  it("keep the profile that paid, which a stake's may not be the one selected", async () => {
    const { localSend } = await import("./localBus.js");
    const { getTxMeta } = await import("../shared/txStore.js");
    engine.sendTransaction.mockResolvedValueOnce({ hash: "cc".repeat(32), nonce: 1n });
    await localSend({ type: "DUSK_UI_SEND_TX", params: { kind: "stake", amount: "1000000000000", profileIndex: 1 } });
    await expect(getTxMeta("cc".repeat(32))).resolves.toMatchObject({ kind: "stake", profileIndex: 1 });
  });

  it("keep nothing of a send that finished after a wallet reset", async () => {
    const { localSend } = await import("./localBus.js");
    const { clearTxs, listTxs } = await import("../shared/txStore.js");
    const sent = Promise.withResolvers();
    engine.sendTransaction.mockReturnValueOnce(sent.promise);
    const params = { kind: "transfer", privacy: "public", to: ACCOUNT, amount: "1" };
    const response = localSend({ type: "DUSK_UI_SEND_TX", params });
    await vi.waitFor(() => expect(engine.sendTransaction).toHaveBeenCalled());
    // The reset's clear, while the send was out.
    await clearTxs();
    sent.resolve({ hash: "dd".repeat(32), nonce: 1n });
    await expect(response).resolves.toMatchObject({ ok: true });
    await expect(listTxs()).resolves.toEqual([]);
  });

  it("keep the .dusk name the recipient was typed as, and nothing that isn't one", async () => {
    const { localSend } = await import("./localBus.js");
    const { listTxs } = await import("../shared/txStore.js");
    const params = { kind: "transfer", privacy: "public", to: ACCOUNT, amount: "1000000000" };

    engine.sendTransaction.mockResolvedValueOnce({ hash: "aa".repeat(32), nonce: 1n });
    await expect(localSend({ type: "DUSK_UI_SEND_TX", params, toName: "alice.dusk" })).resolves.toMatchObject({ ok: true });
    engine.sendTransaction.mockResolvedValueOnce({ hash: "bb".repeat(32), nonce: 2n });
    await localSend({ type: "DUSK_UI_SEND_TX", params, toName: "not a name" });

    const byHash = Object.fromEntries((await listTxs()).map((tx) => [tx.hash, tx]));
    expect(byHash["aa".repeat(32)]).toMatchObject({ to: ACCOUNT, toName: "alice.dusk", status: "submitted" });
    expect(byHash["bb".repeat(32)].toName).toBeUndefined();
  });
});

describe("a wallet reset", () => {
  it("leaves nothing of the old wallet: its transactions, shielded notes and history", async () => {
    const { localSend } = await import("./localBus.js");
    const txs = await import("../shared/txStore.js");
    const shielded = await import("../shared/shieldedStore.js");
    const activity = await import("../shared/activityStore.js");
    const owner = activity.activityOwnerKey("testnet", ACCOUNT);
    await txs.putTxMeta("aa".repeat(32), { status: "executed", submittedAt: 1 });
    await shielded.putNotesMap("net", "acct0", 0, new Map([[new Uint8Array([1]), new Uint8Array([2])]]));
    await activity.commitActivityStep(owner, [{ hash: "bb".repeat(32), blockHeight: 7 }], () => ({ covered: [[0, 9]] }));

    await expect(localSend({ type: "DUSK_UI_RESET_WALLET" })).resolves.toEqual({ ok: true });

    expect(await txs.listTxs()).toEqual([]);
    expect(await shielded.countNotes("net", "acct0", 0)).toBe(0);
    expect(await activity.listActivityEntries(owner)).toEqual([]);
    expect(await activity.getActivityMeta(owner)).toBeNull();
  });

  it("fails while the old wallet's data can't be cleared, and makes no new wallet until it can", async () => {
    const { localSend } = await import("./localBus.js");
    const activity = await import("../shared/activityStore.js");
    const epoch = await activity.getActivityEpoch();
    const clear = vi.spyOn(IDBObjectStore.prototype, "clear").mockImplementation(() => {
      throw new DOMException("The store is gone", "UnknownError");
    });
    try {
      const reset = await localSend({ type: "DUSK_UI_RESET_WALLET" });
      expect(reset.error.message).toMatch(/old wallet.s data couldn.t be cleared/);
      const create = await localSend({ type: "DUSK_UI_CREATE_WALLET", mnemonic: "wallet B", password: "password123" });
      expect(create.error.message).toMatch(/old wallet.s data couldn.t be cleared/);
    } finally {
      clear.mockRestore();
    }
    // The failed clear changed nothing.
    expect(await activity.getActivityEpoch()).toBe(epoch);
  });
});
