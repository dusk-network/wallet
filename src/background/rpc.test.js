import { describe, expect, it, vi, beforeEach } from "vitest";

import { ERROR_CODES } from "../shared/errors.js";

vi.mock("@dusk/w3sper", () => ({
  ProfileGenerator: {
    typeOf(value) {
      const s = String(value ?? "");
      if (s.startsWith("acct")) return "account";
      if (s.startsWith("addr")) return "address";
      return "undefined";
    },
  },
}));

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
let engineStatus = { isUnlocked: true, accounts: ["acct0", "acct1"], addresses: ["addr0", "addr1"], selectedAccountIndex: 0 };

const loadVault = vi.fn(async () => vaultValue);

const approveOrigin = vi.fn(async (origin, grant = {}) => {
  const accountIndex = Number(grant.accountIndex) || 0;
  const profileId = grant.profileId || `account:${accountIndex}:acct${accountIndex}`;
  const prev = perms[origin] ?? null;
  const sameProfile = prev?.profileId === profileId;
  const requestedShielded = Boolean(grant.grants?.shieldedReceiveAddress);
  const previousShielded = Boolean(prev?.grants?.shieldedReceiveAddress);
  perms[origin] = {
    profileId,
    accountIndex,
    grants: {
      publicAccount: true,
      shieldedReceiveAddress: sameProfile ? previousShielded || requestedShielded : requestedShielded,
    },
    connectedAt: prev?.connectedAt ?? 123,
    updatedAt: 456,
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
    engineStatus = { isUnlocked: true, accounts: ["acct0", "acct1"], addresses: ["addr0", "addr1"], selectedAccountIndex: 0 };

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

  it("dusk_requestProfiles rejects when no vault exists (opens onboarding)", async () => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    vaultValue = null;

    await expect(
      handleRpc("https://dapp.example", { method: "dusk_requestProfiles" })
    ).rejects.toMatchObject({ code: ERROR_CODES.UNAUTHORIZED });

    expect(tabsCreate).toHaveBeenCalled();
    expect(runtimeGetURL).toHaveBeenCalledWith("full.html");
  });

  it("dusk_requestProfiles does not grant permission if wallet stays locked", async () => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    vaultValue = { v: 1 };
    requestUserApproval.mockResolvedValueOnce({ accountIndex: 0 });
    engineStatus = { isUnlocked: false, accounts: ["acct0"], addresses: ["addr0"], selectedAccountIndex: 0 };

    await expect(
      handleRpc("https://dapp.example", { method: "dusk_requestProfiles" })
    ).rejects.toMatchObject({ code: ERROR_CODES.UNAUTHORIZED });

    expect(approveOrigin).not.toHaveBeenCalled();
  });

  it("dusk_requestProfiles stores a profile-scoped public-account grant", async () => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    vaultValue = { v: 1 };
    requestUserApproval.mockResolvedValueOnce({ accountIndex: 1 });
    engineStatus = { isUnlocked: true, accounts: ["acct0", "acct1"], addresses: ["addr0", "addr1"], selectedAccountIndex: 0 };

    const profiles = await handleRpc("https://dapp.example", { method: "dusk_requestProfiles" });
    expect(profiles).toEqual([{ profileId: "account:1:acct1", account: "acct1" }]);
    expect(perms["https://dapp.example"]).toMatchObject({
      profileId: "account:1:acct1",
      accountIndex: 1,
      grants: { publicAccount: true, shieldedReceiveAddress: false },
    });
  });

  it("dusk_requestProfiles can grant a shielded receive address in one prompt", async () => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    vaultValue = { v: 1 };
    requestUserApproval.mockResolvedValueOnce({ accountIndex: 1 });
    engineStatus = { isUnlocked: true, accounts: ["acct0", "acct1"], addresses: ["addr0", "addr1"], selectedAccountIndex: 0 };

    const profiles = await handleRpc("https://dapp.example", {
      method: "dusk_requestProfiles",
      params: { shieldedReceiveAddress: true, reason: "payment_request" },
    });

    expect(requestUserApproval).toHaveBeenCalledWith(
      "connect",
      "https://dapp.example",
      expect.objectContaining({
        requestedProfiles: true,
        shieldedReceiveAddress: true,
        effectiveShieldedReceiveAddress: true,
        reason: "payment_request",
      })
    );
    expect(profiles).toEqual([{ profileId: "account:1:acct1", account: "acct1", shieldedAddress: "addr1" }]);
  });

  it("dusk_profiles returns [] when not connected or locked", async () => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    expect(await handleRpc("https://dapp.example", { method: "dusk_profiles" })).toEqual([]);

    perms["https://dapp.example"] = {
      profileId: "account:1:acct1",
      accountIndex: 1,
      grants: { publicAccount: true, shieldedReceiveAddress: true },
      connectedAt: 1,
      updatedAt: 1,
    };
    engineStatus = { isUnlocked: false, accounts: ["acct0", "acct1"], addresses: ["addr0", "addr1"], selectedAccountIndex: 0 };
    expect(await handleRpc("https://dapp.example", { method: "dusk_profiles" })).toEqual([]);
  });

  it("dusk_profiles returns only approved fields", async () => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    perms["https://dapp.example"] = {
      profileId: "account:1:acct1",
      accountIndex: 1,
      grants: { publicAccount: true, shieldedReceiveAddress: false },
      connectedAt: 1,
      updatedAt: 1,
    };
    engineStatus = { isUnlocked: true, accounts: ["acct0", "acct1"], addresses: ["addr0", "addr1"], selectedAccountIndex: 0 };
    expect(await handleRpc("https://dapp.example", { method: "dusk_profiles" })).toEqual([
      { profileId: "account:1:acct1", account: "acct1" },
    ]);

    perms["https://dapp.example"].grants.shieldedReceiveAddress = true;
    expect(await handleRpc("https://dapp.example", { method: "dusk_profiles" })).toEqual([
      { profileId: "account:1:acct1", account: "acct1", shieldedAddress: "addr1" },
    ]);
  });

  it("dusk_requestShieldedAddress upgrades and returns the connected profile address", async () => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    vaultValue = { v: 1 };
    perms["https://dapp.example"] = {
      profileId: "account:1:acct1",
      accountIndex: 1,
      grants: { publicAccount: true, shieldedReceiveAddress: false },
      connectedAt: 1,
      updatedAt: 1,
    };
    requestUserApproval.mockResolvedValueOnce({ accountIndex: 1 });
    engineStatus = { isUnlocked: true, accounts: ["acct0", "acct1"], addresses: ["addr0", "addr1"], selectedAccountIndex: 0 };

    await expect(
      handleRpc("https://dapp.example", { method: "dusk_requestShieldedAddress" })
    ).resolves.toEqual({
      address: "addr1",
      account: "acct1",
      profileId: "account:1:acct1",
      chainId: "dusk:2",
    });
    expect(perms["https://dapp.example"].grants.shieldedReceiveAddress).toBe(true);
  });

  it("reconnecting the same profile preserves shielded grant and prompts with effective disclosure", async () => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    vaultValue = { v: 1 };
    perms["https://dapp.example"] = {
      profileId: "account:1:acct1",
      accountIndex: 1,
      grants: { publicAccount: true, shieldedReceiveAddress: true },
      connectedAt: 1,
      updatedAt: 1,
    };
    requestUserApproval.mockResolvedValueOnce({ accountIndex: 1 });
    engineStatus = { isUnlocked: true, accounts: ["acct0", "acct1"], addresses: ["addr0", "addr1"], selectedAccountIndex: 1 };

    const profiles = await handleRpc("https://dapp.example", { method: "dusk_requestProfiles" });

    expect(requestUserApproval).toHaveBeenCalledWith(
      "connect",
      "https://dapp.example",
      expect.objectContaining({
        shieldedReceiveAddress: false,
        effectiveShieldedReceiveAddress: true,
      })
    );
    expect(profiles).toEqual([{ profileId: "account:1:acct1", account: "acct1", shieldedAddress: "addr1" }]);
  });

  it("reconnecting a different profile does not carry shielded grant unless requested", async () => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    vaultValue = { v: 1 };
    perms["https://dapp.example"] = {
      profileId: "account:1:acct1",
      accountIndex: 1,
      grants: { publicAccount: true, shieldedReceiveAddress: true },
      connectedAt: 1,
      updatedAt: 1,
    };
    requestUserApproval.mockResolvedValueOnce({ accountIndex: 0 });
    engineStatus = { isUnlocked: true, accounts: ["acct0", "acct1"], addresses: ["addr0", "addr1"], selectedAccountIndex: 0 };

    const profiles = await handleRpc("https://dapp.example", { method: "dusk_requestProfiles" });

    expect(requestUserApproval).toHaveBeenCalledWith(
      "connect",
      "https://dapp.example",
      expect.objectContaining({
        shieldedReceiveAddress: false,
        effectiveShieldedReceiveAddress: false,
      })
    );
    expect(profiles).toEqual([{ profileId: "account:0:acct0", account: "acct0" }]);
    expect(perms["https://dapp.example"].grants.shieldedReceiveAddress).toBe(false);
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
        privacy: "public",
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
        privacy: "public",
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

  it.each([
    ["missing privacy", { kind: "transfer", to: "acct1", amount: "1" }],
    ["blank privacy", { kind: "transfer", privacy: "  ", to: "acct1", amount: "1" }],
    ["invalid privacy", { kind: "transfer", privacy: "private", to: "acct1", amount: "1" }],
    ["public to shielded address", { kind: "transfer", privacy: "public", to: "addr1", amount: "1" }],
    ["shielded to public account", { kind: "transfer", privacy: "shielded", to: "acct1", amount: "1" }],
  ])("dusk_sendTransaction rejects transfer with %s", async (_label, params) => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    perms["https://dapp.example"] = { accountIndex: 0, connectedAt: 1 };
    engineStatus = { isUnlocked: true, accounts: ["acct0"], addresses: ["addr0"], selectedAccountIndex: 0 };

    await expect(
      handleRpc("https://dapp.example", { method: "dusk_sendTransaction", params })
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_PARAMS });
    expect(requestUserApproval).not.toHaveBeenCalledWith("send_tx", expect.anything(), expect.anything());
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
