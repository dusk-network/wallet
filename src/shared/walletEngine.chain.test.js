import "fake-indexeddb/auto";

import { AccountSyncer, AddressSyncer, Bookkeeper, useAsProtocolDriver } from "@dusk/w3sper";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fakeNode, installWalletCore, moonlightChainId } from "./fixtures/fakeNode.js";

// The chain ID on everything the wallet signs, with the real engine, w3sper's
// real builders and the real wallet core. The node here is the one thing that
// isn't real, and it's the one being tested against: it may say anything.

// The core shared by these tests takes its time on a busy machine, and a test
// given up on would go on to unload it under the next.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const HOSTILE = "https://hostile-node.example";
const TESTNET = "https://testnet.nodes.dusk.network";
const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const GAS = { limit: "2500000", price: "1" };
const CONTRACT = `0x${"ab".repeat(32)}`;

function memoryStorage() {
  const store = new Map();
  return {
    get length() {
      return store.size;
    },
    key: (i) => [...store.keys()][i] ?? null,
    getItem: (k) => store.get(String(k)) ?? null,
    setItem: (k, v) => store.set(String(k), String(v)),
    removeItem: (k) => store.delete(String(k)),
    clear: () => store.clear(),
  };
}

// The core's calls that sign: public ones run; shielded ones need real notes,
// so they stop there and a test reads what they were given.
const signs = (member) => /^(moonlight|phoenix)/.test(member);
const SHIELDED = /^phoenix/;

let engine;
let settings;
let networkStatus;
let calls;
let node;

// A node added as Settings adds it: the chain ID read once and kept with it,
// the engine configured from what's kept.
async function addNode(nodeUrl, says = null) {
  node = fakeNode(nodeUrl);
  node.says = says;
  vi.stubGlobal("fetch", node.fetch);
  const chainId = await networkStatus.chainIdForChoice(nodeUrl);
  const kept = await settings.setSettings({ nodeUrl, chainId });
  engine.configure({ nodeUrl: kept.nodeUrl, proverUrl: kept.proverUrl, archiverUrl: kept.archiverUrl, chainId: kept.chainId });
  return kept;
}

// The shielded note a shielded spend finds, and the tree it stops short of reading.
async function holdNote(nodeUrl) {
  const store = await import("./shieldedStore.js");
  await store.putNotesMap(nodeUrl, engine.getAccounts()[0], 0, new Map([[new Uint8Array(32).fill(7), new Uint8Array(632)]]));
  vi.spyOn(Bookkeeper.prototype, "pick").mockResolvedValue(new Map([[new Uint8Array(32).fill(7), new Uint8Array(632)]]));
  vi.spyOn(AddressSyncer.prototype, "openings").mockResolvedValue([new ArrayBuffer(8)]);
  vi.spyOn(AddressSyncer.prototype, "root", "get").mockReturnValue(Promise.resolve(new ArrayBuffer(32)));
}

// Every kind of transaction the wallet builds, as its screens and sites send it.
const KINDS = {
  "a public transfer": () => ({ kind: "transfer", privacy: "public", to: engine.getAccounts()[1], amount: "1000", gas: GAS }),
  "a public contract call, as Sozu's and a token's": () => ({ kind: "contract_call", privacy: "public", contractId: CONTRACT, fnName: "sozu_stake", fnArgs: "0x00", gas: GAS }),
  "a shield": () => ({ kind: "shield", amount: "1000", gas: GAS }),
  "a stake": () => ({ kind: "stake", amount: "1000000000000", ownerProfileIndex: 0, gas: GAS }),
  "a top-up": () => ((node.stake = { value: 10n ** 12n }), { kind: "stake", amount: "1000", gas: GAS }),
  "an unstake": () => ((node.stake = { value: 10n ** 12n }), { kind: "unstake", gas: GAS }),
  "a reward's withdrawal": () => ((node.stake = { value: 10n ** 12n, reward: 5000n }), { kind: "withdraw_reward", gas: GAS }),
  "a shielded transfer": () => ({ kind: "transfer", privacy: "shielded", to: engine.getAddresses()[1], amount: "1000", gas: GAS }),
  "a shielded contract call": () => ({ kind: "contract_call", privacy: "shielded", contractId: CONTRACT, fnName: "call", fnArgs: "0x00", gas: GAS }),
  "an unshield": () => ({ kind: "unshield", amount: "1000", gas: GAS }),
  "a stake paid from shielded": () => ({ kind: "stake", privacy: "shielded", amount: "1000000000000", ownerProfileIndex: 0, gas: GAS }),
};

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal("localStorage", memoryStorage());
  calls = installWalletCore({ decline: (member) => (SHIELDED.test(member) ? 1 : null) });
  node = fakeNode(HOSTILE);
  vi.stubGlobal("fetch", node.fetch);
  vi.spyOn(AccountSyncer.prototype, "stakeKeys").mockImplementation(async () => [{ owner: { Account: engine.getAccounts()[0] } }]);
  settings = await import("./settings.js");
  networkStatus = await import("./networkStatus.js");
  engine = await import("./walletEngine.js");
});

