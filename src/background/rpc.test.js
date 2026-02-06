import { describe, expect, it, vi, beforeEach } from "vitest";

import { ERROR_CODES } from "../shared/errors.js";

// ---------------------------------------------------------------------------
// Shared mutable state for mocks
// ---------------------------------------------------------------------------

let vaultValue = null;
let perms = {};
let settings = {
  nodeUrl: "https://testnet.nodes.dusk.network",
  proverUrl: "https://testnet.provers.dusk.network",
  archiverUrl: "https://testnet.nodes.dusk.network",
};
let engineStatus = { isUnlocked: true, accounts: ["acct0", "acct1"] };

const loadVault = vi.fn(async () => vaultValue);

const approveOrigin = vi.fn(async (origin, accountIndex = 0) => {
  perms[origin] = {
    accountIndex: Number(accountIndex) || 0,
    connectedAt: perms[origin]?.connectedAt ?? 123,
  };
  return perms[origin];
});

const getPermissionForOrigin = vi.fn(async (origin) => perms[origin] ?? null);
const revokeOrigin = vi.fn(async (origin) => {
  delete perms[origin];
});

const getSettings = vi.fn(async () => settings);
const setSettings = vi.fn(async (patch) => {
  settings = { ...settings, ...(patch ?? {}) };
  return settings;
});

const engineCall = vi.fn(async (method, params) => {
  if (method === "dusk_getCachedGasPrice") {
    return { average: "1", max: "1", median: "1", min: "1" };
  }
  if (method === "dusk_getPublicBalance") {
    return { nonce: "0", value: "0", __params: params };
  }
  if (method === "dusk_sendTransaction") {
    return { hash: "0xhash", nonce: "5", __params: params };
  }
  if (method === "dusk_signMessage") {
    return { ok: true, __params: params };
  }
  if (method === "dusk_signAuth") {
    return { ok: true, __params: params };
  }
  throw new Error(`Unexpected engineCall(${method}) in test`);
});

const ensureEngineConfigured = vi.fn(async () => true);
const getEngineStatus = vi.fn(async () => engineStatus);
const invalidateEngineConfig = vi.fn(() => {});

const requestUserApproval = vi.fn(async () => null);
const notifyTxSubmitted = vi.fn(async () => true);
const putTxMeta = vi.fn(async () => {});
const broadcastChainChangedAll = vi.fn(async () => {});

const tabsCreate = vi.fn(async () => ({ id: 1 }));
const runtimeGetURL = vi.fn((path) => `chrome-extension://test/${String(path ?? "")}`);
const getExtensionApi = vi.fn(() => ({
  runtime: {
    getManifest: () => ({ version: "9.9.9" }),
  },
}));

vi.mock("../shared/vault.js", () => ({ loadVault }));
vi.mock("../shared/permissions.js", () => ({
  approveOrigin,
  getPermissionForOrigin,
  revokeOrigin,
}));
vi.mock("../shared/settings.js", () => ({ getSettings, setSettings }));
vi.mock("./engineHost.js", () => ({
  engineCall,
  ensureEngineConfigured,
  getEngineStatus,
  invalidateEngineConfig,
}));
vi.mock("./pending.js", () => ({ requestUserApproval }));
vi.mock("./txNotify.js", () => ({ notifyTxSubmitted }));
vi.mock("../shared/txStore.js", () => ({ putTxMeta }));
vi.mock("./dappEvents.js", () => ({ broadcastChainChangedAll }));
vi.mock("../platform/extensionApi.js", () => ({
  getExtensionApi,
  runtimeGetURL,
  tabsCreate,
}));

