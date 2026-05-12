import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listener: null,
  sentMessages: [],
  classifyTxPresence: vi.fn(),
  notifyTxExecuted: vi.fn(async () => true),
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

vi.mock("../shared/txLifecycle.js", () => ({
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

  it("marks removed shielded tx reservations recoverable without clearing pending nullifiers", async () => {
    const hash = "0xremoved";
    await seedTxMeta(hash);
    mocks.classifyTxPresence.mockResolvedValueOnce({ state: "not_found" });

    await sendBackgroundMessage({ type: "DUSK_TX_REMOVED", hash, reason: "removed" });

    const { getTxMeta } = await import("../shared/txStore.js");
    await expect(getTxMeta(hash)).resolves.toMatchObject({
      status: "removed",
      reservationStatus: "recoverable",
      pendingNullifiers: ["aa"],
      recoveryReason: "removed",
    });

    expect(mocks.sentMessages).toContainEqual(
      expect.objectContaining({ type: "DUSK_UI_TX_STATUS", hash, status: "removed" })
    );
    expect(mocks.notifyTxExecuted).not.toHaveBeenCalled();
  });
});
