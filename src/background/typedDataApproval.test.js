import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bls12_381 } from "@noble/curves/bls12-381";
import { hashTypedDataHex } from "@dusk/typed-data";
import { verifyTypedDataSignature } from "@dusk/typed-data/bls";
import { deriveBlsSecretKeyFromSeed, signProfileTypedDataDigest } from "../shared/blsDigest.js";
import { hexToBytes } from "../shared/bytes.js";
import { approveOrigin, revokeOrigin } from "../shared/permissions.js";
import { setSettings } from "../shared/settings.js";
import { WALLET_LIFECYCLE_LOCK, withStorageLock } from "../shared/storageLock.js";
import { handleRpc } from "./rpc.js";
import { cancelPendingApprovals, pendingApprovals, resolvePendingDecision } from "./pending.js";

// Real RPC, queue, permission/settings logic, lifecycle mutex and BLS signer.
// Only platform persistence/windows and the engine host/status boundary are mocked.
const mocks = vi.hoisted(() => ({
  store: {}, status: {}, engineCall: vi.fn(), windowsCreate: vi.fn(),
}));
vi.mock("../platform/storage.js", () => ({ kv: {
  get: async key => structuredClone({ [key]: mocks.store[key] }),
  set: async items => { Object.assign(mocks.store, structuredClone(items)); },
} }));
vi.mock("../platform/extensionApi.js", () => ({
  getExtensionApi: () => ({ windows: { onRemoved: { addListener() {} } } }),
  runtimeGetURL: path => `chrome-extension://test/${path}`,
  windowsCreate: mocks.windowsCreate,
  windowsRemove: async () => {},
  tabsCreate: async () => {},
}));
vi.mock("./engineHost.js", () => ({
  engineCall: mocks.engineCall,
  ensureEngineConfigured: async () => {},
  getEngineStatus: async () => structuredClone(mocks.status),
  getEngineStatusStrict: async () => structuredClone(mocks.status),
  invalidateEngineConfig() {},
}));
vi.mock("@dusk/typed-data", async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, hashTypedDataHex: vi.fn(actual.hashTypedDataHex) };
});
const { hashTypedDataHex: hash } = await vi.importActual("@dusk/typed-data");

const nodeUrl = "https://testnet.nodes.dusk.network";
const origins = ["https://first.example", "https://second.example"];
const seed = new Uint8Array(64); // Public test seed only; no vault or funded wallet.
const profiles = [0, 1].map(index => ({
  seed,
  account: { valueOf: () => bls12_381.G2.ProjectivePoint.BASE.multiply(deriveBlsSecretKeyFromSeed(seed, index)).toRawBytes(true) },
  [Symbol.toPrimitive]: () => index,
}));
let requests;

function params(contents = "first request") {
  return {
    domain: { name: "Example", version: "1", chainId: "dusk:2" },
    types: {
      DuskTypedDataDomain: [
        { name: "name", type: "string" }, { name: "version", type: "string" },
        { name: "chainId", type: "string" }, { name: "verifyingContract", type: "bytes32" },
      ],
      Message: [{ name: "contents", type: "string" }],
    },
    primaryType: "Message", message: { contents }, origin: "https://ignored.example",
  };
}

function request(origin, input = params()) {
  const promise = handleRpc(origin, { method: "dusk_signTypedData", params: input });
  requests.push(promise);
  void promise.catch(() => {}); // Assertions below observe the outcome; cleanup can reject pending work.
  return promise;
}

function approval(origin) {
  const entry = [...pendingApprovals].find(([, value]) => value.origin === origin);
  expect(entry).toBeDefined();
  return entry;
}

function approve(origin) {
  const [rid] = approval(origin);
  // Typed-data approval is a decision only, not permission to replace the captured digest/profile.
  expect(resolvePendingDecision({ rid, decision: "approve", approvedParams: { digestHex: "0x" + "ff".repeat(32), profileIndex: 255 } })).toEqual({ ok: true });
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-16T00:00:00Z"));
  vi.clearAllMocks();
  requests = [];
  mocks.store = {};
  mocks.status = { isUnlocked: true, accounts: ["acct0", "acct1"], selectedAccountIndex: 0 };
  mocks.windowsCreate.mockImplementation(async () => ({ id: mocks.windowsCreate.mock.calls.length }));
  mocks.engineCall.mockImplementation(async (method, { digestHex, profileIndex }) => {
    expect(method).toBe("dusk_signTypedData");
    const signed = await signProfileTypedDataDigest(profiles[profileIndex], hexToBytes(digestHex));
    return { account: `acct${profileIndex}`, publicKeyHex: signed.publicKeyHex, signature: signed.signatureHex };
  });
  await setSettings({ nodeUrl });
  for (const [index, origin] of origins.entries()) {
    await approveOrigin(origin, { accountIndex: index, profileId: `account:${index}:acct${index}` });
  }
});

