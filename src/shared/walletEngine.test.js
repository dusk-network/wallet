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
    toValue = "";
    memoValue = "";
    gasValue = null;
    chainValue = null;
    nonceValue = null;
    depositValue = 0n;
    payloadValue = null;
    obfuscatedValue = false;

    constructor(profile, amount) {
      this.profile = profile;
      this.amount = amount;
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

    async build() {
      return { buffer: buildSignedMoonlightBuffer() };
    }
  }

  class Bookkeeper {
    constructor(_treasury) {}
    as(profile) {
      return {
        transfer: (amount) => new TxBuilder(profile, amount),
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
  }

  class AccountSyncer {
    constructor(_network) {}
    async balances(profiles) {
      return (profiles ?? []).map(() => ({ nonce: 0n, value: 0n }));
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
    useAsProtocolDriver,
  };
});

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("walletEngine", () => {
  /** @type {typeof import('./walletEngine.js')} */
  let engine;

  beforeEach(async () => {
    vi.resetModules();
    globalThis.__W3SPER_LAST_EXEC_TX__ = null;

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
});
