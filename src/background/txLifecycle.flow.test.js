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
  bindPendingWallet: vi.fn(() => true),
  alarmListeners: [],
  alarmsCreate: vi.fn(),
  // Whether the node answers when it's asked whether it does.
  nodeAnswers: true,
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
  getEngineStatusStrict: vi.fn(async () => ({
    isUnlocked: true,
    accounts: ["acct0"],
    addresses: ["addr0"],
    selectedAccountIndex: 0,
  })),
  invalidateEngineConfig: vi.fn(() => {}),
  handleEngineReady: vi.fn(() => {}),
  // Firefox's engine tab closing: the background's listener, for a test to close it.
  onEngineClosed: vi.fn((listener) => {
    mocks.engineClosed = listener;
  }),
}));

// The waiting requests themselves, and how they end, as pending.js keeps them.
vi.mock("../background/pending.js", async (importOriginal) => ({
  ...(await importOriginal()),
  bindPendingWallet: mocks.bindPendingWallet,
  getPending: vi.fn(() => null),
  requestUserApproval: mocks.requestUserApproval,
  resolvePendingDecision: vi.fn(() => ({ ok: true })),
}));

vi.mock("../background/dappEvents.js", () => ({
  broadcastChainChangedAll: vi.fn(async () => {}),
  broadcastProfilesChangedAll: vi.fn(async () => {}),
  bindPortsForSenderOrigin: vi.fn(() => {}),
  providerStateFor: vi.fn(async () => ({})),
  registerDappPort: vi.fn(() => {}),
  registerStorageChangeForwarder: vi.fn(() => {}),
}));

vi.mock("../background/txNotify.js", () => ({
  askPhoneNotices: vi.fn(async () => "asked"),
  notifyTxSubmitted: vi.fn(async () => true),
  notifyTxExecuted: mocks.notifyTxExecuted,
  registerTxNotificationHandlers: vi.fn(() => {}),
}));

