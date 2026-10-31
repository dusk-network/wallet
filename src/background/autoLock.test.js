import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ERROR_CODES } from "../shared/errors.js";

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
    settingsError: null,
    now: 1_000_000,
    sentMessages: [],
    // A node's chain ID, as networkStatus.js reads it: Mainnet's own node's here.
    readChainId: vi.fn(async () => 1),
    checkAllEndpoints: vi.fn(async () => ({ ok: true })),
    isStatusStale: vi.fn(() => false),
    alarmsClear: vi.fn(async () => true),
    alarmsCreate: vi.fn(() => {}),
    vault: { v: 1 },
    clearVault: vi.fn(async () => {}),
    createVault: vi.fn(async () => ({ id: "w1", n: 1 })),
    clearPermissions: vi.fn(async () => {}),
    clearAllPermissions: vi.fn(async () => {}),
    beginReset: vi.fn(async () => {}),
    clearWalletData: vi.fn(async () => {}),
    endReset: vi.fn(async () => {}),
    finishReset: vi.fn(async () => {}),
    finishPendingReset: vi.fn(async () => ({ pending: false, keepContactsOf: null })),
    cancelPendingApprovals: vi.fn(),
    engineCall: vi.fn(async (method) => {
      if (method === "engine_unlock") {
        return { accounts: ["acct0"] };
      }
      if (method === "engine_walletId") return "acct0";
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
    broadcastWalletChanged: vi.fn(async () => {}),
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

vi.mock("../shared/settings.js", async (importOriginal) => ({
  normalizeAutoLock: (await importOriginal()).normalizeAutoLock,
  getSettings: vi.fn(async () => mocks.settings),
  setSettings: vi.fn(async (patch) => {
    if (mocks.settingsError) throw mocks.settingsError;
    mocks.settings = { ...mocks.settings, ...patch };
    return mocks.settings;
  }),
}));

vi.mock("../shared/vault.js", () => ({
  addVaultWallet: vi.fn(async () => ({ id: "w2", n: 2 })),
  changeVaultPassword: vi.fn(async () => true),
  clearVault: mocks.clearVault,
  createVault: mocks.createVault,
  loadVault: vi.fn(async () => mocks.vault),
  removeVaultWallet: vi.fn(async () => true),
  unlockVault: vi.fn(async () => ({ wallets: [{ id: "w1", n: 1, mnemonic: "mnemonic" }] })),
}));

vi.mock("../shared/walletReset.js", () => ({
  beginReset: mocks.beginReset,
  clearWalletData: mocks.clearWalletData,
  endReset: mocks.endReset,
  finishReset: mocks.finishReset,
  finishPendingReset: mocks.finishPendingReset,
  forgetWalletData: vi.fn(async () => true),
}));

vi.mock("../shared/permissions.js", () => ({
  adoptLegacyPermissions: vi.fn(async () => 0),
  approveOrigin: vi.fn(async () => true),
  clearAllPermissions: mocks.clearAllPermissions,
  clearPermissions: mocks.clearPermissions,
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
  getEngineStatusStrict: mocks.getEngineStatus,
  invalidateEngineConfig: vi.fn(() => {}),
  handleEngineReady: vi.fn(() => {}),
}));

vi.mock("./rpc.js", () => ({
  handleRpc: mocks.handleRpc,
}));

vi.mock("./pending.js", () => ({
  cancelPendingApprovals: mocks.cancelPendingApprovals,
  getPending: vi.fn(() => null),
  resolvePendingDecision: vi.fn(() => ({ ok: true })),
}));

vi.mock("./dappEvents.js", () => ({
  broadcastChainChangedAll: vi.fn(async () => {}),
  broadcastProfilesChangedAll: mocks.broadcastProfilesChangedAll,
  broadcastWalletChanged: mocks.broadcastWalletChanged,
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
  checkAllEndpoints: mocks.checkAllEndpoints,
  readChainId: mocks.readChainId,
  resetNetworkStatus: vi.fn(async () => {}),
  isStatusStale: mocks.isStatusStale,
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
    mocks.settingsError = null;
    mocks.vault = { v: 1 };
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
    expect(mocks.cancelPendingApprovals).toHaveBeenCalledTimes(1);
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
    expect(mocks.cancelPendingApprovals).toHaveBeenCalledTimes(1);
    expect(mocks.sentMessages).toContainEqual(
      expect.objectContaining({
        type: "DUSK_UI_LOCK_STATE",
        isUnlocked: false,
        reason: "manual_lock",
      })
    );
    expect(activityRecord()).toBeUndefined();
  });

  it("resets the wallet with its transactions, shielded notes and history", async () => {
    const response = await sendBackgroundMessage({ type: "DUSK_UI_RESET_WALLET" });

    expect(response).toEqual({ ok: true });
    // Noted before the vault goes, ended once all is cleared.
    const order = (fn) => fn.mock.invocationCallOrder[0];
    expect(order(mocks.beginReset)).toBeLessThan(order(mocks.clearVault));
    expect(order(mocks.clearVault)).toBeLessThan(order(mocks.finishReset));
    // Every wallet's sites go.
    expect(mocks.clearAllPermissions).toHaveBeenCalledTimes(1);
    expect(mocks.clearPermissions).not.toHaveBeenCalled();
  });

  it("reports a reset that couldn't clear the old wallet's data, and makes no wallet until it can", async () => {
    const failure = new Error("The old wallet's data couldn't be cleared. Try again.");
    mocks.finishReset.mockRejectedValueOnce(failure);
    const response = await sendBackgroundMessage({ type: "DUSK_UI_RESET_WALLET" });
    expect(response.error.message).toBe(failure.message);

    mocks.vault = null;
    mocks.engineUnlocked = false;
    mocks.finishPendingReset.mockRejectedValueOnce(failure);
    const create = await sendBackgroundMessage({ type: "DUSK_UI_CREATE_WALLET", mnemonic: "wallet B", password: "password123" });
    expect(create.error.message).toBe(failure.message);
    expect(mocks.createVault).not.toHaveBeenCalled();
  });

  it("restores a wallet in place of the one here once its phrase makes one: as Reset does, keeping its contacts", async () => {
    mocks.engineUnlocked = false;
    const response = await sendBackgroundMessage({ type: "DUSK_UI_RESTORE_WALLET", mnemonic: "wallet A", password: "new password" });
    expect(response).toEqual({ ok: true, accounts: ["acct0"] });
    const order = (fn) => fn.mock.invocationCallOrder[0];
    const methods = mocks.engineCall.mock.calls.map(([method]) => method);
    const named = mocks.engineCall.mock.invocationCallOrder[methods.indexOf("engine_walletId")];
    expect(named).toBeLessThan(order(mocks.beginReset));
    expect(order(mocks.beginReset)).toBeLessThan(order(mocks.clearAllPermissions));
    expect(order(mocks.clearAllPermissions)).toBeLessThan(order(mocks.clearWalletData));
    expect(order(mocks.clearWalletData)).toBeLessThan(order(mocks.clearVault));
    expect(order(mocks.clearVault)).toBeLessThan(order(mocks.createVault));
    // Noted, with the wallet it makes, until that wallet's vault is.
    expect(mocks.beginReset).toHaveBeenCalledWith({ keepContactsOf: "acct0" });
    expect(mocks.clearWalletData).toHaveBeenCalledWith({ keepContactsOf: "acct0" });
    expect(order(mocks.createVault)).toBeLessThan(order(mocks.endReset));
    expect(mocks.finishReset).not.toHaveBeenCalled();
    expect(mocks.createVault).toHaveBeenCalledWith("wallet A", "new password");
    expect(methods.at(-1)).toBe("engine_unlock");
  });

  it("keeps a restore noted when its new vault can't be made, so the next import of that wallet keeps its contacts", async () => {
    mocks.engineUnlocked = false;
    mocks.createVault.mockRejectedValueOnce(new Error("Storage is full"));
    const restore = await sendBackgroundMessage({ type: "DUSK_UI_RESTORE_WALLET", mnemonic: "wallet A", password: "new password" });
    expect(restore.error.message).toBe("Storage is full");
    expect(mocks.clearVault).toHaveBeenCalledTimes(1);
    expect(mocks.endReset).not.toHaveBeenCalled();

    // The next import finds it, and keeps the contacts only of the wallet it makes, if it's that one.
    mocks.vault = null;
    mocks.finishPendingReset.mockResolvedValueOnce({ pending: true, keepContactsOf: "acct0" });
    const create = await sendBackgroundMessage({ type: "DUSK_UI_CREATE_WALLET", mnemonic: "wallet A", password: "password123" });
    expect(create).toEqual({ ok: true, accounts: ["acct0"] });
    const methods = mocks.engineCall.mock.calls.map(([method]) => method);
    expect(methods.filter((m) => m === "engine_walletId")).toHaveLength(2);
    const order = (fn) => fn.mock.invocationCallOrder.at(-1);
    expect(order(mocks.createVault)).toBeLessThan(order(mocks.endReset));
  });

  it("leaves the wallet here as it was when the phrase makes no wallet, or the wallet is unlocked", async () => {
    mocks.engineUnlocked = false;
    mocks.engineCall.mockRejectedValueOnce(new Error("That isn't a valid recovery phrase."));
    const response = await sendBackgroundMessage({ type: "DUSK_UI_RESTORE_WALLET", mnemonic: "not a phrase", password: "new password" });
    expect(response.error.message).toBe("That isn't a valid recovery phrase.");
    mocks.engineUnlocked = true;
    const unlocked = await sendBackgroundMessage({ type: "DUSK_UI_RESTORE_WALLET", mnemonic: "wallet A", password: "new password" });
    expect(unlocked.error.message).toMatch(/lock the wallet first/i);
    for (const fn of [mocks.beginReset, mocks.clearPermissions, mocks.clearAllPermissions, mocks.finishReset, mocks.clearVault, mocks.createVault, mocks.cancelPendingApprovals]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it("does not clear the vault when reset cannot lock the engine", async () => {
    mocks.engineCall.mockRejectedValueOnce(new Error("lock transport failed"));

    const response = await sendBackgroundMessage({ type: "DUSK_UI_RESET_WALLET" });

    expect(response.error.message).toBe("lock transport failed");
    expect(mocks.clearVault).not.toHaveBeenCalled();
    expect(mocks.clearPermissions).not.toHaveBeenCalled();
    expect(mocks.clearAllPermissions).not.toHaveBeenCalled();
    expect(mocks.beginReset).not.toHaveBeenCalled();
    expect(mocks.finishReset).not.toHaveBeenCalled();
    expect(mocks.cancelPendingApprovals).not.toHaveBeenCalled();
    expect(mocks.engineUnlocked).toBe(true);
  });

  it("rejects replacement of an existing locked vault", async () => {
    mocks.engineUnlocked = false;

    const response = await sendBackgroundMessage({
      type: "DUSK_UI_CREATE_WALLET",
      mnemonic: "wallet B",
      password: "password123",
    });

    expect(response.error.message).toMatch(/reset the existing wallet/i);
    expect(mocks.createVault).not.toHaveBeenCalled();
  });

  it("rejects wallet creation while an engine is already unlocked", async () => {
    mocks.vault = null;

    const response = await sendBackgroundMessage({
      type: "DUSK_UI_CREATE_WALLET",
      mnemonic: "wallet B",
      password: "password123",
    });

    expect(response.error.message).toMatch(/lock or reset/i);
    expect(mocks.createVault).not.toHaveBeenCalled();
  });

  it("does not create a vault when strict engine status is unavailable", async () => {
    mocks.vault = null;
    mocks.getEngineStatus.mockRejectedValueOnce(new Error("engine unavailable"));

    const response = await sendBackgroundMessage({
      type: "DUSK_UI_CREATE_WALLET",
      mnemonic: "wallet B",
      password: "password123",
    });

    expect(response.error.message).toBe("engine unavailable");
    expect(mocks.createVault).not.toHaveBeenCalled();
  });

  it("preserves a newly written vault when its first unlock fails", async () => {
    mocks.vault = null;
    mocks.engineUnlocked = false;
    mocks.createVault.mockImplementationOnce(async () => {
      mocks.vault = { v: 1 };
      return { id: "w1", n: 1 };
    });
    mocks.engineCall.mockRejectedValueOnce(new Error("unlock failed"));

    const response = await sendBackgroundMessage({
      type: "DUSK_UI_CREATE_WALLET",
      mnemonic: "wallet B",
      password: "password123",
    });

    expect(response.error.message).toBe("unlock failed");
    expect(mocks.vault).toEqual({ v: 1 });
    expect(mocks.clearVault).not.toHaveBeenCalled();
  });

  it("switches to another wallet without a password: approvals end first, then sites and pages are told", async () => {
    // Two profiles a wallet, as the settings' default has it.
    mocks.settings = { ...mocks.settings, accountCount: 2 };
    const wallets = [{ key: "w1", n: 1 }, { key: "w2", n: 2 }];
    mocks.getEngineStatus.mockImplementation(async () => ({
      isUnlocked: mocks.engineUnlocked,
      accounts: ["acct0", "acct1"],
      addresses: ["addr0", "addr1"],
      selectedAccountIndex: 0,
      walletKey: "w1",
      wallets,
    }));
    mocks.engineCall.mockImplementation(async (method) => {
      if (method === "engine_switchWallet") return { accounts: ["other0", "other1"], walletKey: "w2", wallets };
      return true;
    });

    const response = await sendBackgroundMessage({ type: "DUSK_UI_SWITCH_WALLET", walletKey: "w2", index: 1 });

    expect(response).toEqual({ ok: true, result: { accounts: ["other0", "other1"], walletKey: "w2", selectedAccountIndex: 1 } });
    const switched = mocks.engineCall.mock.calls.findIndex(([method]) => method === "engine_switchWallet");
    expect(mocks.engineCall.mock.calls[switched][1]).toEqual({ walletKey: "w2" });
    expect(mocks.cancelPendingApprovals.mock.invocationCallOrder[0]).toBeLessThan(mocks.engineCall.mock.invocationCallOrder[switched]);
    expect(mocks.cancelPendingApprovals).toHaveBeenCalledWith(null, "Wallet changed");
    expect(mocks.settings.selectedAccountIndex).toBe(1);
    expect(mocks.broadcastWalletChanged).toHaveBeenCalledWith({}, expect.objectContaining({ walletKey: "w1", accounts: ["acct0", "acct1"] }));
    expect(mocks.sentMessages).toContainEqual({ type: "DUSK_UI_WALLET_CHANGED" });
    expect(activityRecord()).toEqual({ lastActivityAt: 1_000_000 });

    // One the engine doesn't hold, or a locked wallet, switches nothing.
    mocks.engineCall.mockClear();
    await expect(sendBackgroundMessage({ type: "DUSK_UI_SWITCH_WALLET", walletKey: "gone" })).resolves.toMatchObject({ error: { message: "That wallet isn't here." } });
    mocks.engineUnlocked = false;
    await expect(sendBackgroundMessage({ type: "DUSK_UI_SWITCH_WALLET", walletKey: "w2" })).resolves.toMatchObject({ error: { message: "Wallet locked" } });
    expect(mocks.engineCall.mock.calls.map(([method]) => method)).not.toContain("engine_switchWallet");
  });

  it("locks the engine when a switch gets no answer in time, so it can't open the other wallet later", async () => {
    const wallets = [{ key: "w1", n: 1 }, { key: "w2", n: 2 }];
    // The engine's wallet, which a switch the bridge gave up on still changes later, unless locked first.
    let engineWallet = "w1";
    const late = Promise.withResolvers();
    const [engineCallBefore, statusBefore] = [mocks.engineCall.getMockImplementation(), mocks.getEngineStatus.getMockImplementation()];
    mocks.getEngineStatus.mockImplementation(async () => ({
      isUnlocked: mocks.engineUnlocked,
      accounts: [`${engineWallet}acct0`],
      addresses: ["addr0"],
      selectedAccountIndex: 0,
      walletKey: engineWallet,
      wallets,
    }));
    mocks.engineCall.mockImplementation(async (method) => {
      if (method === "engine_lock") mocks.engineUnlocked = false;
      if (method !== "engine_switchWallet") return true;
      late.promise.then(() => {
        if (mocks.engineUnlocked) engineWallet = "w2";
      });
      throw new Error("Engine call timed out");
    });
    try {
      await expect(sendBackgroundMessage({ type: "DUSK_UI_SWITCH_WALLET", walletKey: "w2" })).resolves.toMatchObject({
        error: { message: "Engine call timed out" },
      });
      late.resolve();
      await late.promise;
      await Promise.resolve();
      // Locked: no wallet is open that the wallets list doesn't show, and pages are told.
      expect([mocks.engineUnlocked, engineWallet]).toEqual([false, "w1"]);
      expect(mocks.broadcastWalletChanged).not.toHaveBeenCalled();
      expect(mocks.sentMessages).toContainEqual(expect.objectContaining({ type: "DUSK_UI_LOCK_STATE", isUnlocked: false }));
    } finally {
      mocks.engineCall.mockImplementation(engineCallBefore);
      mocks.getEngineStatus.mockImplementation(statusBefore);
    }
  });

  it("tells every page when a wallet goes or is renamed, the open one or another", async () => {
    const wallets = [{ key: "w1", n: 1 }, { key: "w2", n: 2 }];
    mocks.getEngineStatus.mockImplementation(async () => ({
      isUnlocked: mocks.engineUnlocked,
      accounts: ["acct0"],
      addresses: ["addr0"],
      selectedAccountIndex: 0,
      walletKey: "w1",
      wallets,
    }));
    mocks.engineCall.mockImplementation(async (method) => (method === "engine_walletAccounts" ? ["other0"] : true));

    await expect(sendBackgroundMessage({ type: "DUSK_UI_REMOVE_WALLET", walletKey: "w2", password: "pw" })).resolves.toEqual({ ok: true });
    expect(mocks.sentMessages).toContainEqual({ type: "DUSK_UI_WALLETS_CHANGED" });
    // Another wallet's: the open one stays, so no switch is said.
    expect(mocks.sentMessages).not.toContainEqual({ type: "DUSK_UI_WALLET_CHANGED" });

    mocks.sentMessages.length = 0;
    await expect(sendBackgroundMessage({ type: "DUSK_UI_RENAME_WALLET", walletKey: "w1", name: "Savings" })).resolves.toMatchObject({ ok: true });
    expect(mocks.sentMessages).toEqual([{ type: "DUSK_UI_WALLETS_CHANGED" }]);
  });

  it("locks the engine before returning an unlock timeout", async () => {
    mocks.engineUnlocked = false;
    mocks.engineCall.mockRejectedValueOnce(new Error("Engine call timed out"));

    const response = await sendBackgroundMessage({ type: "DUSK_UI_UNLOCK", password: "pw" });

    expect(response.error.message).toBe("Engine call timed out");
    expect(mocks.engineCall.mock.calls.map(([method]) => method)).toEqual([
      "engine_unlock",
      "engine_lock",
    ]);
    expect(mocks.engineUnlocked).toBe(false);
  });

  it("serializes create behind an in-flight unlock", async () => {
    mocks.engineUnlocked = false;
    let releaseUnlock;
    let markUnlockStarted;
    const unlockGate = new Promise((resolve) => { releaseUnlock = resolve; });
    const unlockStarted = new Promise((resolve) => { markUnlockStarted = resolve; });
    mocks.engineCall.mockImplementationOnce(async (method) => {
      expect(method).toBe("engine_unlock");
      markUnlockStarted();
      await unlockGate;
      mocks.engineUnlocked = true;
      return { accounts: ["acct0"] };
    });

    const unlock = sendBackgroundMessage({ type: "DUSK_UI_UNLOCK", password: "pw" });
    await unlockStarted;
    const create = sendBackgroundMessage({
      type: "DUSK_UI_CREATE_WALLET",
      mnemonic: "wallet B",
      password: "password123",
    });
    expect(mocks.createVault).not.toHaveBeenCalled();

    releaseUnlock();
    await expect(unlock).resolves.toEqual({ ok: true, accounts: ["acct0"] });
    await expect(create).resolves.toMatchObject({
      error: { message: expect.stringMatching(/reset the existing wallet/i) },
    });
    expect(mocks.createVault).not.toHaveBeenCalled();
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

  it("ignores activity from an orphaned approval window", async () => {
    mocks.now = 1_234_567;

    await expect(
      sendBackgroundMessage(
        { type: "DUSK_UI_ACTIVITY", rid: "missing" },
        {}
      )
    ).resolves.toEqual({ ok: false });

    expect(activityRecord()).toBeUndefined();
  });

  it("returns structured errors when changing network settings fails", async () => {
    mocks.settingsError = new Error("storage unavailable");

    await expect(sendBackgroundMessage({
      type: "DUSK_UI_SET_NODE_URL",
      nodeUrl: "https://nodes.dusk.network",
    })).resolves.toEqual({
      error: {
        code: ERROR_CODES.INTERNAL,
        message: "storage unavailable",
      },
    });
  });

  it("saves a custom node with the chain ID it gives, read before it's saved", async () => {
    mocks.readChainId.mockResolvedValueOnce(2);
    const response = await sendBackgroundMessage({ type: "DUSK_UI_SET_NODE_URL", nodeUrl: "https://my-node.example" });
    expect(response).toMatchObject({ ok: true, nodeUrl: "https://my-node.example" });
    expect(mocks.readChainId).toHaveBeenCalledWith("https://my-node.example");
    expect(mocks.settings).toMatchObject({ nodeUrl: "https://my-node.example", chainId: 2 });
    // The overview carries it, as every page that draws the network reads it.
    const overview = await sendBackgroundMessage({ type: "DUSK_UI_OVERVIEW" });
    expect(overview.chainId).toBe(2);
  });

  it("tells the popup to draw again when a status check reads the chain ID a node didn't give when it was chosen", async () => {
    mocks.settings = { ...mocks.settings, nodeUrl: "https://my-node.example", chainId: null };
    mocks.isStatusStale.mockReturnValue(true);
    mocks.checkAllEndpoints.mockImplementationOnce(async () => {
      mocks.settings = { ...mocks.settings, chainId: 2 };
      return { ok: true };
    });
    const overview = await sendBackgroundMessage({ type: "DUSK_UI_OVERVIEW" });
    expect(overview.chainId).toBeNull();
    await vi.waitFor(() => expect(mocks.sentMessages).toContainEqual({ type: "DUSK_UI_NETWORK_CHANGED" }));
    mocks.isStatusStale.mockReturnValue(false);
  });

  it("checks the endpoints at most every 5 minutes, and after 30 s while a read fails or the node was down", async () => {
    const { isStatusStale } = await vi.importActual("../shared/networkStatus.js");
    const status = await import("../shared/networkStatus.js");
    mocks.isStatusStale.mockImplementation(isStatusStale);
    // Testnet's node, its chain ID known.
    mocks.settings = { ...mocks.settings, chainId: 2 };
    await sendBackgroundMessage({ type: "DUSK_UI_UNLOCK", password: "pw" });
    const checks = () => mocks.checkAllEndpoints.mock.calls.length;
    const overview = async (ago, { node = "online", balance = true } = {}) => {
      status.getNetworkStatus.mockResolvedValue({ nodeStatus: node, proverStatus: "online", archiverStatus: "online", lastChecked: mocks.now - ago });
      mocks.engineCall.mockImplementation(async (method) => {
        if (method === "dusk_getPublicBalance" && !balance) throw new Error("Balance request timed out");
        return method === "engine_walletId" ? "acct0" : true;
      });
      await sendBackgroundMessage({ type: "DUSK_UI_OVERVIEW" });
    };
    try {
      const before = checks();
      // Checked a minute ago, all well: not again.
      await overview(60_000);
      expect(checks()).toBe(before);
      await overview(5 * 60_000 + 1);
      expect(checks()).toBe(before + 1);
      // The node was down, or the balance can't be read: again after 30 s, not before.
      await overview(31_000, { node: "offline" });
      await overview(31_000, { balance: false });
      expect(checks()).toBe(before + 3);
      await overview(10_000, { node: "offline", balance: false });
      expect(checks()).toBe(before + 3);
    } finally {
      mocks.isStatusStale.mockReturnValue(false);
      status.getNetworkStatus.mockResolvedValue({ checkedAt: 0 });
    }
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

  it.each([
    [1, 5],
    [5, 5],
    [60, 15],
    [0, 0],
  ])("stores an auto-lock of %s minutes as %s: never 1 minute, never over 15", async (asked, stored) => {
    await expect(
      sendBackgroundMessage({ type: "DUSK_UI_SET_AUTO_LOCK", autoLockTimeoutMinutes: asked })
    ).resolves.toEqual({ ok: true, autoLockTimeoutMinutes: stored });
    expect(mocks.settings.autoLockTimeoutMinutes).toBe(stored);
  });

  it("locks an idle wallet once a lowered timer runs out, and not before", async () => {
    await sendBackgroundMessage({ type: "DUSK_UI_UNLOCK", password: "pw" });
    mocks.engineCall.mockClear();
    // A test lowers the timer to 6 seconds; Settings can't.
    mocks.settings = { ...mocks.settings, autoLockTimeoutMinutes: 0.1 };
    const start = mocks.now;

    mocks.now = start + 5_000;
    await fireAutoLockAlarm();
    expect(mocks.engineCall).not.toHaveBeenCalledWith("engine_lock");

    mocks.now = start + 6_001;
    await fireAutoLockAlarm();
    expect(mocks.engineCall).toHaveBeenCalledWith("engine_lock");
  });

  it.each([
    "dusk_sendTransaction", "dusk_signMessage", "dusk_signAuth", "dusk_signTypedData",
  ])("successful unlocked %s refreshes persisted activity", async (method) => {
    mocks.now = 3_000_000;

    await expect(
      sendBackgroundMessage(
        {
          type: "DUSK_RPC_REQUEST",
          id: "rpc-1",
          request: { method, params: { kind: "transfer" } },
        },
        { url: "https://dapp.example/page", tab: { url: "https://dapp.example/page" } }
      )
    ).resolves.toEqual({
      id: "rpc-1",
      result: { method },
    });

    expect(activityRecord()).toEqual({ lastActivityAt: 3_000_000 });
  });

  it.each(["rejected", "locked"])("does not refresh activity for a %s typed-data request", async (state) => {
    mocks.sessionStore.set(AUTO_LOCK_ACTIVITY_KEY, { lastActivityAt: 1_000_000 });
    mocks.now = 3_000_000;
    if (state === "rejected") {
      mocks.handleRpc.mockRejectedValueOnce(Object.assign(new Error("Rejected"), { code: 4001 }));
    } else {
      mocks.handleRpc.mockImplementationOnce(async () => {
        mocks.engineUnlocked = false;
        return { method: "dusk_signTypedData" };
      });
    }
    const response = await sendBackgroundMessage({
      type: "DUSK_RPC_REQUEST", id: "typed",
      request: { method: "dusk_signTypedData" },
    }, { url: "https://dapp.example/page" });
    if (state === "rejected") expect(response.error).toMatchObject({ code: 4001 });
    else expect(response.result).toEqual({ method: "dusk_signTypedData" });
    expect(activityRecord()).toEqual({ lastActivityAt: 1_000_000 });
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
