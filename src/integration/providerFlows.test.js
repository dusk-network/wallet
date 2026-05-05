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
  invalidateEngineConfig: vi.fn(() => {}),
}));

vi.mock("../background/pending.js", () => ({ requestUserApproval }));

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
    expect(requestUserApproval).toHaveBeenCalledWith("connect", origin, expect.any(Object));

    const perm = await getPermissionForOrigin(origin);
    expect(perm).toMatchObject({
      profileId: "account:1:acct1",
      accountIndex: 1,
      grants: { publicAccount: true, shieldedReceiveAddress: false },
    });

    const profiles2 = await handleRpc(origin, { method: "dusk_profiles" });
    expect(profiles2).toEqual([{ profileId: "account:1:acct1", account: "acct1" }]);

    await handleRpc(origin, { method: "dusk_disconnect" });
    expect(await getPermissionForOrigin(origin)).toBeNull();
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
        to: "acct0",
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
      to: "acct0",
      status: "submitted",
    });
  });
});
