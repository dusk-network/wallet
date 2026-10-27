import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "fake-indexeddb/auto";

import { bytesToHex, sha256Hex, toBytes } from "./bytes.js";
import phoenix from "./fixtures/phoenix-testnet.json";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@dusk/w3sper", () => {
  // Minimal mock of w3sper primitives used by walletEngine.
  //
  // The real library uses a Key object that:
  // - toString() => base58
  // - valueOf() => Uint8Array bytes
  // - Symbol.toPrimitive("number") => profile index
  class Key {
    #buf;
    #index;
    #prefix;

    constructor(prefix, index, len) {
      this.#prefix = prefix;
      this.#index = index;
      this.#buf = new Uint8Array(len);
      this.#buf.fill(index & 0xff);
    }

    toString() {
      if (this.#prefix === "acct" && this.#index === 0 && globalThis.__W3SPER_FAIL_WALLET_ID__) {
        globalThis.__W3SPER_FAIL_WALLET_ID__ = false;
        throw new Error("wallet ID failed");
      }
      return `${this.#prefix}${this.#index}`;
    }

    valueOf() {
      return this.#buf.slice();
    }

    [Symbol.toPrimitive](hint) {
      if (hint === "number") return this.#index;
      if (hint === "string") return this.toString();
      return null;
    }
  }

  class Profile {
    #index;
    #account;
    #address;

    constructor(index) {
      this.#index = index;
      this.#address = new Key("addr", index, 64);
      this.#account = new Key("acct", index, 96);
    }

    get account() {
      return this.#account;
    }

    get address() {
      return this.#address;
    }

    [Symbol.toPrimitive](hint) {
      if (hint === "number") return this.#index;
      return null;
    }
  }

  class ProfileGenerator {
    #profiles = [];

    constructor(seeder) {
      globalThis.__W3SPER_LAST_SEEDER__ = seeder;
    }

    async #nth(n) {
      await globalThis.__W3SPER_PROFILE_GATE__?.(n);
      return new Profile(n);
    }

    next() {
      const index = this.#profiles.length || 1;
      if (globalThis.__W3SPER_FAIL_PROFILE_INDEX__ === index) {
        throw new Error("profile derivation failed");
      }
      const p = this.#nth(index);
      this.#profiles[index] = p;
      return p;
    }

    get default() {
      if (globalThis.__W3SPER_FAIL_PROFILE_INDEX__ === 0) {
        throw new Error("profile derivation failed");
      }
      if (typeof this.#profiles[0] === "undefined") {
        this.#profiles[0] = this.#nth(0);
      }
      return this.#profiles[0];
    }

    static typeOf(value) {
      const s = String(value ?? "");
      if (s.startsWith("addr")) return "address";
      if (s.startsWith("acct")) return "account";
      return "undefined";
    }
  }

  function buildSignedMoonlightBuffer(sigByte = 0x42) {
    const sig = new Uint8Array(48);
    sig.fill(sigByte);
    const payloadLen = 0n;

    const out = new Uint8Array(1 + 8 + Number(payloadLen) + sig.length);
    out[0] = 1; // Transaction enum variant: Moonlight
    new DataView(out.buffer).setBigUint64(1, payloadLen, true);
    out.set(sig, 1 + 8 + Number(payloadLen));
    return out;
  }

  class TxBuilder {
    profile;
    amount;
    ownerProfile = null;
    ownerProfilesValue = [];
    paymentValue = "account";
    toValue = "";
    memoValue = "";
    gasValue = null;
    chainValue = null;
    nonceValue = null;
    depositValue = 0n;
    payloadValue = null;
    obfuscatedValue = false;

    constructor(profile, amount, options = {}) {
      this.profile = profile;
      this.amount = amount;
      this.ownerProfile = options.ownerProfile ?? null;
      this.ownerProfilesValue = Array.isArray(options.ownerProfiles) ? options.ownerProfiles : [];
      this.paymentValue = options.payment ?? "account";
    }

    to(v) {
      this.toValue = String(v ?? "");
      return this;
    }

    memo(v) {
      this.memoValue = String(v ?? "");
      return this;
    }

    payload(v) {
      this.payloadValue = v;
      return this;
    }

    deposit(v) {
      this.depositValue = BigInt(v ?? 0);
      return this;
    }

    gas(v) {
      this.gasValue = v;
      return this;
    }

    chain(v) {
      this.chainValue = v;
      return this;
    }

    nonce(v) {
      this.nonceValue = v;
      return this;
    }

    obfuscated() {
      this.obfuscatedValue = true;
      return this;
    }

    owner(profile) {
      this.ownerProfile = profile;
      return this;
    }

    ownerProfiles(profiles) {
      this.ownerProfilesValue = Array.from(profiles ?? []);
      return this;
    }

    shielded() {
      this.paymentValue = "address";
      return this;
    }

    public() {
      this.paymentValue = "account";
      return this;
    }

    async build() {
      return { buffer: buildSignedMoonlightBuffer() };
    }
  }

  class Bookkeeper {
    constructor(treasury) {
      this.treasury = treasury;
    }
    get minimumStake() {
      return Promise.resolve(1n);
    }
    balance(identifier) {
      if (typeof globalThis.__W3SPER_BALANCE__ === "function") {
        return globalThis.__W3SPER_BALANCE__(identifier, this.treasury);
      }
      return Promise.resolve({ nonce: 0n, value: 0n });
    }
    stakeInfo(identifier) {
      if (typeof globalThis.__W3SPER_STAKE_INFO__ === "function") {
        return globalThis.__W3SPER_STAKE_INFO__(identifier);
      }
      return Promise.resolve({ amount: null, reward: 0n, faults: 0, hardFaults: 0 });
    }
    stakeKeys(identifier) {
      if (typeof globalThis.__W3SPER_STAKE_KEYS__ === "function") {
        return globalThis.__W3SPER_STAKE_KEYS__(identifier);
      }
      return Promise.resolve(null);
    }
    async pick() {
      return new Map([[new Uint8Array([0xee]), new Uint8Array([0x01])]]);
    }
    as(profile) {
      return {
        transfer: (amount) => new TxBuilder(profile, amount),
        unshield: (amount) => new TxBuilder(profile, amount, { payment: "address" }),
        stake: (amount, options) => new TxBuilder(profile, amount, options),
        topup: (amount, options) => new TxBuilder(profile, amount, { ...options, topup: true }),
        unstake: (amount, options) => new TxBuilder(profile, amount, options),
        withdraw: (amount, options) => new TxBuilder(profile, amount, options),
      };
    }
  }

  class Network {
    connected = false;
    __duskPatchedEndpoints = false;
    __duskProveKey = "";

    constructor(url) {
      this.url = url;
      this.blockHeight = 100n;
      this.contracts = { transferContract: { call: { num_notes: async () => 0n } } };
      this.query = async (query) => ({ block: { header: { hash: `block-${query.match(/height: (\d+)/)[1]}` } } });

      // Wallet code expects a tx watcher surface for waitTxExecuted.
      this.transactions = {
        withId: (hash) => ({
          once: { executed: async () => ({ hash, success: true }) },
        }),
      };
      this.dataDrivers = {
        register: vi.fn(),
      };
    }

    connect() {
      this.connected = true;
      return Promise.resolve(true);
    }

    disconnect() {
      this.connected = false;
    }

    close() {
      this.connected = false;
    }

    prove() {
      throw new Error("prove() not implemented in mock");
    }

    async execute(tx) {
      globalThis.__W3SPER_LAST_EXEC_TX__ = tx;
      if (typeof globalThis.__W3SPER_EXECUTE_IMPL__ === "function") {
        return await globalThis.__W3SPER_EXECUTE_IMPL__(tx);
      }
      return { hash: "0xmockhash", nonce: 42 };
    }
  }

  class Bookmark {
    static from(n) { return new Bookmark(n); }
    constructor(n) {
      this._n = BigInt(n ?? 0);
    }
    asUint() {
      return this._n;
    }
  }

  class AddressSyncer extends EventTarget {
    constructor(network) { super(); this.network = network; }
    async spent() { return []; }
    async notes() { return new ReadableStream({ start(controller) { controller.close(); } }); }
    get root() {
      return Promise.resolve(new Uint8Array([0]));
    }
    async openings(picked) {
      return Array.from(picked ?? [], () => new Uint8Array([0]));
    }
  }

  class AccountSyncer {
    constructor(_network) {}
    async balances(profiles) {
      return (profiles ?? []).map(() => ({ nonce: 0n, value: 0n }));
    }
    async stakes() {
      return [{ amount: null, reward: 0n, faults: 0, hardFaults: 0 }];
    }
    async stakeKeys() {
      return [null];
    }
  }

  function useAsProtocolDriver(_bytes) {
    // no-op
  }

  // A data-driver contract as w3sper's: an argument encoded and an answer
  // decoded by its driver (here as JSON), a call sent as RUES sends it.
  class Contract {
    #id;
    #driver;
    #network;

    constructor({ contractId, driver, network }) {
      this.#id = Array.from(contractId, (b) => b.toString(16).padStart(2, "0")).join("");
      this.#driver = driver;
      this.#network = network;
    }

    get id() {
      return this.#id;
    }

    async encode(_fnName, args) {
      return new TextEncoder().encode(JSON.stringify(args ?? null));
    }

    get call() {
      return new Proxy(
        {},
        {
          get: (_t, fnName) => async (args) => {
            const res = await fetch(new URL(`/on/contracts:${this.#id}/${String(fnName)}`, this.#network.url), {
              method: "POST",
              body: await this.encode(fnName, args),
            });
            return this.#driver.decodeOutputFn(String(fnName), new Uint8Array(await res.arrayBuffer()));
          },
        }
      );
    }
  }

  const dataDrivers = {
    DataDriverRegistry: class {
      register() {}
      async get(key) {
        // A driver that takes this long (ms) to load, as a cold one does.
        const ms = globalThis.__W3SPER_DRIVER_DELAYS__?.[key];
        if (ms) await new Promise((resolve) => setTimeout(resolve, ms));
        return { decodeOutputFn: (_fnName, bytes) => JSON.parse(new TextDecoder().decode(bytes)) };
      }
    },
  };

  return {
    Bookkeeper,
    Bookmark,
    Contract,
    Network,
    ProfileGenerator,
    AddressSyncer,
    AccountSyncer,
    STAKE: "stake",
    dataDrivers,
    useAsProtocolDriver,
  };
});

