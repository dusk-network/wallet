import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ERROR_CODES } from "../shared/errors.js";

const SHIELDED_ADDRESS =
  "2Ana1pUpv2ZbMVkwF5FXapYeBEjdxDatLn7nvJkhgTSXbs59SyZSx866bXirPgj8QQVB57uxHJBG1YFvkRbFj4T";

const mocks = vi.hoisted(() => ({
  listener: null,
  sentMessages: [],
  classifyTxPresence: vi.fn(),
  notifyTxExecuted: vi.fn(async () => true),
  requestUserApproval: vi.fn(async () => null),
}));

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

vi.mock("../shared/txLifecycle.js", async (importOriginal) => ({
  ...(await importOriginal()),
  classifyTxPresence: mocks.classifyTxPresence,
}));

vi.mock("../background/engineHost.js", () => ({
  engineCall: vi.fn(async () => true),
  ensureEngineConfigured: vi.fn(async () => true),
  getEngineStatus: vi.fn(async () => ({
    isUnlocked: true,
    accounts: ["acct0"],
    addresses: ["addr0"],
    selectedAccountIndex: 0,
  })),
  invalidateEngineConfig: vi.fn(() => {}),
  handleEngineReady: vi.fn(() => {}),
}));

vi.mock("../background/pending.js", () => ({
  getPending: vi.fn(() => null),
  requestUserApproval: mocks.requestUserApproval,
  resolvePendingDecision: vi.fn(() => ({ ok: true })),
}));

vi.mock("../background/dappEvents.js", () => ({
  broadcastChainChangedAll: vi.fn(async () => {}),
  broadcastProfilesChangedAll: vi.fn(async () => {}),
  bindPortsForSenderOrigin: vi.fn(() => {}),
  registerDappPort: vi.fn(() => {}),
  registerStorageChangeForwarder: vi.fn(() => {}),
}));

vi.mock("../background/txNotify.js", () => ({
  notifyTxSubmitted: vi.fn(async () => true),
  notifyTxExecuted: mocks.notifyTxExecuted,
  registerTxNotificationHandlers: vi.fn(() => {}),
}));

vi.mock("../shared/vault.js", () => ({
  createVault: vi.fn(async () => ({ ok: true })),
  loadVault: vi.fn(async () => ({ v: 1 })),
  unlockVault: vi.fn(async () => "mnemonic"),
}));

vi.mock("../shared/accountNames.js", () => ({
  getAccountNames: vi.fn(async () => ({})),
}));

vi.mock("../shared/assetsStore.js", () => ({
  getWatchedAssets: vi.fn(async () => ({ tokens: [], nfts: [] })),
  watchToken: vi.fn(async () => true),
  unwatchToken: vi.fn(async () => true),
  watchNft: vi.fn(async () => true),
  unwatchNft: vi.fn(async () => true),
}));

vi.mock("../shared/networkStatus.js", () => ({
  getNetworkStatus: vi.fn(async () => ({ checkedAt: 0 })),
  checkAllEndpoints: vi.fn(async () => ({ ok: true })),
  resetNetworkStatus: vi.fn(async () => {}),
  isStatusStale: vi.fn(() => false),
}));

vi.mock("../platform/extensionApi.js", () => ({
  getExtensionApi: () => ({
    runtime: {
      id: "test-runtime",
      getManifest: () => ({ version: "0.0.0-test" }),
      onMessage: {
        addListener: (fn) => {
          mocks.listener = fn;
        },
      },
      onInstalled: { addListener: vi.fn() },
      onConnect: { addListener: vi.fn() },
    },
    alarms: {
      clear: vi.fn(),
      create: vi.fn(),
      onAlarm: { addListener: vi.fn() },
    },
  }),
  alarmsClear: vi.fn(async () => true),
  runtimeGetURL: (p) => String(p ?? ""),
  runtimeSendMessage: vi.fn(async (message) => {
    mocks.sentMessages.push(message);
    return { ok: true };
  }),
  storageSessionGet: vi.fn(async () => ({})),
  storageSessionSet: vi.fn(async () => {}),
  storageSessionRemove: vi.fn(async () => {}),
  tabsCreate: vi.fn(async () => ({ id: 1 })),
}));

