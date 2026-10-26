import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const engine = vi.hoisted(() => ({ sendTransaction: vi.fn() }));

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
  isUnlocked: () => true,
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
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("local sends", () => {
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
