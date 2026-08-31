import { describe, expect, it, vi, beforeEach } from "vitest";

import { sha256Hex } from "../shared/bytes.js";
import { ERROR_CODES } from "../shared/errors.js";
import { DAPP_RPC_METHODS } from "../shared/providerSurface.js";
import { hashTypedDataHex } from "../shared/typedDataHash.js";

const PUBLIC_ACCOUNT =
  "M8vMuVUZZrHCW3LBFKEctWFJerYmT2HghQNuGHKrgV6BQqgkYK1A4FZLX3Nm9Rri63RZwL4gQCMhLyJRJQE5MQouqqu77Dr1rQnHqk1W7zAf4WKZqr6MgdxzkxFwFjo8ZM";
const SHIELDED_ADDRESS =
  "2Ana1pUpv2ZbMVkwF5FXapYeBEjdxDatLn7nvJkhgTSXbs59SyZSx866bXirPgj8QQVB57uxHJBG1YFvkRbFj4T";

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

const getPermissionForOrigin = vi.fn(async (origin) => {
  const permission = perms[origin];
  if (!permission) return null;
  const accountIndex = Number(permission.accountIndex) || 0;
  return {
    profileId: `account:${accountIndex}:acct${accountIndex}`,
    updatedAt: 1,
    ...permission,
  };
});
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
    const nullifiers = params?.privacy === "shielded" ? ["aa"] : undefined;
    return { hash: "0xhash", nonce: "5", nullifiers, __params: params };
  }
  if (method === "dusk_signMessage") {
    return { ok: true, __params: params };
  }
  if (method === "dusk_signAuth") {
    return { ok: true, __params: params };
  }
  if (method === "dusk_signTypedData") {
    return {
      account: PUBLIC_ACCOUNT,
      publicKeyHex: `0X${"AB".repeat(96)}`,
      signature: `0X${"CD".repeat(48)}`,
      __params: params,
    };
  }
  throw new Error(`Unexpected engineCall(${method}) in test`);
});

const ensureEngineConfigured = vi.fn(async () => true);
const getEngineStatus = vi.fn(async () => engineStatus);
const getEngineStatusStrict = vi.fn(async () => engineStatus);
const invalidateEngineConfig = vi.fn(() => {});

