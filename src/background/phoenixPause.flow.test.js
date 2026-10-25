import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ERROR_CODES } from "../shared/errors.js";

const PUBLIC_ACCOUNT =
  "M8vMuVUZZrHCW3LBFKEctWFJerYmT2HghQNuGHKrgV6BQqgkYK1A4FZLX3Nm9Rri63RZwL4gQCMhLyJRJQE5MQouqqu77Dr1rQnHqk1W7zAf4WKZqr6MgdxzkxFwFjo8ZM";
const SHIELDED_ADDRESS =
  "2Ana1pUpv2ZbMVkwF5FXapYeBEjdxDatLn7nvJkhgTSXbs59SyZSx866bXirPgj8QQVB57uxHJBG1YFvkRbFj4T";

const mocks = vi.hoisted(() => ({
  listener: null,
  paused: false,
  unlocked: true,
}));

const engineCall = vi.hoisted(() =>
  vi.fn(async (method) => {
    if (method === "dusk_getAddresses") return ["addr0"];
    if (method === "dusk_getPublicBalance") return { nonce: "0", value: "5" };
    if (method === "dusk_getShieldedStatus") return { state: "done", updatedAt: Date.now() };
    if (method === "dusk_getShieldedBalance") return { value: "7", spendable: "7" };
    if (method === "dusk_getCachedGasPrice") return { median: "1" };
    if (method === "dusk_sendTransaction") return { hash: "0xhash", nonce: "3" };
    return null;
  })
);
const getPhoenixPause = vi.hoisted(() => vi.fn(async () => ({ paused: mocks.paused, checkedAt: 1 })));
// A network switch reconfigures the engine through this.
const invalidateEngineConfig = vi.hoisted(() => vi.fn(() => {}));

function makeLocalStorage() {
  const store = new Map();
  return {
    get length() {
      return store.size;
    },
    key: (i) => Array.from(store.keys())[i] ?? null,
    getItem: (k) => (store.has(String(k)) ? store.get(String(k)) : null),
    setItem: (k, v) => store.set(String(k), String(v)),
    removeItem: (k) => store.delete(String(k)),
    clear: () => store.clear(),
  };
}

vi.mock("../shared/phoenixPause.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getPhoenixPause,
}));

vi.mock("../background/engineHost.js", () => {
  const status = async () => ({
    isUnlocked: mocks.unlocked,
    accounts: mocks.unlocked ? ["acct0"] : [],
    selectedAccountIndex: 0,
  });
  return {
    engineCall,
    ensureEngineConfigured: vi.fn(async () => true),
    getEngineStatus: vi.fn(status),
    getEngineStatusStrict: vi.fn(status),
    invalidateEngineConfig,
    handleEngineReady: vi.fn(() => {}),
  };
});

vi.mock("../background/pending.js", () => ({
  cancelPendingApprovals: vi.fn(),
  getPending: vi.fn(() => null),
  requestUserApproval: vi.fn(async () => null),
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
  notifyTxExecuted: vi.fn(async () => true),
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

vi.mock("../shared/networkStatus.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getNetworkStatus: vi.fn(async () => ({ nodeStatus: "online" })),
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
  runtimeSendMessage: vi.fn(async () => ({ ok: true })),
  storageSessionGet: vi.fn(async () => ({})),
  storageSessionSet: vi.fn(async () => {}),
  storageSessionRemove: vi.fn(async () => {}),
  tabsCreate: vi.fn(async () => ({ id: 1 })),
}));

async function sendBackgroundMessage(message) {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("sendResponse timed out")), 1000);
    mocks.listener(message, {}, (response) => {
      clearTimeout(timeout);
      resolve(response);
    });
  });
}

const sentTransactions = () => engineCall.mock.calls.filter(([method]) => method === "dusk_sendTransaction");

