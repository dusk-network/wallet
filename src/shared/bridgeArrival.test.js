import { networks } from "@dusk-network/networks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// chrome.storage, as a map, a write held where a test says; the transaction store's reset count.
const items = vi.hoisted(() => ({}));
const hooks = vi.hoisted(() => ({ beforeSet: null }));
const epoch = vi.hoisted(() => ({ now: 1 }));
vi.mock("./storage.js", () => ({
  STORAGE_KEYS: { BRIDGE_ARRIVALS: "dusk_bridge_arrivals_v1", SETTINGS: "dusk_settings_v1", NETWORK_STATUS: "dusk_network_status_v1" },
  storage: {
    get: async (key) => ({ [key]: items[key] }),
    set: async (patch) => {
      await hooks.beforeSet?.(patch);
      Object.assign(items, structuredClone(patch));
    },
    remove: async (key) => {
      delete items[key];
    },
  },
}));
vi.mock("./txStore.js", () => ({ getTxEpoch: vi.fn(async () => epoch.now) }));

const TESTNET = "https://testnet.nodes.dusk.network";
const MAINNET = "https://nodes.dusk.network";
const evm = networks.testnet.duskEvm;
const API = evm.blockscoutApiUrl;
const L2_BRIDGE = evm.predeploys.l2StandardBridge;
const BRIDGE = evm.contracts.l1_standard_bridge.contractId;
const TO = "0xAB84EDFFd745AF9420ac74FeC73121FBEE9fC86F";
const L2 = (n) => `0x${String(n).repeat(64).slice(0, 64)}`;
const NOW = Date.parse("2026-10-28T12:00:00Z");