describe("background rpc handler", () => {
  beforeEach(() => {
    perms = {};
    vaultValue = null;
    settings = {
      nodeUrl: "https://testnet.nodes.dusk.network",
      proverUrl: "https://testnet.provers.dusk.network",
      archiverUrl: "https://testnet.nodes.dusk.network",
    };
    engineStatus = { isUnlocked: true, accounts: ["acct0", "acct1"] };

    vi.clearAllMocks();
  });

  it("dusk_getCapabilities is public", async () => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    const caps = await handleRpc("https://dapp.example", { method: "dusk_getCapabilities" });

    expect(caps.provider).toBe("dusk-wallet");
    expect(caps.walletVersion).toBe("9.9.9");
    expect(caps.chainId).toBe("dusk:2");
    expect(Array.isArray(caps.methods)).toBe(true);
    expect(caps.features).toMatchObject({
      shieldedRead: false,
      signMessage: true,
      signAuth: true,
    });
  });

  it("dusk_requestAccounts rejects when no vault exists (opens onboarding)", async () => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    vaultValue = null;

    await expect(
      handleRpc("https://dapp.example", { method: "dusk_requestAccounts" })
    ).rejects.toMatchObject({ code: ERROR_CODES.UNAUTHORIZED });

    expect(tabsCreate).toHaveBeenCalled();
    expect(runtimeGetURL).toHaveBeenCalledWith("full.html");
  });

  it("dusk_requestAccounts does not grant permission if wallet stays locked", async () => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    vaultValue = { v: 1 };
    requestUserApproval.mockResolvedValueOnce({ accountIndex: 0 });
    engineStatus = { isUnlocked: false, accounts: ["acct0"] };

    await expect(
      handleRpc("https://dapp.example", { method: "dusk_requestAccounts" })
    ).rejects.toMatchObject({ code: ERROR_CODES.UNAUTHORIZED });

    expect(approveOrigin).not.toHaveBeenCalled();
  });

  it("dusk_requestAccounts stores accountIndex from approval and returns only that account", async () => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    vaultValue = { v: 1 };
    requestUserApproval.mockResolvedValueOnce({ accountIndex: 1 });
    engineStatus = { isUnlocked: true, accounts: ["acct0", "acct1"] };

    const accounts = await handleRpc("https://dapp.example", { method: "dusk_requestAccounts" });
    expect(accounts).toEqual(["acct1"]);
    expect(perms["https://dapp.example"]).toMatchObject({ accountIndex: 1 });

    // Subsequent calls should not prompt again if already connected+unlocked.
    const accounts2 = await handleRpc("https://dapp.example", { method: "dusk_requestAccounts" });
    expect(accounts2).toEqual(["acct1"]);
    expect(requestUserApproval).toHaveBeenCalledTimes(1);
  });

  it("dusk_accounts returns [] when not connected/locked, otherwise the permitted account", async () => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    expect(await handleRpc("https://dapp.example", { method: "dusk_accounts" })).toEqual([]);

    perms["https://dapp.example"] = { accountIndex: 1, connectedAt: 1 };
    engineStatus = { isUnlocked: false, accounts: ["acct0", "acct1"] };
    expect(await handleRpc("https://dapp.example", { method: "dusk_accounts" })).toEqual([]);

    engineStatus = { isUnlocked: true, accounts: ["acct0", "acct1"] };
    expect(await handleRpc("https://dapp.example", { method: "dusk_accounts" })).toEqual(["acct1"]);
  });

  it("dusk_getPublicBalance passes the permitted profileIndex to the engine", async () => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    perms["https://dapp.example"] = { accountIndex: 1, connectedAt: 1 };
    engineStatus = { isUnlocked: true, accounts: ["acct0", "acct1"] };

    const res = await handleRpc("https://dapp.example", { method: "dusk_getPublicBalance" });
    expect(res.__params).toEqual({ profileIndex: 1 });
  });

  it("dusk_sendTransaction overwrites any dApp-supplied profileIndex and records tx meta", async () => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    perms["https://dapp.example"] = { accountIndex: 0, connectedAt: 1 };
    vaultValue = { v: 1 };
    engineStatus = { isUnlocked: true, accounts: ["acct0", "acct1"] };

    const tx = await handleRpc("https://dapp.example", {
      method: "dusk_sendTransaction",
      params: {
        kind: "transfer",
        to: "acct1",
        amount: "1",
        memo: "hi",
        profileIndex: 999,
      },
    });

    expect(tx).toMatchObject({ hash: "0xhash", nonce: "5" });

    const call = engineCall.mock.calls.find(([m]) => m === "dusk_sendTransaction");
    expect(call).toBeTruthy();
    expect(call[1].profileIndex).toBe(0);

    expect(putTxMeta).toHaveBeenCalledWith(
      "0xhash",
      expect.objectContaining({
        origin: "https://dapp.example",
        kind: "transfer",
        to: "acct1",
      })
    );
  });

  it("dusk_sendTransaction rejects unsupported tx kinds for dApps", async () => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    perms["https://dapp.example"] = { accountIndex: 0, connectedAt: 1 };
    engineStatus = { isUnlocked: true, accounts: ["acct0"] };

    await expect(
      handleRpc("https://dapp.example", { method: "dusk_sendTransaction", params: { kind: "shield" } })
    ).rejects.toMatchObject({ code: ERROR_CODES.UNSUPPORTED });
  });

  it("dusk_sendTransaction validates contract_call privacy", async () => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    perms["https://dapp.example"] = { accountIndex: 0, connectedAt: 1 };
    engineStatus = { isUnlocked: true, accounts: ["acct0"] };

    await expect(
      handleRpc("https://dapp.example", {
        method: "dusk_sendTransaction",
        params: {
          kind: "contract_call",
          privacy: "nope",
          contractId: "0x" + "02".padEnd(64, "0"),
          fnName: "x",
          fnArgs: "0x",
          amount: "0",
          deposit: "0",
        },
      })
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_PARAMS });
  });
});

