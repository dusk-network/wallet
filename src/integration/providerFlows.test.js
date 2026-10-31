import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// LocalStorage polyfill (needed for src/platform/storage.js in node tests)
// ---------------------------------------------------------------------------

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
      const key = String(k);
      return store.has(key) ? store.get(key) : null;
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

// ---------------------------------------------------------------------------
// Mocks for background dependencies (engine + UI approvals)
// ---------------------------------------------------------------------------

let engineStatus = { isUnlocked: true, accounts: ["acct0", "acct1"], addresses: ["addr0", "addr1"], selectedAccountIndex: 0 };

const PUBLIC_ACCOUNT =
  "M8vMuVUZZrHCW3LBFKEctWFJerYmT2HghQNuGHKrgV6BQqgkYK1A4FZLX3Nm9Rri63RZwL4gQCMhLyJRJQE5MQouqqu77Dr1rQnHqk1W7zAf4WKZqr6MgdxzkxFwFjo8ZM";

const engineCall = vi.fn(async (method) => {
  if (method === "dusk_getCachedGasPrice") {
    return { average: "1", max: "1", median: "1", min: "1" };
  }
  if (method === "dusk_sendTransaction") {
    return { hash: "0xhash", nonce: "7" };
  }
  throw new Error(`Unexpected engineCall(${method}) in integration test`);
});

const requestUserApproval = vi.fn(async (kind) => {
  if (kind === "connect") return { accountIndex: 1 };
  if (kind === "send_tx") return null;
  return null;
});

vi.mock("../shared/vault.js", () => ({
  loadVault: vi.fn(async () => ({ v: 1 })),
}));

vi.mock("../background/engineHost.js", () => ({
  engineCall,
  ensureEngineConfigured: vi.fn(async () => true),
  getEngineStatus: vi.fn(async () => engineStatus),
  getEngineStatusStrict: vi.fn(async () => engineStatus),
  invalidateEngineConfig: vi.fn(() => {}),
}));

vi.mock("../background/pending.js", () => ({
  cancelPendingApprovals: vi.fn(),
  requestUserApproval,
}));

vi.mock("../background/txNotify.js", () => ({ notifyTxSubmitted: vi.fn(async () => true) }));

vi.mock("../background/dappEvents.js", () => ({
  broadcastChainChangedAll: vi.fn(async () => {}),
}));

vi.mock("../platform/extensionApi.js", () => ({
  getExtensionApi: () => ({
    runtime: { getManifest: () => ({ version: "0.0.0-test" }) },
  }),
  runtimeGetURL: (p) => String(p ?? ""),
  tabsCreate: vi.fn(async () => ({ id: 1 })),
}));

