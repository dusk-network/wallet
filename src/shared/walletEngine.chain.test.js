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

  // Astra's: a node that checked it, then turned its hand-over down, didn't take it. Rusk 1.7.3's own
  // refusal (map_check_tx_error, behind HTTP 400): {"error":"Invalid input: Tx <id> not accepted: <why>"}.
  it("says nothing went out when the node turns the hand-over down in Rusk's own refusal, after checking it", async () => {
    await addNode(TESTNET);
    await engine.unlockWithMnemonic(MNEMONIC);
    node.refuses = JSON.stringify({ error: `Invalid input: Tx ${"4f".repeat(32)} not accepted: gas price lower than minimum 1` });
    node.refusesAt = /\/propagate$/;
    const error = await engine.sendTransaction(KINDS["a public transfer"]()).catch((e) => e);
    expect(error.data.sent).toBe(false);
    expect(error.message).toBe("The node refused it: the network fee is too low. Raise it under Custom fee.");
    // Checked, then handed over and refused.
    expect(node.signed).toHaveLength(2);
  });

  // Astra's: a gateway in front of the node answers in JSON too, after the hand-over went through it.
  it("says it may have gone, with its ID, when what answers the hand-over is anything but the node's refusal, JSON or not", async () => {
    await addNode(TESTNET);
    await engine.unlockWithMnemonic(MNEMONIC);
    node.refusesAt = /\/propagate$/;
    for (const answer of [JSON.stringify({ error: "Gateway Timeout" }), "Invalid nonce", JSON.stringify({ error: "Internal server error" })]) {
      node.refuses = answer;
      const error = await engine.sendTransaction(KINDS["a public transfer"]()).catch((e) => e);
      expect(error.data).toMatchObject({ sent: "unknown", hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
      expect(error.message).toBe("The node gave no clear answer, so this may still go through. Check Activity before sending again.");
    }
  });

  it("says nothing of it for a send that went", async () => {
    await addNode(TESTNET);
    await engine.unlockWithMnemonic(MNEMONIC);
    const sent = await engine.sendTransaction(KINDS["a public transfer"]());
    expect(sent.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("the network's gas price", () => {
  // Lena's: the extension's unstake paid gas price 2 where the web wallet's paid 1: the extension asked for the median
  // of the 100 best-paying transactions, the web wallet for that of every one the node holds.
  it("is asked of every transaction the node holds, as the web wallet asks it, and kept 30 seconds", async () => {
    await addNode(TESTNET);
    await engine.unlockWithMnemonic(MNEMONIC);
    const asked = [];
    const fetch = node.fetch;
    vi.stubGlobal("fetch", async (input, init = {}) => {
      if (new URL(String(input), "https://wallet.invalid").pathname === "/on/blocks/gas-price") {
        asked.push(init.body ?? null);
        return new Response(JSON.stringify({ average: 3, max: 9, median: 2, min: 1 }));
      }
      return fetch(input, init);
    });
    await expect(engine.getCachedGasPrice({ forceRefresh: true })).resolves.toEqual({ average: "3", max: "9", median: "2", min: "1" });
    await engine.getCachedGasPrice();
    expect(asked).toEqual([null]);
  });
});

describe("a payment from Send, called off", () => {
  // Amélie's: the extension gave up on a send it couldn't get out, where the web wallet waits with Cancel. Cancel
  // and the hand-over are settled here, where the transaction is handed over: never both.
  const payment = (sendId) => ({ ...KINDS["a public transfer"](), sendId });
  // Each try kept with its ID before it's handed over, as the wallet keeps it.
  beforeEach(() => engine.setHandOverHook(async () => {}));
  afterEach(() => engine.setHandOverHook(null));

  it("never reaches the node once called off, also as the node is checking it, and says nothing was sent", async () => {
    await addNode(TESTNET);
    await engine.unlockWithMnemonic(MNEMONIC);
    // Called off as the node checks it: the hand-over after is refused.
    const fetch = node.fetch;
    vi.stubGlobal("fetch", async (input, init) => {
      if (String(input).endsWith("/preverify")) expect(engine.cancelSend({ sendId: "send-checking" })).toEqual({ cancelled: true });
      return fetch(input, init);
    });
    const error = await engine.sendTransaction(payment("send-checking")).catch((e) => e);
    expect(error.data).toMatchObject({ sent: false, cancelled: true });
    expect(error.message).toBe("You cancelled it, so nothing was sent.");
    // Checked, never handed over.
    expect(node.signed).toHaveLength(1);

    // Called off before its try came: refused as it comes, nothing signed.
    expect(engine.cancelSend({ sendId: "send-early" })).toEqual({ cancelled: true });
    await expect(engine.sendTransaction(payment("send-early"))).rejects.toMatchObject({ data: { sent: false, cancelled: true } });
    expect(node.signed).toHaveLength(1);
  });

  it("goes on once handed over, which Cancel can't undo, and is never handed over twice", async () => {
    await addNode(TESTNET);
    await engine.unlockWithMnemonic(MNEMONIC);
    const sent = await engine.sendTransaction(payment("send-out"));
    expect(sent.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(engine.cancelSend({ sendId: "send-out" })).toEqual({ cancelled: false });
    const handedOver = node.signed.length;
    await expect(engine.sendTransaction(payment("send-out"))).rejects.toMatchObject({ data: { sent: "unknown" } });
    expect(node.signed).toHaveLength(handedOver);
  });
});

describe("a payment from Send, as it's handed over", () => {
  const payment = (sendId) => ({ ...KINDS["a public transfer"](), sendId });

  // Astra's: a payment that waited and reached the node as the wallet stopped was said not sent once it was back.
  // Sofía's: one whose first try was cut short by Android ending the app vanished; every try is told of now.
  it("is told of with its ID and nonce before it's handed over, on every try; one that can't be told of isn't handed over", async () => {
    await addNode(TESTNET);
    await engine.unlockWithMnemonic(MNEMONIC);
    const asked = [];
    const fetch = node.fetch;
    vi.stubGlobal("fetch", async (input, init) => {
      asked.push(new URL(String(input), "https://wallet.invalid").pathname);
      return fetch(input, init);
    });
    const handedOver = () => asked.filter((path) => path.endsWith("/propagate")).length;
    const told = [];
    engine.setHandOverHook(async (sent) => told.push({ ...sent, handedOver: handedOver() }));

    // Being handed over from the word till the node answers, as a background started again asks (sendUnderWay).
    const underWay = [];
    engine.setHandOverHook(async (sent) => {
      told.push({ ...sent, handedOver: handedOver() });
      underWay.push(engine.sendUnderWay({ sendId: sent.sendId }).underWay);
    });
    const sent = await engine.sendTransaction(payment("send-first"));
    expect(told).toEqual([{ sendId: "send-first", hash: sent.hash, nonce: "1", handedOver: 0 }]);
    expect(handedOver()).toBe(1);
    expect([underWay, engine.sendUnderWay({ sendId: "send-first" })]).toEqual([[true], { underWay: false }]);

    // Not told, as when what's kept can't be written: never handed over, and nothing went out.
    engine.setHandOverHook(async () => {
      throw new Error("Storage is full");
    });
    const error = await engine.sendTransaction(payment("send-untold")).catch((e) => e);
    expect(error.data).toMatchObject({ sent: false });
    expect(handedOver()).toBe(1);
    engine.setHandOverHook(null);
  });
});

describe("a public payment from Send handed over without a clear answer", () => {
  // Chen's: confirmed as the Wi-Fi died, the node never had it, and the wallet said it may have reached the network.
  const payment = (sendId) => ({ ...KINDS["a public transfer"](), sendId });
  const nonces = [];
  beforeEach(() => {
    nonces.length = 0;
    engine.setHandOverHook(async ({ sendId, nonce }) => nonces.push(`${sendId} ${nonce}`));
  });
  afterEach(() => engine.setHandOverHook(null));

  it("goes out again as the very transaction made for it, once the node turns out never to have had it", async () => {
    await addNode(TESTNET);
    await engine.unlockWithMnemonic(MNEMONIC);
    node.drops = /\/propagate$/;
    const lost = await engine.sendTransaction(payment("send-lost")).catch((e) => e);
    expect(lost.data).toMatchObject({ sent: "unknown", hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const made = node.signed.at(-1);

    node.drops = null;
    const again = await engine.resendSend({ sendId: "send-lost" });
    expect(again).toEqual({ hash: lost.data.hash, nonce: 1n });
    // Checked and handed over as it was: the same bytes, nothing signed anew.
    expect(node.signed.slice(-2)).toEqual([made, made]);
    expect(nonces).toEqual(["send-lost 1", "send-lost 1"]);
    // Once is all: nothing of it is kept to send a third time.
    await expect(engine.resendSend({ sendId: "send-lost" })).rejects.toMatchObject({ data: { sent: false, gone: true } });
  });

  it("is followed by the next transaction's nonce, never shares it; forgotten, its nonce is free again", async () => {
    await addNode(TESTNET);
    await engine.unlockWithMnemonic(MNEMONIC);
    node.drops = /\/propagate$/;
    await engine.sendTransaction(payment("send-lost")).catch(() => {});
    node.drops = null;
    // It may be in the node's mempool: the next one comes after it.
    await engine.sendTransaction(payment("send-next"));
    expect(nonces).toEqual(["send-lost 1", "send-next 2"]);

    node.drops = /\/propagate$/;
    await engine.sendTransaction(payment("send-lost-2")).catch(() => {});
    node.drops = null;
    expect(engine.forgetHandedOver({ sendId: "send-lost-2" })).toEqual({ forgotten: true });
    await engine.sendTransaction(payment("send-after"));
    expect(nonces.slice(-2)).toEqual(["send-lost-2 3", "send-after 3"]);
  });

  // Astra's: signed for Testnet, it went to Mainnet's node once Mainnet was chosen as it waited, and was refused there.
  it("waits for the network it was made for, never handed to another, and goes out there once it's chosen again", async () => {
    await addNode(TESTNET);
    await engine.unlockWithMnemonic(MNEMONIC);
    node.drops = /\/propagate$/;
    const lost = await engine.sendTransaction(payment("send-lost")).catch((e) => e);
    await addNode("https://nodes.dusk.network");
    const held = await engine.resendSend({ sendId: "send-lost" }).catch((e) => e);
    expect(held.data).toMatchObject({ sent: false, unreachable: true });
    expect(node.signed).toEqual([]);
    await addNode(TESTNET);
    await expect(engine.resendSend({ sendId: "send-lost" })).resolves.toEqual({ hash: lost.data.hash, nonce: 1n });
    expect(node.signed).toHaveLength(2);
  });

  it("can't be sent again once the wallet locked", async () => {
    await addNode(TESTNET);
    await engine.unlockWithMnemonic(MNEMONIC);
    node.drops = /\/propagate$/;
    await engine.sendTransaction(payment("send-lost")).catch(() => {});
    engine.lock();
    await engine.unlockWithMnemonic(MNEMONIC);
    node.drops = null;
    const signed = node.signed.length;
    await expect(engine.resendSend({ sendId: "send-lost" })).rejects.toMatchObject({ data: { sent: false, gone: true } });
    expect(node.signed).toHaveLength(signed);
  });
});

// Astra's: a site's transfer or a contract call that lost its connection before the node had it kept its nonce
// taken: the next transaction skipped it (the chain at 0, the next at 2) and waited behind one that never came.
describe("a public transaction of a site's, or a contract call, handed over without a clear answer", () => {
  const nonces = [];
  // The node, as its GraphQL and its account status answer: whether it has the transaction (`has`), by its ID.
  const asks = { has: null };
  const answering = () => {
    const fetch = node.fetch;
    vi.stubGlobal("fetch", async (input, init = {}) => {
      const url = new URL(String(input), "https://wallet.invalid");
      const body = String(init.body ?? "");
      if (url.pathname === "/on/graphql/query" && body.includes("tx(hash")) return new Response(JSON.stringify({ tx: null }));
      if (url.pathname === "/on/graphql/query" && body.includes("mempoolTxs")) return new Response(JSON.stringify({ mempoolTxs: asks.has ? [{ id: asks.has }] : [] }));
      if (/\/on\/account:[^/]+\/status$/.test(url.pathname)) return new Response(JSON.stringify({ balance: 1, nonce: Number(node.balance.nonce), next_nonce: Number(node.balance.nonce) + 1 }));
      return fetch(input, init);
    });
  };
  beforeEach(() => {
    nonces.length = 0;
    asks.has = null;
    engine.setHandOverHook(async ({ sendId, nonce }) => nonces.push(`${sendId} ${nonce}`));
  });
  afterEach(() => engine.setHandOverHook(null));

  it("frees its nonce once the node is known not to have it, and keeps it taken where the node has it", async () => {
    await addNode(TESTNET);
    await engine.unlockWithMnemonic(MNEMONIC);
    answering();
    node.drops = /\/propagate$/;
    const call = await engine.sendTransaction(KINDS["a public contract call, as Sozu's and a token's"]()).catch((e) => e);
    expect(call.data).toMatchObject({ sent: "unknown", hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    node.drops = null;
    // The node never had it, and the account's nonce is still 0: the next one takes its nonce.
    await engine.sendTransaction({ ...KINDS["a public transfer"](), sendId: "send-next" });
    expect(nonces).toEqual(["send-next 1"]);

    // Lost again, but in the node's mempool this time: its nonce stays taken.
    node.drops = /\/propagate$/;
    const kept = await engine.sendTransaction(KINDS["a public contract call, as Sozu's and a token's"]()).catch((e) => e);
    node.drops = null;
    asks.has = kept.data.hash;
    await engine.sendTransaction({ ...KINDS["a public transfer"](), sendId: "send-after" });
    expect(nonces).toEqual(["send-next 1", "send-after 3"]);
  });
});

describe("a prover out of reach", () => {
  // Astra's: a shielded payment proved as the network went failed, the engine's words for that read as no network.
  it("is the network out of reach, as the engine marks it", async () => {
    await addNode(TESTNET);
    await engine.unlockWithMnemonic(MNEMONIC);
    const network = await engine.ensureNetwork();
    const fetch = node.fetch;
    vi.stubGlobal("fetch", async (input, init) => {
      if (String(input).includes("/on/prover/prove")) throw new TypeError("Failed to fetch");
      return fetch(input, init);
    });
    const error = await network.prove(new Uint8Array(8)).catch((e) => e);
    expect(error.message).toMatch(/^Could not reach prover \(/);
    expect(error.data).toEqual({ unreachable: true });
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
