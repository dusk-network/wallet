import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const AUTO_LOCK_ACTIVITY_KEY = "dusk_auto_lock_activity_v1";
const AUTO_LOCK_ALARM_NAME = "dusk_auto_lock_check";

const mocks = vi.hoisted(() => {
  const sessionStore = new Map();

  function storageGet(keys) {
    if (typeof keys === "string") {
      return sessionStore.has(keys) ? { [keys]: sessionStore.get(keys) } : {};
    }
    if (Array.isArray(keys)) {
      const out = {};
      for (const key of keys) {
        if (sessionStore.has(key)) out[key] = sessionStore.get(key);
      }
      return out;
    }
    if (keys && typeof keys === "object") {
      const out = {};
      for (const [key, fallback] of Object.entries(keys)) {
        out[key] = sessionStore.has(key) ? sessionStore.get(key) : fallback;
      }
      return out;
    }
    return Object.fromEntries(sessionStore);
  }

  return {
    listener: null,
    alarmListener: null,
    sessionStore,
    settings: {
      autoLockTimeoutMinutes: 5,
      nodeUrl: "https://testnet.nodes.dusk.network",
    },
    engineUnlocked: true,
    now: 1_000_000,
    sentMessages: [],
    alarmsClear: vi.fn(async () => true),
    alarmsCreate: vi.fn(() => {}),
    engineCall: vi.fn(async (method) => {
      if (method === "engine_unlock") {
        return { accounts: ["acct0"] };
      }
      if (method === "engine_lock") {
        mocks.engineUnlocked = false;
      }
      return true;
    }),
    getEngineStatus: vi.fn(async () => ({
      isUnlocked: mocks.engineUnlocked,
      accounts: ["acct0"],
      addresses: ["addr0"],
      selectedAccountIndex: 0,
    })),
    broadcastProfilesChangedAll: vi.fn(async () => {}),
    handleRpc: vi.fn(async (_origin, request) => {
      if (request?.method === "dusk_switchNetwork") {
        const nextNodeUrl = String(request?.params?.nodeUrl ?? "").trim();
        if (nextNodeUrl) {
          mocks.settings = { ...mocks.settings, nodeUrl: nextNodeUrl };
        }
      }
      return { method: request?.method ?? "" };
    }),
    runtimeSendMessage: vi.fn(async (message) => {
      mocks.sentMessages.push(message);
      return { ok: true };
    }),
    storageSessionGet: vi.fn(async (keys) => storageGet(keys)),
    storageSessionSet: vi.fn(async (items) => {
      for (const [key, value] of Object.entries(items ?? {})) {
        sessionStore.set(key, value);
      }
    }),
    storageSessionRemove: vi.fn(async (keys) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        sessionStore.delete(key);
      }
    }),
  };
});

vi.mock("../shared/settings.js", () => ({
  getSettings: vi.fn(async () => mocks.settings),
  setSettings: vi.fn(async (patch) => {
    mocks.settings = { ...mocks.settings, ...patch };
    return mocks.settings;
  }),
}));

vi.mock("../shared/vault.js", () => ({
  createVault: vi.fn(async () => true),
  loadVault: vi.fn(async () => ({ v: 1 })),
  unlockVault: vi.fn(async () => "mnemonic"),
}));

vi.mock("../shared/permissions.js", () => ({
  approveOrigin: vi.fn(async () => true),
  getPermissionForOrigin: vi.fn(async () => ({
    profileId: "account:0:acct0",
    accountIndex: 0,
    grants: { publicAccount: true, shieldedReceiveAddress: false },
  })),
  getPermissions: vi.fn(async () => ({})),
  revokeOrigin: vi.fn(async () => true),
}));

vi.mock("./engineHost.js", () => ({
  engineCall: mocks.engineCall,
  ensureEngineConfigured: vi.fn(async () => true),
  getEngineStatus: mocks.getEngineStatus,
  invalidateEngineConfig: vi.fn(() => {}),
  handleEngineReady: vi.fn(() => {}),
}));

vi.mock("./rpc.js", () => ({
  handleRpc: mocks.handleRpc,
}));

vi.mock("./pending.js", () => ({
  getPending: vi.fn(() => null),
  resolvePendingDecision: vi.fn(() => ({ ok: true })),
}));

vi.mock("./dappEvents.js", () => ({
  broadcastChainChangedAll: vi.fn(async () => {}),
  broadcastProfilesChangedAll: mocks.broadcastProfilesChangedAll,
  bindPortsForSenderOrigin: vi.fn(() => {}),
  registerDappPort: vi.fn(() => {}),
  registerStorageChangeForwarder: vi.fn(() => {}),
}));