describe("integration: provider flows", () => {
  let prevLocalStorage = null;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    prevLocalStorage = globalThis.localStorage ?? null;
    globalThis.localStorage = makeLocalStorage();

    engineStatus = { isUnlocked: true, accounts: ["acct0", "acct1"], addresses: ["addr0", "addr1"], selectedAccountIndex: 0 };
  });

  afterEach(() => {
    if (prevLocalStorage) globalThis.localStorage = prevLocalStorage;
    else delete globalThis.localStorage;
  });

  it("dApp connection flow: requestProfiles -> profiles -> disconnect", async () => {
    const { handleRpc } = await import("../background/rpc.js");
    const { getPermissionForOrigin } = await import("../shared/permissions.js");

    const origin = "https://dapp.example";

    const profiles = await handleRpc(origin, { method: "dusk_requestProfiles" });
    expect(profiles).toEqual([{ profileId: "account:1:acct1", account: "acct1" }]);
    expect(requestUserApproval).toHaveBeenCalledWith("connect", origin, expect.any(Object), { walletId: "acct0" });

    const perm = await getPermissionForOrigin(origin, "acct0");
    expect(perm).toMatchObject({
      profileId: "account:1:acct1",
      accountIndex: 1,
      grants: { publicAccount: true, shieldedReceiveAddress: false },
    });

    const profiles2 = await handleRpc(origin, { method: "dusk_profiles" });
    expect(profiles2).toEqual([{ profileId: "account:1:acct1", account: "acct1" }]);

    await handleRpc(origin, { method: "dusk_disconnect" });
    expect(await getPermissionForOrigin(origin, "acct0")).toBeNull();
  });

  it("keeps a site's connection to its wallet: on another wallet it sees nothing until it's connected there too", async () => {
    const { handleRpc } = await import("../background/rpc.js");
    const { getPermissionForOrigin } = await import("../shared/permissions.js");
    const origin = "https://dapp.example";
    const wallet = (w) => ({ isUnlocked: true, accounts: [`${w}acct0`, `${w}acct1`], addresses: [`${w}addr0`, `${w}addr1`], selectedAccountIndex: 0 });
    const profile = (w) => [{ profileId: `account:1:${w}acct1`, account: `${w}acct1` }];
    const sign = { method: "dusk_signMessage", params: { message: "0x00" } };

    engineStatus = wallet("w1");
    await expect(handleRpc(origin, { method: "dusk_requestProfiles" })).resolves.toEqual(profile("w1"));

    // Wallet 2 unlocked: nothing of it, nor of wallet 1.
    engineStatus = wallet("w2");
    await expect(handleRpc(origin, { method: "dusk_profiles" })).resolves.toEqual([]);
    await expect(handleRpc(origin, { method: "dusk_requestShieldedAddress" })).resolves.toMatchObject({ account: "w2acct1" });
    await handleRpc(origin, { method: "dusk_disconnect" });
    await expect(handleRpc(origin, { method: "dusk_getPublicBalance" })).rejects.toThrow("Not connected");
    await expect(handleRpc(origin, sign)).rejects.toThrow("Not connected");
    await expect(handleRpc(origin, { method: "dusk_estimateGas" })).rejects.toThrow("Not connected");

    // Back on wallet 1, its connection went with the site's own disconnect;
    // connected again to each, each shows its own.
    engineStatus = wallet("w1");
    await expect(handleRpc(origin, { method: "dusk_profiles" })).resolves.toEqual([]);
    await handleRpc(origin, { method: "dusk_requestProfiles" });
    engineStatus = wallet("w2");
    await expect(handleRpc(origin, { method: "dusk_profiles" })).resolves.toEqual([]);
    await handleRpc(origin, { method: "dusk_requestProfiles" });
    await expect(handleRpc(origin, { method: "dusk_profiles" })).resolves.toEqual(profile("w2"));
    engineStatus = wallet("w1");
    await expect(handleRpc(origin, { method: "dusk_profiles" })).resolves.toEqual(profile("w1"));
    expect(await getPermissionForOrigin(origin, "w1acct0")).toMatchObject({ profileId: "account:1:w1acct1" });
    expect(await getPermissionForOrigin(origin, "w2acct0")).toMatchObject({ profileId: "account:1:w2acct1" });
  });

  it("grants nothing to a wallet other than the one its prompt showed, and discloses nothing of it", async () => {
    const { handleRpc } = await import("../background/rpc.js");
    const { getPermissions } = await import("../shared/permissions.js");
    const origin = "https://dapp.example";
    const wallet = (w) => ({ isUnlocked: true, accounts: [`${w}acct0`, `${w}acct1`], addresses: [`${w}addr0`, `${w}addr1`], selectedAccountIndex: 0 });
    // Asked on wallet 1; wallet 2 is open by the time the prompt is approved.
    const switchesWhileOpen = (decision) =>
      requestUserApproval.mockImplementationOnce(async () => {
        engineStatus = wallet("w2");
        return decision;
      });

    for (const [method, decision] of [
      ["dusk_requestProfiles", { accountIndex: 1 }],
      ["dusk_requestShieldedAddress", { accountIndex: 1, shieldedReceiveAddress: true }],
    ]) {
      engineStatus = wallet("w1");
      switchesWhileOpen(decision);
      await expect(handleRpc(origin, { method })).rejects.toThrow("Wallet changed while awaiting approval");
    }
    await expect(getPermissions("w1acct0")).resolves.toEqual({});
    await expect(getPermissions("w2acct0")).resolves.toEqual({});
  });

  it("refuses a signature or a send approved on another wallet than the one its prompt showed", async () => {
    const { handleRpc } = await import("../background/rpc.js");
    const origin = "https://dapp.example";
    await handleRpc(origin, { method: "dusk_requestProfiles" });
    for (const request of [
      { method: "dusk_signMessage", params: { message: "0x00" } },
      { method: "dusk_sendTransaction", params: { kind: "transfer", privacy: "public", to: PUBLIC_ACCOUNT, amount: "1" } },
    ]) {
      requestUserApproval.mockImplementationOnce(async () => {
        engineStatus = { ...engineStatus, accounts: ["other-wallet", "acct1"] };
        return null;
      });
      await expect(handleRpc(origin, request)).rejects.toThrow("Wallet changed while awaiting approval");
      engineStatus = { isUnlocked: true, accounts: ["acct0", "acct1"], addresses: ["addr0", "addr1"], selectedAccountIndex: 0 };
    }
    expect(engineCall).not.toHaveBeenCalledWith("dusk_sendTransaction", expect.anything());
  });

  it("moves a site's connection from before wallets were kept apart when it asks, and nothing when another site asks", async () => {
    const { handleRpc } = await import("../background/rpc.js");
    const { getPermissions } = await import("../shared/permissions.js");
    const old = "https://old.example";
    const before = { profileId: "account:1:acct1", accountIndex: 1, grants: { publicAccount: true }, connectedAt: 1, updatedAt: 1 };
    localStorage.setItem("dusk_permissions_v1", JSON.stringify({ [old]: before }));

    await expect(handleRpc("https://new.example", { method: "dusk_profiles" })).resolves.toEqual([]);
    await expect(getPermissions("")).resolves.toEqual({ [old]: before });

    await expect(handleRpc(old, { method: "dusk_profiles" })).resolves.toEqual([{ profileId: "account:1:acct1", account: "acct1" }]);
    await expect(getPermissions("")).resolves.toEqual({});
    await expect(getPermissions("acct0")).resolves.toEqual({ [old]: before });
  });

  it("E2E-ish: connect -> sendTransaction -> tx meta recorded", async () => {
    const { handleRpc } = await import("../background/rpc.js");
    const { listTxs } = await import("../shared/txStore.js");

    const origin = "https://dapp.example";

    await handleRpc(origin, { method: "dusk_requestProfiles" });

    const tx = await handleRpc(origin, {
      method: "dusk_sendTransaction",
      params: {
        kind: "transfer",
        privacy: "public",
        to: PUBLIC_ACCOUNT,
        amount: "1",
        memo: "hi",
      },
    });

    expect(tx).toMatchObject({ hash: "0xhash", nonce: "7" });

    const txs = await listTxs();
    const entry = txs.find((t) => t.hash === "0xhash");
    expect(entry).toMatchObject({
      origin,
      kind: "transfer",
      to: PUBLIC_ACCOUNT,
      status: "submitted",
    });
  });
});