// The calls of a Multicall for Dusk `aggregate` envelope (rkyv 0.7): contract,
// function and argument of each.
function envelopeCalls(body) {
  const b = new Uint8Array(body);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const root = b.length - 8;
  const array = root + v.getInt32(root, true);
  const text = new TextDecoder();
  const calls = [];
  for (let i = 0; i < v.getUint32(root + 4, true); i++) {
    const slot = array + i * 56;
    const last = b[slot + 39];
    const at = slot + 32 + v.getInt32(slot + 36, true);
    const name = (last & 0x80) === 0 ? b.subarray(slot + 32, slot + 32 + last) : b.subarray(at, at + v.getUint32(slot + 32, true));
    const args = slot + 40 + v.getInt32(slot + 40, true);
    calls.push({
      contract: Array.from(b.subarray(slot, slot + 32), (x) => x.toString(16).padStart(2, "0")).join(""),
      fnName: text.decode(name),
      args: text.decode(b.subarray(args, args + v.getUint32(slot + 44, true))),
    });
  }
  return calls;
}

// An `aggregate` reply as the contract writes it (rkyv 0.7): each result's
// bytes, then one 16-byte slot per result, then the root.
function aggregateReply(results) {
  const align = (n, to) => Math.ceil(n / to) * to;
  const slots = align(results.reduce((n, r) => n + r.length, 0), 4);
  const root = align(slots + 16 * results.length, 8);
  const out = new Uint8Array(root + 16);
  const view = new DataView(out.buffer);
  let at = 0;
  results.forEach((r, i) => {
    const slot = slots + 16 * i;
    out.set(r, at);
    view.setInt32(slot + 4, at - (slot + 4), true);
    view.setUint32(slot + 8, r.length, true);
    at += r.length;
  });
  view.setBigUint64(root, 7n, true);
  view.setInt32(root + 8, slots - (root + 8), true);
  view.setUint32(root + 12, results.length, true);
  return out;
}

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const NETWORK_KEY = "https://nodes.dusk.network";
const WALLET_ID = "acct0";