vi.mock("./txNotify.js", () => ({
  notifyTxSubmitted: vi.fn(async () => true),
  notifyTxExecuted: vi.fn(async () => true),
  registerTxNotificationHandlers: vi.fn(() => {}),
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
  alarmsClear: mocks.alarmsClear,
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
      create: mocks.alarmsCreate,
      onAlarm: {
        addListener: (fn) => {
          mocks.alarmListener = fn;
        },
      },
    },
  }),
  runtimeGetURL: (path) => String(path ?? ""),
  runtimeSendMessage: mocks.runtimeSendMessage,
  storageSessionGet: mocks.storageSessionGet,
  storageSessionSet: mocks.storageSessionSet,
  storageSessionRemove: mocks.storageSessionRemove,
  tabsCreate: vi.fn(async () => ({ id: 1 })),
}));

function activityRecord() {
  return mocks.sessionStore.get(AUTO_LOCK_ACTIVITY_KEY);
}

async function flushAsync() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function importBackground() {
  await import("./index.js");
  await flushAsync();
  expect(mocks.listener).toBeTypeOf("function");
  expect(mocks.alarmListener).toBeTypeOf("function");
}

async function restartBackground() {
  vi.resetModules();
  mocks.listener = null;
  mocks.alarmListener = null;
  await importBackground();
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

async function fireAutoLockAlarm() {
  mocks.alarmListener({ name: AUTO_LOCK_ALARM_NAME });
  await flushAsync();
}

describe("background auto-lock activity", () => {
  let dateNowSpy;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.listener = null;
    mocks.alarmListener = null;
    mocks.sessionStore.clear();
    mocks.settings = {
      autoLockTimeoutMinutes: 5,
      nodeUrl: "https://testnet.nodes.dusk.network",
    };
    mocks.engineUnlocked = true;
    mocks.now = 1_000_000;
    mocks.sentMessages = [];
    dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => mocks.now);

    await importBackground();
    vi.clearAllMocks();
  });

  afterEach(() => {
    dateNowSpy?.mockRestore();
  });

  it("keeps an unlocked wallet unlocked before timeout after service worker memory resets", async () => {
    await sendBackgroundMessage({ type: "DUSK_UI_UNLOCK", password: "pw" });
    expect(activityRecord()).toEqual({ lastActivityAt: 1_000_000 });

    mocks.engineCall.mockClear();
    mocks.broadcastProfilesChangedAll.mockClear();

    mocks.now += 60_000;
    await restartBackground();
    await fireAutoLockAlarm();

    expect(mocks.engineCall).not.toHaveBeenCalledWith("engine_lock");
    expect(mocks.broadcastProfilesChangedAll).not.toHaveBeenCalled();
    expect(mocks.engineUnlocked).toBe(true);
  });

  it("locks and broadcasts profilesChanged only after persisted inactivity exceeds timeout", async () => {
    await sendBackgroundMessage({ type: "DUSK_UI_UNLOCK", password: "pw" });
    mocks.engineCall.mockClear();
    mocks.broadcastProfilesChangedAll.mockClear();

    mocks.now += 60_000;
    await restartBackground();
    await fireAutoLockAlarm();
    expect(mocks.engineCall).not.toHaveBeenCalledWith("engine_lock");
    expect(mocks.broadcastProfilesChangedAll).not.toHaveBeenCalled();

    mocks.now = 1_000_000 + 5 * 60_000 + 1;
    await fireAutoLockAlarm();

    expect(mocks.engineCall).toHaveBeenCalledWith("engine_lock");
    expect(mocks.broadcastProfilesChangedAll).toHaveBeenCalledTimes(1);
    expect(mocks.sentMessages).toContainEqual(
      expect.objectContaining({
        type: "DUSK_UI_LOCK_STATE",
        isUnlocked: false,
        reason: "auto_lock",
      })
    );
    expect(activityRecord()).toBeUndefined();
  });

  it("manual lock clears persisted activity and broadcasts profilesChanged", async () => {
    mocks.sessionStore.set(AUTO_LOCK_ACTIVITY_KEY, { lastActivityAt: 1_000_000 });

    await expect(sendBackgroundMessage({ type: "DUSK_UI_LOCK" })).resolves.toEqual({ ok: true });

    expect(mocks.engineCall).toHaveBeenCalledWith("engine_lock");
    expect(mocks.broadcastProfilesChangedAll).toHaveBeenCalledTimes(1);
    expect(mocks.sentMessages).toContainEqual(
      expect.objectContaining({
        type: "DUSK_UI_LOCK_STATE",
        isUnlocked: false,
        reason: "manual_lock",
      })
    );
    expect(activityRecord()).toBeUndefined();
  });

  it("initializes missing activity for an unlocked wallet instead of locking immediately", async () => {
    expect(activityRecord()).toBeUndefined();

    await fireAutoLockAlarm();

    expect(mocks.engineCall).not.toHaveBeenCalledWith("engine_lock");
    expect(mocks.broadcastProfilesChangedAll).not.toHaveBeenCalled();
    expect(activityRecord()).toEqual({ lastActivityAt: 1_000_000 });
  });

  it("persists DUSK_UI_ACTIVITY heartbeats", async () => {
    mocks.now = 1_234_567;

    await expect(sendBackgroundMessage({ type: "DUSK_UI_ACTIVITY" })).resolves.toEqual({ ok: true });

    expect(activityRecord()).toEqual({ lastActivityAt: 1_234_567 });
  });

  it("changing auto-lock setting restarts the alarm and keeps sane unlocked activity", async () => {
    mocks.now = 2_000_000;

    await expect(
      sendBackgroundMessage({ type: "DUSK_UI_SET_AUTO_LOCK", autoLockTimeoutMinutes: 15 })
    ).resolves.toEqual({ ok: true, autoLockTimeoutMinutes: 15 });

    expect(mocks.settings.autoLockTimeoutMinutes).toBe(15);
    expect(mocks.alarmsClear).toHaveBeenCalledWith(AUTO_LOCK_ALARM_NAME);
    expect(mocks.alarmsCreate).toHaveBeenCalledWith(AUTO_LOCK_ALARM_NAME, {
      periodInMinutes: 1,
    });
    expect(activityRecord()).toEqual({ lastActivityAt: 2_000_000 });
  });

  it("successful unlocked dApp actions refresh persisted activity", async () => {
    mocks.now = 3_000_000;

    await expect(
      sendBackgroundMessage(
        {
          type: "DUSK_RPC_REQUEST",
          id: "rpc-1",
          request: { method: "dusk_sendTransaction", params: { kind: "transfer" } },
        },
        { url: "https://dapp.example/page", tab: { url: "https://dapp.example/page" } }
      )
    ).resolves.toEqual({
      id: "rpc-1",
      result: { method: "dusk_sendTransaction" },
    });

    expect(activityRecord()).toEqual({ lastActivityAt: 3_000_000 });
  });

  it("real dApp network switches refresh persisted activity", async () => {
    mocks.sessionStore.set(AUTO_LOCK_ACTIVITY_KEY, { lastActivityAt: 1_000_000 });
    mocks.now = 3_000_000;

    await expect(
      sendBackgroundMessage(
        {
          type: "DUSK_RPC_REQUEST",
          id: "rpc-switch",
          request: { method: "dusk_switchNetwork", params: { nodeUrl: "https://nodes.dusk.network" } },
        },
        { url: "https://dapp.example/page", tab: { url: "https://dapp.example/page" } }
      )
    ).resolves.toEqual({
      id: "rpc-switch",
      result: { method: "dusk_switchNetwork" },
    });

    expect(activityRecord()).toEqual({ lastActivityAt: 3_000_000 });
  });

  it("passive connected dApp polling does not refresh persisted activity", async () => {
    mocks.sessionStore.set(AUTO_LOCK_ACTIVITY_KEY, { lastActivityAt: 1_000_000 });
    mocks.now = 3_000_000;

    for (const [id, request] of [
      ["rpc-profiles", { method: "dusk_profiles" }],
      ["rpc-balance", { method: "dusk_getPublicBalance" }],
      ["rpc-chain", { method: "dusk_chainId" }],
      [
        "rpc-switch",
        {
          method: "dusk_switchNetwork",
          params: { nodeUrl: "https://testnet.nodes.dusk.network" },
        },
      ],
    ]) {
      await expect(
        sendBackgroundMessage(
          {
            type: "DUSK_RPC_REQUEST",
            id,
            request,
          },
          { url: "https://dapp.example/page", tab: { url: "https://dapp.example/page" } }
        )
      ).resolves.toEqual({
        id,
        result: { method: request.method },
      });
    }

    expect(activityRecord()).toEqual({ lastActivityAt: 1_000_000 });
  });
});