vi.mock("../shared/vault.js", () => ({
  // The vault's check of a password, for the wallet open.
  checkVaultPassword: vi.fn(async (password, id) => {
    if (password !== "the password" || id !== "wallet-key") throw new Error("Incorrect password");
  }),
  // Three wallets in the vault: the two the password opened, and one another opens.
  countVaultWallets: vi.fn(async () => 3),
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

vi.mock("../shared/networkStatus.js", async (importOriginal) => ({
  // How often it checks, and what a check said, as the wallet has them.
  checkEveryMs: (await importOriginal()).checkEveryMs,
  statusWords: (await importOriginal()).statusWords,
  getNetworkStatus: vi.fn(async () => ({ checkedAt: 0 })),
  checkAllEndpoints: vi.fn(async () => ({ ok: true })),
  resetNetworkStatus: vi.fn(async () => {}),
  isStatusStale: vi.fn(() => false),
  chainIdForChoice: vi.fn(async () => null),
  statusChainRefusal: vi.fn(() => ""),
  checkNode: vi.fn(async (nodeUrl) => ({ nodeStatus: mocks.nodeAnswers ? "online" : "offline", nodeUrl })),
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
      create: mocks.alarmsCreate,
      onAlarm: {
        addListener: (fn) => {
          mocks.alarmListeners.push(fn);
        },
      },
    },
  }),
  alarmsClear: vi.fn(async () => true),
  runtimeGetURL: (p) => `chrome-extension://wallet/${p ?? ""}`,
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

async function sendBackgroundMessage(message, sender = {}) {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("sendResponse timed out")), 1000);
    mocks.listener(message, sender, (response) => {
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

    await sendBackgroundMessage({ type: "DUSK_TX_EXECUTED", hash, ok: true, blockHeight: "4700000" });

    const { getTxMeta } = await import("../shared/txStore.js");
    await expect(getTxMeta(hash)).resolves.toMatchObject({
      status: "executed",
      reservationStatus: "spent",
      pendingNullifiers: ["aa"],
      // Its block, for Completed to read a stake's stDUSK there as it goes through.
      blockHeight: "4700000",
    });

    await vi.waitFor(() => expect(mocks.sentMessages).toContainEqual(
      expect.objectContaining({ type: "DUSK_UI_TX_STATUS", hash, status: "executed", blockHeight: "4700000" })
    ));
  });

  it("tells the UI the block the node has it in now, where it went in again in another", async () => {
    const hash = "0xreincluded";
    await seedTxMeta(hash);
    mocks.classifyTxPresence.mockResolvedValueOnce({ state: "executed_success", tx: { id: hash, blockHeight: 4_700_005, gasSpent: "1", tx: { gasPrice: "1" } } });

    await sendBackgroundMessage({ type: "DUSK_TX_EXECUTED", hash, ok: true, blockHeight: "4700000" });

    const { getTxMeta } = await import("../shared/txStore.js");
    await vi.waitFor(() => expect(mocks.sentMessages).toContainEqual(expect.objectContaining({ type: "DUSK_UI_TX_STATUS", hash, status: "executed" })));
    const told = mocks.sentMessages.find((m) => m.type === "DUSK_UI_TX_STATUS" && m.hash === hash);
    await expect(getTxMeta(hash)).resolves.toMatchObject({ blockHeight: "4700005" });
    expect(told.blockHeight).toBe("4700005");
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

  it.each([
    {
      name: "rechecks old shielded reservations without clearing pending nullifiers",
      presence: { state: "mempool" },
      result: { status: "mempool" },
      stored: { status: "mempool", reservationStatus: "pending" },
    },
    {
      name: "rechecks old shielded reservations to finalized success and marks reservation spent",
      presence: { state: "executed_success" },
      result: { status: "executed", ok: true },
      stored: { status: "executed", reservationStatus: "spent" },
    },
    {
      name: "rechecks old shielded reservations to finalized failure and marks reservations spent",
      presence: { state: "executed_failed", error: "OutOfGas" },
      result: { status: "failed", ok: false, error: "OutOfGas" },
      stored: { status: "failed", error: "OutOfGas", reservationStatus: "spent" },
    },
  ])("$name", async ({ presence, result, stored }) => {
    const hash = `0xrecheck-${presence.state}`;
    await seedTxMeta(hash, { status: "unknown", recoveryReason: "watcher_timeout" });
    mocks.classifyTxPresence.mockResolvedValueOnce({ ...presence, tx: { id: hash } });

    await expect(sendBackgroundMessage({ type: "DUSK_UI_RECHECK_TX", hash })).resolves.toMatchObject({ ok: true, result });

    // The reserved notes stay with it, whatever the recheck found.
    const { getTxMeta } = await import("../shared/txStore.js");
    await expect(getTxMeta(hash)).resolves.toMatchObject({ ...stored, pendingNullifiers: ["aa"] });

    // One status, the one found; a recheck notifies nothing.
    const statuses = mocks.sentMessages.filter((m) => m.type === "DUSK_UI_TX_STATUS" && m.hash === hash);
    expect(statuses).toEqual([expect.objectContaining(result)]);
    expect(mocks.notifyTxExecuted).not.toHaveBeenCalled();
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
        message: expect.stringContaining("at least 30000000"),
      },
    });
    expect(mocks.requestUserApproval).not.toHaveBeenCalled();
  });

  it("changes a site's connection only for the wallet its page showed", async () => {
    const { approveOrigin, getPermissions } = await import("../shared/permissions.js");
    const origin = "https://dapp.example";
    await approveOrigin(origin, { profileId: "account:0:acct0", accountIndex: 0, grants: { publicAccount: true } }, "acct0");
    const before = await getPermissions("acct0");
    for (const message of [
      { type: "DUSK_UI_DISCONNECT_ORIGIN", origin },
      { type: "DUSK_UI_CLEAR_PERMISSIONS" },
      { type: "DUSK_UI_CONNECT_ORIGIN", origin },
      { type: "DUSK_UI_SET_ORIGIN_ACCOUNT", origin, accountIndex: 0 },
    ]) {
      await expect(sendBackgroundMessage({ ...message, walletId: "acct9" })).resolves.toMatchObject({
        error: { message: "The wallet changed meanwhile." },
      });
    }
    await expect(getPermissions("acct0")).resolves.toEqual(before);
    await expect(sendBackgroundMessage({ type: "DUSK_UI_DISCONNECT_ORIGIN", origin, walletId: "acct0" })).resolves.toMatchObject({ ok: true });
    await expect(getPermissions("acct0")).resolves.toEqual({});
  });

  it("lists every wallet's connected sites by wallet, and disconnects a site from its own", async () => {
    const { getEngineStatus } = await import("../background/engineHost.js");
    const { approveOrigin, getPermissions } = await import("../shared/permissions.js");
    const { noteActiveWallet } = await import("../shared/wallets.js");
    const two = { isUnlocked: true, accounts: ["acct0"], addresses: ["addr0"], selectedAccountIndex: 0, walletKey: "k1", wallets: [{ key: "k1", n: 1 }, { key: "k2", n: 2 }] };
    getEngineStatus.mockResolvedValue(two);
    await noteActiveWallet("k2", { walletId: "acct9", accounts: ["acct9"] });
    await noteActiveWallet("k1", { walletId: "acct0", accounts: ["acct0"] });
    const grant = (profileId) => ({ profileId, accountIndex: 0, grants: { publicAccount: true } });
    await approveOrigin("https://shop.example", grant("account:0:acct0"), "acct0");
    await approveOrigin("https://app.example", grant("account:0:acct9"), "acct9");
    try {
      const overview = await sendBackgroundMessage({ type: "DUSK_UI_OVERVIEW" });
      // Settings' Lock text counts the vault's wallets.
      expect([overview.wallets.length, overview.walletsHere]).toEqual([2, 3]);
      expect(overview.permissions.map(({ origin, walletId }) => [origin, walletId])).toEqual([
        ["https://shop.example", "acct0"],
        ["https://app.example", "acct9"],
      ]);

      await expect(sendBackgroundMessage({ type: "DUSK_UI_DISCONNECT_ORIGIN", origin: "https://app.example", siteWallet: "acct9", walletId: "acct0" })).resolves.toMatchObject({ ok: true });
      await expect(getPermissions("acct9")).resolves.toEqual({});
      expect(Object.keys(await getPermissions("acct0"))).toEqual(["https://shop.example"]);

      await approveOrigin("https://app.example", grant("account:0:acct9"), "acct9");
      await expect(sendBackgroundMessage({ type: "DUSK_UI_CLEAR_PERMISSIONS", siteWallets: ["acct0", "acct9"], walletId: "acct0" })).resolves.toMatchObject({ ok: true });
      expect([await getPermissions("acct0"), await getPermissions("acct9")]).toEqual([{}, {}]);
    } finally {
      getEngineStatus.mockReset();
      getEngineStatus.mockResolvedValue({ isUnlocked: true, accounts: ["acct0"], addresses: ["addr0"], selectedAccountIndex: 0 });
    }
  });

  it("names the wallet a site's request is bound to beside its profiles, with more than one wallet", async () => {
    const { getEngineStatus } = await import("../background/engineHost.js");
    const { getPending } = await import("../background/pending.js");
    const { setWalletName } = await import("../shared/wallets.js");
    const two = { isUnlocked: true, accounts: ["acct0"], addresses: ["addr0"], selectedAccountIndex: 0, walletKey: "k2", wallets: [{ key: "k1", n: 1 }, { key: "k2", n: 2 }] };
    getEngineStatus.mockResolvedValue(two);
    getPending.mockReturnValue({ kind: "connect", origin: "https://dapp.example", params: {}, shown: { walletId: "acct0" } });
    const asked = async () => (await sendBackgroundMessage({ type: "DUSK_GET_PENDING", rid: "rid-1" }))?.walletName;
    try {
      await expect(asked()).resolves.toBe("Wallet 2");
      await setWalletName("k2", "Savings");
      await expect(asked()).resolves.toBe("Savings");
      // One wallet: no name, as before.
      getEngineStatus.mockResolvedValue({ ...two, wallets: [{ key: "k2", n: 2 }] });
      await expect(asked()).resolves.toBe("");
    } finally {
      getPending.mockReset();
      getPending.mockReturnValue(null);
      getEngineStatus.mockReset();
      getEngineStatus.mockResolvedValue({ isUnlocked: true, accounts: ["acct0"], addresses: ["addr0"], selectedAccountIndex: 0 });
    }
  });

  describe("a site connected to two wallets, with a request waiting on the open one", () => {
    const origin = "https://shop.example";
    // Waiting on wallet A (acct0, open); wallet B is acct9.
    async function waiting() {
      const { pendingApprovals } = await import("../background/pending.js");
      const onA = { kind: "send_tx", origin, params: {}, shown: { walletId: "acct0" }, createdAt: Date.now(), resolve: vi.fn(), reject: vi.fn() };
      // Asked while locked: its window will show the wallet open.
      const unshown = { kind: "connect", origin: "https://other.example", params: {}, shown: { walletId: "" }, createdAt: Date.now(), resolve: vi.fn(), reject: vi.fn() };
      pendingApprovals.set("rid-a", onA);
      pendingApprovals.set("rid-unshown", unshown);
      return { pendingApprovals, onA, unshown };
    }

    it("keeps it when the site's row for the other wallet is disconnected, and ends it with its own", async () => {
      const { pendingApprovals, onA } = await waiting();
      try {
        await expect(sendBackgroundMessage({ type: "DUSK_UI_DISCONNECT_ORIGIN", origin, siteWallet: "acct9", walletId: "acct0" })).resolves.toMatchObject({ ok: true });
        expect(onA.reject).not.toHaveBeenCalled();
        expect(pendingApprovals.has("rid-a")).toBe(true);

        await expect(sendBackgroundMessage({ type: "DUSK_UI_DISCONNECT_ORIGIN", origin, walletId: "acct0" })).resolves.toMatchObject({ ok: true });
        expect(onA.reject).toHaveBeenCalledWith(expect.objectContaining({ message: "Site disconnected" }));
        expect(pendingApprovals.has("rid-a")).toBe(false);
      } finally {
        pendingApprovals.clear();
      }
    });

    it("keeps the open wallet's requests when only the other wallet's sites are disconnected, and ends them with its own", async () => {
      const { pendingApprovals, onA, unshown } = await waiting();
      try {
        await expect(sendBackgroundMessage({ type: "DUSK_UI_CLEAR_PERMISSIONS", siteWallets: ["acct9"], walletId: "acct0" })).resolves.toMatchObject({ ok: true });
        expect([onA.reject, unshown.reject].map((fn) => fn.mock.calls.length)).toEqual([0, 0]);
        expect(pendingApprovals.size).toBe(2);

        await expect(sendBackgroundMessage({ type: "DUSK_UI_CLEAR_PERMISSIONS", siteWallets: ["acct0", "acct9"], walletId: "acct0" })).resolves.toMatchObject({ ok: true });
        for (const fn of [onA.reject, unshown.reject]) expect(fn).toHaveBeenCalledWith(expect.objectContaining({ message: "Sites disconnected" }));
        expect(pendingApprovals.size).toBe(0);
      } finally {
        pendingApprovals.clear();
      }
    });
  });

  describe("a site's request on a node that contradicts the chain it's fixed to", () => {
    const ask = async (kind, says) => {
      const { getPending } = await import("../background/pending.js");
      getPending.mockReturnValueOnce({ kind, origin: "https://dapp.example", params: {}, shown: { walletId: "acct0" } });
      vi.stubGlobal("fetch", vi.fn(async () => (says === null ? new Response("", { status: 503 }) : new Response(JSON.stringify({ chain_id: says })))));
      try {
        return await sendBackgroundMessage({ type: "DUSK_GET_PENDING", rid: "rid-1" });
      } finally {
        vi.unstubAllGlobals();
      }
    };

    beforeEach(() => {
      globalThis.localStorage.setItem("dusk_settings_v1", JSON.stringify({ nodeUrl: "https://hostile-node.example", chainId: 2 }));
    });

    it("says why it can't be signed as the window opens, of everything that's signed", async () => {
      for (const kind of ["send_tx", "sign_message", "sign_auth", "sign_typed_data"]) {
        const { chainRefusal, networkName, chainId } = await ask(kind, 1);
        expect(chainRefusal, kind).toBe(
          "hostile-node.example now says it's on Mainnet (chain 1), not Testnet (chain 2). The wallet won't sign on it, because a signature here could count on the other network."
        );
        expect([networkName, chainId]).toEqual(["Custom", 2]);
      }
    });

    it("says nothing while it agrees or doesn't answer, or for what isn't signed", async () => {
      expect((await ask("send_tx", 2)).chainRefusal).toBe("");
      expect((await ask("send_tx", null)).chainRefusal).toBe("");
      expect((await ask("connect", 1)).chainRefusal).toBe("");
    });
  });

  describe("what pays for a site's request to send", () => {
    const ask = async (params, { accountIndex = 0, reply } = {}) => {
      const { engineCall, getEngineStatus } = await import("../background/engineHost.js");
      const { getPending } = await import("../background/pending.js");
      const { approveOrigin } = await import("../shared/permissions.js");
      await approveOrigin("https://dapp.example", { profileId: `account:${accountIndex}:acct${accountIndex}`, accountIndex, grants: {} }, "acct0");
      getPending.mockReturnValueOnce({ kind: "send_tx", origin: "https://dapp.example", params, shown: { walletId: "acct0" } });
      getEngineStatus.mockResolvedValueOnce({ isUnlocked: true, accounts: ["acct0", "acct1"], addresses: ["addr0", "addr1"], selectedAccountIndex: 0 });
      engineCall.mockImplementation(reply);
      vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 503 })));
      try {
        return await sendBackgroundMessage({ type: "DUSK_GET_PENDING", rid: "rid-1" });
      } finally {
        vi.unstubAllGlobals();
        engineCall.mockImplementation(async () => true);
      }
    };

    it("is the connected profile's public balance, or for a shielded payment what can be spent", async () => {
      const reply = vi.fn(async (method) => (method === "dusk_getPublicBalance" ? { nonce: "1", value: "777" } : { value: "9", spendable: "8" }));
      expect((await ask({ kind: "transfer", privacy: "public" }, { accountIndex: 1, reply })).payBalance).toBe("777");
      expect(reply).toHaveBeenCalledWith("dusk_getPublicBalance", { profileIndex: 1 });
      expect((await ask({ kind: "transfer", privacy: "shielded" }, { reply })).payBalance).toBe("8");
    });

    it("is unknown when it can't be read, or for another profile's shielded balance, and the window checks nothing", async () => {
      const failing = vi.fn(async () => {
        throw new Error("node down");
      });
      expect((await ask({ kind: "transfer", privacy: "public" }, { reply: failing })).payBalance).toBeNull();
      const reply = vi.fn(async () => ({ value: "9", spendable: "8" }));
      expect((await ask({ kind: "transfer", privacy: "shielded" }, { accountIndex: 1, reply })).payBalance).toBeNull();
      expect(reply).not.toHaveBeenCalledWith("dusk_getShieldedBalance", undefined);
    });
  });

  describe("a send still marked on its way that no watcher follows", () => {
    const HASH = "ab".repeat(32);
    // It's looked up after the overview answers: wait for the outcome, however busy the machine.
    const soon = (check) => vi.waitFor(check, { timeout: 4_000 });
    const sozuStake = (over = {}) =>
      seedTxMeta(HASH, { walletId: "acct0", kind: "contract_call", privacy: "public", pendingNullifiers: [], reservationStatus: undefined, asset: { kind: "sozu", action: "sozu_stake" }, submittedAt: Date.now() - 17 * 60_000, ...over });
    const overview = () => sendBackgroundMessage({ type: "DUSK_UI_OVERVIEW" });
    const told = () => mocks.sentMessages.filter((m) => m.type === "DUSK_UI_TX_STATUS");
    const kept = async () => (await (await import("../shared/txStore.js")).getTxMeta(HASH))?.status;

    it("comes to its outcome as the wallet draws, and the pages are told, so its note goes", async () => {
      await sozuStake();
      mocks.classifyTxPresence.mockResolvedValue({ state: "executed_success", tx: {} });
      expect((await overview()).txs.map((t) => t.status)).toEqual(["submitted"]);
      await soon(async () => expect(await kept()).toBe("executed"));
      await soon(() => expect(told()).toEqual([expect.objectContaining({ hash: HASH, status: "executed", ok: true })]));
      expect((await overview()).txs.map((t) => t.status)).toEqual(["executed"]);
    });

    it("says it failed, or that it isn't known any more, when that's what the node says", async () => {
      await sozuStake();
      mocks.classifyTxPresence.mockResolvedValue({ state: "executed_failed", tx: {}, error: "Out of gas" });
      await overview();
      await soon(async () => expect(await kept()).toBe("failed"));
    });

    it("stays on its way while the node still has it, asked at most once a minute", async () => {
      await sozuStake();
      mocks.classifyTxPresence.mockResolvedValue({ state: "mempool", tx: {} });
      await overview();
      await soon(() => expect(mocks.classifyTxPresence).toHaveBeenCalledTimes(1));
      await soon(async () => expect(await kept()).toBe("mempool"));
      await overview();
      await overview();
      expect(mocks.classifyTxPresence).toHaveBeenCalledTimes(1);
    });

    it("is left to its watcher in its first minute", async () => {
      await sozuStake({ submittedAt: Date.now() - 30_000 });
      mocks.classifyTxPresence.mockResolvedValue({ state: "executed_success", tx: {} });
      await overview();
      await overview();
      expect(mocks.classifyTxPresence).not.toHaveBeenCalled();
      expect(await kept()).toBe("submitted");
    });

    it("takes only an outcome while a watcher may still follow it: done goes, not yet listed stays", async () => {
      await sozuStake({ submittedAt: Date.now() - 70_000 });
      mocks.classifyTxPresence.mockResolvedValue({ state: "not_found" });
      await overview();
      await soon(() => expect(mocks.classifyTxPresence).toHaveBeenCalledTimes(1));
      await overview();
      expect(await kept()).toBe("submitted");
      expect(told()).toEqual([]);
    });

    it("comes to its outcome about a minute on, when the watcher went with a browser restart", async () => {
      await sozuStake({ submittedAt: Date.now() - 70_000 });
      mocks.classifyTxPresence.mockResolvedValue({ state: "executed_success", tx: {} });
      await overview();
      await soon(async () => expect(await kept()).toBe("executed"));
    });

    it("asks nothing of a send that's done", async () => {
      await sozuStake({ status: "executed" });
      await overview();
      expect(mocks.classifyTxPresence).not.toHaveBeenCalled();
    });
  });

  it("shows a site's request only on its own wallet: on another, there's nothing to show", async () => {
    const { getPending } = await import("../background/pending.js");
    getPending.mockReturnValueOnce({ kind: "connect", origin: "https://dapp.example", params: {}, shown: { walletId: "acct9" } });
    mocks.bindPendingWallet.mockReturnValueOnce(false);
    await expect(sendBackgroundMessage({ type: "DUSK_GET_PENDING", rid: "rid-1" })).resolves.toBeNull();
    expect(mocks.bindPendingWallet).toHaveBeenCalledWith("rid-1", "acct0");
  });

  describe("a site's record", () => {
    const SITE = "https://dapp.example";
    const fromPage = { url: "chrome-extension://wallet/popup.html" };
    const fromSite = { url: `${SITE}/`, tab: { id: 7 } };
    const grant = { accountIndex: 0, profileId: "account:0:acct0" };
    const rpc = (method) => sendBackgroundMessage({ type: "DUSK_RPC_REQUEST", id: 1, request: { method } }, fromSite);
    const stored = async () => {
      const { STORAGE_KEYS, storage } = await import("../shared/storage.js");
      return (await storage.get(STORAGE_KEYS.SITE_RECORDS))[STORAGE_KEYS.SITE_RECORDS];
    };

    it("notes when a connected site used its connection, not what any page can ask", async () => {
      const { approveOrigin } = await import("../shared/permissions.js");
      await rpc("dusk_profiles");
      await rpc("dusk_chainId");
      expect((await stored())?.acct0?.[SITE]).toBeUndefined();

      await approveOrigin(SITE, grant, "acct0");
      await rpc("dusk_chainId");
      expect((await stored())?.acct0?.[SITE]).toBeUndefined();
      const before = Date.now();
      await rpc("dusk_profiles");
      await vi.waitFor(async () => expect((await stored())?.acct0?.[SITE]?.lastUsedAt).toBeGreaterThanOrEqual(before));
    });

    it("gives Settings the records, and what new sites are set to", async () => {
      const { noteSiteRequest } = await import("../shared/siteRecords.js");
      await noteSiteRequest("acct0", SITE, { kind: "connect", answer: "approved", at: 5 });
      await sendBackgroundMessage({ type: "DUSK_UI_SET_NEW_SITE_LASTS", lastsMs: 86_400_000 }, fromPage);
      const overview = await sendBackgroundMessage({ type: "DUSK_UI_OVERVIEW" }, fromPage);
      expect(overview.siteRecords.acct0[SITE].asked).toEqual([{ at: 5, what: "connect", answer: "approved" }]);
      expect(overview.newSiteLastsMs).toBe(86_400_000);
      // Only what's offered.
      await sendBackgroundMessage({ type: "DUSK_UI_SET_NEW_SITE_LASTS", lastsMs: 5 }, fromPage);
      await expect(sendBackgroundMessage({ type: "DUSK_UI_OVERVIEW" }, fromPage)).resolves.toMatchObject({ newSiteLastsMs: 0 });
    });

    it("lets only the wallet's own pages set how long a site stays connected, or forget it", async () => {
      const { approveOrigin, getPermissionForOrigin } = await import("../shared/permissions.js");
      const { noteSiteRequest } = await import("../shared/siteRecords.js");
      await approveOrigin(SITE, grant, "acct0");
      await noteSiteRequest("acct0", SITE, { kind: "connect", answer: "approved", at: 5 });
      const set = { type: "DUSK_UI_SET_SITE_LASTS", origin: SITE, lastsMs: 86_400_000 };
      const forget = { type: "DUSK_UI_FORGET_SITE_RECORD", origin: SITE, siteWallet: "acct0" };
      for (const message of [set, forget, { type: "DUSK_UI_SET_NEW_SITE_LASTS", lastsMs: 86_400_000 }]) {
        await expect(sendBackgroundMessage(message, fromSite)).resolves.toMatchObject({ error: { message: "Only the wallet can do that" } });
      }
      expect((await getPermissionForOrigin(SITE, "acct0")).expiresAt).toBeUndefined();
      expect((await stored()).acct0[SITE]).toBeTruthy();

      const before = Date.now();
      await expect(sendBackgroundMessage(set, fromPage)).resolves.toEqual({ ok: true });
      expect((await getPermissionForOrigin(SITE, "acct0")).expiresAt).toBeGreaterThanOrEqual(before + 86_400_000);
      expect((await stored()).acct0[SITE].lastsMs).toBe(86_400_000);
      await expect(sendBackgroundMessage(forget, fromPage)).resolves.toEqual({ ok: true });
      expect((await stored())?.acct0?.[SITE]).toBeUndefined();
      // One not connected says so.
      await expect(sendBackgroundMessage({ ...set, origin: "https://gone.example" }, fromPage)).resolves.toMatchObject({ error: { message: "That site isn't connected any more." } });
    });

    it("connects from the popup's Connect only through the site's approval, as Marek asked, and not once it's rejected", async () => {
      const { getPermissionForOrigin, revokeOrigin } = await import("../shared/permissions.js");
      await revokeOrigin(SITE, "acct0");
      mocks.requestUserApproval.mockClear();
      mocks.requestUserApproval.mockRejectedValueOnce(Object.assign(new Error("User rejected the request"), { code: ERROR_CODES.USER_REJECTED }));
      await expect(sendBackgroundMessage({ type: "DUSK_UI_CONNECT_ORIGIN", origin: SITE }, fromPage)).resolves.toMatchObject({
        error: { code: ERROR_CODES.USER_REJECTED },
      });
      expect(mocks.requestUserApproval).toHaveBeenCalledWith("connect", SITE, expect.objectContaining({ requestedProfiles: true }), expect.anything());
      await expect(getPermissionForOrigin(SITE, "acct0")).resolves.toBeNull();

      // Approved for the profile the approval picked.
      mocks.requestUserApproval.mockResolvedValueOnce({ accountIndex: 0 });
      await expect(sendBackgroundMessage({ type: "DUSK_UI_CONNECT_ORIGIN", origin: SITE }, fromPage)).resolves.toEqual({ ok: true });
      await expect(getPermissionForOrigin(SITE, "acct0")).resolves.toMatchObject({ accountIndex: 0 });
      await revokeOrigin(SITE, "acct0");
    });

    it("lasts as new sites do when it's connected from the popup too", async () => {
      const { getPermissionForOrigin, revokeOrigin } = await import("../shared/permissions.js");
      await revokeOrigin(SITE, "acct0");
      await sendBackgroundMessage({ type: "DUSK_UI_SET_NEW_SITE_LASTS", lastsMs: 86_400_000 }, fromPage);
      await expect(sendBackgroundMessage({ type: "DUSK_UI_CONNECT_ORIGIN", origin: SITE }, fromPage)).resolves.toEqual({ ok: true });
      await expect(getPermissionForOrigin(SITE, "acct0")).resolves.toMatchObject({ lastsMs: 86_400_000 });
      await revokeOrigin(SITE, "acct0");
      await sendBackgroundMessage({ type: "DUSK_UI_SET_NEW_SITE_LASTS", lastsMs: 0 }, fromPage);
    });

    it("takes out a connection when its time is up, and sets the alarm for the next", async () => {
      const { approveOrigin, getPermissions } = await import("../shared/permissions.js");
      const { storage, STORAGE_KEYS } = await import("../shared/storage.js");
      const now = Date.now();
      await approveOrigin(SITE, { ...grant, lastsMs: 1_000 }, "acct0");
      await approveOrigin("https://later.example", { ...grant, lastsMs: 86_400_000 }, "acct0");
      await approveOrigin("https://stays.example", grant, "acct0");
      const raw = async () => (await storage.get(STORAGE_KEYS.PERMISSIONS_V2))[STORAGE_KEYS.PERMISSIONS_V2].acct0;
      const clock = vi.spyOn(Date, "now").mockReturnValue(now + 5_000);
      expect(Object.keys(await getPermissions("acct0"))).not.toContain(SITE);
      expect(Object.keys(await raw())).toContain(SITE);
      mocks.alarmsCreate.mockClear();
      expect(mocks.alarmListeners.length).toBeGreaterThan(0);
      for (const listener of mocks.alarmListeners) listener({ name: "dusk_connection_end" });
      await vi.waitFor(() => expect(mocks.alarmsCreate).toHaveBeenCalled());
      clock.mockRestore();
      expect(Object.keys(await raw()).sort()).toEqual(["https://later.example", "https://stays.example"]);
      expect(mocks.alarmsCreate).toHaveBeenCalledWith("dusk_connection_end", { when: expect.any(Number) });
      expect(mocks.alarmsCreate.mock.lastCall[1].when).toBeGreaterThan(now + 86_000_000);
    });
  });

  describe("the password on big sends, from the popup", () => {
    const params = { kind: "transfer", privacy: "public", to: "acct1", amount: "6000000000" };
    // A wallet page's messages, and a page's own content script's.
    const fromPage = { url: "chrome-extension://wallet/popup.html" };
    const fromSite = { url: "https://dapp.example/", tab: { id: 7 } };
    const status = { isUnlocked: true, accounts: ["acct0"], addresses: ["addr0"], selectedAccountIndex: 0, walletKey: "wallet-key" };
    let sends;

    beforeEach(async () => {
      const { engineCall, getEngineStatus } = await import("../background/engineHost.js");
      getEngineStatus.mockImplementation(async () => status);
      engineCall.mockImplementation(async (method) => (method === "dusk_sendTransaction" ? { hash: "0xmine" } : method === "dusk_getCachedGasPrice" ? { median: "1" } : true));
      sends = () => engineCall.mock.calls.filter(([method]) => method === "dusk_sendTransaction");
      const { setSendPasswordLimit } = await import("../shared/sendPassword.js");
      await setSendPasswordLimit(5_000_000_000n);
    });

    afterEach(async () => {
      const { engineCall, getEngineStatus } = await import("../background/engineHost.js");
      getEngineStatus.mockImplementation(async () => ({ isUnlocked: true, accounts: ["acct0"], addresses: ["addr0"], selectedAccountIndex: 0 }));
      engineCall.mockImplementation(async () => true);
    });

    it("refuses a send above the amount with no password, before anything of it is made", async () => {
      const response = await sendBackgroundMessage({ type: "DUSK_UI_SEND_TX", walletId: "acct0", params });
      expect(response).toMatchObject({ error: { message: "It waits for your password, so nothing was sent." } });
      expect(sends()).toEqual([]);
    });

    it("sends once the vault took the password, for that send, with what's given not going on", async () => {
      const asks = await sendBackgroundMessage({ type: "DUSK_UI_SEND_PASSWORD_ASKS", params }, fromPage);
      expect(asks).toEqual({ ok: true, result: { limit: "5000000000", moves: "6000000000", always: false } });

      const wrong = await sendBackgroundMessage({ type: "DUSK_UI_SEND_PASSWORD_PROVE", params, password: "not it" }, fromPage);
      expect(wrong).toMatchObject({ error: { message: "Incorrect password" } });

      const proved = await sendBackgroundMessage({ type: "DUSK_UI_SEND_PASSWORD_PROVE", params, password: "the password" }, fromPage);
      expect(proved).toEqual({ ok: true, result: expect.any(String) });
      const sent = await sendBackgroundMessage({ type: "DUSK_UI_SEND_TX", walletId: "acct0", params, sendTicket: proved.result });
      expect(sent).toMatchObject({ ok: true });
      expect(sends()).toHaveLength(1);
      expect(JSON.stringify(sends()[0][1])).not.toContain("the password");

      // Once.
      const again = await sendBackgroundMessage({ type: "DUSK_UI_SEND_TX", walletId: "acct0", params, sendTicket: proved.result });
      expect(again).toMatchObject({ error: { message: "It waits for your password, so nothing was sent." } });
      expect(sends()).toHaveLength(1);
    });

    // Astra's: a payment above the amount that waited for the network failed "It waits for your password" as it
    // went, its ticket spent on the try the network didn't answer.
    it("goes out once the network answers on the password given for it once, however many tries it takes", async () => {
      const { engineCall } = await import("../background/engineHost.js");
      engineCall.mockImplementation(async (method) => {
        if (method === "dusk_getCachedGasPrice") return { median: "1" };
        if (method !== "dusk_sendTransaction") return true;
        if (sends().length === 1) throw Object.assign(new TypeError("Failed to fetch"), { data: { sent: false } });
        return { hash: "0xwaited" };
      });
      const proved = await sendBackgroundMessage({ type: "DUSK_UI_SEND_PASSWORD_PROVE", params, password: "the password" }, fromPage);
      mocks.nodeAnswers = false;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const response = new Promise((resolve) =>
          mocks.listener({ type: "DUSK_UI_SEND_TX", walletId: "acct0", sendId: "send-pass-1", params, sendTicket: proved.result }, {}, resolve)
        );
        await vi.waitFor(() => expect(mocks.sentMessages).toContainEqual({ type: "DUSK_UI_SEND_WAITING", sendId: "send-pass-1", waits: true }));
        mocks.nodeAnswers = true;
        await vi.advanceTimersByTimeAsync(5_000);
        await expect(response).resolves.toMatchObject({ ok: true, result: { hash: "0xwaited" } });
        expect(sends()).toHaveLength(2);
      } finally {
        mocks.nodeAnswers = true;
        vi.useRealTimers();
      }
    });

    // Astra's: two payments above the amount, each given the password, three minutes offline: the second, which
    // waited behind the first, failed "It waits for your password", its ticket gone stale unchecked.
    it("checks each payment's password as it's taken, so one waiting behind another goes out on it, however long", async () => {
      const { engineCall } = await import("../background/engineHost.js");
      engineCall.mockImplementation(async (method) => {
        if (method === "dusk_getCachedGasPrice") return { median: "1" };
        if (method !== "dusk_sendTransaction") return true;
        if (sends().length === 1) throw Object.assign(new TypeError("Failed to fetch"), { data: { sent: false } });
        return { hash: `0xqueued${sends().length}` };
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      try {
        const first = await sendBackgroundMessage({ type: "DUSK_UI_SEND_PASSWORD_PROVE", params, password: "the password" }, fromPage);
        const second = await sendBackgroundMessage({ type: "DUSK_UI_SEND_PASSWORD_PROVE", params, password: "the password" }, fromPage);
        mocks.nodeAnswers = false;
        const one = new Promise((resolve) => mocks.listener({ type: "DUSK_UI_SEND_TX", walletId: "acct0", sendId: "send-pass-a", params, sendTicket: first.result }, {}, resolve));
        await vi.waitFor(() => expect(mocks.sentMessages).toContainEqual({ type: "DUSK_UI_SEND_WAITING", sendId: "send-pass-a", waits: true }));
        const two = new Promise((resolve) => mocks.listener({ type: "DUSK_UI_SEND_TX", walletId: "acct0", sendId: "send-pass-b", params, sendTicket: second.result }, {}, resolve));
        await vi.waitFor(() => expect(mocks.sentMessages).toContainEqual({ type: "DUSK_UI_SEND_WAITING", sendId: "send-pass-b", waits: true }));
        // Three minutes with no network: past either ticket's two.
        await vi.advanceTimersByTimeAsync(3 * 60_000);
        mocks.nodeAnswers = true;
        await vi.advanceTimersByTimeAsync(5_000);
        await expect(one).resolves.toMatchObject({ ok: true });
        await expect(two).resolves.toMatchObject({ ok: true });
        expect(sends().map(([, sent]) => sent.sendId)).toEqual(["send-pass-a", "send-pass-a", "send-pass-b"]);
      } finally {
        mocks.nodeAnswers = true;
        vi.useRealTimers();
      }
    });

    it("says nothing's asked up to the amount, and sends with no password", async () => {
      const small = { ...params, amount: "1" };
      await expect(sendBackgroundMessage({ type: "DUSK_UI_SEND_PASSWORD_ASKS", params: small }, fromPage)).resolves.toEqual({ ok: true, result: null });
      await expect(sendBackgroundMessage({ type: "DUSK_UI_SEND_TX", walletId: "acct0", params: small })).resolves.toMatchObject({ ok: true });
    });

    it("changes the amount only with the password, and turns it off the same way", async () => {
      const { sendPasswordLimit } = await import("../shared/sendPassword.js");
      const wrong = await sendBackgroundMessage({ type: "DUSK_UI_SET_SEND_PASSWORD", password: "not it", limitLux: null }, fromPage);
      expect(wrong).toMatchObject({ error: { message: "Incorrect password" } });
      await expect(sendPasswordLimit()).resolves.toBe(5_000_000_000n);

      await expect(sendBackgroundMessage({ type: "DUSK_UI_SET_SEND_PASSWORD", password: "the password", limitLux: "7" }, fromPage)).resolves.toEqual({ ok: true });
      await expect(sendPasswordLimit()).resolves.toBe(7n);
      await expect(sendBackgroundMessage({ type: "DUSK_UI_SET_SEND_PASSWORD", password: "the password", limitLux: "lots" }, fromPage)).resolves.toMatchObject({ error: {} });
      await expect(sendPasswordLimit()).resolves.toBe(7n);
      await expect(sendBackgroundMessage({ type: "DUSK_UI_SET_SEND_PASSWORD", password: "the password", limitLux: null }, fromPage)).resolves.toEqual({ ok: true });
      await expect(sendPasswordLimit()).resolves.toBeNull();
    });

    it("answers none of it to a page's content script, the right password or not", async () => {
      const { sendPasswordLimit } = await import("../shared/sendPassword.js");
      for (const message of [
        { type: "DUSK_UI_SET_SEND_PASSWORD", password: "the password", limitLux: null },
        { type: "DUSK_UI_SEND_PASSWORD_ASKS", params },
        { type: "DUSK_UI_SEND_PASSWORD_PROVE", params, password: "the password" },
      ]) {
        await expect(sendBackgroundMessage(message, fromSite)).resolves.toMatchObject({ error: { message: "Only the wallet can do that" } });
      }
      await expect(sendPasswordLimit()).resolves.toBe(5_000_000_000n);
    });

    it("gives the amount to the wallet's own pages with what they draw, and to a site's window with its request", async () => {
      const overview = await sendBackgroundMessage({ type: "DUSK_UI_OVERVIEW" });
      expect(overview.sendPasswordLimit).toBe("5000000000");
    });
  });

  describe("a send from the popup", () => {
    const params = { kind: "transfer", privacy: "public", to: "acct1", amount: "1" };

    it("isn't sent from another wallet than the one it was reviewed on", async () => {
      const { engineCall } = await import("../background/engineHost.js");
      const response = await sendBackgroundMessage({ type: "DUSK_UI_SEND_TX", walletId: "acct9", params });
      expect(response).toMatchObject({ error: { message: "The wallet changed while you reviewed it." } });
      expect(engineCall).not.toHaveBeenCalledWith("dusk_sendTransaction", expect.anything());
    });

    // Amélie's: the Wi-Fi off at Confirm, the popup said "Not sent" a second later and never waited.
    it("waits for the network where a payment from Send couldn't reach it before it went out, and goes out once it answers", async () => {
      const { engineCall } = await import("../background/engineHost.js");
      const sends = () => engineCall.mock.calls.filter(([method]) => method === "dusk_sendTransaction");
      const offline = Object.assign(new TypeError("Failed to fetch"), { data: { sent: false } });
      engineCall.mockImplementation(async (method) => {
        if (method !== "dusk_sendTransaction") return true;
        if (sends().length === 1) throw offline;
        return { hash: "0xwaited" };
      });
      mocks.nodeAnswers = false;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const response = new Promise((resolve) =>
          mocks.listener({ type: "DUSK_UI_SEND_TX", walletId: "acct0", sendId: "send-0001", feeCapLux: "2500000", params: { ...params, memo: "Hors ligne un" } }, {}, resolve)
        );
        await vi.waitFor(() => expect(mocks.sentMessages).toContainEqual({ type: "DUSK_UI_SEND_WAITING", sendId: "send-0001", waits: true }));
        const overview = new Promise((resolve) => mocks.listener({ type: "DUSK_UI_OVERVIEW" }, {}, resolve));
        await vi.advanceTimersByTimeAsync(0);
        expect((await overview).waitingSends).toEqual([expect.objectContaining({ sendId: "send-0001", memo: "Hors ligne un", waiting: true, waits: true })]);

        await vi.advanceTimersByTimeAsync(5_000);
        expect(sends()).toHaveLength(1);
        mocks.nodeAnswers = true;
        await vi.advanceTimersByTimeAsync(5_000);
        await expect(response).resolves.toMatchObject({ ok: true, result: { hash: "0xwaited" } });
        expect(sends()).toHaveLength(2);
        expect(sends()[1][1]).toMatchObject({ sendId: "send-0001", memo: "Hors ligne un" });
      } finally {
        mocks.nodeAnswers = true;
        vi.useRealTimers();
      }
    });

    // Astra's: Firefox's engine tab closed with a payment waiting, the wallet unlocked again before the network came
    // back, and the payment went out by itself.
    it("ends a payment waiting for the network as the engine's tab closes, said not sent, never going out by itself", async () => {
      const { engineCall } = await import("../background/engineHost.js");
      const sends = () => engineCall.mock.calls.filter(([method]) => method === "dusk_sendTransaction");
      engineCall.mockImplementation(async (method) => {
        if (method !== "dusk_sendTransaction") return true;
        throw Object.assign(new TypeError("Failed to fetch"), { data: { sent: false } });
      });
      mocks.nodeAnswers = false;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const response = new Promise((resolve) => mocks.listener({ type: "DUSK_UI_SEND_TX", walletId: "acct0", sendId: "send-gone-1", params: { ...params, memo: "Onglet fermé" } }, {}, resolve));
        await vi.waitFor(() => expect(mocks.sentMessages).toContainEqual({ type: "DUSK_UI_SEND_WAITING", sendId: "send-gone-1", waits: true }));
        expect(mocks.engineClosed).toBeTypeOf("function");
        mocks.engineClosed();
        await expect(response).resolves.toMatchObject({ error: { message: "The wallet closed before the network answered, so nothing was sent.", data: { sent: false } } });

        // Unlocked again, the network back: it never goes out by itself, and Home says it wasn't sent.
        mocks.nodeAnswers = true;
        await vi.advanceTimersByTimeAsync(10_000);
        expect(sends()).toHaveLength(1);
        const overview = new Promise((resolve) => mocks.listener({ type: "DUSK_UI_OVERVIEW" }, {}, resolve));
        await vi.advanceTimersByTimeAsync(0);
        expect((await overview).waitingSends).toEqual([expect.objectContaining({ sendId: "send-gone-1", memo: "Onglet fermé", waiting: false, ended: "closed" })]);
      } finally {
        mocks.nodeAnswers = true;
        vi.useRealTimers();
      }
    });

    // Astra's: a payment waiting on one profile, another picked meanwhile, failed "Wallet changed while awaiting
    // approval" as it went.
    it("goes out from the profile its Review was for, whichever is picked as it waits", async () => {
      const { engineCall } = await import("../background/engineHost.js");
      const sends = () => engineCall.mock.calls.filter(([method]) => method === "dusk_sendTransaction");
      engineCall.mockImplementation(async (method) => {
        if (method !== "dusk_sendTransaction") return true;
        if (sends().length === 1) throw Object.assign(new TypeError("Failed to fetch"), { data: { sent: false } });
        return { hash: "0xprofile" };
      });
      const reviewed = { ...params, _approvalContext: { walletId: "acct0", profileIndex: 1, account: "acct1", nodeUrl: "https://testnet.nodes.dusk.network" } };
      mocks.nodeAnswers = false;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const response = new Promise((resolve) => mocks.listener({ type: "DUSK_UI_SEND_TX", walletId: "acct0", sendId: "send-prof-1", params: reviewed }, {}, resolve));
        await vi.waitFor(() => expect(mocks.sentMessages).toContainEqual({ type: "DUSK_UI_SEND_WAITING", sendId: "send-prof-1", waits: true }));
        const overview = new Promise((resolve) => mocks.listener({ type: "DUSK_UI_OVERVIEW" }, {}, resolve));
        await vi.advanceTimersByTimeAsync(0);
        expect((await overview).waitingSends).toEqual([expect.objectContaining({ sendId: "send-prof-1", profileIndex: 1 })]);
        mocks.nodeAnswers = true;
        await vi.advanceTimersByTimeAsync(5_000);
        await expect(response).resolves.toMatchObject({ ok: true, result: { hash: "0xprofile" } });
        expect(sends().map(([, sent]) => sent.profileIndex)).toEqual([1, 1]);
        // Its second try, which waited, is told of before it's handed over.
        expect(sends()[1][1]).toMatchObject({ sendId: "send-prof-1", sendKept: true });
        expect(sends()[0][1].sendKept).toBeUndefined();
      } finally {
        mocks.nodeAnswers = true;
        vi.useRealTimers();
      }
    });

    it("keeps a waiting payment with its transaction's ID as the engine hands it over, for the engine's page alone", async () => {
      const { getTxMeta } = await import("../shared/txStore.js");
      // Kept by a background that stopped during its try: the engine still hands it over.
      localStorage.setItem(
        "dusk_waiting_sends_v1",
        JSON.stringify({ "send-kept-1": { sendId: "send-kept-1", walletId: "acct0", nodeUrl: "https://testnet.nodes.dusk.network", profileIndex: 0, privacy: "public", to: "acct1", lux: "1", feeLux: "0", memo: "Gardé", at: 1 } })
      );
      const handing = { type: "DUSK_ENGINE_HANDING_OVER", sendId: "send-kept-1", hash: "0xkept" };
      await expect(sendBackgroundMessage(handing, { url: "https://site.example/" })).resolves.toEqual({ ok: false });
      await expect(sendBackgroundMessage(handing, { url: "chrome-extension://wallet/offscreen.html" })).resolves.toEqual({ ok: true });
      // Nothing here waits on it: followed by its ID, never said not sent.
      const overview = await sendBackgroundMessage({ type: "DUSK_UI_OVERVIEW" });
      expect(overview.waitingSends).toEqual([]);
      await expect(getTxMeta("0xkept")).resolves.toMatchObject({ status: "unknown", recoveryReason: "handover_unclear", to: "acct1", amount: "1", walletId: "acct0" });
    });

    it("calls off a payment from Send waiting for the network, from a wallet page only, and sends nothing", async () => {
      const { engineCall } = await import("../background/engineHost.js");
      const sends = () => engineCall.mock.calls.filter(([method]) => method === "dusk_sendTransaction");
      engineCall.mockImplementation(async (method) => {
        if (method === "dusk_cancelSend") return { cancelled: true };
        if (method !== "dusk_sendTransaction") return true;
        throw Object.assign(new TypeError("Failed to fetch"), { data: { sent: false } });
      });
      mocks.nodeAnswers = false;
      try {
        const response = new Promise((resolve) => mocks.listener({ type: "DUSK_UI_SEND_TX", walletId: "acct0", sendId: "send-0002", params }, {}, resolve));
        await vi.waitFor(() => expect(mocks.sentMessages).toContainEqual({ type: "DUSK_UI_SEND_WAITING", sendId: "send-0002", waits: true }));
        // Not from a site's page.
        await expect(sendBackgroundMessage({ type: "DUSK_UI_CANCEL_SEND", sendId: "send-0002" }, { url: "https://site.example/" })).resolves.toMatchObject({
          error: { message: "Only the wallet can do that" },
        });
        await expect(sendBackgroundMessage({ type: "DUSK_UI_CANCEL_SEND", sendId: "send-0002" }, { url: "chrome-extension://wallet/popup.html" })).resolves.toEqual({
          ok: true,
          result: { cancelled: true },
        });
        await expect(response).resolves.toMatchObject({ error: { message: "You cancelled it, so nothing was sent.", data: { sent: false, cancelled: true } } });
        expect(sends()).toHaveLength(1);
      } finally {
        mocks.nodeAnswers = true;
      }
    });

    // Chen's on Firefox for Android: the tab the wallet runs in, the one left once the wallet's was closed, said
    // nothing of the payment just made.
    it("tells the tab the wallet runs in where its last payment within the hour stands, sent or waiting", async () => {
      const { putTxMeta } = await import("../shared/txStore.js");
      const { engineCall } = await import("../background/engineHost.js");
      const page = { url: "chrome-extension://wallet/engine.html" };
      await expect(sendBackgroundMessage({ type: "DUSK_UI_LAST_SEND" }, page)).resolves.toEqual({ ok: true, result: null });

      const at = Date.now() - 60_000;
      await putTxMeta("0xlast", { walletId: "acct0", origin: "Wallet", nodeUrl: "https://testnet.nodes.dusk.network", kind: "transfer", status: "submitted", submittedAt: at });
      await putTxMeta("0xold", { walletId: "acct0", origin: "Wallet", nodeUrl: "https://testnet.nodes.dusk.network", kind: "transfer", status: "executed", submittedAt: at - 2 * 60 * 60_000 });
      await expect(sendBackgroundMessage({ type: "DUSK_UI_LAST_SEND" }, page)).resolves.toEqual({ ok: true, result: { at, state: "submitted" } });

      // A later one, waiting for the network.
      engineCall.mockImplementation(async (method) => {
        if (method === "dusk_cancelSend") return { cancelled: true };
        if (method !== "dusk_sendTransaction") return true;
        throw Object.assign(new TypeError("Failed to fetch"), { data: { sent: false } });
      });
      mocks.nodeAnswers = false;
      try {
        const response = new Promise((resolve) => mocks.listener({ type: "DUSK_UI_SEND_TX", walletId: "acct0", sendId: "send-0003", params }, {}, resolve));
        await vi.waitFor(() => expect(mocks.sentMessages).toContainEqual({ type: "DUSK_UI_SEND_WAITING", sendId: "send-0003", waits: true }));
        await expect(sendBackgroundMessage({ type: "DUSK_UI_LAST_SEND" }, page)).resolves.toMatchObject({ ok: true, result: { state: "waiting" } });
        // Only for the wallet's own pages.
        await expect(sendBackgroundMessage({ type: "DUSK_UI_LAST_SEND" }, { url: "https://site.example/" })).resolves.toMatchObject({ error: { message: "Only the wallet can do that" } });
        await sendBackgroundMessage({ type: "DUSK_UI_CANCEL_SEND", sendId: "send-0003" }, page);
        await response;
      } finally {
        mocks.nodeAnswers = true;
      }
    });

    // Astra's: once history had a payment, Activity forgot its record, and the tab said nothing of it, or an older one,
    // well within its hour.
    it("says where the wallet's last payment stands though Activity forgot its record once history had it", async () => {
      const { forgetTxs } = await import("../shared/txStore.js");
      const { engineCall } = await import("../background/engineHost.js");
      engineCall.mockImplementation(async (method) => (method === "dusk_sendTransaction" ? { hash: "0xsettled" } : true));
      const page = { url: "chrome-extension://wallet/engine.html" };
      await expect(sendBackgroundMessage({ type: "DUSK_UI_SEND_TX", walletId: "acct0", params })).resolves.toMatchObject({ ok: true, result: { hash: "0xsettled" } });
      await expect(sendBackgroundMessage({ type: "DUSK_UI_LAST_SEND" }, page)).resolves.toMatchObject({ ok: true, result: { state: "submitted" } });
      // In its block, then history has it: Activity forgets its record (settleSends).
      await sendBackgroundMessage({ type: "DUSK_TX_EXECUTED", hash: "0xsettled", ok: true }, { url: "chrome-extension://wallet/offscreen.html" });
      await vi.waitFor(async () => expect((await sendBackgroundMessage({ type: "DUSK_UI_LAST_SEND" }, page)).result).toMatchObject({ state: "executed" }));
      await forgetTxs(["0xsettled"]);
      await expect(sendBackgroundMessage({ type: "DUSK_UI_LAST_SEND" }, page)).resolves.toMatchObject({ ok: true, result: { state: "executed" } });
    });

    // Marek's and Lena's: the default price followed the median with no ceiling, and each wallet read its own median.
    it("goes at the network's median up to the ceiling, by both wallets' one rule, where Review left the price to the network", async () => {
      const { engineCall } = await import("../background/engineHost.js");
      let median = "900";
      engineCall.mockImplementation(async (method) => {
        if (method === "dusk_getCachedGasPrice") return { average: "300", max: "1000", median, min: "1" };
        if (method === "dusk_sendTransaction") return { hash: "0xpriced" };
        return true;
      });
      const sent = () => engineCall.mock.calls.filter(([method]) => method === "dusk_sendTransaction").at(-1)[1];
      await expect(sendBackgroundMessage({ type: "DUSK_UI_SEND_TX", walletId: "acct0", params })).resolves.toMatchObject({ ok: true });
      expect(sent().gas).toEqual({ limit: "2500000", price: "5" });
      median = "2";
      await sendBackgroundMessage({ type: "DUSK_UI_SEND_TX", walletId: "acct0", params });
      expect(sent().gas).toEqual({ limit: "2500000", price: "2" });
      // A price of your own is yours, over the ceiling too.
      await sendBackgroundMessage({ type: "DUSK_UI_SEND_TX", walletId: "acct0", params: { ...params, gas: { limit: "2500000", price: "40" } } });
      expect(sent().gas).toEqual({ limit: "2500000", price: "40" });
    });

    it("goes from the wallet it was reviewed on, and a switch waits for it", async () => {
      const { engineCall } = await import("../background/engineHost.js");
      const { WALLET_LIFECYCLE_LOCK, withStorageLock } = await import("../shared/storageLock.js");
      const { listTxs } = await import("../shared/txStore.js");
      const sent = Promise.withResolvers();
      const started = Promise.withResolvers();
      engineCall.mockImplementation(async (method) => {
        if (method !== "dusk_sendTransaction") return true;
        started.resolve();
        return sent.promise;
      });

      const response = sendBackgroundMessage({ type: "DUSK_UI_SEND_TX", walletId: "acct0", params });
      await started.promise;
      let switched = false;
      const switching = withStorageLock(WALLET_LIFECYCLE_LOCK, async () => {
        switched = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(switched).toBe(false);
      sent.resolve({ hash: "0xmine" });
      await expect(response).resolves.toMatchObject({ ok: true });
      await switching;
      expect(switched).toBe(true);
      await expect(listTxs({ walletId: "acct0" })).resolves.toEqual([expect.objectContaining({ hash: "0xmine" })]);
    });
  });

  describe("after a wallet reset", () => {
    // The reset's clear: every record goes, and the store counts it.
    async function reset() {
      const { clearTxs } = await import("../shared/txStore.js");
      await clearTxs();
    }

    it.each([
      ["DUSK_TX_EXECUTED", { ok: true }],
      ["DUSK_TX_UNKNOWN", { reason: "watcher_timeout" }],
      ["DUSK_TX_REMOVED", { reason: "removed" }],
    ])("keeps nothing of an old send's %s", async (type, extra) => {
      const { getTxEpoch, listTxs } = await import("../shared/txStore.js");
      const epoch = await getTxEpoch();
      await seedTxMeta("0xold");
      await reset();
      mocks.classifyTxPresence.mockResolvedValue({ state: "executed_success", tx: { id: "0xold" } });

      await sendBackgroundMessage({ type, hash: "0xold", epoch, ...extra });
      await new Promise((resolve) => setTimeout(resolve, 10));
      await expect(listTxs()).resolves.toEqual([]);
    });

    it("keeps nothing of a send that finished after it", async () => {
      const { engineCall } = await import("../background/engineHost.js");
      const { getTxEpoch, listTxs } = await import("../shared/txStore.js");
      const epoch = await getTxEpoch();
      const sent = Promise.withResolvers();
      const started = Promise.withResolvers();
      engineCall.mockImplementation(async (method) => {
        if (method !== "dusk_sendTransaction") return true;
        started.resolve();
        return sent.promise;
      });

      const response = sendBackgroundMessage({
        type: "DUSK_UI_SEND_TX",
        params: { kind: "transfer", privacy: "public", to: "acct1", amount: "1" },
      });
      await started.promise;
      // The engine is asked to send with the store's count, for its watcher's events.
      expect(engineCall).toHaveBeenCalledWith("dusk_sendTransaction", expect.objectContaining({ txEpoch: epoch }));
      await reset();
      sent.resolve({ hash: "0xlate" });
      await expect(response).resolves.toMatchObject({ ok: true });
      await expect(listTxs()).resolves.toEqual([]);
    });

    it("rechecks nothing it no longer keeps", async () => {
      const { listTxs } = await import("../shared/txStore.js");
      await seedTxMeta("0xold");
      await reset();
      mocks.classifyTxPresence.mockResolvedValue({ state: "not_found" });

      await sendBackgroundMessage({ type: "DUSK_UI_RECHECK_TX", hash: "0xold" });
      await expect(listTxs()).resolves.toEqual([]);
    });
  });
});