const requestUserApproval = vi.fn(async () => null);
const notifyTxSubmitted = vi.fn(async () => true);
const putTxMeta = vi.fn(async () => {});
const broadcastChainChangedAll = vi.fn(async () => {});
const watchToken = vi.fn(async () => true);
const watchNft = vi.fn(async () => true);
const normalizeContractId = vi.fn((value) => {
  const s = String(value ?? "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(s)) throw new Error("invalid contractId");
  return s.toLowerCase();
});

const tabsCreate = vi.fn(async () => ({ id: 1 }));
const runtimeGetURL = vi.fn((path) => `chrome-extension://test/${String(path ?? "")}`);
const getExtensionApi = vi.fn(() => ({
  runtime: {
    getManifest: () => ({ version: "9.9.9" }),
  },
}));

vi.mock("../shared/vault.js", () => ({ loadVault }));
vi.mock("../shared/permissions.js", async (importOriginal) => ({
  ...(await importOriginal()),
  approveOrigin,
  getPermissionForOrigin,
  revokeOrigin,
}));
vi.mock("../shared/settings.js", () => ({ getSettings, setSettings }));
vi.mock("./engineHost.js", () => ({
  engineCall,
  ensureEngineConfigured,
  getEngineStatus,
  getEngineStatusStrict,
  invalidateEngineConfig,
}));
vi.mock("./pending.js", () => ({
  cancelPendingApprovals: vi.fn(),
  requestUserApproval,
}));
vi.mock("./txNotify.js", () => ({ notifyTxSubmitted }));
vi.mock("../shared/txStore.js", () => ({ putTxMeta }));
vi.mock("../shared/assetsStore.js", () => ({
  normalizeContractId,
  watchToken,
  watchNft,
}));
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

  it.each([
    ["HTTPS", "https://dapp.example"],
    ["localhost HTTP", "http://localhost:5173"],
    ["127.0.0.1 HTTP", "http://127.0.0.1:5173"],
    ["IPv6 localhost HTTP", "http://[::1]:5173"],
  ])("accepts dApp RPC from %s origins", async (_label, origin) => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    await expect(
      handleRpc(origin, { method: "dusk_getCapabilities" })
    ).resolves.toMatchObject({ provider: "dusk-wallet" });
  });

  it.each([
    ["non-local HTTP", "http://dapp.example"],
    ["private LAN HTTP", "http://192.168.1.10:5173"],
    ["extension origin", "chrome-extension://abc/page.html"],
    ["missing origin", ""],
  ])("rejects dApp RPC from %s before permission lookup", async (_label, origin) => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    await expect(
      handleRpc(origin, { method: "dusk_requestProfiles" })
    ).rejects.toMatchObject({ code: ERROR_CODES.UNAUTHORIZED });

    expect(getPermissionForOrigin).not.toHaveBeenCalled();
    expect(requestUserApproval).not.toHaveBeenCalled();
  });

  it("rejects dusk_signBlsDigest with METHOD_NOT_FOUND even from a connected origin", async () => {
    // dusk_signBlsDigest is a raw-digest signing oracle: it must never be
    // reachable, whether or not the dApp is connected/permitted.
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    perms["https://dapp.example"] = { accountIndex: 0, connectedAt: 1 };

    await expect(
      handleRpc("https://dapp.example", { method: "dusk_signBlsDigest", params: {} })
    ).rejects.toMatchObject({ code: ERROR_CODES.METHOD_NOT_FOUND });
  });

  it("rejects an invented method name with METHOD_NOT_FOUND", async () => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    perms["https://dapp.example"] = { accountIndex: 0, connectedAt: 1 };

    await expect(
      handleRpc("https://dapp.example", { method: "dusk_notARealMethod", params: {} })
    ).rejects.toMatchObject({ code: ERROR_CODES.METHOD_NOT_FOUND });
  });

  it("rejects unknown methods before any permission lookup or user approval", async () => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    perms["https://dapp.example"] = { accountIndex: 0, connectedAt: 1 };

    await expect(
      handleRpc("https://dapp.example", { method: "dusk_signBlsDigest", params: {} })
    ).rejects.toMatchObject({ code: ERROR_CODES.METHOD_NOT_FOUND });

    // An unknown method must cost nothing: no permission lookup, no approval prompt.
    expect(getPermissionForOrigin).not.toHaveBeenCalled();
    expect(requestUserApproval).not.toHaveBeenCalled();
  });

  it("keeps tombstoned methods explaining themselves instead of reporting METHOD_NOT_FOUND", async () => {
    // dusk_getAddresses is deliberately refused so dApps cannot enumerate shielded
    // addresses. The allowlist must not flatten that into "Unknown method": the
    // method is known, it is declined, and the caller should be told which.
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    perms["https://dapp.example"] = { accountIndex: 0, connectedAt: 1 };

    await expect(
      handleRpc("https://dapp.example", { method: "dusk_getAddresses", params: {} })
    ).rejects.toMatchObject({ code: ERROR_CODES.UNSUPPORTED });
  });

  it("never rejects a canonical DAPP_RPC_METHODS entry with METHOD_NOT_FOUND", async () => {
    // Guards against a typo in the allowlist silently disabling a real method.
    // Other failures (missing permission, locked wallet, invalid params, ...)
    // are expected and fine here -- only METHOD_NOT_FOUND is disallowed.
    vaultValue = { v: 1 };
    perms["https://dapp.example"] = { accountIndex: 0, connectedAt: 1 };
    engineStatus = {
      isUnlocked: true,
      accounts: ["acct0", "acct1"],
      addresses: ["addr0", "addr1"],
      selectedAccountIndex: 0,
    };

    for (const method of DAPP_RPC_METHODS) {
      vi.resetModules();
      const { handleRpc } = await import("./rpc.js");
      try {
        await handleRpc("https://dapp.example", { method, params: {} });
      } catch (err) {
        expect(err?.code).not.toBe(ERROR_CODES.METHOD_NOT_FOUND);
      }
    }
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

  it("does not commit a connection grant during a wallet lifecycle mutation", async () => {
    vi.resetModules();
    const [{ handleRpc }, { WALLET_LIFECYCLE_LOCK, withStorageLock }] = await Promise.all([
      import("./rpc.js"),
      import("../shared/storageLock.js"),
    ]);

    vaultValue = { v: 1 };
    requestUserApproval.mockResolvedValueOnce({ accountIndex: 0 });
    let releaseLifecycle;
    let lifecycleStarted;
    const started = new Promise((resolve) => { lifecycleStarted = resolve; });
    const lifecycle = withStorageLock(WALLET_LIFECYCLE_LOCK, async () => {
      lifecycleStarted();
      await new Promise((resolve) => { releaseLifecycle = resolve; });
    });
    await started;

    const request = handleRpc("https://dapp.example", { method: "dusk_requestProfiles" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(approveOrigin).not.toHaveBeenCalled();

    engineStatus = { isUnlocked: false, accounts: [], addresses: [], selectedAccountIndex: 0 };
    releaseLifecycle();
    await lifecycle;
    await expect(request).rejects.toMatchObject({ code: ERROR_CODES.UNAUTHORIZED });
    expect(approveOrigin).not.toHaveBeenCalled();
  });

  it("connected-but-locked dApps can request profiles to trigger unlock and reconnect UX", async () => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    vaultValue = { v: 1 };
    perms["https://dapp.example"] = {
      profileId: "account:0:acct0",
      accountIndex: 0,
      grants: { publicAccount: true, shieldedReceiveAddress: false },
      connectedAt: 1,
      updatedAt: 1,
    };
    engineStatus = {
      isUnlocked: false,
      accounts: ["acct0"],
      addresses: ["addr0"],
      selectedAccountIndex: 0,
    };
    requestUserApproval.mockImplementationOnce(async () => {
      engineStatus = {
        isUnlocked: true,
        accounts: ["acct0"],
        addresses: ["addr0"],
        selectedAccountIndex: 0,
      };
      return { accountIndex: 0 };
    });

    const profiles = await handleRpc("https://dapp.example", { method: "dusk_requestProfiles" });

    expect(requestUserApproval).toHaveBeenCalledWith(
      "connect",
      "https://dapp.example",
      expect.objectContaining({
        requestedProfiles: true,
        currentProfileId: "account:0:acct0",
        currentAccountIndex: 0,
      })
    );
    expect(profiles).toEqual([{ profileId: "account:0:acct0", account: "acct0" }]);
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

  it("keeps permissions and disconnect scoped to the requesting origin", async () => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    perms["https://a.example"] = {
      profileId: "account:0:acct0",
      accountIndex: 0,
      grants: { publicAccount: true, shieldedReceiveAddress: false },
      connectedAt: 1,
      updatedAt: 1,
    };
    perms["https://b.example"] = {
      profileId: "account:1:acct1",
      accountIndex: 1,
      grants: { publicAccount: true, shieldedReceiveAddress: true },
      connectedAt: 1,
      updatedAt: 1,
    };
    engineStatus = { isUnlocked: true, accounts: ["acct0", "acct1"], addresses: ["addr0", "addr1"], selectedAccountIndex: 0 };

    expect(await handleRpc("https://a.example", { method: "dusk_profiles" })).toEqual([
      { profileId: "account:0:acct0", account: "acct0" },
    ]);
    expect(await handleRpc("https://b.example", { method: "dusk_profiles" })).toEqual([
      { profileId: "account:1:acct1", account: "acct1", shieldedAddress: "addr1" },
    ]);
    expect(await handleRpc("https://untrusted.example", { method: "dusk_profiles" })).toEqual([]);

    await expect(handleRpc("https://a.example", { method: "dusk_disconnect" })).resolves.toBe(true);

    expect(perms["https://a.example"]).toBeUndefined();
    expect(perms["https://b.example"]).toBeTruthy();
    expect(await handleRpc("https://b.example", { method: "dusk_profiles" })).toEqual([
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

  it("does not expose profiles through a stale permission", async () => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");
    perms["https://dapp.example"] = {
      profileId: "account:0:another-wallet",
      accountIndex: 0,
      updatedAt: 1,
    };

    await expect(
      handleRpc("https://dapp.example", { method: "dusk_profiles" })
    ).resolves.toEqual([]);
  });

  it("dusk_getPublicBalance passes the permitted profileIndex to the engine", async () => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    perms["https://dapp.example"] = { accountIndex: 1, connectedAt: 1 };
    engineStatus = { isUnlocked: true, accounts: ["acct0", "acct1"] };

    const res = await handleRpc("https://dapp.example", { method: "dusk_getPublicBalance" });
    expect(res.__params).toMatchObject({
      profileIndex: 1,
      _approvalContext: { account: "acct1", walletId: "acct0" },
    });
  });

  it("does not read a replacement wallet balance after context capture", async () => {
    vi.resetModules();
    const [{ handleRpc }, { WALLET_LIFECYCLE_LOCK, withStorageLock }] = await Promise.all([
      import("./rpc.js"),
      import("../shared/storageLock.js"),
    ]);
    perms["https://dapp.example"] = {
      profileId: "account:0:acct0",
      accountIndex: 0,
      updatedAt: 1,
    };
    let releaseLifecycle;
    let lifecycleStarted;
    const started = new Promise((resolve) => { lifecycleStarted = resolve; });
    const lifecycle = withStorageLock(WALLET_LIFECYCLE_LOCK, async () => {
      lifecycleStarted();
      await new Promise((resolve) => { releaseLifecycle = resolve; });
    });
    await started;

    const request = handleRpc("https://dapp.example", { method: "dusk_getPublicBalance" });
    await vi.waitFor(() => expect(getEngineStatusStrict).toHaveBeenCalled());
    engineStatus = { isUnlocked: true, accounts: ["wallet-b"] };
    perms = {};
    releaseLifecycle();
    await lifecycle;

    await expect(request).rejects.toMatchObject({
      code: ERROR_CODES.UNAUTHORIZED,
      message: "Wallet changed while awaiting approval",
    });
    expect(engineCall).not.toHaveBeenCalledWith("dusk_getPublicBalance", expect.anything());
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
        to: PUBLIC_ACCOUNT,
        amount: "1",
        memo: "hi",
        profileIndex: 999,
      },
    });

    expect(tx).toMatchObject({ hash: "0xhash", nonce: "5" });
    expect(requestUserApproval).toHaveBeenCalledWith(
      "send_tx",
      "https://dapp.example",
      expect.objectContaining({
        kind: "transfer",
        privacy: "public",
        to: PUBLIC_ACCOUNT,
        amount: "1",
        chainId: "dusk:2",
        networkName: "Testnet",
        nodeUrl: "https://testnet.nodes.dusk.network",
        gas: { limit: "2000000", price: "1" },
      })
    );

    const call = engineCall.mock.calls.find(([m]) => m === "dusk_sendTransaction");
    expect(call).toBeTruthy();
    expect(call[1].profileIndex).toBe(0);

    expect(putTxMeta).toHaveBeenCalledWith(
      "0xhash",
      expect.objectContaining({
        origin: "https://dapp.example",
        kind: "transfer",
        to: PUBLIC_ACCOUNT,
        privacy: "public",
      })
    );
  });

  it("dusk_sendTransaction applies the higher Phoenix transfer gas default", async () => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    perms["https://dapp.example"] = { accountIndex: 0, connectedAt: 1 };
    vaultValue = { v: 1 };
    engineStatus = { isUnlocked: true, accounts: ["acct0"], addresses: ["addr0"] };

    const result = await handleRpc("https://dapp.example", {
      method: "dusk_sendTransaction",
      params: {
        kind: "transfer",
        privacy: "shielded",
        to: SHIELDED_ADDRESS,
        amount: "1",
      },
    });

    expect(result).toEqual({ hash: "0xhash", nonce: "5" });
    expect(requestUserApproval).toHaveBeenCalledWith(
      "send_tx",
      "https://dapp.example",
      expect.objectContaining({
        kind: "transfer",
        privacy: "shielded",
        to: SHIELDED_ADDRESS,
        gas: { limit: "15000000", price: "1" },
      })
    );
    expect(putTxMeta).toHaveBeenCalledWith(
      "0xhash",
      expect.objectContaining({
        privacy: "shielded",
        pendingNullifiers: ["aa"],
        reservationStatus: "pending",
      })
    );
  });

  it("dusk_sendTransaction rejects under-floor Phoenix transfer gas before approval", async () => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    perms["https://dapp.example"] = { accountIndex: 0, connectedAt: 1 };
    vaultValue = { v: 1 };
    engineStatus = { isUnlocked: true, accounts: ["acct0"], addresses: ["addr0"] };

    await expect(
      handleRpc("https://dapp.example", {
        method: "dusk_sendTransaction",
        params: {
          kind: "transfer",
          privacy: "shielded",
          to: SHIELDED_ADDRESS,
          amount: "1",
          gas: { limit: "10000000", price: "1" },
        },
      })
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_PARAMS,
      message: expect.stringMatching(/at least 15000000/),
    });

    expect(requestUserApproval).not.toHaveBeenCalledWith("send_tx", expect.anything(), expect.anything());
    expect(engineCall).not.toHaveBeenCalledWith("dusk_sendTransaction", expect.anything());
  });

  it("dusk_sendTransaction rejects approval override that lowers Phoenix transfer gas", async () => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    perms["https://dapp.example"] = { accountIndex: 0, connectedAt: 1 };
    vaultValue = { v: 1 };
    engineStatus = { isUnlocked: true, accounts: ["acct0"], addresses: ["addr0"] };
    requestUserApproval.mockResolvedValueOnce({ gas: { limit: "10000000", price: "1" } });

    await expect(
      handleRpc("https://dapp.example", {
        method: "dusk_sendTransaction",
        params: {
          kind: "transfer",
          privacy: "shielded",
          to: SHIELDED_ADDRESS,
          amount: "1",
        },
      })
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_PARAMS,
      message: expect.stringMatching(/at least 15000000/),
    });

    expect(requestUserApproval).toHaveBeenCalledWith(
      "send_tx",
      "https://dapp.example",
      expect.objectContaining({ gas: { limit: "15000000", price: "1" } })
    );
    expect(engineCall).not.toHaveBeenCalledWith("dusk_sendTransaction", expect.anything());
  });

  it("dusk_sendTransaction can unlock in the approval window", async () => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    perms["https://dapp.example"] = { accountIndex: 0, connectedAt: 1 };
    engineStatus = { isUnlocked: false, accounts: [] };
    requestUserApproval.mockImplementationOnce(async () => {
      engineStatus = { isUnlocked: true, accounts: ["acct0", "acct1"] };
      return null;
    });

    await expect(handleRpc("https://dapp.example", {
      method: "dusk_sendTransaction",
      params: { kind: "transfer", privacy: "public", to: PUBLIC_ACCOUNT, amount: "1" },
    })).resolves.toMatchObject({ hash: "0xhash" });
  });

  it("dusk_sendTransaction rejects if the wallet locks after approval and before send", async () => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    perms["https://dapp.example"] = { accountIndex: 0, connectedAt: 1 };
    engineStatus = { isUnlocked: true, accounts: ["acct0", "acct1"] };
    requestUserApproval.mockImplementationOnce(async () => {
      engineStatus = { isUnlocked: false, accounts: ["acct0", "acct1"] };
      return null;
    });

    await expect(
      handleRpc("https://dapp.example", {
        method: "dusk_sendTransaction",
        params: {
          kind: "transfer",
          privacy: "public",
          to: PUBLIC_ACCOUNT,
          amount: "1",
        },
      })
    ).rejects.toMatchObject({ code: ERROR_CODES.UNAUTHORIZED });

    expect(engineCall).not.toHaveBeenCalledWith("dusk_sendTransaction", expect.anything());
    expect(putTxMeta).not.toHaveBeenCalled();
  });

  it.each(["account", "network", "permission"]) (
    "dusk_sendTransaction rejects when %s changes during approval",
    async (changed) => {
      vi.resetModules();
      const { handleRpc } = await import("./rpc.js");
      perms["https://dapp.example"] = {
        profileId: "account:0:acct0",
        accountIndex: 0,
        updatedAt: 1,
      };
      engineStatus = { isUnlocked: true, accounts: ["acct0", "acct1"] };
      requestUserApproval.mockImplementationOnce(async () => {
        if (changed === "account") engineStatus.accounts[0] = "other-wallet";
        if (changed === "network") settings.nodeUrl = "https://nodes.dusk.network";
        if (changed === "permission") perms["https://dapp.example"].updatedAt = 2;
        return null;
      });

      await expect(handleRpc("https://dapp.example", {
        method: "dusk_sendTransaction",
        params: {
          kind: "transfer",
          privacy: "public",
          to: PUBLIC_ACCOUNT,
          amount: "1",
        },
      })).rejects.toMatchObject({
        code: ERROR_CODES.UNAUTHORIZED,
        message: "Wallet changed while awaiting approval",
      });
      expect(engineCall).not.toHaveBeenCalledWith("dusk_sendTransaction", expect.anything());
    }
  );

  it("rejects a resolved approval if reset wins the lifecycle lock", async () => {
    vi.resetModules();
    const [{ handleRpc }, { WALLET_LIFECYCLE_LOCK, withStorageLock }] = await Promise.all([
      import("./rpc.js"),
      import("../shared/storageLock.js"),
    ]);
    perms["https://dapp.example"] = {
      profileId: "account:0:acct0",
      accountIndex: 0,
      updatedAt: 1,
    };
    let releaseLifecycle;
    let lifecycleStarted;
    const started = new Promise((resolve) => { lifecycleStarted = resolve; });
    const lifecycle = withStorageLock(WALLET_LIFECYCLE_LOCK, async () => {
      lifecycleStarted();
      await new Promise((resolve) => { releaseLifecycle = resolve; });
    });
    await started;

    const request = handleRpc("https://dapp.example", {
      method: "dusk_sendTransaction",
      params: { kind: "transfer", privacy: "public", to: PUBLIC_ACCOUNT, amount: "1" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    engineStatus = { isUnlocked: true, accounts: ["wallet-b"] };
    perms = {};
    releaseLifecycle();
    await lifecycle;

    await expect(request).rejects.toMatchObject({
      code: ERROR_CODES.UNAUTHORIZED,
      message: "Wallet changed while awaiting approval",
    });
    expect(engineCall).not.toHaveBeenCalledWith("dusk_sendTransaction", expect.anything());
  });

  it("dusk_sendTransaction preserves user rejection error codes", async () => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    perms["https://dapp.example"] = { accountIndex: 0, connectedAt: 1 };
    engineStatus = { isUnlocked: true, accounts: ["acct0"] };
    requestUserApproval.mockRejectedValueOnce(
      Object.assign(new Error("User rejected the request"), {
        code: ERROR_CODES.USER_REJECTED,
      })
    );

    await expect(
      handleRpc("https://dapp.example", {
        method: "dusk_sendTransaction",
        params: {
          kind: "transfer",
          privacy: "public",
          to: PUBLIC_ACCOUNT,
          amount: "1",
        },
      })
    ).rejects.toMatchObject({ code: ERROR_CODES.USER_REJECTED });

    expect(engineCall).not.toHaveBeenCalledWith("dusk_sendTransaction", expect.anything());
  });

  it("dusk_signMessage overwrites dApp-supplied profile/account indexes before engine calls", async () => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    perms["https://dapp.example"] = {
      profileId: "account:1:acct1",
      accountIndex: 1,
      grants: { publicAccount: true, shieldedReceiveAddress: false },
      connectedAt: 1,
      updatedAt: 1,
    };
    engineStatus = { isUnlocked: true, accounts: ["acct0", "acct1"] };

    await expect(
      handleRpc("https://dapp.example", {
        method: "dusk_signMessage",
        params: {
          message: "0x1234",
          profileIndex: 999,
          accountIndex: 999,
        },
      })
    ).resolves.toMatchObject({ ok: true });

    const call = engineCall.mock.calls.find(([m]) => m === "dusk_signMessage");
    expect(call).toBeTruthy();
    expect(call[1]).toMatchObject({
      origin: "https://dapp.example",
      profileIndex: 1,
    });
    expect(call[1]).not.toHaveProperty("accountIndex");
  });

  it("dusk_signMessage sends canonical readable preview metadata for approval without changing engine input", async () => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    perms["https://dapp.example"] = { accountIndex: 0, connectedAt: 1 };
    engineStatus = { isUnlocked: true, accounts: ["acct0"] };
    const message = new TextEncoder().encode("Sign in to Dusk Wallet");

    await expect(
      handleRpc("https://dapp.example", {
        method: "dusk_signMessage",
        params: {
          message,
          display: { messageHash: "fake", messagePreview: { text: "fake" } },
        },
      })
    ).resolves.toMatchObject({ ok: true });

    const expectedHash = await sha256Hex(message);
    expect(requestUserApproval).toHaveBeenCalledWith(
      "sign_message",
      "https://dapp.example",
      expect.objectContaining({
        chainId: "dusk:2",
        messageHash: `0x${expectedHash}`,
        messageLen: message.length,
        messagePreview: expect.objectContaining({
          kind: "text",
          text: "Sign in to Dusk Wallet",
          byteLength: message.length,
          truncated: false,
        }),
      })
    );

    const approvalPayload = requestUserApproval.mock.calls.find(([kind]) => kind === "sign_message")?.[2];
    expect(approvalPayload).not.toHaveProperty("display");

    const enginePayload = engineCall.mock.calls.find(([m]) => m === "dusk_signMessage")?.[1];
    expect(enginePayload).toMatchObject({
      origin: "https://dapp.example",
      chainId: "dusk:2",
      message,
      profileIndex: 0,
    });
    expect(enginePayload).not.toHaveProperty("messagePreview");
    expect(enginePayload).not.toHaveProperty("messageHash");
    expect(enginePayload).not.toHaveProperty("messageLen");
  });

  it("dusk_signMessage labels binary approval payloads as opaque bytes", async () => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    perms["https://dapp.example"] = { accountIndex: 0, connectedAt: 1 };
    engineStatus = { isUnlocked: true, accounts: ["acct0"] };

    await expect(
      handleRpc("https://dapp.example", {
        method: "dusk_signMessage",
        params: { message: Uint8Array.from([0xff, 0xfe, 0xfd]) },
      })
    ).resolves.toMatchObject({ ok: true });

    expect(requestUserApproval).toHaveBeenCalledWith(
      "sign_message",
      "https://dapp.example",
      expect.objectContaining({
        messageLen: 3,
        messagePreview: expect.objectContaining({
          kind: "opaque",
          reason: "invalid_utf8",
          label: "Opaque bytes",
        }),
      })
    );
  });

  it("custody-sensitive methods reject while locked and do not call the engine", async () => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    perms["https://dapp.example"] = {
      profileId: "account:0:acct0",
      accountIndex: 0,
      grants: { publicAccount: true, shieldedReceiveAddress: false },
      connectedAt: 1,
      updatedAt: 1,
    };
    engineStatus = { isUnlocked: false, accounts: ["acct0"], addresses: ["addr0"], selectedAccountIndex: 0 };

    await expect(
      handleRpc("https://dapp.example", {
        method: "dusk_signMessage",
        params: { message: "0x1234" },
      })
    ).rejects.toMatchObject({ code: ERROR_CODES.UNAUTHORIZED });
    expect(engineCall).not.toHaveBeenCalledWith("dusk_signMessage", expect.anything());
  });

  it("dusk_signMessage rejects if the wallet locks after approval and before signing", async () => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    perms["https://dapp.example"] = { accountIndex: 0, connectedAt: 1 };
    engineStatus = { isUnlocked: true, accounts: ["acct0"] };
    requestUserApproval.mockImplementationOnce(async () => {
      engineStatus = { isUnlocked: false, accounts: ["acct0"] };
      return null;
    });

    await expect(
      handleRpc("https://dapp.example", {
        method: "dusk_signMessage",
        params: { message: "0x1234" },
      })
    ).rejects.toMatchObject({ code: ERROR_CODES.UNAUTHORIZED });

    expect(engineCall).not.toHaveBeenCalledWith("dusk_signMessage", expect.anything());
  });

  it("dusk_signAuth rejects if the wallet locks after approval and before signing", async () => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    perms["https://dapp.example"] = { accountIndex: 0, connectedAt: 1 };
    engineStatus = { isUnlocked: true, accounts: ["acct0"] };
    requestUserApproval.mockImplementationOnce(async () => {
      engineStatus = { isUnlocked: false, accounts: ["acct0"] };
      return null;
    });

    await expect(
      handleRpc("https://dapp.example", {
        method: "dusk_signAuth",
        params: { nonce: "nonce-1", statement: "Sign in" },
      })
    ).rejects.toMatchObject({ code: ERROR_CODES.UNAUTHORIZED });

    expect(engineCall).not.toHaveBeenCalledWith("dusk_signAuth", expect.anything());
  });

  it("dusk_watchAsset rejects if the wallet locks after approval and before asset writes", async () => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    perms["https://dapp.example"] = { accountIndex: 0, connectedAt: 1 };
    engineStatus = { isUnlocked: true, accounts: ["acct0"] };
    requestUserApproval.mockImplementationOnce(async () => {
      engineStatus = { isUnlocked: false, accounts: ["acct0"] };
      return null;
    });

    await expect(
      handleRpc("https://dapp.example", {
        method: "dusk_watchAsset",
        params: {
          type: "DRC20",
          options: { contractId: `0x${"02".repeat(32)}` },
        },
      })
    ).rejects.toMatchObject({ code: ERROR_CODES.UNAUTHORIZED });

    expect(engineCall).not.toHaveBeenCalledWith("dusk_getDrc20Metadata", expect.anything());
    expect(watchToken).not.toHaveBeenCalled();
    expect(watchNft).not.toHaveBeenCalled();
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
    ["missing privacy", { kind: "transfer", to: PUBLIC_ACCOUNT, amount: "1" }],
    ["blank privacy", { kind: "transfer", privacy: "  ", to: PUBLIC_ACCOUNT, amount: "1" }],
    ["invalid privacy", { kind: "transfer", privacy: "private", to: PUBLIC_ACCOUNT, amount: "1" }],
    ["public to shielded address", { kind: "transfer", privacy: "public", to: SHIELDED_ADDRESS, amount: "1" }],
    ["shielded to public account", { kind: "transfer", privacy: "shielded", to: PUBLIC_ACCOUNT, amount: "1" }],
    ["missing amount", { kind: "transfer", privacy: "public", to: PUBLIC_ACCOUNT }],
    ["zero amount", { kind: "transfer", privacy: "public", to: PUBLIC_ACCOUNT, amount: "0" }],
    ["decimal amount", { kind: "transfer", privacy: "public", to: PUBLIC_ACCOUNT, amount: "1.5" }],
    ["negative amount", { kind: "transfer", privacy: "public", to: PUBLIC_ACCOUNT, amount: "-1" }],
    ["amount larger than u64", { kind: "transfer", privacy: "public", to: PUBLIC_ACCOUNT, amount: "18446744073709551616" }],
    ["non-string memo", { kind: "transfer", privacy: "public", to: PUBLIC_ACCOUNT, amount: "1", memo: { text: "hi" } }],
    ["oversized memo", { kind: "transfer", privacy: "public", to: PUBLIC_ACCOUNT, amount: "1", memo: "x".repeat(513) }],
    ["partial gas", { kind: "transfer", privacy: "public", to: PUBLIC_ACCOUNT, amount: "1", gas: { limit: "1" } }],
    ["non-object gas", { kind: "transfer", privacy: "public", to: PUBLIC_ACCOUNT, amount: "1", gas: "auto" }],
    ["zero gas", { kind: "transfer", privacy: "public", to: PUBLIC_ACCOUNT, amount: "1", gas: { limit: "0", price: "1" } }],
    ["decimal gas", { kind: "transfer", privacy: "public", to: PUBLIC_ACCOUNT, amount: "1", gas: { limit: "1.5", price: "1" } }],
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

  it.each([
    ["invalid contractId", { contractId: "0x1234", fnName: "stake", fnArgs: "0x", amount: "0", deposit: "0", display: { label: "safe" } }],
    ["missing fnName", { contractId: `0x${"02".repeat(32)}`, fnArgs: "0x", amount: "0", deposit: "0" }],
    ["oversized fnName", { contractId: `0x${"02".repeat(32)}`, fnName: "x".repeat(65), fnArgs: "0x", amount: "0", deposit: "0" }],
    ["malformed fnArgs", { contractId: `0x${"02".repeat(32)}`, fnName: "stake", fnArgs: { bytes: "0x" }, amount: "0", deposit: "0" }],
    ["oversized fnArgs", { contractId: `0x${"02".repeat(32)}`, fnName: "stake", fnArgs: `0x${"00".repeat(65537)}`, amount: "0", deposit: "0" }],
    ["negative deposit", { contractId: `0x${"02".repeat(32)}`, fnName: "stake", fnArgs: "0x", amount: "0", deposit: "-1" }],
    ["partial gas", { contractId: `0x${"02".repeat(32)}`, fnName: "stake", fnArgs: "0x", amount: "0", deposit: "0", gas: { price: "1" } }],
    ["memo", { contractId: `0x${"02".repeat(32)}`, fnName: "stake", fnArgs: "0x", amount: "0", deposit: "0", memo: "not allowed" }],
  ])("dusk_sendTransaction rejects contract_call with %s before approval", async (_label, tx) => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    perms["https://dapp.example"] = { accountIndex: 0, connectedAt: 1 };
    engineStatus = { isUnlocked: true, accounts: ["acct0"] };

    await expect(
      handleRpc("https://dapp.example", {
        method: "dusk_sendTransaction",
        params: {
          kind: "contract_call",
          privacy: "public",
          ...tx,
        },
      })
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_PARAMS });
    expect(requestUserApproval).not.toHaveBeenCalledWith("send_tx", expect.anything(), expect.anything());
  });

  it("dusk_sendTransaction approval shows canonical contract call context", async () => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    perms["https://dapp.example"] = { accountIndex: 0, connectedAt: 1 };
    engineStatus = { isUnlocked: true, accounts: ["acct0"] };
    requestUserApproval.mockImplementationOnce(async () => {
      engineStatus = { isUnlocked: false, accounts: ["acct0"] };
      return null;
    });

    await expect(
      handleRpc("https://dapp.example", {
        method: "dusk_sendTransaction",
        params: {
          kind: "contract_call",
          privacy: "shielded",
          contractId: `0x${"AB".repeat(32)}`,
          fnName: "transfer",
          fnArgs: "0x1234",
          amount: "0",
          deposit: "5",
          display: { spender: "untrusted-display-only" },
        },
      })
    ).rejects.toMatchObject({ code: ERROR_CODES.UNAUTHORIZED });

    expect(requestUserApproval).toHaveBeenCalledWith(
      "send_tx",
      "https://dapp.example",
      expect.objectContaining({
        kind: "contract_call",
        privacy: "shielded",
        contractId: `0x${"ab".repeat(32)}`,
        fnName: "transfer",
        fnArgs: "0x1234",
        amount: "0",
        deposit: "5",
        chainId: "dusk:2",
        networkName: "Testnet",
        nodeUrl: "https://testnet.nodes.dusk.network",
      })
    );
  });

  it("dusk_sendTransaction rejects under-floor shielded contract-call gas before approval", async () => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    perms["https://dapp.example"] = { accountIndex: 0, connectedAt: 1 };
    vaultValue = { v: 1 };
    engineStatus = { isUnlocked: true, accounts: ["acct0"], addresses: ["addr0"] };

    await expect(
      handleRpc("https://dapp.example", {
        method: "dusk_sendTransaction",
        params: {
          kind: "contract_call",
          privacy: "shielded",
          contractId: `0x${"ab".repeat(32)}`,
          fnName: "transfer",
          fnArgs: "0x1234",
          amount: "0",
          deposit: "5",
          gas: { limit: "50000000", price: "1" },
        },
      })
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_PARAMS,
      message: expect.stringMatching(/at least 100000000/),
    });

    expect(requestUserApproval).not.toHaveBeenCalledWith("send_tx", expect.anything(), expect.anything());
    expect(engineCall).not.toHaveBeenCalledWith("dusk_sendTransaction", expect.anything());
  });

  it("dusk_sendTransaction strips shielded contract-call nullifiers from provider response", async () => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    perms["https://dapp.example"] = { accountIndex: 0, connectedAt: 1 };
    vaultValue = { v: 1 };
    engineStatus = { isUnlocked: true, accounts: ["acct0"], addresses: ["addr0"] };

    const result = await handleRpc("https://dapp.example", {
      method: "dusk_sendTransaction",
      params: {
        kind: "contract_call",
        privacy: "shielded",
        contractId: `0x${"ab".repeat(32)}`,
        fnName: "transfer",
        fnArgs: "0x1234",
        amount: "0",
        deposit: "5",
      },
    });

    expect(result).toEqual({ hash: "0xhash", nonce: "5" });
    expect(putTxMeta).toHaveBeenCalledWith(
      "0xhash",
      expect.objectContaining({
        kind: "contract_call",
        privacy: "shielded",
        pendingNullifiers: ["aa"],
        reservationStatus: "pending",
      })
    );
  });

  it.each([
    ["non-object params", null],
    ["unsupported type", { type: "ERC20", options: { contractId: `0x${"02".repeat(32)}` } }],
    ["missing options", { type: "DRC20" }],
    ["invalid DRC20 contractId", { type: "DRC20", options: { contractId: "0x1234", symbol: "FAKE" } }],
    ["missing DRC721 tokenId", { type: "DRC721", options: { contractId: `0x${"02".repeat(32)}` } }],
    ["negative DRC721 tokenId", { type: "DRC721", options: { contractId: `0x${"02".repeat(32)}`, tokenId: "-1" } }],
    ["oversized DRC721 tokenId", { type: "DRC721", options: { contractId: `0x${"02".repeat(32)}`, tokenId: "18446744073709551616" } }],
  ])("dusk_watchAsset rejects %s before approval", async (_label, params) => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    perms["https://dapp.example"] = { accountIndex: 0, connectedAt: 1 };
    engineStatus = { isUnlocked: true, accounts: ["acct0"] };

    await expect(
      handleRpc("https://dapp.example", {
        method: "dusk_watchAsset",
        params,
      })
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_PARAMS });
    expect(requestUserApproval).not.toHaveBeenCalledWith("watch_asset", expect.anything(), expect.anything());
  });

  it.each([
    ["non-object params", null],
    ["unknown chain", { chainId: "dusk:999" }],
    ["invalid node URL", { nodeUrl: "not a url" }],
    ["unsupported node URL protocol", { nodeUrl: "ftp://node.example" }],
    ["non-local HTTP node URL", { nodeUrl: "http://node.example:8080" }],
    ["private LAN HTTP node URL", { nodeUrl: "http://192.168.1.20:8080" }],
  ])("dusk_switchNetwork rejects %s before approval", async (_label, params) => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    vaultValue = { v: 1 };
    perms["https://dapp.example"] = { accountIndex: 0, connectedAt: 1 };

    await expect(
      handleRpc("https://dapp.example", {
        method: "dusk_switchNetwork",
        params,
      })
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_PARAMS });
    expect(requestUserApproval).not.toHaveBeenCalledWith("switch_network", expect.anything(), expect.anything());
  });

  it.each([
    ["HTTPS custom node", "https://node.example"],
    ["localhost custom node", "http://localhost:8080"],
    ["127.0.0.1 custom node", "http://127.0.0.1:8080"],
    ["IPv6 localhost custom node", "http://[::1]:8080"],
  ])("dusk_switchNetwork accepts %s", async (_label, nodeUrl) => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    vaultValue = { v: 1 };
    perms["https://dapp.example"] = { accountIndex: 0, connectedAt: 1 };

    await expect(
      handleRpc("https://dapp.example", {
        method: "dusk_switchNetwork",
        params: { nodeUrl },
      })
    ).resolves.toBeNull();

    expect(requestUserApproval).toHaveBeenCalledWith(
      "switch_network",
      "https://dapp.example",
      expect.objectContaining({
        to: expect.objectContaining({ nodeUrl }),
      })
    );
    expect(setSettings).toHaveBeenCalledWith({ nodeUrl });
  });

  it("dusk_switchNetwork returns null without approval when target preset URL matches current settings", async () => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    vaultValue = { v: 1 };
    perms["https://dapp.example"] = { accountIndex: 0, connectedAt: 1 };
    settings = {
      ...settings,
      nodeUrl: "https://testnet.nodes.dusk.network",
    };

    await expect(
      handleRpc("https://dapp.example", {
        method: "dusk_switchNetwork",
        params: { chainId: "dusk:2" },
      })
    ).resolves.toBeNull();

    expect(requestUserApproval).not.toHaveBeenCalledWith("switch_network", expect.anything(), expect.anything());
    expect(setSettings).not.toHaveBeenCalled();
  });

  it("dusk_switchNetwork treats a trailing slash as the current node", async () => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    vaultValue = { v: 1 };
    perms["https://dapp.example"] = { accountIndex: 0, connectedAt: 1 };
    settings = {
      ...settings,
      nodeUrl: "http://127.0.0.1:18181",
    };

    await expect(
      handleRpc("https://dapp.example", {
        method: "dusk_switchNetwork",
        params: { nodeUrl: "http://127.0.0.1:18181/" },
      })
    ).resolves.toBeNull();

    expect(requestUserApproval).not.toHaveBeenCalledWith("switch_network", expect.anything(), expect.anything());
    expect(setSettings).not.toHaveBeenCalled();
  });

  it("dusk_signMessage rejects malformed message params before approval", async () => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    perms["https://dapp.example"] = { accountIndex: 0, connectedAt: 1 };
    engineStatus = { isUnlocked: true, accounts: ["acct0"] };

    await expect(
      handleRpc("https://dapp.example", {
        method: "dusk_signMessage",
        params: { message: { not: "bytes" } },
      })
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_PARAMS });
    expect(requestUserApproval).not.toHaveBeenCalledWith("sign_message", expect.anything(), expect.anything());
  });

  it("dusk_signMessage rejects missing message before approval", async () => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    perms["https://dapp.example"] = { accountIndex: 0, connectedAt: 1 };
    engineStatus = { isUnlocked: true, accounts: ["acct0"] };

    await expect(
      handleRpc("https://dapp.example", {
        method: "dusk_signMessage",
        params: {},
      })
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_PARAMS });
    expect(requestUserApproval).not.toHaveBeenCalledWith("sign_message", expect.anything(), expect.anything());
  });

  it("dusk_signAuth rejects missing nonce before approval", async () => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    perms["https://dapp.example"] = { accountIndex: 0, connectedAt: 1 };
    engineStatus = { isUnlocked: true, accounts: ["acct0"] };

    await expect(
      handleRpc("https://dapp.example", {
        method: "dusk_signAuth",
        params: { statement: "Sign in" },
      })
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_PARAMS });
    expect(requestUserApproval).not.toHaveBeenCalledWith("sign_auth", expect.anything(), expect.anything());
  });

  it.each([
    ["oversized nonce", { nonce: "n".repeat(129) }],
    ["oversized statement", { nonce: "n", statement: "s".repeat(281) }],
    ["invalid expiresAt", { nonce: "n", expiresAt: "not a date" }],
  ])("dusk_signAuth rejects %s before approval", async (_label, params) => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    perms["https://dapp.example"] = { accountIndex: 0, connectedAt: 1 };
    engineStatus = { isUnlocked: true, accounts: ["acct0"] };

    await expect(
      handleRpc("https://dapp.example", {
        method: "dusk_signAuth",
        params,
      })
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_PARAMS });
    expect(requestUserApproval).not.toHaveBeenCalledWith("sign_auth", expect.anything(), expect.anything());
  });

  it("dusk_signAuth includes nonce and normalized expiry in approval and engine payload", async () => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    perms["https://dapp.example"] = { accountIndex: 0, connectedAt: 1 };
    engineStatus = { isUnlocked: true, accounts: ["acct0"] };

    await expect(
      handleRpc("https://dapp.example", {
        method: "dusk_signAuth",
        params: {
          nonce: "nonce-1",
          statement: "Sign in",
          expiresAt: "2026-05-11T12:00:00Z",
        },
      })
    ).resolves.toMatchObject({ ok: true });

    expect(requestUserApproval).toHaveBeenCalledWith(
      "sign_auth",
      "https://dapp.example",
      expect.objectContaining({
        chainId: "dusk:2",
        nonce: "nonce-1",
        statement: "Sign in",
        expiresAt: "2026-05-11T12:00:00.000Z",
      })
    );
    expect(engineCall).toHaveBeenCalledWith(
      "dusk_signAuth",
      expect.objectContaining({
        origin: "https://dapp.example",
        chainId: "dusk:2",
        nonce: "nonce-1",
        statement: "Sign in",
        expiresAt: "2026-05-11T12:00:00.000Z",
        profileIndex: 0,
      })
    );
  });

  // ---------------------------------------------------------------------------
  // dusk_signTypedData
  // ---------------------------------------------------------------------------

  const TYPED_DATA_DOMAIN_FIELDS = [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "string" },
    { name: "verifyingContract", type: "bytes32" },
  ];

  const TYPED_DATA_DOMAIN = { name: "Example dApp", version: "1", chainId: "dusk:2" };
  const TYPED_DATA_TYPES = {
    DuskTypedDataDomain: TYPED_DATA_DOMAIN_FIELDS,
    Mail: [
      { name: "to", type: "string" },
      { name: "contents", type: "string" },
    ],
  };
  const TYPED_DATA_PRIMARY_TYPE = "Mail";
  const TYPED_DATA_MESSAGE = { to: "alice", contents: "hello" };

  function typedDataParams({ domain, types, ...rest } = {}) {
    return {
      domain: { ...TYPED_DATA_DOMAIN, ...domain },
      types: { ...TYPED_DATA_TYPES, ...types },
      primaryType: TYPED_DATA_PRIMARY_TYPE,
      message: TYPED_DATA_MESSAGE,
      // No `origin` by default: the wallet injects it (spec 8) and the docs tell
      // dApps not to send one, so this is the shape a conforming caller uses.
      // Defaulting it here would mean no test ever exercised the documented
      // request, and a validator that demanded a caller-supplied origin would
      // pass every test while rejecting every real dApp. Origin injection has
      // its own test that passes one explicitly.
      ...rest,
    };
  }

  function connectDapp(accountIndex = 0) {
    perms["https://dapp.example"] = {
      profileId: `account:${accountIndex}:acct${accountIndex}`,
      accountIndex,
      grants: { publicAccount: true, shieldedReceiveAddress: false },
      connectedAt: 1,
      updatedAt: 1,
    };
  }

  it("dusk_signTypedData returns the exact spec section 13 result shape", async () => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    connectDapp(0);
    engineStatus = { isUnlocked: true, accounts: ["acct0"] };

    const params = typedDataParams();
    const result = await handleRpc("https://dapp.example", {
      method: "dusk_signTypedData",
      params,
    });

    const expectedDigest = hashTypedDataHex({
      domain: TYPED_DATA_DOMAIN,
      types: TYPED_DATA_TYPES,
      primaryType: TYPED_DATA_PRIMARY_TYPE,
      message: TYPED_DATA_MESSAGE,
      origin: "https://dapp.example",
    });

    expect(Object.keys(result).sort()).toEqual(
      ["account", "chainId", "digestHex", "origin", "primaryType", "publicKeyHex", "signature"].sort()
    );
    expect(result).toEqual({
      account: PUBLIC_ACCOUNT,
      publicKeyHex: `0x${"ab".repeat(96)}`,
      origin: "https://dapp.example",
      chainId: "dusk:2",
      primaryType: "Mail",
      digestHex: expectedDigest,
      signature: `0x${"cd".repeat(48)}`,
    });

    expect(requestUserApproval).toHaveBeenCalledWith(
      "sign_typed_data",
      "https://dapp.example",
      expect.objectContaining({
        domain: TYPED_DATA_DOMAIN,
        types: TYPED_DATA_TYPES,
        primaryType: TYPED_DATA_PRIMARY_TYPE,
        message: TYPED_DATA_MESSAGE,
        chainId: "dusk:2",
        digestHex: expectedDigest,
      })
    );
  });

  it("dusk_signTypedData accepts a request that omits origin, as the docs instruct", async () => {
    // docs/provider-api.md tells dApps the wallet injects origin and they must
    // not supply it. Validating the caller's raw params instead of the input the
    // wallet assembles made a caller-supplied origin mandatory, so every
    // conforming dApp got INVALID_PARAMS while the suite stayed green. Pin the
    // documented shape so the contract and the code cannot drift apart again.
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    connectDapp(0);
    engineStatus = { isUnlocked: true, accounts: ["acct0"] };

    const params = typedDataParams();
    expect(params).not.toHaveProperty("origin");

    const result = await handleRpc("https://dapp.example", {
      method: "dusk_signTypedData",
      params,
    });

    expect(result.origin).toBe("https://dapp.example");
    expect(result.digestHex).toBe(
      hashTypedDataHex({
        domain: TYPED_DATA_DOMAIN,
        types: TYPED_DATA_TYPES,
        primaryType: TYPED_DATA_PRIMARY_TYPE,
        message: TYPED_DATA_MESSAGE,
        origin: "https://dapp.example",
      })
    );
  });

  it("dusk_signTypedData ignores a dApp-supplied params.origin when computing the digest", async () => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    connectDapp(0);
    engineStatus = { isUnlocked: true, accounts: ["acct0"] };

    const params = typedDataParams({ origin: "https://attacker.example" });
    const result = await handleRpc("https://dapp.example", {
      method: "dusk_signTypedData",
      params,
    });

    const digestWithHandlerOrigin = hashTypedDataHex({
      domain: TYPED_DATA_DOMAIN,
      types: TYPED_DATA_TYPES,
      primaryType: TYPED_DATA_PRIMARY_TYPE,
      message: TYPED_DATA_MESSAGE,
      origin: "https://dapp.example",
    });
    const digestWithAttackerOrigin = hashTypedDataHex({
      domain: TYPED_DATA_DOMAIN,
      types: TYPED_DATA_TYPES,
      primaryType: TYPED_DATA_PRIMARY_TYPE,
      message: TYPED_DATA_MESSAGE,
      origin: "https://attacker.example",
    });

    // Sanity: the two origins really do produce different digests, so the
    // assertions below are meaningful.
    expect(digestWithHandlerOrigin).not.toBe(digestWithAttackerOrigin);

    expect(result.digestHex).toBe(digestWithHandlerOrigin);
    expect(result.origin).toBe("https://dapp.example");
  });

  it("dusk_signTypedData rejects wrong domain.chainId before approval", async () => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    connectDapp(0);
    engineStatus = { isUnlocked: true, accounts: ["acct0"] };

    const params = typedDataParams({ domain: { chainId: "dusk:999" } });

    await expect(
      handleRpc("https://dapp.example", { method: "dusk_signTypedData", params })
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_PARAMS });
    expect(requestUserApproval).not.toHaveBeenCalled();
  });

  it("dusk_signTypedData rejects an unknown params.version before approval", async () => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    connectDapp(0);
    engineStatus = { isUnlocked: true, accounts: ["acct0"] };

    const params = typedDataParams({ version: 2 });

    await expect(
      handleRpc("https://dapp.example", { method: "dusk_signTypedData", params })
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_PARAMS });
    expect(requestUserApproval).not.toHaveBeenCalled();
  });

  it.each([
    [
      "missing primaryType",
      typedDataParams({ primaryType: undefined }),
    ],
    [
      "malformed types (unknown struct reference)",
      typedDataParams({
        types: { Mail: [{ name: "to", type: "string" }, { name: "contents", type: "Bogus" }] },
      }),
    ],
  ])("dusk_signTypedData rejects %s with INVALID_PARAMS before approval", async (_label, params) => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    connectDapp(0);
    engineStatus = { isUnlocked: true, accounts: ["acct0"] };

    await expect(
      handleRpc("https://dapp.example", { method: "dusk_signTypedData", params })
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_PARAMS });
    expect(requestUserApproval).not.toHaveBeenCalled();
  });

  it("dusk_signTypedData rejects a payload exceeding the policy floor before approval", async () => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    connectDapp(0);
    engineStatus = { isUnlocked: true, accounts: ["acct0"] };

    const params = typedDataParams({
      message: { to: "alice", contents: "a".repeat(70_000) },
    });

    await expect(
      handleRpc("https://dapp.example", { method: "dusk_signTypedData", params })
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_PARAMS });
    expect(requestUserApproval).not.toHaveBeenCalled();
  });

  it("dusk_signTypedData rejects if the network changes while approval is pending", async () => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    connectDapp(0);
    engineStatus = { isUnlocked: true, accounts: ["acct0"] };
    requestUserApproval.mockImplementationOnce(async () => {
      // Simulate the user switching networks while the approval popup is open.
      // The context captured before approval recorded the old nodeUrl, so
      // assertApprovalContext sees the mismatch when it re-reads afterwards.
      settings = { ...settings, nodeUrl: "https://devnet.nodes.dusk.network" };
      return null;
    });

    const params = typedDataParams();

    // UNAUTHORIZED rather than INVALID_PARAMS: nothing is wrong with the
    // request, the wallet moved out from under an approval it had already
    // granted. Same classification the sibling sign_* methods use.
    await expect(
      handleRpc("https://dapp.example", { method: "dusk_signTypedData", params })
    ).rejects.toMatchObject({ code: ERROR_CODES.UNAUTHORIZED });
    expect(engineCall).not.toHaveBeenCalledWith("dusk_signTypedData", expect.anything());
  });

  it("dusk_signTypedData rejects an unconnected origin with UNAUTHORIZED", async () => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    engineStatus = { isUnlocked: true, accounts: ["acct0"] };
    const params = typedDataParams();

    await expect(
      handleRpc("https://dapp.example", { method: "dusk_signTypedData", params })
    ).rejects.toMatchObject({ code: ERROR_CODES.UNAUTHORIZED });
    expect(requestUserApproval).not.toHaveBeenCalled();
  });

  it("dusk_signTypedData rejects a locked wallet", async () => {
    vi.resetModules();
    const { handleRpc } = await import("./rpc.js");

    connectDapp(0);
    engineStatus = { isUnlocked: false, accounts: ["acct0"] };
    const params = typedDataParams();

    await expect(
      handleRpc("https://dapp.example", { method: "dusk_signTypedData", params })
    ).rejects.toMatchObject({ code: ERROR_CODES.UNAUTHORIZED });
    expect(engineCall).not.toHaveBeenCalledWith("dusk_signTypedData", expect.anything());
  });
});