async function importBackground() {
  await import("./index.js");
  expect(mocks.listener).toBeTypeOf("function");
}

async function sendBackgroundMessage(message) {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("sendResponse timed out")), 1000);
    mocks.listener(message, {}, (response) => {
      clearTimeout(timeout);
      resolve(response);
    });
  });
}

async function seedTxMeta(hash, patch = {}) {
  const { putTxMeta } = await import("../shared/txStore.js");
  await putTxMeta(hash, {
    origin: "Wallet",
    nodeUrl: "https://testnet.nodes.dusk.network",
    kind: "transfer",
    privacy: "shielded",
    pendingNullifiers: ["aa"],
    reservationStatus: "pending",
    reservationUpdatedAt: 1,
    submittedAt: 1,
    status: "submitted",
    ...patch,
  });
}

describe("background Phoenix tx lifecycle flow", () => {
  let prevLocalStorage = null;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.listener = null;
    mocks.sentMessages = [];

    prevLocalStorage = globalThis.localStorage ?? null;
    globalThis.localStorage = makeLocalStorage();
    globalThis.localStorage.setItem(
      "dusk_settings_v1",
      JSON.stringify({ nodeUrl: "https://testnet.nodes.dusk.network" })
    );

    await importBackground();
  });

  afterEach(() => {
    if (prevLocalStorage) globalThis.localStorage = prevLocalStorage;
    else delete globalThis.localStorage;
  });

  it("reconciles DUSK_TX_UNKNOWN to mempool without releasing Phoenix reservation", async () => {
    const hash = "0xmem";
    await seedTxMeta(hash);
    mocks.classifyTxPresence.mockResolvedValueOnce({ state: "mempool", tx: { id: hash } });

    await expect(
      sendBackgroundMessage({ type: "DUSK_TX_UNKNOWN", hash, reason: "watcher_timeout" })
    ).resolves.toEqual({ ok: true });

    const { getTxMeta } = await import("../shared/txStore.js");
    await expect(getTxMeta(hash)).resolves.toMatchObject({
      status: "mempool",
      reservationStatus: "pending",
      pendingNullifiers: ["aa"],
    });

    expect(mocks.sentMessages).toContainEqual(
      expect.objectContaining({ type: "DUSK_UI_TX_STATUS", hash, status: "mempool" })
    );
    expect(mocks.notifyTxExecuted).not.toHaveBeenCalled();
  });

  it("keeps DUSK_TX_UNKNOWN unknown when tx is neither chain nor mempool", async () => {
    const hash = "0xunknown";
    await seedTxMeta(hash);
    mocks.classifyTxPresence.mockResolvedValueOnce({ state: "not_found" });

    await sendBackgroundMessage({ type: "DUSK_TX_UNKNOWN", hash, reason: "watcher_timeout" });

    const { getTxMeta } = await import("../shared/txStore.js");
    await expect(getTxMeta(hash)).resolves.toMatchObject({
      status: "unknown",
      reservationStatus: "pending",
      pendingNullifiers: ["aa"],
      recoveryReason: "not_found",
    });

    expect(mocks.sentMessages).toContainEqual(
      expect.objectContaining({ type: "DUSK_UI_TX_STATUS", hash, status: "unknown" })
    );
    expect(mocks.sentMessages).not.toContainEqual(
      expect.objectContaining({ type: "DUSK_UI_TX_STATUS", hash, status: "failed" })
    );
  });

  it("marks executed shielded tx reservations spent", async () => {
    const hash = "0xexecuted";
    await seedTxMeta(hash);

    await sendBackgroundMessage({ type: "DUSK_TX_EXECUTED", hash, ok: true });

    const { getTxMeta } = await import("../shared/txStore.js");
    await expect(getTxMeta(hash)).resolves.toMatchObject({
      status: "executed",
      reservationStatus: "spent",
      pendingNullifiers: ["aa"],
    });

    await vi.waitFor(() => expect(mocks.sentMessages).toContainEqual(
      expect.objectContaining({ type: "DUSK_UI_TX_STATUS", hash, status: "executed" })
    ));
  });

  it("marks failed finalized shielded tx reservations spent", async () => {
    const hash = "0xfailed";
    await seedTxMeta(hash);

    await sendBackgroundMessage({
      type: "DUSK_TX_EXECUTED",
      hash,
      ok: false,
      error: "OutOfGas",
    });

    const { getTxMeta } = await import("../shared/txStore.js");
    await expect(getTxMeta(hash)).resolves.toMatchObject({
      status: "failed",
      error: "OutOfGas",
      reservationStatus: "spent",
      pendingNullifiers: ["aa"],
    });
    await vi.waitFor(() => expect(mocks.notifyTxExecuted).toHaveBeenCalledWith(expect.objectContaining({
      hash,
      ok: false,
      error: "OutOfGas",
    })));
  });

  it("still notifies when transaction storage is unavailable", async () => {
    const getItem = globalThis.localStorage.getItem;
    globalThis.localStorage.getItem = () => { throw new Error("storage unavailable"); };

    await sendBackgroundMessage({ type: "DUSK_TX_EXECUTED", hash: "0xstorage", ok: true });
    await vi.waitFor(() => expect(mocks.notifyTxExecuted).toHaveBeenCalledWith({
      hash: "0xstorage",
      origin: "Wallet",
      ok: true,
      error: "",
      nodeUrl: "",
    }));
    globalThis.localStorage.getItem = getItem;
  });

  it("enriches execution from the transaction's original network", async () => {
    const hash = "0xenriched";
    await seedTxMeta(hash, { gasPrice: "1" });
    globalThis.localStorage.setItem(
      "dusk_settings_v1",
      JSON.stringify({ nodeUrl: "https://nodes.dusk.network" })
    );
    mocks.classifyTxPresence.mockResolvedValueOnce({
      state: "executed_failed",
      error: "OutOfGas",
      tx: {
        gasSpent: "9007199254740993",
        blockHash: "block-1",
        blockHeight: "18446744073709551615",
        blockTimestamp: "1753000000",
        tx: { gasPrice: "2" },
      },
    });

    await sendBackgroundMessage({ type: "DUSK_TX_EXECUTED", hash, ok: true });

    const { getTxMeta } = await import("../shared/txStore.js");
    await vi.waitFor(async () => await expect(getTxMeta(hash)).resolves.toMatchObject({
      status: "failed",
      error: "OutOfGas",
      gasSpent: "9007199254740993",
      feePaid: "18014398509481986",
      blockHeight: "18446744073709551615",
      finalizedAt: 1_753_000_000_000,
    }));
    expect(mocks.classifyTxPresence).toHaveBeenCalledWith(
      "https://testnet.nodes.dusk.network",
      hash
    );
  });

  it("does not replace an observed failure with successful enrichment", async () => {
    const hash = "0xobserved-failure";
    await seedTxMeta(hash);
    mocks.classifyTxPresence.mockResolvedValueOnce({
      state: "executed_success",
      tx: { gasSpent: "1", tx: { gasPrice: "2" } },
    });

    await sendBackgroundMessage({ type: "DUSK_TX_EXECUTED", hash, ok: false, error: "OutOfGas" });

    const { getTxMeta } = await import("../shared/txStore.js");
    await vi.waitFor(async () => await expect(getTxMeta(hash)).resolves.toMatchObject({
      status: "failed",
      error: "OutOfGas",
      feePaid: "2",
    }));
  });

  it("keeps a first removed/not-found observation provisional", async () => {
    const hash = "0xremoved";
    await seedTxMeta(hash);
    mocks.classifyTxPresence.mockResolvedValueOnce({ state: "not_found" });

    await sendBackgroundMessage({ type: "DUSK_TX_REMOVED", hash, reason: "removed" });

    const { getTxMeta } = await import("../shared/txStore.js");
    const meta = await getTxMeta(hash);
    expect(meta).toMatchObject({
      status: "unknown",
      reservationStatus: "pending",
      pendingNullifiers: ["aa"],
      recoveryReason: "removed_unconfirmed",
    });
    expect(meta.removedAt).toBeUndefined();
    expect(mocks.notifyTxExecuted).not.toHaveBeenCalled();
  });

  it("lets a later executed event supersede provisional removal", async () => {
    const hash = "0xremoved-then-executed";
    await seedTxMeta(hash);
    mocks.classifyTxPresence.mockResolvedValueOnce({ state: "not_found" });

    await sendBackgroundMessage({ type: "DUSK_TX_REMOVED", hash, reason: "removed" });
    await sendBackgroundMessage({ type: "DUSK_TX_EXECUTED", hash, ok: true });

    const { getTxMeta } = await import("../shared/txStore.js");
    const meta = await getTxMeta(hash);
    expect(meta).toMatchObject({
      status: "executed",
      reservationStatus: "spent",
      pendingNullifiers: ["aa"],
    });
    expect(meta.recoveryReason).toBeUndefined();
    expect(meta.removedAt).toBeUndefined();
  });

  it("timestamps removal only after a second not-found observation", async () => {
    const hash = "0xconfirmed-removed";
    await seedTxMeta(hash);
    mocks.classifyTxPresence.mockResolvedValue({ state: "not_found" });

    await sendBackgroundMessage({ type: "DUSK_TX_REMOVED", hash, reason: "removed" });
    await sendBackgroundMessage({ type: "DUSK_TX_UNKNOWN", hash, reason: "watcher_timeout" });
    await sendBackgroundMessage({ type: "DUSK_TX_UNKNOWN", hash, reason: "watcher_timeout" });
    await sendBackgroundMessage({ type: "DUSK_TX_RECHECK", hash });

    const { getTxMeta } = await import("../shared/txStore.js");
    await expect(getTxMeta(hash)).resolves.toMatchObject({
      status: "removed",
      reservationStatus: "recoverable",
      recoveryReason: "removed",
      removedAt: expect.any(Number),
      reservationUpdatedAt: expect.any(Number),
    });
  });

  it("does not let not-found removal evidence erase execution evidence", async () => {
    const hash = "0xremoved-after-failed";
    await seedTxMeta(hash, {
      status: "failed",
      error: "OutOfGas",
      reservationStatus: "spent",
    });
    mocks.classifyTxPresence.mockResolvedValueOnce({ state: "not_found" });

    await sendBackgroundMessage({ type: "DUSK_TX_REMOVED", hash, reason: "removed" });

    const { getTxMeta } = await import("../shared/txStore.js");
    await expect(getTxMeta(hash)).resolves.toMatchObject({
      status: "failed",
      error: "OutOfGas",
      reservationStatus: "spent",
    });
  });

  it("records a provisional removal when reconciliation is unavailable", async () => {
    const hash = "0xremoved-unavailable";
    await seedTxMeta(hash);
    mocks.classifyTxPresence.mockResolvedValueOnce({
      state: "unavailable",
      error: "node offline",
    });

    await sendBackgroundMessage({ type: "DUSK_TX_REMOVED", hash, reason: "removed" });

    const { getTxMeta } = await import("../shared/txStore.js");
    await expect(getTxMeta(hash)).resolves.toMatchObject({
      status: "unknown",
      recoveryReason: "removed_unconfirmed",
      reservationStatus: "pending",
    });
  });

  it("does not let an unverified removed event erase execution evidence", async () => {
    const hash = "0xremoved-unavailable-terminal";
    await seedTxMeta(hash, {
      status: "failed",
      error: "OutOfGas",
      reservationStatus: "spent",
    });
    mocks.classifyTxPresence.mockResolvedValueOnce({
      state: "unavailable",
      error: "node offline",
    });

    await sendBackgroundMessage({ type: "DUSK_TX_REMOVED", hash, reason: "removed" });

    const { getTxMeta } = await import("../shared/txStore.js");
    await expect(getTxMeta(hash)).resolves.toMatchObject({
      status: "failed",
      error: "OutOfGas",
      reservationStatus: "spent",
    });
  });

  it("rechecks old shielded reservations without clearing pending nullifiers", async () => {
    const hash = "0xrecheck";
    await seedTxMeta(hash, { status: "unknown", recoveryReason: "watcher_timeout" });
    mocks.classifyTxPresence.mockResolvedValueOnce({ state: "mempool", tx: { id: hash } });

    await expect(sendBackgroundMessage({ type: "DUSK_UI_RECHECK_TX", hash })).resolves.toMatchObject({
      ok: true,
      result: { status: "mempool" },
    });

    const { getTxMeta } = await import("../shared/txStore.js");
    await expect(getTxMeta(hash)).resolves.toMatchObject({
      status: "mempool",
      reservationStatus: "pending",
      pendingNullifiers: ["aa"],
    });

    expect(mocks.sentMessages).toContainEqual(
      expect.objectContaining({ type: "DUSK_UI_TX_STATUS", hash, status: "mempool" })
    );
    expect(mocks.sentMessages).not.toContainEqual(
      expect.objectContaining({ type: "DUSK_UI_TX_STATUS", hash, status: "failed" })
    );
    expect(mocks.notifyTxExecuted).not.toHaveBeenCalled();
  });

  it("rechecks old shielded reservations to finalized success and marks reservation spent", async () => {
    const hash = "0xrecheck-success";
    await seedTxMeta(hash, { status: "unknown", recoveryReason: "watcher_timeout" });
    mocks.classifyTxPresence.mockResolvedValueOnce({ state: "executed_success", tx: { id: hash } });

    await expect(sendBackgroundMessage({ type: "DUSK_UI_RECHECK_TX", hash })).resolves.toMatchObject({
      ok: true,
      result: { status: "executed", ok: true },
    });

    const { getTxMeta } = await import("../shared/txStore.js");
    await expect(getTxMeta(hash)).resolves.toMatchObject({
      status: "executed",
      reservationStatus: "spent",
      pendingNullifiers: ["aa"],
    });

    expect(mocks.sentMessages).toContainEqual(
      expect.objectContaining({ type: "DUSK_UI_TX_STATUS", hash, status: "executed", ok: true })
    );
  });

  it("rechecks old shielded reservations to finalized failure and marks reservations spent", async () => {
    const hash = "0xrecheck-failed";
    await seedTxMeta(hash, { status: "unknown", recoveryReason: "watcher_timeout" });
    mocks.classifyTxPresence.mockResolvedValueOnce({
      state: "executed_failed",
      tx: { id: hash },
      error: "OutOfGas",
    });

    await expect(sendBackgroundMessage({ type: "DUSK_UI_RECHECK_TX", hash })).resolves.toMatchObject({
      ok: true,
      result: { status: "failed", ok: false, error: "OutOfGas" },
    });

    const { getTxMeta } = await import("../shared/txStore.js");
    await expect(getTxMeta(hash)).resolves.toMatchObject({
      status: "failed",
      error: "OutOfGas",
      reservationStatus: "spent",
      pendingNullifiers: ["aa"],
    });

    expect(mocks.sentMessages).toContainEqual(
      expect.objectContaining({
        type: "DUSK_UI_TX_STATUS",
        hash,
        status: "failed",
        ok: false,
        error: "OutOfGas",
      })
    );
  });

  it("serializes under-floor Phoenix gas from dApp RPC as INVALID_PARAMS", async () => {
    globalThis.localStorage.setItem(
      "dusk_permissions_v1",
      JSON.stringify({
        "https://dapp.example": {
          profileId: "account:0:acct0",
          accountIndex: 0,
          grants: { publicAccount: true, shieldedReceiveAddress: false },
          connectedAt: 1,
          updatedAt: 1,
        },
      })
    );

    const response = await sendBackgroundMessage({
      type: "DUSK_RPC_REQUEST",
      id: "req-1",
      origin: "https://dapp.example",
      request: {
        method: "dusk_sendTransaction",
        params: {
          kind: "transfer",
          privacy: "shielded",
          to: SHIELDED_ADDRESS,
          amount: "1",
          gas: { limit: "10000000", price: "1" },
        },
      },
    });

    expect(response).toMatchObject({
      error: {
        code: ERROR_CODES.INVALID_PARAMS,
        message: expect.stringContaining("at least 15000000"),
      },
    });
    expect(mocks.requestUserApproval).not.toHaveBeenCalled();
  });
});