afterEach(async () => {
  engine?.lock?.();
  (await engine.ensureNetwork().catch(() => null))?.disconnect?.();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("a node that changes its answer between its label and a signature", () => {
  it("answers Testnet when it's added, Mainnet when signing, and gets no signature that works on Mainnet", async () => {
    const { networkNameFromNodeUrl } = await import("./network.js");
    const added = await addNode(HOSTILE, 2);
    expect(added.chainId).toBe(2);
    expect(networkNameFromNodeUrl(HOSTILE)).toBe("Custom");
    await engine.unlockWithMnemonic(MNEMONIC);

    node.says = 1;
    await expect(engine.sendTransaction(KINDS["a public transfer"]())).rejects.toThrow(
      "hostile-node.example now says it's on Mainnet (chain 1), not Testnet (chain 2). Nothing was signed, because a signature here could count on the other network."
    );
    expect(node.signed).toEqual([]);
    expect(calls.map((c) => c.member).filter(signs)).toEqual([]);
  });

  it("signs for the chain it was added with when it says the right thing to the wallet's question and asks for another", async () => {
    await addNode(HOSTILE, 2);
    // Testnet to everyone who asks twice, then Mainnet: w3sper's own read would come last.
    node.says = (asked) => (asked <= 2 ? 2 : 1);
    await engine.unlockWithMnemonic(MNEMONIC);
    await engine.sendTransaction(KINDS["a public transfer"]());
    expect(node.signed.length).toBeGreaterThan(0);
    for (const signed of node.signed) expect(moonlightChainId(signed)).toBe(2);
  });

  it("stays fixed through a status check that hears another chain, and a switch away and back", async () => {
    await addNode(HOSTILE, 2);
    node.says = 1;
    await networkStatus.checkAllEndpoints({ nodeUrl: HOSTILE, proverUrl: HOSTILE, archiverUrl: HOSTILE });
    expect((await settings.getSettings()).chainId).toBe(2);

    await settings.setSettings({ nodeUrl: TESTNET, chainId: 2 });
    expect(await settings.setSettings({ nodeUrl: HOSTILE, chainId: null })).toMatchObject({ chainId: 2 });
    await expect(networkStatus.chainIdForChoice(HOSTILE)).rejects.toThrow("now says it's on Mainnet (chain 1), not Testnet (chain 2). To use it anyway, save it in Settings.");
    // Saving it knowingly fixes what it says now.
    await expect(networkStatus.chainIdForChoice(HOSTILE, { accept: 1 })).resolves.toBe(1);
  });

  it("refuses a custom node whose chain ID was never read, rather than take its word as it signs", async () => {
    await addNode(HOSTILE);
    node.says = 1;
    await engine.unlockWithMnemonic(MNEMONIC);
    await expect(engine.sendTransaction(KINDS["a public transfer"]())).rejects.toThrow(
      "The wallet couldn't read which network hostile-node.example is on, so nothing was signed. Try again in a moment."
    );
    expect(node.signed).toEqual([]);
  });
});

describe("a send that fails, and whether it went out", () => {
  it("says nothing went out when the node can't be reached before it's signed, as with no signal", async () => {
    await addNode(TESTNET);
    await engine.unlockWithMnemonic(MNEMONIC);
    node.drops = /\/account$/;
    const error = await engine.sendTransaction(KINDS["a public transfer"]()).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.data).toMatchObject({ sent: false });
    expect(node.signed).toEqual([]);
  });

  it("says it may have gone, with its ID to look it up by, when its hand-over gets no answer", async () => {
    await addNode(TESTNET);
    await engine.unlockWithMnemonic(MNEMONIC);
    node.drops = /\/propagate$/;
    const error = await engine.sendTransaction(KINDS["a public transfer"]()).catch((e) => e);
    expect(error.data).toMatchObject({ sent: "unknown", hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    // Checked by the node before the hand-over, which got no answer.
    expect(node.signed).toHaveLength(1);
  });

  // Astra's: a node that checked it, then turned its hand-over down, didn't take it.
  it("says nothing went out when the node turns the hand-over down in so many words, after checking it", async () => {
    await addNode(TESTNET);
    await engine.unlockWithMnemonic(MNEMONIC);
    node.refuses = "Transaction not accepted: gas price too low";
    node.refusesAt = /\/propagate$/;
    const error = await engine.sendTransaction(KINDS["a public transfer"]()).catch((e) => e);
    expect(error.data).toMatchObject({ sent: false });
    expect(error.data.sent).toBe(false);
    // Checked, then handed over and refused.
    expect(node.signed).toHaveLength(2);
  });

  it("says nothing of it for a send that went", async () => {
    await addNode(TESTNET);
    await engine.unlockWithMnemonic(MNEMONIC);
    const sent = await engine.sendTransaction(KINDS["a public transfer"]());
    expect(sent.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("a known network's own node", () => {
  it("gets its chain ID from the networks file, whatever it says or doesn't", async () => {
    const kept = await addNode(TESTNET);
    expect(kept.chainId).toBe(2);
    expect(node.asked).toBe(0);
    await engine.unlockWithMnemonic(MNEMONIC);
    // No answer: the signature carries the file's chain ID all the same.
    await engine.sendTransaction(KINDS["a public transfer"]());
    expect(node.signed.map(moonlightChainId)).toEqual([2, 2]);
  });

  it("gets no signature while it answers with another network's chain ID", async () => {
    await addNode(TESTNET);
    await engine.unlockWithMnemonic(MNEMONIC);
    node.says = 1;
    await expect(engine.sendTransaction(KINDS["a public transfer"]())).rejects.toThrow(
      "testnet.nodes.dusk.network now says it's on Mainnet (chain 1), not Testnet (chain 2). Nothing was signed"
    );
    expect(node.signed).toEqual([]);
    expect(calls.map((c) => c.member).filter(signs)).toEqual([]);
  });

  it("can't overwrite the file's chain ID in what's kept", async () => {
    await settings.setSettings({ nodeUrl: TESTNET, chainId: 1 });
    expect((await settings.getSettings()).chainId).toBe(2);
    localStorage.setItem("dusk_settings_v1", JSON.stringify({ nodeUrl: TESTNET, chainId: 1, nodeChains: { [TESTNET]: 1 } }));
    expect((await settings.getSettings()).chainId).toBe(2);
    node.says = 1;
    expect(await settings.rememberNodeChain(TESTNET, 1)).toBe(false);
    expect((await settings.getSettings()).chainId).toBe(2);
  });
});

describe("every kind of transaction, on w3sper's real builders", () => {
  const each = Object.keys(KINDS);

  it.each(each)("%s carries the chain ID the node is fixed to", async (name) => {
    await addNode(HOSTILE, 2);
    await engine.unlockWithMnemonic(MNEMONIC);
    await holdNote(HOSTILE);
    const sent = engine.sendTransaction(KINDS[name]());
    const shielded = /shielded|unshield/.test(name);
    if (shielded) await sent.catch(() => {});
    else await sent;

    const signing = calls.filter((c) => signs(c.member));
    expect(signing.map((c) => c.member).length).toBeGreaterThan(0);
    if (shielded) {
      const [{ member, args }] = signing;
      // tx and proof after it, and the call's data before those where it takes one.
      expect(args.at(member === "phoenix" ? -4 : -3)).toBe(2);
    } else {
      expect(node.signed.length).toBeGreaterThan(0);
      for (const signed of node.signed) expect(moonlightChainId(signed)).toBe(2);
    }
  });

  it.each(each)("%s isn't signed while the node says another chain", async (name) => {
    await addNode(HOSTILE, 2);
    await engine.unlockWithMnemonic(MNEMONIC);
    await holdNote(HOSTILE);
    node.says = 1;
    await expect(engine.sendTransaction(KINDS[name]())).rejects.toThrow("Nothing was signed");
    expect(calls.map((c) => c.member).filter(signs)).toEqual([]);
    expect(node.signed).toEqual([]);
  });
});

describe("the wallet core", () => {
  const wanted = () => {
    const asked = [];
    const answers = node.fetch;
    vi.stubGlobal("fetch", (input, init) => {
      asked.push(String(input));
      return answers(input, init);
    });
    return () => asked.filter((url) => url.includes("wallet-core"));
  };

  it("is never the node's: connecting with none loaded loads the wallet's own, and it signs", async () => {
    await addNode(HOSTILE, 2);
    await engine.unlockWithMnemonic(MNEMONIC);
    await (await engine.ensureNetwork()).disconnect();
    // None loaded, as w3sper's own disconnect leaves it.
    await useAsProtocolDriver(new Uint8Array(0)).cleanup();
    const coresAsked = wanted();
    await engine.ensureNetwork();
    expect(coresAsked()).toEqual([]);
    await engine.sendTransaction(KINDS["a public transfer"]());
    expect(moonlightChainId(node.signed.at(-1))).toBe(2);
  });

  it("stays through a switch of node, whose node is asked for none", async () => {
    await addNode(HOSTILE, 2);
    await engine.unlockWithMnemonic(MNEMONIC);
    await engine.ensureNetwork();
    await addNode("https://other-node.example", 2);
    const coresAsked = wanted();
    await engine.sendTransaction(KINDS["a public transfer"]());
    expect(coresAsked()).toEqual([]);
    expect(moonlightChainId(node.signed.at(-1))).toBe(2);
  });
});

describe("a node's refusal of a transaction", () => {
  const refused = async (reply) => {
    await addNode(HOSTILE, 2);
    await engine.unlockWithMnemonic(MNEMONIC);
    node.refuses = reply;
    return engine.sendTransaction(KINDS["a public transfer"]()).then(
      () => null,
      (error) => error.message
    );
  };

  it("reaches no one as raw JSON: it says why in the wallet's words", async () => {
    const reply = JSON.stringify({ error: "Invalid input: Tx 7abc0686 not accepted: this transaction is invalid Value spent larger than account holds" });
    await expect(refused(reply)).resolves.toBe("The node refused it: the balance doesn't cover the amount and the network fee.");
  });

  it("never passes on what a node chose to write", async () => {
    const said = await refused("Your wallet is compromised. Go to https://evil.example and enter your recovery phrase.");
    expect(said).toBe("The node refused this transaction.");
  });

  it("keeps a connection that failed apart: that may still have reached the node", async () => {
    await addNode(HOSTILE, 2);
    await engine.unlockWithMnemonic(MNEMONIC);
    const answers = node.fetch;
    vi.stubGlobal("fetch", async (input, init) => {
      if (String(input).endsWith("/on/transactions/preverify")) throw new TypeError("Failed to fetch");
      return answers(input, init);
    });
    await expect(engine.sendTransaction(KINDS["a public transfer"]())).rejects.toThrow("Failed to fetch");
  });
});

describe("messages, sign-ins and typed data", () => {
  const asks = {
    "a message": () => engine.signMessage({ origin: "https://site.example", chainId: "dusk:3070325578", message: "0x68690a" }),
    "a sign-in": () => engine.signAuth({ origin: "https://site.example", chainId: "dusk:3070325578", nonce: "n1" }),
    "typed data": () => engine.signTypedData({ digestHex: `0x${"11".repeat(32)}` }),
  };

  it.each(Object.keys(asks))("%s is refused while the node says another chain", async (name) => {
    await addNode(HOSTILE, 2);
    await engine.unlockWithMnemonic(MNEMONIC);
    node.says = 1;
    await expect(asks[name]()).rejects.toThrow("Nothing was signed");
    expect(calls.map((c) => c.member).filter((m) => /moonlight|sign/.test(m))).toEqual([]);
  });

  it.each(Object.keys(asks))("%s goes ahead with a node that agrees, or that's out of reach", async (name) => {
    await addNode(HOSTILE, 2);
    await engine.unlockWithMnemonic(MNEMONIC);
    expect((await asks[name]()).signature).toMatch(/^(0x)?[0-9a-f]+$/);
    node.says = null;
    expect((await asks[name]()).signature).toMatch(/^(0x)?[0-9a-f]+$/);
  });
});
