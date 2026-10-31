import { networks } from "@dusk-network/networks";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { rowOf, rowsOf } from "./fixtures/rows.js";

// chrome.storage, as a map, a write held where a test says; the transaction store's reset count.
const items = vi.hoisted(() => ({}));
const hooks = vi.hoisted(() => ({ beforeSet: null }));
const epoch = vi.hoisted(() => ({ now: 1 }));
vi.mock("./storage.js", () => ({
  STORAGE_KEYS: {
    BRIDGE_ARRIVALS: "dusk_bridge_arrivals_v1",
    BRIDGE_ARRIVALS_V2: "dusk_bridge_arrivals_v2",
    SETTINGS: "dusk_settings_v1",
    NETWORK_STATUS: "dusk_network_status_v1",
  },
  storage: {
    get: async (key) => ({ [key]: structuredClone(items[key]) }),
    set: async (patch) => {
      await hooks.beforeSet?.(patch);
      Object.assign(items, structuredClone(patch));
    },
    remove: async (keys) => {
      for (const key of [keys].flat()) delete items[key];
    },
  },
}));
vi.mock("./txStore.js", () => ({ getTxEpoch: vi.fn(async () => epoch.now) }));

const TESTNET = "https://testnet.nodes.dusk.network";
const MAINNET = "https://nodes.dusk.network";
const evm = networks.testnet.duskEvm;
const BRIDGE = evm.contracts.l1_standard_bridge.contractId;
const TO = "0xAB84EDFFd745AF9420ac74FeC73121FBEE9fC86F";
const L2 = (n) => `0x${String(n).repeat(64).slice(0, 64)}`;
const NOW = Date.parse("2026-10-28T12:00:00Z");

// Activity's row of a deposit of `lux` to TO this wallet sent, in a Dusk block `ago` ms before NOW.
const deposit = (hash, { lux = "500000000", ago = 180_000, ...over } = {}) =>
  rowOf({
    hash: hash.repeat(64).slice(0, 64),
    kind: "contract_call",
    contractId: BRIDGE,
    fnName: "depositETHToWithValue",
    amount: "0",
    deposit: lux,
    bridgeTo: TO,
    status: "executed",
    finalizedAt: NOW - ago,
    nodeUrl: TESTNET,
    ...over,
  });
// A's arrival, as a look on DuskEVM finds it.
const FOUND = { [deposit("a").hash]: { hash: L2(2), at: NOW - 60_000 } };
// The wallet that sent it (its first public account), and another one.
const W1 = "wallet-one";
const W2 = "wallet-two";

let arrivals;
// The arrival kept for a deposit, or null.
const arrivalOf = (hash, from = arrivals) => from.keptArrivals().get(hash) ?? null;

beforeEach(async () => {
  vi.resetModules();
  for (const key of Object.keys(items)) delete items[key];
  hooks.beforeSet = null;
  epoch.now = 1;
  arrivals = await import("./bridgeArrival.js");
});

