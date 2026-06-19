import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "fake-indexeddb/auto";

import { bytesToHex, sha256Hex, toBytes } from "./bytes.js";

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

    constructor(_seeder) {}

    async #nth(n) {
      return new Profile(n);
    }

    next() {
      const index = this.#profiles.length || 1;
      const p = this.#nth(index);
      this.#profiles[index] = p;
      return p;
    }

    get default() {
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
        return globalThis.__W3SPER_BALANCE__(identifier);
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
    constructor(n) {
      this._n = BigInt(n ?? 0);
    }
    asUint() {
      return this._n;
    }
  }

  class AddressSyncer {
    constructor(_network) {}
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

  return {
    Bookkeeper,
    Bookmark,
    Network,
    ProfileGenerator,
    AddressSyncer,
    AccountSyncer,
    STAKE: "stake",
    useAsProtocolDriver,
  };
});

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

  afterEach(() => {
    try {
      engine?.lock?.();
    } catch {
      // ignore
    }
    vi.unstubAllGlobals();
    delete globalThis.__W3SPER_EXECUTE_IMPL__;
    delete globalThis.__W3SPER_STAKE_INFO__;
    delete globalThis.__W3SPER_STAKE_KEYS__;
  });

  it("derives the CLI-aligned two default profiles on unlock", async () => {
    await engine.unlockWithMnemonic(MNEMONIC);

    expect(engine.getAccounts()).toEqual(["acct0", "acct1"]);
    expect(engine.getAddresses()).toEqual(["addr0", "addr1"]);
    expect(engine.getSelectedAccountIndex()).toBe(0);
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
});