describe("walletEngine", () => {
  /** @type {typeof import('./walletEngine.js')} */
  let engine;

  beforeEach(async () => {
    vi.resetModules();
    globalThis.__W3SPER_LAST_EXEC_TX__ = null;
    globalThis.__W3SPER_EXECUTE_IMPL__ = null;
    globalThis.__W3SPER_BALANCE__ = null;
    globalThis.__W3SPER_STAKE_INFO__ = null;
    globalThis.__W3SPER_STAKE_KEYS__ = null;
    globalThis.__W3SPER_FAIL_PROFILE_INDEX__ = null;
    globalThis.__W3SPER_FAIL_WALLET_ID__ = false;
    globalThis.__W3SPER_LAST_SEEDER__ = null;
    globalThis.__W3SPER_PROFILE_GATE__ = null;
    globalThis.__W3SPER_DRIVER_DELAYS__ = null;

    // walletEngine loads a WASM protocol driver via fetch() on first use.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(8),
        text: async () => "",
      }))
    );

    engine = await import("./walletEngine.js");
  });

  afterEach(async () => {
    try {
      engine?.lock?.();
    } catch {
      // ignore
    }
    const store = await import("./shieldedStore.js");
    for (const index of [0, 1]) await store.clearNotes(NETWORK_KEY, WALLET_ID, index, { resetMeta: true });
    vi.unstubAllGlobals();
    delete globalThis.__W3SPER_EXECUTE_IMPL__;
    delete globalThis.__W3SPER_STAKE_INFO__;
    delete globalThis.__W3SPER_STAKE_KEYS__;
    delete globalThis.__W3SPER_FAIL_PROFILE_INDEX__;
    delete globalThis.__W3SPER_FAIL_WALLET_ID__;
    delete globalThis.__W3SPER_LAST_SEEDER__;
    delete globalThis.__W3SPER_PROFILE_GATE__;
    delete globalThis.__W3SPER_DRIVER_DELAYS__;
  });

  async function prepareReviewCache(tip = 10n) {
    await engine.unlockWithMnemonic(MNEMONIC);
    const store = await import("./shieldedStore.js");
    await store.clearNotes(NETWORK_KEY, WALLET_ID, 0);
    await store.putShieldedMeta(NETWORK_KEY, WALLET_ID, 0, {
      checkpointBookmark: "0", checkpointBlock: "0", cursorBookmark: "10", cursorBlock: "100",
      anchorBlock: "100", anchorHash: "block-100",
    });
    const network = await engine.ensureNetwork();
    network.contracts = { transferContract: { call: { num_notes: async () => tip } } };
    return store;
  }

  it("review: reconciles distinct spent and unspent sets correctly", async () => {
    const store = await prepareReviewCache();
    const a = new Uint8Array([0xaa]), b = new Uint8Array([0xbb]), c = new Uint8Array([0xcc]);
    await store.putNotesMap(NETWORK_KEY, WALLET_ID, 0, new Map([[a, a], [b, b], [c, c]]));
    await store.markNullifiersSpent(NETWORK_KEY, WALLET_ID, 0, [a, b]);
    const { AddressSyncer } = await import("@dusk/w3sper");
    const spent = vi.spyOn(AddressSyncer.prototype, "spent").mockImplementation(async (nullifiers) =>
      nullifiers.filter(n => bytesToHex(n) === "bb").map(n => n.buffer)
    );
    try {
      await engine.startShieldedSync();
      expect((await store.getUnspentNullifiers(NETWORK_KEY, WALLET_ID, 0)).map(bytesToHex).sort()).toEqual(["aa", "cc"]);
      expect((await store.getSpentNullifiers(NETWORK_KEY, WALLET_ID, 0)).map(bytesToHex)).toEqual(["bb"]);
    } finally { spent.mockRestore(); }
  });

  it("review: does not report up-to-date when spent reconciliation fails", async () => {
    const store = await prepareReviewCache();
    const a = new Uint8Array([0xaa]);
    await store.putNotesMap(NETWORK_KEY, WALLET_ID, 0, new Map([[a, a]]));
    const { AddressSyncer } = await import("@dusk/w3sper");
    const spent = vi.spyOn(AddressSyncer.prototype, "spent").mockRejectedValue(new Error("Offline during nullifier check"));
    try {
      await engine.startShieldedSync();
      expect(spent).toHaveBeenCalled();
      expect(engine.getShieldedStatus().state).toBe("error");
      spent.mockResolvedValue([]);
      await engine.startShieldedSync();
      expect(engine.getShieldedStatus()).toMatchObject({ state: "done", lastError: "" });
    } finally { spent.mockRestore(); }
  });

  it.each(["lock", "profile", "network"])("caught-up reconciliation cannot write after %s changes", async (change) => {
    const store = await prepareReviewCache();
    const a = new Uint8Array([0xaa]);
    await store.putNotesMap(NETWORK_KEY, WALLET_ID, 0, new Map([[a, a]]));
    const { AddressSyncer } = await import("@dusk/w3sper");
    const gate = Promise.withResolvers();
    const entered = Promise.withResolvers();
    const spent = vi.spyOn(AddressSyncer.prototype, "spent").mockImplementation(async () => {
      entered.resolve();
      return await gate.promise;
    });
    const pending = engine.startShieldedSync();
    try {
      await entered.promise;
      if (change === "lock") engine.lock();
      else if (change === "profile") await engine.selectAccountIndex({ index: 1 });
      else engine.configure({ nodeUrl: "https://testnet.nodes.dusk.network" });
      expect(engine.getShieldedStatus().state).toBe("idle");
      gate.resolve([a.buffer]);
      await pending;
      expect(engine.isUnlocked()).toBe(change !== "lock");
      expect(engine.getShieldedStatus().state).toBe("idle");
      expect((await store.getUnspentNullifiers(NETWORK_KEY, WALLET_ID, 0)).map(bytesToHex)).toEqual(["aa"]);
    } finally { gate.resolve([]); await pending; spent.mockRestore(); }
  });

  it.each([false, true])("review: a cursor beyond the chain tip is not considered caught up (force=%s)", async (force) => {
    const store = await prepareReviewCache(9n);
    const orphan = new Uint8Array([0xaa]);
    await store.putNotesMap(NETWORK_KEY, WALLET_ID, 0, new Map([[orphan, orphan]]));
    const { AddressSyncer } = await import("@dusk/w3sper");
    const notes = vi.spyOn(AddressSyncer.prototype, "notes");
    try {
      await engine.startShieldedSync({ force });
      await vi.waitFor(() => expect(engine.getShieldedStatus().state).not.toBe("syncing"));
      expect(engine.getShieldedStatus().state).toBe("error");
      expect(engine.getShieldedStatus().lastError).toContain("behind");
      expect(store.metaCursor(await store.getShieldedMeta(NETWORK_KEY, WALLET_ID, 0)).bookmark).toBe(10n);
      expect(notes).not.toHaveBeenCalled();
      expect((await store.getNotesMap(NETWORK_KEY, WALLET_ID, 0)).size).toBe(1);
    } finally { notes.mockRestore(); }
  });

  it.each([[false, 1n], [false, 9n], [true, 9n], [false, 10n], [true, 10n]])(
    "rebuilds a replaced branch, preserving reservations and other profiles (force=%s, tip=%s)",
    async (force, tip) => {
      const store = await prepareReviewCache(tip);
      await store.putShieldedMeta(NETWORK_KEY, WALLET_ID, 0, { anchorHash: "old-branch" });
      const orphan = new Uint8Array([0xaa]), replacement = new Uint8Array([0xbb]);
      await store.putNotesMap(NETWORK_KEY, WALLET_ID, 0, new Map([[orphan, orphan]]));
      await store.putNotesMap(NETWORK_KEY, WALLET_ID, 1, new Map([[orphan, orphan]]));
      await store.putPendingNullifiers(NETWORK_KEY, WALLET_ID, 0, [orphan], "pending-tx");
      const { AddressSyncer } = await import("@dusk/w3sper");
      const notes = vi.spyOn(AddressSyncer.prototype, "notes").mockResolvedValueOnce(new ReadableStream({
        start(controller) {
          controller.enqueue([[new Map([[replacement, replacement]])], { bookmark: tip - 1n, blockHeight: 100n }]);
          controller.close();
        },
      }));
      try {
        expect((await engine.startShieldedSync({ force })).started).toBe(true);
        await vi.waitFor(() => expect(engine.getShieldedStatus().state).toBe("done"));
        expect(notes.mock.calls[0][1].from.asUint()).toBe(0n);
        expect(notes.mock.calls[0][0].map(profile => +profile)).toEqual([0]);
        expect((await store.getUnspentNullifiers(NETWORK_KEY, WALLET_ID, 0)).map(bytesToHex)).toEqual(["bb"]);
        expect((await store.getUnspentNullifiers(NETWORK_KEY, WALLET_ID, 1)).map(bytesToHex)).toEqual(["aa"]);
        expect(await store.getPendingNullifiersForTx(NETWORK_KEY, WALLET_ID, 0, "pending-tx")).toEqual(["aa"]);
        expect(await store.getShieldedMeta(NETWORK_KEY, WALLET_ID, 0)).toMatchObject({ cursorBookmark: tip.toString(), anchorBlock: "100", anchorHash: "block-100" });
      } finally { notes.mockRestore(); }
    }
  );

  it.each([
    [false, "missing", 1n], [true, "missing", 1n],
    [false, "zero cursor", 1n], [true, "zero cursor", 1n],
    [false, "missing", 0n], [true, "missing", 0n],
    [false, "zero cursor", 0n], [true, "zero cursor", 0n],
  ])("clears spent-only legacy caches (force=%s, metadata=%s, tip=%s)", async (force, metadata, tip) => {
    const store = await prepareReviewCache(tip);
    await store.clearNotes(NETWORK_KEY, WALLET_ID, 0, { resetMeta: true });
    if (metadata === "zero cursor") {
      await store.putShieldedMeta(NETWORK_KEY, WALLET_ID, 0, { cursorBookmark: "0", cursorBlock: "0" });
    }
    const orphan = new Uint8Array([0xaa]), replacement = new Uint8Array([0xbb]);
    await store.putNotesMap(NETWORK_KEY, WALLET_ID, 0, new Map([[orphan, orphan]]));
    await store.markNullifiersSpent(NETWORK_KEY, WALLET_ID, 0, [orphan]);
    await store.putPendingNullifiers(NETWORK_KEY, WALLET_ID, 0, [new Uint8Array([0xcc])], "pending-tx");

    const meta = await store.getShieldedMeta(NETWORK_KEY, WALLET_ID, 0);
    if (metadata === "missing") expect(meta).toBeNull();
    else expect(meta).toMatchObject({ cursorBookmark: "0", cursorBlock: "0" });
    expect(meta?.anchorHash).toBeUndefined();
    expect(await store.countNotes(NETWORK_KEY, WALLET_ID, 0)).toBe(0);
    expect((await store.getSpentNullifiers(NETWORK_KEY, WALLET_ID, 0)).map(bytesToHex)).toEqual(["aa"]);

    const { AddressSyncer } = await import("@dusk/w3sper");
    const notes = vi.spyOn(AddressSyncer.prototype, "notes").mockResolvedValueOnce(new ReadableStream({
      start(controller) {
        if (tip > 0n) controller.enqueue([[new Map([[replacement, replacement]])], { bookmark: 0n, blockHeight: 100n }]);
        controller.close();
      },
    }));
    try {
      const scans = force || tip > 0n;
      expect((await engine.startShieldedSync({ force })).started).toBe(scans);
      await vi.waitFor(() => expect(engine.getShieldedStatus().state).toBe("done"));
      const expected = tip > 0n ? ["bb"] : [];
      expect((await store.getUnspentNullifiers(NETWORK_KEY, WALLET_ID, 0)).map(bytesToHex)).toEqual(expected);
      expect(Array.from((await store.getSpendableNotesMap(NETWORK_KEY, WALLET_ID, 0)).keys()).map(bytesToHex)).toEqual(expected);
      expect(await store.getSpentNullifiers(NETWORK_KEY, WALLET_ID, 0)).toEqual([]);
      expect(await store.getPendingNullifiersForTx(NETWORK_KEY, WALLET_ID, 0, "pending-tx")).toEqual(["cc"]);
      const checkpoint = { cursorBookmark: tip.toString(), anchorBlock: "100", anchorHash: "block-100" };
      // A forced empty scan has no chunk to commit; the caught-up path anchors it below.
      expect(await store.getShieldedMeta(NETWORK_KEY, WALLET_ID, 0)).toEqual(
        force && tip === 0n ? null : expect.objectContaining(checkpoint)
      );
      if (scans) expect(notes.mock.calls[0][1].from.asUint()).toBe(0n);

      // A subsequent reconciliation must not resurrect the discarded note.
      expect((await engine.startShieldedSync()).started).toBe(false);
      expect(engine.getShieldedStatus()).toMatchObject({ state: "done", notes: expected.length, lastError: "" });
      expect((await store.getUnspentNullifiers(NETWORK_KEY, WALLET_ID, 0)).map(bytesToHex)).toEqual(expected);
      expect(await store.getShieldedMeta(NETWORK_KEY, WALLET_ID, 0)).toMatchObject(checkpoint);
      expect(notes).toHaveBeenCalledTimes(scans ? 1 : 0);
    } finally { notes.mockRestore(); }
  });

  it("does not publish caught-up status after cancellation during preflight", async () => {
    const store = await prepareReviewCache();
    const network = await engine.ensureNetwork();
    const gate = Promise.withResolvers(), entered = Promise.withResolvers();
    const query = vi.spyOn(network, "query").mockImplementation(async () => {
      entered.resolve();
      return await gate.promise;
    });
    const pending = engine.startShieldedSync();
    try {
      await entered.promise;
      engine.lock();
      gate.resolve({ block: { header: { hash: "block-100" } } });
      await pending;
      expect(engine.getShieldedStatus().state).toBe("idle");
      expect(await store.getShieldedMeta(NETWORK_KEY, WALLET_ID, 0)).toMatchObject({ cursorBookmark: "10" });
    } finally { gate.resolve({ block: { header: { hash: "block-100" } } }); await pending; query.mockRestore(); }
  });

  it("cancels a blocked note reader on lock without waiting for another chunk", async () => {
    await prepareReviewCache(11n);
    const { AddressSyncer } = await import("@dusk/w3sper");
    const cancel = vi.fn();
    let controller;
    const notes = vi.spyOn(AddressSyncer.prototype, "notes").mockResolvedValue(new ReadableStream({
      start(c) { controller = c; }, cancel,
    }));
    try {
      await engine.startShieldedSync();
      await vi.waitFor(() => expect(notes).toHaveBeenCalled());
      engine.lock();
      await vi.waitFor(() => expect(cancel).toHaveBeenCalled());
      expect(engine.getShieldedStatus().state).toBe("idle");
    } finally { if (!cancel.mock.calls.length) controller.close(); notes.mockRestore(); }
  });

  it("commits the prefetched final chunk before stopping at the scan target", async () => {
    const store = await prepareReviewCache(12n);
    const network = await engine.ensureNetwork();
    const { AddressSyncer } = await import("@dusk/w3sper");
    const ahead = Promise.withResolvers();
    let scanning = false;
    const query = vi.spyOn(network, "query").mockImplementation(async () => {
      if (scanning) await ahead.promise;
      return { block: { header: { hash: "block-100" } } };
    });
    const notes = vi.spyOn(AddressSyncer.prototype, "notes").mockImplementation(async function () {
      scanning = true;
      const syncer = this;
      let position = 10n;
      return new ReadableStream({ pull(controller) {
        const event = new Event("synciteration");
        Object.defineProperty(event, "detail", { value: {
          bookmarks: { current: position }, blocks: { current: 100n }, progress: Number(position) / 12,
        } });
        syncer.dispatchEvent(event);
        const note = new Uint8Array([Number(position)]);
        controller.enqueue([[new Map([[note, note]])], { bookmark: position, blockHeight: 100n }]);
        if (position++ === 11n) { ahead.resolve(); controller.close(); }
      } });
    });
    try {
      await engine.startShieldedSync();
      await vi.waitFor(() => expect(engine.getShieldedStatus().state).toBe("done"));
      expect(await store.getShieldedMeta(NETWORK_KEY, WALLET_ID, 0)).toMatchObject({ cursorBookmark: "12" });
      expect((await store.getNotesMap(NETWORK_KEY, WALLET_ID, 0)).size).toBe(2);
    } finally { ahead.resolve(); notes.mockRestore(); query.mockRestore(); }
  });

  it("rejects scan data when the captured chain anchor changes mid-scan", async () => {
    const store = await prepareReviewCache(11n);
    const network = await engine.ensureNetwork();
    const { AddressSyncer } = await import("@dusk/w3sper");
    const query = vi.spyOn(network, "query");
    const notes = vi.spyOn(AddressSyncer.prototype, "notes").mockImplementationOnce(async () => {
      query.mockResolvedValue({ block: { header: { hash: "replacement-branch" } } });
      return new ReadableStream({ start(controller) {
        controller.enqueue([[new Map()], { bookmark: 10n, blockHeight: 100n }]);
        controller.close();
      } });
    });
    try {
      await engine.startShieldedSync();
      await vi.waitFor(() => expect(engine.getShieldedStatus().state).toBe("error"));
      expect(engine.getShieldedStatus().lastError).toContain("Chain changed");
      expect(await store.getShieldedMeta(NETWORK_KEY, WALLET_ID, 0)).toBeNull();
    } finally { notes.mockRestore(); query.mockRestore(); }
  });

  it.each(["lock", "profile", "network", "sync"])("does not publish abandoned unlock metadata errors after %s changes", async (change) => {
    const store = await import("./shieldedStore.js");
    const gate = Promise.withResolvers(), entered = Promise.withResolvers();
    const init = vi.spyOn(store, "ensureShieldedMeta").mockImplementationOnce(async () => {
      entered.resolve(); return await gate.promise;
    });
    try {
      await engine.unlockWithMnemonic(MNEMONIC);
      await entered.promise;
      if (change === "lock") engine.lock();
      else if (change === "profile") await engine.selectAccountIndex({ index: 1 });
      else if (change === "network") engine.configure({ nodeUrl: "https://testnet.nodes.dusk.network" });
      else {
        const network = await engine.ensureNetwork();
        network.contracts = { transferContract: { call: { num_notes: async () => 0n } } };
        await engine.startShieldedSync();
      }
      const status = engine.getShieldedStatus();
      gate.reject(new Error("Late metadata failure"));
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(engine.getShieldedStatus()).toEqual(status);
    } finally { gate.resolve(null); init.mockRestore(); }
  });

  it("still surfaces a current unlock metadata failure", async () => {
    const store = await import("./shieldedStore.js");
    const init = vi.spyOn(store, "ensureShieldedMeta").mockRejectedValueOnce(new Error("Metadata unavailable"));
    try {
      await engine.unlockWithMnemonic(MNEMONIC);
      await vi.waitFor(() => expect(engine.getShieldedStatus()).toMatchObject({ state: "error", lastError: "Metadata unavailable" }));
    } finally { init.mockRestore(); }
  });

  it("allows a balance read to finish when only a newer sync supersedes its metadata read", async () => {
    const store = await prepareReviewCache();
    const gate = Promise.withResolvers(), entered = Promise.withResolvers();
    const count = vi.spyOn(store, "countNotes").mockImplementationOnce(async () => {
      entered.resolve(); return await gate.promise;
    });
    const balance = engine.getShieldedBalance();
    try {
      await entered.promise;
      await engine.startShieldedSync();
      gate.resolve(0);
      await expect(balance).resolves.toMatchObject({ value: 0n });
      expect(engine.getShieldedStatus().state).toBe("done");
    } finally { gate.resolve(0); await balance.catch(() => {}); count.mockRestore(); }
  });

  it("derives the CLI-aligned two default profiles on unlock", async () => {
    await engine.unlockWithMnemonic(MNEMONIC);

    expect(engine.getAccounts()).toEqual(["acct0", "acct1"]);
    expect(engine.getAddresses()).toEqual(["addr0", "addr1"]);
    expect(engine.getSelectedAccountIndex()).toBe(0);
  });

  it.each([0, 1])("keeps the current wallet when replacement profile %i fails", async (index) => {
    engine.configure({ accountCount: 1 });
    await engine.unlockWithMnemonic(MNEMONIC);
    globalThis.__W3SPER_FAIL_PROFILE_INDEX__ = index;
    engine.configure({ accountCount: 2 });

    await expect(engine.unlockWithMnemonic("different mnemonic")).rejects.toThrow(
      "profile derivation failed"
    );
    expect(engine.isUnlocked()).toBe(true);
    expect(engine.getAccounts()).toEqual(["acct0"]);
  });

  it("keeps the current wallet and clears the candidate seed when wallet ID derivation fails", async () => {
    engine.configure({ accountCount: 1 });
    await engine.unlockWithMnemonic(MNEMONIC);
    globalThis.__W3SPER_FAIL_WALLET_ID__ = true;

    await expect(engine.unlockWithMnemonic("different mnemonic")).rejects.toThrow("wallet ID failed");

    expect(engine.isUnlocked()).toBe(true);
    expect(engine.getAccounts()).toEqual(["acct0"]);
    expect((await globalThis.__W3SPER_LAST_SEEDER__()).every((byte) => byte === 0)).toBe(true);
  });

  it("does not let a superseded unlock commit after lock", async () => {
    let releaseProfile;
    let profileStarted;
    const started = new Promise((resolve) => { profileStarted = resolve; });
    globalThis.__W3SPER_PROFILE_GATE__ = async (index) => {
      if (index !== 0) return;
      profileStarted();
      await new Promise((resolve) => { releaseProfile = resolve; });
    };

    const unlock = engine.unlockWithMnemonic(MNEMONIC);
    await started;
    engine.lock();
    releaseProfile();

    await expect(unlock).rejects.toThrow("Unlock superseded");
    expect(engine.isUnlocked()).toBe(false);
    expect(engine.getAccounts()).toEqual([]);
    expect((await globalThis.__W3SPER_LAST_SEEDER__()).every((byte) => byte === 0)).toBe(true);
  });

  it("restores multiple derived accounts on unlock", async () => {
    engine.configure({ accountCount: 2, selectedAccountIndex: 1 });
    await engine.unlockWithMnemonic(MNEMONIC);

    expect(engine.isUnlocked()).toBe(true);
    expect(engine.getAccounts()).toEqual(["acct0", "acct1"]);
    expect(engine.getAddresses()).toEqual(["addr0", "addr1"]);
    expect(engine.getSelectedAccountIndex()).toBe(1);
  });

  it("selectAccountIndex derives missing profiles sequentially", async () => {
    engine.configure({ accountCount: 1, selectedAccountIndex: 0 });
    await engine.unlockWithMnemonic(MNEMONIC);

    expect(engine.getAccounts()).toEqual(["acct0"]);

    const res = await engine.selectAccountIndex({ index: 1 });
    expect(res.selectedAccountIndex).toBe(1);
    expect(res.accounts).toEqual(["acct0", "acct1"]);
    expect(engine.getSelectedAccountIndex()).toBe(1);
  });

  it("selectAccountIndex invalidates stale shielded sync status", async () => {
    engine.configure({ accountCount: 2, selectedAccountIndex: 0 });
    await engine.unlockWithMnemonic(MNEMONIC);

    const started = await engine.startShieldedSync({ force: true });
    expect(started.started).toBe(true);
    expect(engine.getShieldedStatus().state).toBe("syncing");

    await engine.selectAccountIndex({ index: 1 });
    expect(engine.getSelectedAccountIndex()).toBe(1);
    expect(engine.getShieldedStatus()).toMatchObject({
      state: "idle",
      progress: 0,
      notes: 0,
      cursorBookmark: "0",
      cursorBlock: "0",
      lastError: "",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(engine.getShieldedStatus().state).toBe("idle");
  });

  it("signMessage signs a domain-separated envelope (uses selected profileIndex)", async () => {
    engine.configure({ accountCount: 2, selectedAccountIndex: 0 });
    await engine.unlockWithMnemonic(MNEMONIC);

    const origin = "https://example.com";
    const chainId = "dusk:2";
    const message = "0x0102";

    const msgBytes = toBytes(message);
    const messageHash = await sha256Hex(msgBytes);
    const messageLen = msgBytes.length;

    const res = await engine.signMessage({
      origin,
      chainId,
      message,
      profileIndex: 1,
    });

    expect(res.account).toBe("acct1");
    expect(res.origin).toBe(origin);
    expect(res.chainId).toBe(chainId);
    expect(res.messageHash).toBe(`0x${messageHash}`);
    expect(res.messageLen).toBe(messageLen);
    expect(res.signature).toMatch(/^0x[0-9a-f]+$/i);
    expect(res.payload).toMatch(/^0x[0-9a-f]+$/i);

    const memo = [
      "Dusk Connect SignMessage v1",
      `Origin: ${origin}`,
      `Chain ID: ${chainId}`,
      "Account: acct1",
      `Message Hash: 0x${messageHash}`,
      `Message Len: ${messageLen}`,
    ].join("\n");

    const memoHex = bytesToHex(new TextEncoder().encode(memo));
    expect(res.payload.endsWith(memoHex)).toBe(true);
  });

  it("signMessage signs a Uint8Array that extension messaging turned into an object, as its bytes", async () => {
    engine.configure({ accountCount: 1, selectedAccountIndex: 0 });
    await engine.unlockWithMnemonic(MNEMONIC);

    const bytes = new TextEncoder().encode("I agree to the shop terms");
    const res = await engine.signMessage({
      origin: "https://example.com",
      chainId: "dusk:2",
      message: JSON.parse(JSON.stringify(bytes)),
      profileIndex: 0,
    });
    expect(res.messageHash).toBe(`0x${await sha256Hex(bytes)}`);
    expect(res.messageLen).toBe(bytes.length);
  });

  it("signMessage refuses plain text instead of signing bytes guessed from it", async () => {
    engine.configure({ accountCount: 1, selectedAccountIndex: 0 });
    await engine.unlockWithMnemonic(MNEMONIC);

    for (const message of ["I agree to the shop terms", "SGVsbG8sIER1c2sh"]) {
      await expect(
        engine.signMessage({ origin: "https://example.com", chainId: "dusk:2", message, profileIndex: 0 })
      ).rejects.toThrow("Unsupported message encoding");
    }
  });

  it("rejects a public balance read when the approved engine context changed", async () => {
    engine.configure({
      nodeUrl: NETWORK_KEY,
      accountCount: 1,
      selectedAccountIndex: 0,
    });
    await engine.unlockWithMnemonic(MNEMONIC);

    await expect(engine.getPublicBalance({
      profileIndex: 0,
      _approvalContext: {
        walletId: WALLET_ID,
        profileIndex: 0,
        account: "acct0",
        nodeUrl: "https://different.example",
      },
    })).rejects.toThrow("Wallet changed while awaiting approval");
  });

  it("rejects signing when the approved engine context changed", async () => {
    engine.configure({
      nodeUrl: NETWORK_KEY,
      accountCount: 1,
      selectedAccountIndex: 0,
    });
    await engine.unlockWithMnemonic(MNEMONIC);

    await expect(engine.signMessage({
      origin: "https://example.com",
      chainId: "dusk:2",
      message: "0x0102",
      profileIndex: 0,
      _approvalContext: {
        walletId: WALLET_ID,
        profileIndex: 0,
        account: "acct0",
        nodeUrl: "https://different.example",
      },
    })).rejects.toThrow("Wallet changed while awaiting approval");
  });

  it("rejects typed-data signing when the approved engine context changed", async () => {
    // The RPC layer checks its own snapshot, but engineCall is mocked in those
    // tests, so this is the only place the engine-side guard actually runs.
    // Without it a stale approval would still produce a signature.
    engine.configure({
      nodeUrl: NETWORK_KEY,
      accountCount: 1,
      selectedAccountIndex: 0,
    });
    await engine.unlockWithMnemonic(MNEMONIC);

    await expect(engine.signTypedData({
      digestHex: `0x${"11".repeat(32)}`,
      profileIndex: 0,
      _approvalContext: {
        walletId: WALLET_ID,
        profileIndex: 0,
        account: "acct0",
        nodeUrl: "https://different.example",
      },
    })).rejects.toThrow("Wallet changed while awaiting approval");
  });

  it("signs typed data when the approved engine context still matches", async () => {
    engine.configure({
      nodeUrl: NETWORK_KEY,
      accountCount: 1,
      selectedAccountIndex: 0,
    });
    await engine.unlockWithMnemonic(MNEMONIC);

    const accounts = engine.getAccounts();
    const res = await engine.signTypedData({
      digestHex: `0x${"11".repeat(32)}`,
      profileIndex: 0,
      _approvalContext: {
        walletId: WALLET_ID,
        profileIndex: 0,
        account: accounts[0],
        nodeUrl: NETWORK_KEY,
      },
    });

    expect(res.account).toBe(accounts[0]);
    expect(res.signature).toMatch(/^0x[0-9a-f]{96}$/);
    expect(res.publicKeyHex).toMatch(/^0x[0-9a-f]{192}$/);
  });

  it("signAuth returns the signed canonical login envelope", async () => {
    engine.configure({ accountCount: 1, selectedAccountIndex: 0 });
    await engine.unlockWithMnemonic(MNEMONIC);

    const origin = "https://example.com";
    const chainId = "dusk:2";

    const res = await engine.signAuth({
      origin,
      chainId,
      nonce: "nonce-123",
      statement: "hello",
      profileIndex: 0,
    });

    expect(res.account).toBe("acct0");
    expect(res.origin).toBe(origin);
    expect(res.chainId).toBe(chainId);
    expect(res.nonce).toBe("nonce-123");
    expect(res.message).toContain("Dusk Connect SignAuth v1");
    expect(res.message).toContain("Account: acct0");
    expect(res.message).toContain("Statement: hello");
    expect(res.message).toContain(`URI: ${origin}`);
    expect(res.message).toContain(`Chain ID: ${chainId}`);
    expect(res.message).toContain("Nonce: nonce-123");
    expect(res.message).toContain("Issued At:");
    expect(res.message).toContain("Expiration Time:");
    expect(res.issuedAt).toMatch(/Z$/);
    expect(res.expiresAt).toMatch(/Z$/);

    const msgHex = bytesToHex(new TextEncoder().encode(res.message));
    expect(res.payload.endsWith(msgHex)).toBe(true);
  });

  it("sendTransaction respects profileIndex (transfer)", async () => {
    engine.configure({ accountCount: 2, selectedAccountIndex: 0 });
    await engine.unlockWithMnemonic(MNEMONIC);

    const result = await engine.sendTransaction({
      kind: "transfer",
      privacy: "public",
      to: "acct0",
      amount: "1",
      memo: "hi",
      gas: { limit: "1", price: "1" },
      profileIndex: 1,
    });

    expect(result).toEqual({ hash: "0xmockhash", nonce: 42 });

    const tx = globalThis.__W3SPER_LAST_EXEC_TX__;
    expect(tx).toBeTruthy();
    expect(tx.profile?.account?.toString?.()).toBe("acct1");
    expect(tx.toValue).toBe("acct0");
    expect(tx.memoValue).toBe("hi");
  });

  it("sendTransaction requires transfer privacy and validates recipient rail", async () => {
    engine.configure({ accountCount: 2, selectedAccountIndex: 0 });
    await engine.unlockWithMnemonic(MNEMONIC);

    await expect(
      engine.sendTransaction({ kind: "transfer", to: "acct0", amount: "1" })
    ).rejects.toThrow(/privacy is required/i);
    await expect(
      engine.sendTransaction({ kind: "transfer", privacy: " ", to: "acct0", amount: "1" })
    ).rejects.toThrow(/privacy is required/i);
    await expect(
      engine.sendTransaction({ kind: "transfer", privacy: "private", to: "acct0", amount: "1" })
    ).rejects.toThrow(/Invalid privacy/);
    await expect(
      engine.sendTransaction({ kind: "transfer", privacy: "public", to: "addr0", amount: "1" })
    ).rejects.toThrow(/Public transfer requires/);
    await expect(
      engine.sendTransaction({ kind: "transfer", privacy: "shielded", to: "acct0", amount: "1" })
    ).rejects.toThrow(/Shielded transfer requires/);
  });

  it("serializes transactions against their initially selected profile", async () => {
    engine.configure({ accountCount: 2, selectedAccountIndex: 0 });
    await engine.unlockWithMnemonic(MNEMONIC);
    let releaseFirst;
    let markFirstStarted;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
    const profiles = [];
    const nonces = [];
    globalThis.__W3SPER_EXECUTE_IMPL__ = vi.fn(async (tx) => {
      profiles.push(Number(tx.profile));
      nonces.push(tx.nonceValue);
      if (profiles.length === 1) {
        markFirstStarted();
        await firstGate;
      }
      return { hash: `0xhash${profiles.length}`, nonce: tx.nonceValue + 1n };
    });

    const first = engine.sendTransaction({ kind: "transfer", privacy: "public", to: "acct0", amount: "1" });
    const second = engine.sendTransaction({ kind: "transfer", privacy: "public", to: "acct0", amount: "1" });
    await firstStarted;
    expect(profiles).toEqual([0]);
    await engine.selectAccountIndex({ index: 1 });
    releaseFirst();
    await Promise.all([first, second]);

    expect(profiles).toEqual([0, 0]);
    expect(nonces).toEqual([0n, 1n]);
  });

  it("rejects a queued transaction after the network changes", async () => {
    engine.configure({ accountCount: 1, nodeUrl: "https://node-a.example" });
    await engine.unlockWithMnemonic(MNEMONIC);
    let releaseFirst;
    let markFirstStarted;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
    globalThis.__W3SPER_EXECUTE_IMPL__ = vi.fn(async () => {
      markFirstStarted();
      await firstGate;
      return { hash: "0xhash", nonce: 1 };
    });
    const params = { kind: "transfer", privacy: "public", to: "acct0", amount: "1" };

    const first = engine.sendTransaction(params);
    const second = engine.sendTransaction(params);
    await firstStarted;
    engine.configure({ nodeUrl: "https://node-b.example" });
    releaseFirst();

    await expect(first).resolves.toMatchObject({ hash: "0xhash" });
    await expect(second).rejects.toThrow("Wallet or network changed");
    expect(globalThis.__W3SPER_EXECUTE_IMPL__).toHaveBeenCalledOnce();
  });

  it("serializes concurrent Phoenix transfers until pending nullifiers are written", async () => {
    engine.configure({ accountCount: 1, selectedAccountIndex: 0 });
    await engine.unlockWithMnemonic(MNEMONIC);

    const store = await import("./shieldedStore.js");
    await store.clearNotes(NETWORK_KEY, WALLET_ID, 0);
    const notes = new Map();
    notes.set(new Uint8Array([0xaa]), new Uint8Array([0x01]));
    await store.putNotesMap(NETWORK_KEY, WALLET_ID, 0, notes);

    let releaseFirst = () => {};
    const firstGate = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstStarted = () => {};
    const firstStarted = new Promise((resolve) => {
      markFirstStarted = resolve;
    });
    const executeStarts = [];
    let secondSpendableAtStart = null;

    globalThis.__W3SPER_EXECUTE_IMPL__ = vi.fn(async () => {
      executeStarts.push(Date.now());
      if (executeStarts.length === 1) {
        markFirstStarted();
        await firstGate;
        return { hash: "0xfirst", nullifiers: [new Uint8Array([0xaa])] };
      }

      const spendable = await store.getSpendableNotesMap(NETWORK_KEY, WALLET_ID, 0);
      secondSpendableAtStart = Array.from(spendable.keys()).map((key) => bytesToHex(key));
      return { hash: "0xsecond", nullifiers: [new Uint8Array([0xbb])] };
    });

    const first = engine.sendTransaction({
      kind: "transfer",
      privacy: "shielded",
      to: "addr0",
      amount: "1",
    });
    const second = engine.sendTransaction({
      kind: "transfer",
      privacy: "shielded",
      to: "addr0",
      amount: "1",
    });

    await firstStarted;
    expect(executeStarts).toHaveLength(1);

    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual(
      expect.arrayContaining([
        { hash: "0xfirst", nonce: undefined, nullifiers: [new Uint8Array([0xaa])] },
        { hash: "0xsecond", nonce: undefined, nullifiers: [new Uint8Array([0xbb])] },
      ])
    );

    expect(secondSpendableAtStart).toEqual([]);
    expect(await store.getPendingNullifiersForTx(NETWORK_KEY, WALLET_ID, 0, "0xfirst")).toEqual(["aa"]);
    expect(await store.getPendingNullifiersForTx(NETWORK_KEY, WALLET_ID, 0, "0xsecond")).toEqual(["bb"]);
  });

  it("keeps no reservation of a Phoenix send that a lock and a new unlock overtook", async () => {
    engine.configure({ accountCount: 1, selectedAccountIndex: 0 });
    await engine.unlockWithMnemonic(MNEMONIC);
    const store = await import("./shieldedStore.js");
    await store.clearNotes(NETWORK_KEY, WALLET_ID, 0);
    await store.putNotesMap(NETWORK_KEY, WALLET_ID, 0, new Map([[new Uint8Array([0xaa]), new Uint8Array([0x01])]]));

    const started = Promise.withResolvers();
    const executed = Promise.withResolvers();
    globalThis.__W3SPER_EXECUTE_IMPL__ = vi.fn(async () => {
      started.resolve();
      await executed.promise;
      return { hash: "0xlate", nullifiers: [new Uint8Array([0xaa])] };
    });
    const send = engine.sendTransaction({ kind: "transfer", privacy: "shielded", to: "addr0", amount: "1" });
    await started.promise;
    // Reset meanwhile: locked, then unlocked again (here with the same accounts).
    engine.lock();
    await engine.unlockWithMnemonic(MNEMONIC);
    executed.resolve();
    await send.catch(() => {});
    expect(await store.getPendingNullifiersForTx(NETWORK_KEY, WALLET_ID, 0, "0xlate")).toEqual([]);
  });

  it("persists returned nullifiers for shielded contract calls", async () => {
    engine.configure({ accountCount: 1, selectedAccountIndex: 0 });
    await engine.unlockWithMnemonic(MNEMONIC);

    const store = await import("./shieldedStore.js");
    await store.clearNotes(NETWORK_KEY, WALLET_ID, 0);
    const notes = new Map();
    notes.set(new Uint8Array([0xcc]), new Uint8Array([0x01]));
    await store.putNotesMap(NETWORK_KEY, WALLET_ID, 0, notes);

    globalThis.__W3SPER_EXECUTE_IMPL__ = vi.fn(async () => ({
      hash: "0xcontract",
      nullifiers: [new Uint8Array([0xcc])],
    }));

    const result = await engine.sendTransaction({
      kind: "contract_call",
      privacy: "shielded",
      to: "addr0",
      amount: "0",
      deposit: "0",
      contractId: "00".repeat(32),
      fnName: "transfer",
      fnArgs: "0x",
    });

    expect(result).toEqual({
      hash: "0xcontract",
      nonce: undefined,
      nullifiers: [new Uint8Array([0xcc])],
    });
    expect(await store.getPendingNullifiersForTx(NETWORK_KEY, WALLET_ID, 0, "0xcontract")).toEqual(["cc"]);
  });

  it("persists returned nullifiers for unshield transactions", async () => {
    engine.configure({ accountCount: 1, selectedAccountIndex: 0 });
    await engine.unlockWithMnemonic(MNEMONIC);

    const store = await import("./shieldedStore.js");
    await store.clearNotes(NETWORK_KEY, WALLET_ID, 0);
    const notes = new Map();
    notes.set(new Uint8Array([0xdd]), new Uint8Array([0x01]));
    await store.putNotesMap(NETWORK_KEY, WALLET_ID, 0, notes);

    globalThis.__W3SPER_EXECUTE_IMPL__ = vi.fn(async () => ({
      hash: "0xunshield",
      nullifiers: [new Uint8Array([0xdd])],
    }));

    const result = await engine.sendTransaction({
      kind: "unshield",
      amount: "1",
    });

    expect(result).toEqual({
      hash: "0xunshield",
      nullifiers: [new Uint8Array([0xdd])],
    });
    expect(await store.getPendingNullifiersForTx(NETWORK_KEY, WALLET_ID, 0, "0xunshield")).toEqual(["dd"]);
  });

  it.each([
    ["at hand", null],
    ["loading at different times", { sozu_pool: 5, sozu_staked_dusk: 20 }],
  ])("reads Sozu's hub names in one Multicall for Dusk query, then its pool and stDUSK in one, with drivers %s", async (_, delays) => {
    globalThis.__W3SPER_DRIVER_DELAYS__ = delays;
    await engine.unlockWithMnemonic(MNEMONIC);
    const MULTICALL = "93de287b7d349d678a0038fe7772e8960e1a84a1b5da2d0b1f62f532616ce1d4";
    const ids = {
      pool: "6fdfdc713a18fc6ca2ad20eb2b4a3305a935ef47d6a872d9a4df8bc9fd9d169e",
      relayer: "1cc415d05b1cfbf2583bf2e8a0e39b2c768d263ef92d6a21a4787f76c6afa924",
      substrate: "bc6f50f7404d098cdd1117b15dddab6f6f3dad01c5ce3c5ce9b68a8b60bc4c1d",
      "staked-dusk": "eb158fce".padEnd(64, "0"),
      vault: "ab".repeat(32),
    };
    const answer = (contract, fnName, args) => {
      if (fnName === "contract") return ids[args];
      if (fnName === "exchange_rate") return { numerator: "3", denominator: "1" };
      return contract === ids.pool ? "5" : "7";
    };
    const json = (value) => new TextEncoder().encode(JSON.stringify(value));
    const node = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith(`/on/contracts:${MULTICALL}/aggregate`)) {
        const calls = envelopeCalls(init.body);
        return new Response(aggregateReply(calls.map((c) => json(answer(c.contract, c.fnName, JSON.parse(c.args))))));
      }
      const read = url.match(/\/on\/contracts:([0-9a-f]{64})\/(\w+)$/);
      if (read) return new Response(json(answer(read[1], read[2], JSON.parse(new TextDecoder().decode(init.body)))));
      return new Response(new ArrayBuffer(8));
    });
    vi.stubGlobal("fetch", node);

    const status = await engine.getSozuStatus();

    expect(status.configured).toBe(true);
    expect(status.contracts.pool).toBe(ids.pool);
    expect(status.pool.exchangeRate).toBe(3);
    expect(status.position).toEqual({ poolBalanceLux: "5", stDuskBalanceLux: "7" });
    const contractReads = node.mock.calls.map(([input]) => String(input)).filter((url) => url.includes("/on/contracts:"));
    expect(contractReads).toEqual([
      `${NETWORK_KEY}/on/contracts:${MULTICALL}/aggregate`,
      `${NETWORK_KEY}/on/contracts:${MULTICALL}/aggregate`,
    ]);
    const [names, reads] = node.mock.calls.filter(([input]) => String(input).includes("/on/contracts:"));
    expect(envelopeCalls(names[1].body).map((c) => c.args)).toEqual(
      ["pool", "relayer", "substrate", "staked-dusk", "vault"].map((name) => JSON.stringify(name))
    );
    expect(envelopeCalls(reads[1].body).map((c) => `${c.contract.slice(0, 8)}.${c.fnName}`)).toEqual([
      "6fdfdc71.exchange_rate",
      "6fdfdc71.balance_of",
      "eb158fce.balance_of",
    ]);
  });

  it("returns owner-separated stake status for local owner profiles", async () => {
    engine.configure({ accountCount: 2, selectedAccountIndex: 0 });
    await engine.unlockWithMnemonic(MNEMONIC);

    globalThis.__W3SPER_STAKE_INFO__ = vi.fn(async () => ({
      amount: { value: 10n, locked: 0n, eligibility: 0n, total: 10n },
      reward: 0n,
      faults: 0,
      hardFaults: 0,
    }));
    globalThis.__W3SPER_STAKE_KEYS__ = vi.fn(async () => ({
      account: "acct0",
      owner: { Account: "acct1" },
    }));

    await engine.selectAccountIndex({ index: 1 });
    const status = await engine.getStakeOwnerStatus({ profileIndex: 0 });

    expect(status.ownerKind).toBe("local");
    expect(status.ownerProfileIndex).toBe(1);
    expect(status.manageable).toBe(true);
    expect(status.info.amount.value).toBe("10");
  });

  it("returns related stake positions owned by the selected profile", async () => {
    engine.configure({ accountCount: 3, selectedAccountIndex: 0 });
    await engine.unlockWithMnemonic(MNEMONIC);

    const stakeInfoByAccount = new Map([
      ["acct0", {
        amount: { value: 10n, locked: 1n, eligibility: 0n, total: 11n },
        reward: 2n,
        faults: 0,
        hardFaults: 0,
      }],
      ["acct1", {
        amount: { value: 100n, locked: 0n, eligibility: 4320n, total: 100n },
        reward: 3n,
        faults: 1,
        hardFaults: 0,
      }],
    ]);
    const stakeKeysByAccount = new Map([
      ["acct0", { account: "acct0", owner: { Account: "acct1" } }],
      ["acct1", { account: "acct1", owner: { Account: "acct0" } }],
    ]);
    const balanceByAccount = new Map([
      ["acct0", { nonce: 7n, value: 1_000n }],
      ["acct1", { nonce: 0n, value: 0n }],
    ]);

    globalThis.__W3SPER_STAKE_INFO__ = vi.fn(async (account) =>
      stakeInfoByAccount.get(String(account)) ?? {
        amount: null,
        reward: 0n,
        faults: 0,
        hardFaults: 0,
      }
    );
    globalThis.__W3SPER_STAKE_KEYS__ = vi.fn(async (account) =>
      stakeKeysByAccount.get(String(account)) ?? null
    );
    globalThis.__W3SPER_BALANCE__ = vi.fn(async (account) =>
      balanceByAccount.get(String(account)) ?? { nonce: 0n, value: 0n }
    );

    const status = await engine.getStakeOwnerStatus({ profileIndex: 0 });

    expect(status.relatedStakes).toHaveLength(2);
    expect(status.relatedStakes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          profileIndex: 0,
          ownerProfileIndex: 1,
          publicBalance: { nonce: "7", value: "1000" },
          info: expect.objectContaining({
            amount: expect.objectContaining({ value: "10", locked: "1", eligibility: "0" }),
            reward: "2",
          }),
        }),
        expect.objectContaining({
          profileIndex: 1,
          ownerProfileIndex: 0,
          publicBalance: { nonce: "0", value: "0" },
          info: expect.objectContaining({
            amount: expect.objectContaining({ value: "100", eligibility: "4320" }),
            reward: "3",
            faults: 1,
          }),
        }),
      ])
    );
  });

  it("marks missing and contract stake owners as not wallet-manageable", async () => {
    engine.configure({ accountCount: 1, selectedAccountIndex: 0 });
    await engine.unlockWithMnemonic(MNEMONIC);

    globalThis.__W3SPER_STAKE_INFO__ = vi.fn(async () => ({
      amount: { value: 10n, locked: 0n, eligibility: 0n, total: 10n },
      reward: 0n,
      faults: 0,
      hardFaults: 0,
    }));
    globalThis.__W3SPER_STAKE_KEYS__ = vi.fn(async () => ({
      account: "acct0",
      owner: { Account: "acct9" },
    }));

    await expect(engine.getStakeOwnerStatus({ profileIndex: 0 })).resolves.toMatchObject({
      ownerKind: "missing",
      manageable: false,
      ownerAccount: "acct9",
    });

    globalThis.__W3SPER_STAKE_KEYS__ = vi.fn(async () => ({
      account: "acct0",
      owner: { Contract: "00".repeat(32) },
    }));

    await expect(engine.getStakeOwnerStatus({ profileIndex: 0 })).resolves.toMatchObject({
      ownerKind: "contract",
      manageable: false,
    });
  });

  it("passes explicit and candidate owner profiles to owner-aware staking builders", async () => {
    engine.configure({ accountCount: 2, selectedAccountIndex: 0 });
    await engine.unlockWithMnemonic(MNEMONIC);

    globalThis.__W3SPER_STAKE_INFO__ = vi.fn(async () => ({
      amount: { value: 10n, locked: 0n, eligibility: 0n, total: 10n },
      reward: 0n,
      faults: 0,
      hardFaults: 0,
    }));

    const result = await engine.sendTransaction({
      kind: "stake",
      amount: "1",
      ownerProfileIndex: 1,
      gas: { limit: "1", price: "1" },
    });

    expect(result).toEqual({ hash: "0xmockhash", nonce: 42 });
    const tx = globalThis.__W3SPER_LAST_EXEC_TX__;
    expect(tx.profile?.account?.toString?.()).toBe("acct0");
    expect(tx.ownerProfile?.account?.toString?.()).toBe("acct1");
    expect(tx.ownerProfilesValue.map((p) => p.account.toString())).toEqual(["acct0", "acct1"]);
    expect(tx.paymentValue).toBe("account");
  });

  it("persists returned nullifiers for shielded staking when explicitly requested", async () => {
    engine.configure({ accountCount: 1, selectedAccountIndex: 0 });
    await engine.unlockWithMnemonic(MNEMONIC);

    const store = await import("./shieldedStore.js");
    await store.clearNotes(NETWORK_KEY, WALLET_ID, 0);
    const notes = new Map();
    notes.set(new Uint8Array([0xee]), new Uint8Array([0x01]));
    await store.putNotesMap(NETWORK_KEY, WALLET_ID, 0, notes);

    globalThis.__W3SPER_EXECUTE_IMPL__ = vi.fn(async () => ({
      hash: "0xstake",
      nullifiers: [new Uint8Array([0xee])],
    }));

    const result = await engine.sendTransaction({
      kind: "stake",
      payment: "address",
      amount: "1",
    });

    expect(result).toEqual({
      hash: "0xstake",
      nullifiers: [new Uint8Array([0xee])],
    });
    expect(globalThis.__W3SPER_LAST_EXEC_TX__.paymentValue).toBe("address");
    expect(await store.getPendingNullifiersForTx(NETWORK_KEY, WALLET_ID, 0, "0xstake")).toEqual(["ee"]);
  });

  describe("shielded history", () => {
    const bytes = (hex) => Uint8Array.from(hex.match(/../g), (b) => parseInt(b, 16));
    const leaves = (hex) => Array.from({ length: hex.length / 1472 }, (_, i) => bytes(hex.slice(i * 1472, (i + 1) * 1472)));
    const FIRST = leaves(phoenix.firstLeaves);
    const [, L493, L494, L495] = leaves(phoenix.leaves492);
    const event = phoenix.blocks.e3602438.json.find((e) => e.topic === "phoenix");
    const NULLIFIERS = [bytes(event.data.slice(0, 64)), bytes(event.data.slice(64, 128))];

    // A first scan of a 6-note tree (Testnet's first leaves), as w3sper's
    // syncer reads it: one stream of leaves from the first. `hold` is awaited
    // once the leaves are read.
    async function scanTree(hold) {
      await engine.unlockWithMnemonic(MNEMONIC);
      const network = await engine.ensureNetwork();
      network.blockHeight = 4_000_000n;
      const leavesFromPos = vi.fn(async () => new Response(Uint8Array.from(FIRST.flatMap((l) => [...l]))));
      network.contracts = { transferContract: { call: { num_notes: async () => 6n, leaves_from_pos: leavesFromPos } } };
      const { AddressSyncer } = await import("@dusk/w3sper");
      const notes = vi.spyOn(AddressSyncer.prototype, "notes").mockImplementation(async function () {
        const res = await this.network.contracts.transferContract.call.leaves_from_pos(new Uint8Array(8), {});
        await res.arrayBuffer();
        await hold?.();
        return new ReadableStream({
          start(controller) {
            controller.enqueue([[new Map()], { bookmark: 5n, blockHeight: 234369n }]);
            controller.close();
          },
        });
      });
      await engine.startShieldedSync();
      await vi.waitFor(() => expect(engine.getShieldedStatus().state).toBe("done"));
      notes.mockRestore();
      return { leavesFromPos };
    }

    it("keeps the note tree's heights from a scan that starts at the first note", async () => {
      const { leavesFromPos } = await scanTree();
      expect(leavesFromPos).toHaveBeenCalledTimes(1);
      const activity = await import("./activityStore.js");
      await vi.waitFor(async () => expect(await activity.getNoteHeightPool("mainnet")).toMatchObject({ heights: [184423, 226951, 234329, 234369], notes: 6 }));
    });

    // The tree since the scan, grown to Testnet's leaves 492 to 495 (the
    // unshield's outputs and the shield's note): leaves 6 to 491 made up, all
    // at one height between.
    const GROWN = 300_000;
    // `distinct`: each made-up leaf at a height of its own, for a pool of hundreds.
    async function growTree(leavesFromPos, { distinct = false } = {}) {
      const made = [];
      for (let pos = 6; pos < 492; pos++) {
        const leaf = FIRST[5].slice();
        const view = new DataView(leaf.buffer);
        view.setBigUint64(648, BigInt(pos), true);
        view.setBigUint64(728, BigInt(distinct ? GROWN + pos : GROWN), true);
        made.push(leaf);
      }
      const grown = [...made, ...leaves(phoenix.leaves492)];
      const network = await engine.ensureNetwork();
      network.contracts.transferContract.call.num_notes = async () => 496n;
      leavesFromPos.mockImplementation(async () => new Response(Uint8Array.from(grown.flatMap((l) => [...l]))));
    }
    const position = (bytes) => new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(0, true);

    // The first profile's notes as its sync keeps them: two the unshield
    // spent, its two outputs, and the shield's note, with the values its
    // keys give them, by position.
    async function profileNotes() {
      const store = await import("./shieldedStore.js");
      await store.putNotesMap(NETWORK_KEY, WALLET_ID, 0, new Map([
        [NULLIFIERS[0], FIRST[0]], [NULLIFIERS[1], FIRST[1]],
        [bytes("aa".repeat(32)), L493], [bytes("bb".repeat(32)), L494], [bytes("cc".repeat(32)), L495],
      ]));
      await store.markNullifiersSpent(NETWORK_KEY, WALLET_ID, 0, NULLIFIERS);
      const values = { 0: 10_000_000_000n, 1: 500_000_000n, 493: 1_000_000_000n, 494: 12_000_000n, 495: 2_000_000_000n };
      globalThis.__W3SPER_BALANCE__ = async (_address, treasury) => {
        const [[, leaf]] = [...(await treasury.address())];
        const pos = new DataView(leaf.buffer, leaf.byteOffset).getBigUint64(648, true);
        return { value: values[Number(pos)], spendable: 0n };
      };
    }

    // The archive, with the recorded blocks; `hold` is awaited before each answer.
    function archive(hold) {
      const queries = [];
      vi.stubGlobal("fetch", vi.fn(async (url, init) => {
        expect(String(url)).toBe("https://nodes.dusk.network/on/graphql/query");
        const query = String(init.body);
        queries.push(query);
        await hold?.();
        const data = {};
        for (const [, h] of query.matchAll(/b(\d+): block\(/g)) {
          data[`e${h}`] = phoenix.blocks[`e${h}`] ?? { json: [] };
          data[`b${h}`] = phoenix.blocks[`b${h}`] ?? { header: { timestamp: 1 }, transactions: [] };
        }
        return { ok: true, status: 200, text: async () => JSON.stringify(data) };
      }));
      return queries;
    }

    it("asks for the profile's notes' blocks among the tree's other heights, once, and nothing for a profile without notes", async () => {
      const { leavesFromPos } = await scanTree();
      await profileNotes();
      await growTree(leavesFromPos);
      const queries = archive();

      const first = await engine.getShieldedHistory();
      expect(first.profileIndex).toBe(0);
      expect(first.entries.map((e) => [e.blockHeight, e.kind, e.direction, e.amount, e.feePaid])).toEqual([
        [3861643, "shield", "in", "2000000000", undefined],
        [3602438, "unshield", "out", String(10_500_000_000n - 1_012_000_000n - 12_429_102n), "12429102"],
      ]);
      // The profile's heights went out among the tree's others, all in one request.
      expect(queries).toHaveLength(1);
      const asked = [...queries[0].matchAll(/b(\d+): block\(/g)].map(([, h]) => Number(h)).sort((a, b) => a - b);
      // Leaf 492 (3577762) and the made-up ones are among them: the tree as it grew.
      expect(asked).toEqual([184423, 226951, 234329, 234369, GROWN, 3577762, 3602438, 3861643]);
      // The scan's heights served, and only the leaves added since it were read.
      expect(leavesFromPos).toHaveBeenCalledTimes(2);
      expect(position(leavesFromPos.mock.calls[1][0])).toBe(6n);
      const activity = await import("./activityStore.js");
      expect(await activity.getNoteHeightPool("mainnet")).toMatchObject({ notes: 496 });

      // Kept: asking again asks the node nothing.
      await expect(engine.getShieldedHistory()).resolves.toEqual(first);
      expect(queries).toHaveLength(1);

      // A profile without shielded notes reads nothing: pending until its
      // own notes are synced, as there may be some.
      await engine.selectAccountIndex({ index: 1 });
      await expect(engine.getShieldedHistory()).resolves.toEqual({ profileIndex: 1, entries: [], pending: true });
      expect(queries).toHaveLength(1);
    });

    it.each(["lock", "profile", "network", "reset", "chain"])("keeps nothing of a build a %s change overtook", async (change) => {
      const activity = await import("./activityStore.js");
      // Nothing kept by an earlier test.
      await activity.clearActivityStore();
      const { leavesFromPos } = await scanTree();
      await profileNotes();
      await growTree(leavesFromPos);
      const asked = Promise.withResolvers();
      const held = Promise.withResolvers();
      archive(async () => {
        asked.resolve();
        await held.promise;
      });

      const build = engine.getShieldedHistory();
      build.catch(() => {});
      await asked.promise;
      let scan = null;
      if (change === "lock") engine.lock();
      else if (change === "profile") await engine.selectAccountIndex({ index: 1 });
      else if (change === "network") engine.configure({ nodeUrl: "https://testnet.nodes.dusk.network" });
      else if (change === "reset") await activity.clearActivityStore();
      else {
        // The sync finds the chain it anchored to replaced.
        const store = await import("./shieldedStore.js");
        await store.putShieldedMeta(NETWORK_KEY, WALLET_ID, 0, { anchorBlock: "100", anchorHash: "old-chain" });
        const { AddressSyncer } = await import("@dusk/w3sper");
        scan = vi.spyOn(AddressSyncer.prototype, "notes").mockImplementation(() => new Promise(() => {}));
        await engine.startShieldedSync({ force: true });
        await vi.waitFor(async () => expect(await activity.getNoteHeightPool("mainnet")).toBeNull());
      }
      held.resolve();

      await expect(build).rejects.toThrow();
      scan?.mockRestore();
      // Nothing it read is kept: at most the decoys it was to ask among, kept
      // before it asked, for next time.
      const record = await activity.getShieldedHistoryRecord(`mainnet::${WALLET_ID}::0`);
      expect(record?.entries ?? []).toEqual([]);
    });

    it("asks nothing for a note at a height the tree it read doesn't have", async () => {
      const activity = await import("./activityStore.js");
      await activity.clearActivityStore();
      // The scan's six leaves, and the tree said to have no more: the
      // unshield's and the shield's heights would be the only ones not
      // drawn from it.
      await scanTree();
      await profileNotes();
      const queries = archive();
      await expect(engine.getShieldedHistory()).resolves.toMatchObject({ profileIndex: 0, entries: [], pending: true });
      expect(queries).toHaveLength(0);
    });

    it.each(["a block request", "keeping the history"])("asks among the same decoys again after %s failed", async (failing) => {
      const activity = await import("./activityStore.js");
      await activity.clearActivityStore();
      const { leavesFromPos } = await scanTree();
      await profileNotes();
      // Hundreds of heights to draw decoys from: two draws all but never match.
      await growTree(leavesFromPos, { distinct: true });
      const heightsOf = (query) => [...query.matchAll(/b(\d+): block\(/g)].map(([, h]) => Number(h));
      let fail = failing === "a block request";
      const queries = archive(async () => {
        if (!fail) return;
        fail = false;
        throw new TypeError("fetch failed");
      });
      const keep = activity.putShieldedHistoryRecord;
      const put = vi.spyOn(activity, "putShieldedHistoryRecord");
      if (failing === "keeping the history") {
        // The decoys are kept; the history after the lookups isn't.
        put.mockImplementation(async (key, record, epoch) => {
          if (record.entries.length) throw new DOMException("The store is full", "QuotaExceededError");
          return keep(key, record, epoch);
        });
      }
      const first = await engine.getShieldedHistory().catch((error) => error);
      const askedFirst = new Set(queries.flatMap(heightsOf));
      expect(askedFirst.size).toBeGreaterThan(0);
      if (failing === "keeping the history") expect(first.entries.length).toBeGreaterThan(0);
      else expect(first).toBeInstanceOf(TypeError);
      put.mockRestore();

      queries.length = 0;
      await engine.getShieldedHistory();
      const askedAgain = new Set(queries.flatMap(heightsOf));
      // Everything asked the first time is asked again: the same decoys.
      expect([...askedFirst].filter((h) => !askedAgain.has(h))).toEqual([]);
    });

    it("asks for no block when it can't keep the decoys first", async () => {
      const activity = await import("./activityStore.js");
      await activity.clearActivityStore();
      const { leavesFromPos } = await scanTree();
      await profileNotes();
      await growTree(leavesFromPos, { distinct: true });
      const queries = archive();
      const put = vi.spyOn(activity, "putShieldedHistoryRecord").mockRejectedValue(new DOMException("The store is full", "QuotaExceededError"));
      try {
        await expect(engine.getShieldedHistory()).rejects.toThrow("The store is full");
        expect(queries).toHaveLength(0);
      } finally {
        put.mockRestore();
      }
    });

    it("asks nothing while the tree has no height but the profile's own", async () => {
      const activity = await import("./activityStore.js");
      await activity.clearActivityStore();
      await scanTree();
      // The profile owns every leaf of the six-note tree: no other height to hide among.
      const store = await import("./shieldedStore.js");
      await store.putNotesMap(NETWORK_KEY, WALLET_ID, 0, new Map(FIRST.map((leaf, i) => [bytes(String(i + 1).padStart(2, "0").repeat(32)), leaf])));
      globalThis.__W3SPER_BALANCE__ = async () => ({ value: 1n, spendable: 0n });
      const queries = archive();
      await expect(engine.getShieldedHistory()).resolves.toMatchObject({ profileIndex: 0, entries: [], pending: true });
      expect(queries).toHaveLength(0);
    });

    it("gives what it kept as pending while the notes still sync", async () => {
      const activity = await import("./activityStore.js");
      await activity.clearActivityStore();
      const { leavesFromPos } = await scanTree();
      await profileNotes();
      await growTree(leavesFromPos);
      archive();
      const first = await engine.getShieldedHistory();
      expect(first.pending).toBeUndefined();
      // Another scan begins: the notes kept may not be all of them.
      const { AddressSyncer } = await import("@dusk/w3sper");
      const notes = vi.spyOn(AddressSyncer.prototype, "notes").mockImplementation(() => new Promise(() => {}));
      try {
        const network = await engine.ensureNetwork();
        network.contracts.transferContract.call.num_notes = async () => 497n;
        await engine.startShieldedSync({ force: true });
        await vi.waitFor(() => expect(engine.getShieldedStatus().state).toBe("syncing"));
        await expect(engine.getShieldedHistory()).resolves.toEqual({ profileIndex: 0, entries: first.entries, pending: true });
      } finally {
        notes.mockRestore();
      }
    });

    it("forgets the tree's heights and the histories kept on a chain the sync finds replaced", async () => {
      const activity = await import("./activityStore.js");
      await activity.clearActivityStore();
      const { leavesFromPos } = await scanTree();
      await profileNotes();
      await growTree(leavesFromPos);
      archive();
      await engine.getShieldedHistory();
      expect(await activity.getNoteHeightPool("mainnet")).not.toBeNull();
      expect(await activity.getShieldedHistoryRecord(`mainnet::${WALLET_ID}::0`)).not.toBeNull();
      // The node's chain was rebuilt: the block the sync anchored to is another one.
      const store = await import("./shieldedStore.js");
      await store.putShieldedMeta(NETWORK_KEY, WALLET_ID, 0, { anchorBlock: "100", anchorHash: "old-chain" });
      const { AddressSyncer } = await import("@dusk/w3sper");
      const notes = vi.spyOn(AddressSyncer.prototype, "notes").mockImplementation(() => new Promise(() => {}));
      try {
        await engine.startShieldedSync({ force: true });
        await vi.waitFor(async () => expect(await activity.getNoteHeightPool("mainnet")).toBeNull());
        expect(await activity.getShieldedHistoryRecord(`mainnet::${WALLET_ID}::0`)).toBeNull();
      } finally {
        notes.mockRestore();
      }
    });

    it("keeps no note heights a scan read before a reset", async () => {
      const activity = await import("./activityStore.js");
      await activity.clearActivityStore();
      const put = vi.spyOn(activity, "putNoteHeightPool");
      const read = Promise.withResolvers();
      const held = Promise.withResolvers();
      const scan = scanTree(async () => {
        read.resolve();
        await held.promise;
      });
      await read.promise;
      await activity.clearActivityStore();
      held.resolve();
      await scan;
      await vi.waitFor(() => expect(put).toHaveBeenCalled());
      await Promise.allSettled(put.mock.results.map((r) => r.value));
      expect(await activity.getNoteHeightPool("mainnet")).toBeNull();
      put.mockRestore();
    });
  });
});