describe("a deposit to DuskEVM's arrival", () => {
  it("is awaited only for a deposit gone through this week, to a DuskEVM address, on a network with DuskEVM", () => {
    const { awaitingArrival } = arrivals;
    expect(awaitingArrival(deposit("a"), TESTNET, NOW)).toBe(true);
    // One the account's history has, sent from another device: its block's time, read.
    const [read] = rowsOf({
      entries: [
        {
          bridge: { amount: "500000000", kind: "deposit", to: TO },
          contractId: BRIDGE,
          fnName: "depositETHToWithValue",
          hash: "b".repeat(64),
          kind: "contract_call",
          timestamp: NOW - 180_000,
          value: "500000000",
        },
      ],
    });
    expect(awaitingArrival(read, TESTNET, NOW)).toBe(true);
    for (const row of [
      deposit("b", { status: "submitted" }),
      deposit("c", { status: "failed" }),
      deposit("d", { bridgeTo: undefined }),
      deposit("e", { ago: 8 * 24 * 60 * 60_000 }),
      deposit("f", { lux: "0" }),
      // A call to another contract.
      deposit("g", { bridgeTo: undefined, contractId: "11".repeat(32) }),
    ]) {
      expect(awaitingArrival(row, TESTNET, NOW)).toBe(false);
    }
    // Mainnet has no DuskEVM: nothing to wait for.
    expect(awaitingArrival(deposit("h", { nodeUrl: MAINNET }), MAINNET, NOW)).toBe(false);
    expect(arrivals.arrivalUrl(MAINNET, L2(1))).toBeNull();
    expect(arrivals.arrivalUrl(TESTNET, L2(1))).toBe(`https://explorer.testnet.evm.dusk.network/tx/${L2(1)}`);
  });

  it("is kept under the reset count its look began with, and no longer awaited, in this page or another", async () => {
    await arrivals.loadArrivals(W1);
    await expect(arrivals.keepArrivals(FOUND, 1, W1)).resolves.toBe(1);
    expect(items.dusk_bridge_arrivals_v2).toEqual({ epoch: 1, wallets: { [W1]: FOUND } });
    expect(arrivals.awaitingArrival(deposit("a"), TESTNET, NOW)).toBe(false);

    vi.resetModules();
    const fresh = await import("./bridgeArrival.js");
    await fresh.loadArrivals(W1);
    expect(arrivalOf(deposit("a").hash, fresh)?.hash).toBe(L2(2));
    expect(fresh.awaitingArrival(deposit("a"), TESTNET, NOW)).toBe(false);
  });

  it("keeps each wallet's own: another wallet reads none of them, and a removed one's go alone", async () => {
    await arrivals.loadArrivals(W1);
    await arrivals.keepArrivals(FOUND, 1, W1);
    const other = { [deposit("b").hash]: { hash: L2(3), at: NOW - 30_000 } };
    await arrivals.keepArrivals(other, 1, W2);

    // The page switches to wallet 2: wallet 1's arrival isn't kept for it, nor shown.
    await arrivals.loadArrivals(W2);
    expect(arrivalOf(deposit("a").hash)).toBeNull();
    expect(arrivalOf(deposit("b").hash)?.hash).toBe(L2(3));
    expect(arrivals.awaitingArrival(deposit("a"), TESTNET, NOW)).toBe(true);
    // A look for wallet 1 finishing now keeps its arrival, but not in wallet 2's view.
    await expect(arrivals.keepArrivals(FOUND, 1, W1)).resolves.toBe(0);
    expect(arrivalOf(deposit("a").hash)).toBeNull();

    await arrivals.forgetWalletArrivals(W1);
    expect(items.dusk_bridge_arrivals_v2).toEqual({ epoch: 1, wallets: { [W2]: other } });
    // Without a wallet (locked), none.
    await arrivals.loadArrivals("");
    expect(arrivals.keptArrivals().size).toBe(0);
  });

  it("makes the arrivals kept before wallets were kept apart the unlocked wallet's own", async () => {
    items.dusk_bridge_arrivals_v1 = { epoch: 1, items: FOUND };
    await arrivals.adoptLegacyArrivals(W1);
    expect(items.dusk_bridge_arrivals_v1).toBeUndefined();
    expect(items.dusk_bridge_arrivals_v2).toEqual({ epoch: 1, wallets: { [W1]: FOUND } });
    await arrivals.loadArrivals(W1);
    expect(arrivalOf(deposit("a").hash)?.hash).toBe(L2(2));

    // Those from before a reset are dropped, not adopted.
    items.dusk_bridge_arrivals_v1 = { epoch: 0, items: FOUND };
    await arrivals.adoptLegacyArrivals(W2);
    expect(items.dusk_bridge_arrivals_v1).toBeUndefined();
    expect(items.dusk_bridge_arrivals_v2.wallets[W2]).toBeUndefined();
  });

  it("keeps nothing when a wallet reset came since its look began, and is forgotten with the wallet", async () => {
    await arrivals.loadArrivals(W1);
    epoch.now = 2;
    await expect(arrivals.keepArrivals(FOUND, 1, W1)).resolves.toBe(0);
    expect([arrivalOf(deposit("a").hash), items.dusk_bridge_arrivals_v2]).toEqual([null, undefined]);

    // Kept, then forgotten with the wallet.
    await arrivals.keepArrivals(FOUND, 2, W1);
    expect(arrivalOf(deposit("a").hash)).not.toBeNull();
    items.dusk_bridge_arrivals_v1 = { epoch: 2, items: FOUND };
    await arrivals.clearArrivals();
    expect([arrivalOf(deposit("a").hash), items.dusk_bridge_arrivals_v2, items.dusk_bridge_arrivals_v1]).toEqual([null, undefined, undefined]);
  });

  it("is forgotten in every page once a wallet reset anywhere moves the reset count on", async () => {
    const { keepArrivals, loadArrivals } = arrivals;
    await loadArrivals(W1);
    await keepArrivals(FOUND, 1, W1);
    expect(arrivalOf(deposit("a").hash)?.hash).toBe(L2(2));

    // Reset in the background: the count moves on, and the key goes there.
    epoch.now = 2;
    delete items.dusk_bridge_arrivals_v2;
    // This page, open all along, draws again.
    await loadArrivals(W1);
    expect(arrivalOf(deposit("a").hash)).toBeNull();
    // The old wallet's arrivals, still in storage, aren't read either.
    items.dusk_bridge_arrivals_v2 = { epoch: 1, wallets: { [W1]: FOUND } };
    await loadArrivals(W1);
    expect(arrivalOf(deposit("a").hash)).toBeNull();
  });

  it("keeps nothing of a look whose write a wallet reset's clear meets", async () => {
    const { clearArrivals, keepArrivals } = arrivals;
    // The look's write, held once it passed its look at the reset count.
    const writing = Promise.withResolvers();
    const go = Promise.withResolvers();
    hooks.beforeSet = async (patch) => {
      if ("dusk_bridge_arrivals_v2" in patch) {
        writing.resolve();
        await go.promise;
      }
    };
    const keeping = keepArrivals(FOUND, 1, W1);
    await writing.promise;
    // A reset: the count moves on, and the arrivals are cleared.
    epoch.now = 2;
    const clearing = clearArrivals();
    go.resolve();
    await Promise.all([keeping, clearing]);
    expect(items.dusk_bridge_arrivals_v2).toBeUndefined();
    // No page of the new wallet sees it.
    vi.resetModules();
    const fresh = await import("./bridgeArrival.js");
    await fresh.loadArrivals(W1);
    expect(arrivalOf(deposit("a").hash, fresh)).toBeNull();
  });

  it("is looked for less often the longer nothing changes: 5 seconds, doubled every 6 looks, at most 5 minutes", () => {
    const { arrivalCheckDelay } = arrivals;
    expect([0, 5, 6, 11, 12, 18, 30, 36, 1000].map(arrivalCheckDelay)).toEqual([
      5_000, 5_000, 10_000, 10_000, 20_000, 40_000, 160_000, 300_000, 300_000,
    ]);
  });
});