// A deposit of `lux` to TO, in a Dusk block `ago` ms before NOW.
const deposit = (hash, { lux = "500000000", ago = 180_000, ...over } = {}) => ({
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
// A call DuskEVM's explorer lists for TO: from the L2 bridge, of `wei`, `ago` ms before NOW.
const call = (hash, { wei = "500000000000000000", ago = 60_000, from = L2_BRIDGE, success = true } = {}) => ({
  transaction_hash: hash,
  from: { hash: from },
  to: { hash: TO },
  value: wei,
  success,
  type: "call",
  timestamp: new Date(NOW - ago).toISOString().replace("Z", "000Z"),
});

let calls;
let fetch;
let arrivals;
// Blockscout's pages of TO's incoming calls, newest first: `calls` as one, else these, in order.
let pages;

beforeEach(async () => {
  vi.resetModules();
  for (const key of Object.keys(items)) delete items[key];
  hooks.beforeSet = null;
  epoch.now = 1;
  calls = [];
  pages = null;
  fetch = vi.fn(async (url) => {
    if (!pages) return new Response(JSON.stringify({ items: calls, next_page_params: null }));
    const at = Number(new URL(url).searchParams.get("page") ?? 0);
    const next = at + 1 < pages.length ? { page: at + 1, items_count: 50 } : null;
    return new Response(JSON.stringify({ items: pages[at], next_page_params: next }));
  });
  vi.stubGlobal("fetch", fetch);
  arrivals = await import("./bridgeArrival.js");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a deposit to DuskEVM's arrival", () => {
  it("is awaited only for a deposit gone through this week, to a DuskEVM address, on a network with DuskEVM", () => {
    const { awaitingArrival } = arrivals;
    expect(awaitingArrival(deposit("a"), TESTNET, NOW)).toBe(true);
    for (const row of [
      deposit("b", { status: "submitted" }),
      deposit("c", { status: "failed" }),
      deposit("d", { bridgeTo: undefined }),
      deposit("e", { ago: 8 * 24 * 60 * 60_000 }),
      deposit("f", { lux: "0" }),
      { ...deposit("g"), contractId: "11".repeat(32) },
    ]) {
      expect(awaitingArrival(row, TESTNET, NOW)).toBe(false);
    }
    // Mainnet has no DuskEVM: nothing to wait for.
    expect(awaitingArrival(deposit("h", { nodeUrl: MAINNET }), MAINNET, NOW)).toBe(false);
    expect(arrivals.arrivalUrl(MAINNET, L2(1))).toBeNull();
    expect(arrivals.arrivalUrl(TESTNET, L2(1))).toBe(`https://explorer.testnet.evm.dusk.network/tx/${L2(1)}`);
  });

  it("is the L2 bridge's payment of its amount to its recipient after it, asked once a recipient, and kept", async () => {
    const { arrivalOf, checkArrivals } = arrivals;
    calls = [
      // Newest first, as Blockscout lists them: another sender's, another amount, one from before the deposit.
      call(L2(5), { from: "0x1111111111111111111111111111111111111111" }),
      call(L2(4), { wei: "1" }),
      call(L2(3), { success: false }),
      call(L2(2)),
      call(L2(1), { ago: 3_600_000 }),
    ];
    const rows = [deposit("a"), deposit("b", { nodeUrl: undefined, status: "submitted" })];
    await expect(checkArrivals(rows, { nodeUrl: TESTNET, now: NOW })).resolves.toBe(1);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([`${API}/addresses/${TO.toLowerCase()}/internal-transactions?filter=to`]);
    expect(arrivalOf(rows[0].hash)).toEqual({ hash: L2(2), at: NOW - 60_000 });
    // Kept under the reset count the check began with.
    expect(items.dusk_bridge_arrivals_v1).toEqual({ epoch: 1, items: { [rows[0].hash]: { hash: L2(2), at: NOW - 60_000 } } });

    // Kept: nothing is asked again, here or in another page.
    await checkArrivals(rows, { nodeUrl: TESTNET, now: NOW });
    vi.resetModules();
    const fresh = await import("./bridgeArrival.js");
    await fresh.loadArrivals();
    expect(fresh.arrivalOf(rows[0].hash)?.hash).toBe(L2(2));
    expect(fresh.awaitingArrival(rows[0], TESTNET, NOW)).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("gives deposits of the same amount to the same recipient one payment each, in order, and waits for the one still on its way", async () => {
    const { arrivalOf, checkArrivals } = arrivals;
    const first = deposit("a", { ago: 600_000 });
    const second = deposit("b", { ago: 300_000 });
    const third = deposit("c", { ago: 120_000 });
    calls = [call(L2(2), { ago: 200_000 }), call(L2(1), { ago: 500_000 })];
    await expect(checkArrivals([third, first, second], { nodeUrl: TESTNET, now: NOW })).resolves.toBe(2);
    expect([arrivalOf(first.hash)?.hash, arrivalOf(second.hash)?.hash, arrivalOf(third.hash)]).toEqual([L2(1), L2(2), null]);

    // Its payment, later: only the third is asked for, and gets the new one.
    calls = [call(L2(3), { ago: 10_000 }), ...calls];
    await expect(checkArrivals([third, first, second], { nodeUrl: TESTNET, now: NOW })).resolves.toBe(1);
    expect(arrivalOf(third.hash)?.hash).toBe(L2(3));
  });

  it("finds nothing, and keeps nothing, when the explorer fails or a wallet reset came meanwhile", async () => {
    const { arrivalOf, checkArrivals, clearArrivals } = arrivals;
    calls = [call(L2(1))];
    fetch.mockResolvedValueOnce(new Response("", { status: 502 }));
    await expect(checkArrivals([deposit("a")], { nodeUrl: TESTNET, now: NOW })).resolves.toBe(0);

    // A reset between the question and the answer.
    fetch.mockImplementationOnce(async () => {
      epoch.now = 2;
      return new Response(JSON.stringify({ items: calls }));
    });
    await expect(checkArrivals([deposit("a")], { nodeUrl: TESTNET, now: NOW })).resolves.toBe(0);
    expect([arrivalOf(deposit("a").hash), items.dusk_bridge_arrivals_v1]).toEqual([null, undefined]);

    // Kept, then forgotten with the wallet.
    await checkArrivals([deposit("a")], { nodeUrl: TESTNET, now: NOW });
    expect(arrivalOf(deposit("a").hash)).not.toBeNull();
    await clearArrivals();
    expect([arrivalOf(deposit("a").hash), items.dusk_bridge_arrivals_v1]).toEqual([null, undefined]);
  });

  it("reads the recipient's calls page after page back to its oldest deposit, so same-amount deposits each get their own", async () => {
    const { arrivalOf, checkArrivals } = arrivals;
    const older = deposit("a", { ago: 3_600_000 });
    const newer = deposit("b", { ago: 300_000 });
    // The newer's payment on the first page, the older's on the second; the third goes back past both, the fourth isn't read.
    pages = [
      [call(L2(2), { ago: 240_000 })],
      [call(L2(1), { ago: 3_540_000 })],
      [call(L2(3), { ago: 7_200_000 })],
      [call(L2(4), { ago: 9_000_000 })],
    ];
    await expect(checkArrivals([newer, older], { nodeUrl: TESTNET, now: NOW })).resolves.toBe(2);
    expect([arrivalOf(older.hash)?.hash, arrivalOf(newer.hash)?.hash]).toEqual([L2(1), L2(2)]);
    expect(fetch.mock.calls.map(([url]) => new URL(url).search)).toEqual([
      "?filter=to",
      "?filter=to&page=1&items_count=50",
      "?filter=to&page=2&items_count=50",
    ]);
  });

  it("matches nothing for a recipient whose calls run past five pages before its oldest deposit", async () => {
    const { arrivalOf, checkArrivals } = arrivals;
    const old = deposit("a", { ago: 3_600_000 });
    // Five pages of later calls, one a payment of the same amount for another deposit; the deposit's own beyond them.
    pages = [
      ...Array.from({ length: 5 }, (_, i) => [call(L2(i + 2), { ago: 60_000 * (i + 1), ...(i === 2 ? {} : { wei: "1" }) })]),
      [call(L2(1), { ago: 3_540_000 })],
    ];
    await expect(checkArrivals([old], { nodeUrl: TESTNET, now: NOW })).resolves.toBe(0);
    expect([fetch.mock.calls.length, arrivalOf(old.hash)]).toEqual([5, null]);
  });

  it("takes a deposit's time from its Dusk block, never the wallet's clock: nothing is asked until the block's time is known", async () => {
    const { arrivalOf, awaitingArrival, checkArrivals } = arrivals;
    // The wallet's clock half an hour behind; an older deposit's payment of the same amount 20 minutes before this one's block.
    const sent = { ...deposit("a"), finalizedAt: undefined, executedAt: NOW - 180_000 - 1_800_000, submittedAt: NOW - 190_000 - 1_800_000 };
    calls = [call(L2(2), { ago: 60_000 }), call(L2(1), { ago: 1_380_000 })];
    expect(awaitingArrival(sent, TESTNET, NOW)).toBe(false);
    await expect(checkArrivals([sent], { nodeUrl: TESTNET, now: NOW })).resolves.toBe(0);
    expect([fetch.mock.calls.length, arrivalOf(sent.hash)]).toEqual([0, null]);
    // Its block's time, from the node: its own payment, after it.
    await expect(checkArrivals([{ ...sent, finalizedAt: NOW - 180_000 }], { nodeUrl: TESTNET, now: NOW })).resolves.toBe(1);
    expect(arrivalOf(sent.hash)?.hash).toBe(L2(2));
  });

  it("is forgotten in every page once a wallet reset anywhere moves the reset count on", async () => {
    const { arrivalOf, checkArrivals, loadArrivals } = arrivals;
    calls = [call(L2(2))];
    await checkArrivals([deposit("a")], { nodeUrl: TESTNET, now: NOW });
    expect(arrivalOf(deposit("a").hash)?.hash).toBe(L2(2));

    // Reset in the background: the count moves on, and the key goes there.
    epoch.now = 2;
    delete items.dusk_bridge_arrivals_v1;
    // This page, open all along, draws again.
    await loadArrivals();
    expect(arrivalOf(deposit("a").hash)).toBeNull();
    // The old wallet's arrivals, still in storage, aren't read either.
    items.dusk_bridge_arrivals_v1 = { epoch: 1, items: { [deposit("a").hash]: { hash: L2(2), at: NOW } } };
    await loadArrivals();
    expect(arrivalOf(deposit("a").hash)).toBeNull();
  });

  it("keeps nothing of a check whose write a wallet reset's clear meets", async () => {
    const { checkArrivals, clearArrivals } = arrivals;
    calls = [call(L2(2))];
    // The check's write, held once it passed its look at the reset count.
    const writing = Promise.withResolvers();
    const go = Promise.withResolvers();
    hooks.beforeSet = async (patch) => {
      if ("dusk_bridge_arrivals_v1" in patch) {
        writing.resolve();
        await go.promise;
      }
    };
    const checking = checkArrivals([deposit("a")], { nodeUrl: TESTNET, now: NOW });
    await writing.promise;
    // A reset: the count moves on, and the arrivals are cleared.
    epoch.now = 2;
    const clearing = clearArrivals();
    go.resolve();
    await Promise.all([checking, clearing]);
    expect(items.dusk_bridge_arrivals_v1).toBeUndefined();
    // No page of the new wallet sees it.
    vi.resetModules();
    const fresh = await import("./bridgeArrival.js");
    await fresh.loadArrivals();
    expect(fresh.arrivalOf(deposit("a").hash)).toBeNull();
  });

  it("is looked for less often the longer nothing changes: 5 seconds, doubled every 6 looks, at most 5 minutes", () => {
    const { arrivalCheckDelay } = arrivals;
    expect([0, 5, 6, 11, 12, 18, 30, 36, 1000].map(arrivalCheckDelay)).toEqual([
      5_000, 5_000, 10_000, 10_000, 20_000, 40_000, 160_000, 300_000, 300_000,
    ]);
  });
});