describe("background while shielded transactions are paused", () => {
  let prevLocalStorage = null;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.listener = null;
    mocks.paused = false;
    mocks.unlocked = true;

    prevLocalStorage = globalThis.localStorage ?? null;
    globalThis.localStorage = makeLocalStorage();
    globalThis.localStorage.setItem(
      "dusk_settings_v1",
      JSON.stringify({ nodeUrl: "https://testnet.nodes.dusk.network" })
    );

    await import("./index.js");
    expect(mocks.listener).toBeTypeOf("function");
  });

  afterEach(() => {
    if (prevLocalStorage) globalThis.localStorage = prevLocalStorage;
    else delete globalThis.localStorage;
  });

  it("tells the popup when the current network has them paused", async () => {
    mocks.paused = true;
    const paused = await sendBackgroundMessage({ type: "DUSK_UI_OVERVIEW" });
    expect(paused).toMatchObject({ isUnlocked: true, networkName: "Testnet", phoenixPaused: true });
    expect(getPhoenixPause).toHaveBeenCalledWith("https://testnet.nodes.dusk.network");

    mocks.paused = false;
    await expect(sendBackgroundMessage({ type: "DUSK_UI_OVERVIEW" })).resolves.toMatchObject({ phoenixPaused: false });
  });

  it("doesn't ask the node while the wallet is locked", async () => {
    mocks.paused = true;
    mocks.unlocked = false;
    await expect(sendBackgroundMessage({ type: "DUSK_UI_OVERVIEW" })).resolves.toMatchObject({
      isUnlocked: false,
      phoenixPaused: false,
    });
    expect(getPhoenixPause).not.toHaveBeenCalled();
  });

  it.each([
    ["shield", { kind: "shield", amount: "1" }],
    ["unshield", { kind: "unshield", amount: "1" }],
    ["a shielded transfer", { kind: "transfer", privacy: "shielded", to: SHIELDED_ADDRESS, amount: "1" }],
    ["a stake paid from the shielded balance", { kind: "stake", amount: "1", payment: "address" }],
  ])("refuses %s from the popup before it reaches the engine", async (_label, params) => {
    mocks.paused = true;
    const res = await sendBackgroundMessage({ type: "DUSK_UI_SEND_TX", params });

    expect(res).toEqual({
      error: { code: ERROR_CODES.UNSUPPORTED, message: "Shielded transactions are paused on Testnet." },
    });
    expect(sentTransactions()).toHaveLength(0);
  });

  it("keeps public sends and stakes working", async () => {
    mocks.paused = true;
    for (const params of [
      { kind: "transfer", privacy: "public", to: PUBLIC_ACCOUNT, amount: "1" },
      { kind: "stake", amount: "1", payment: "account" },
    ]) {
      await expect(sendBackgroundMessage({ type: "DUSK_UI_SEND_TX", params })).resolves.toMatchObject({
        ok: true,
        result: { hash: "0xhash" },
      });
    }
    expect(sentTransactions()).toHaveLength(2);
  });

  it("sends shielded transactions while they aren't paused", async () => {
    const res = await sendBackgroundMessage({ type: "DUSK_UI_SEND_TX", params: { kind: "shield", amount: "1" } });
    expect(res).toMatchObject({ ok: true, result: { hash: "0xhash" } });
    expect(sentTransactions()).toHaveLength(1);
  });

  it("keeps a network switch from coming in between the pause check and the send", async () => {
    // The current network answers "not paused" only once a switch to a paused one was asked for.
    let answerPause;
    getPhoenixPause.mockImplementationOnce(
      () => new Promise((resolve) => (answerPause = () => resolve({ paused: false, checkedAt: 1 })))
    );
    const sending = sendBackgroundMessage({ type: "DUSK_UI_SEND_TX", params: { kind: "shield", amount: "1" } });
    await vi.waitFor(() => expect(answerPause).toBeTypeOf("function"));
    const switching = sendBackgroundMessage({ type: "DUSK_UI_SET_NODE_URL", nodeUrl: "https://nodes.dusk.network" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    answerPause();

    await expect(sending).resolves.toMatchObject({ ok: true, result: { hash: "0xhash" } });
    await expect(switching).resolves.toMatchObject({ ok: true, networkName: "Mainnet" });
    // The shield went out on the network it was checked on, before the switch reconfigured the engine.
    const sent = engineCall.mock.invocationCallOrder[engineCall.mock.calls.findIndex(([m]) => m === "dusk_sendTransaction")];
    expect(invalidateEngineConfig).toHaveBeenCalledTimes(1);
    expect(sent).toBeLessThan(invalidateEngineConfig.mock.invocationCallOrder[0]);
  });
});