afterEach(async () => {
  cancelPendingApprovals(null, "Test cleanup");
  await Promise.allSettled(requests);
  expect(pendingApprovals.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

describe("typed-data RPC with the real approval queue", () => {
  it("keeps concurrent origins, captured digests and profiles separate when approved in reverse order", async () => {
    const inputs = [params(), params("second request")];
    const expected = inputs.map((input, i) => hash({ ...input, origin: origins[i] }));
    expect(expected[0]).not.toBe(expected[1]);
    const first = request(origins[0], inputs[0]);
    const second = request(origins[1], inputs[1]);
    await vi.waitFor(() => expect(pendingApprovals.size).toBe(2));
    expect(mocks.windowsCreate).toHaveBeenCalledTimes(2);
    expect(mocks.engineCall).not.toHaveBeenCalled();
    for (const [index, origin] of origins.entries()) {
      const [rid, entry] = approval(origin);
      expect(entry).toMatchObject({ kind: "sign_typed_data", origin, params: { digestHex: expected[index], message: inputs[index].message } });
      expect(mocks.windowsCreate.mock.calls.some(([window]) => new URL(window.url).searchParams.get("rid") === rid)).toBe(true);
    }

    approve(origins[1]);
    const secondResult = await second;
    expect(pendingApprovals.size).toBe(1);
    expect(approval(origins[0])[1].params.digestHex).toBe(expected[0]);
    expect(mocks.engineCall).toHaveBeenCalledTimes(1);
    // Global UI selection does not rebind an origin's granted profile.
    await setSettings({ selectedAccountIndex: 1 });
    mocks.status.selectedAccountIndex = 1;
    approve(origins[0]);
    const firstResult = await first;
    expect(hashTypedDataHex).toHaveBeenCalledTimes(2); // Once per request, never again after approval.
    expect(mocks.engineCall).toHaveBeenCalledTimes(2);
    expect(mocks.engineCall.mock.calls.map(([, value]) => value.profileIndex)).toEqual([1, 0]);
    for (const [index, result] of [firstResult, secondResult].entries()) {
      expect(result).toMatchObject({ origin: origins[index], chainId: "dusk:2", digestHex: expected[index], account: `acct${index}` });
      const [, engineParams] = mocks.engineCall.mock.calls.find(([, value]) => value.profileIndex === index);
      expect(Object.keys(engineParams).sort()).toEqual(["_approvalContext", "digestHex", "profileIndex"]);
      expect(engineParams).toMatchObject({ digestHex: expected[index], profileIndex: index, _approvalContext: {
        origin: origins[index], nodeUrl, walletId: "acct0", account: `acct${index}`,
        profileIndex: index, permissionProfileId: `account:${index}:acct${index}`,
      } });
      const input = { ...inputs[index], origin: origins[index] };
      const policy = { chainId: "dusk:2", origin: origins[index] };
      expect(verifyTypedDataSignature(input, result.signature, result.publicKeyHex, policy).ok).toBe(true);
      expect(verifyTypedDataSignature({ ...input, origin: origins[1 - index] }, result.signature, result.publicKeyHex, policy).ok).toBe(false);
    }
  });

  it("rejects a simultaneous same-origin duplicate and signs only the first request", async () => {
    const input = params();
    const expected = hash({ ...input, origin: origins[0] });
    const first = request(origins[0], input);
    const second = request(origins[0], params("duplicate"));
    await vi.waitFor(() => expect(hashTypedDataHex).toHaveBeenCalledTimes(2));
    expect(pendingApprovals.size).toBe(1);
    await expect(second).rejects.toMatchObject({ code: 4001, message: "Another approval is already pending" });
    expect(mocks.windowsCreate).toHaveBeenCalledTimes(1);
    expect(mocks.engineCall).not.toHaveBeenCalled();
    expect(approval(origins[0])[1].params.digestHex).toBe(expected);
    approve(origins[0]);
    await expect(first).resolves.toMatchObject({ digestHex: expected });
    expect(mocks.engineCall).toHaveBeenCalledExactlyOnceWith("dusk_signTypedData", expect.objectContaining({ digestHex: expected, profileIndex: 0 }));
  });

  it.each(["profile", "permission", "revocation", "network", "lock", "wallet"])(
    "refuses a %s change while approval is pending, even without queue cancellation", async (change) => {
      const pending = request(origins[0]);
      await vi.waitFor(() => expect(pendingApprovals.size).toBe(1));
      // Deliberately bypass UI cancellation to exercise the post-approval context guard itself.
      vi.setSystemTime(Date.now() + 1);
      if (change === "profile") await approveOrigin(origins[0], { accountIndex: 1, profileId: "account:1:acct1" });
      if (change === "permission") await approveOrigin(origins[0], { accountIndex: 0, profileId: "account:0:acct0", grants: { shieldedReceiveAddress: true } });
      if (change === "revocation") await revokeOrigin(origins[0]);
      if (change === "network") await setSettings({ nodeUrl: "https://devnet.nodes.dusk.network" });
      if (change === "lock") mocks.status.isUnlocked = false;
      if (change === "wallet") mocks.status.accounts = ["replacement-wallet"];
      expect(pendingApprovals.size).toBe(1);
      approve(origins[0]);
      await expect(pending).rejects.toMatchObject({ code: 4100, message: "Wallet changed while awaiting approval" });
      expect(mocks.engineCall).not.toHaveBeenCalled();
    }
  );

  it("rechecks a granted approval after a queued lifecycle change finishes", async () => {
    const pending = request(origins[0]);
    await vi.waitFor(() => expect(pendingApprovals.size).toBe(1));
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const change = withStorageLock(WALLET_LIFECYCLE_LOCK, async () => {
      await gate;
      await approveOrigin(origins[0], { accountIndex: 1, profileId: "account:1:acct1" });
    });
    try {
      approve(origins[0]);
      expect(pendingApprovals.size).toBe(0); // Cancellation can no longer reach the settled approval.
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.engineCall).not.toHaveBeenCalled();
    } finally { release(); await change; }
    await expect(pending).rejects.toMatchObject({ code: 4100, message: "Wallet changed while awaiting approval" });
    expect(mocks.engineCall).not.toHaveBeenCalled();
  });
});
