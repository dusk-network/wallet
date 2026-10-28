import { networks } from "@dusk-network/networks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// chrome.storage, as a map; the transaction store's reset count.
const items = vi.hoisted(() => ({}));
const epoch = vi.hoisted(() => ({ now: 1 }));
vi.mock("./storage.js", () => ({
  STORAGE_KEYS: { BRIDGE_ARRIVALS: "dusk_bridge_arrivals_v1", SETTINGS: "dusk_settings_v1", NETWORK_STATUS: "dusk_network_status_v1" },
  storage: {
    get: async (key) => ({ [key]: items[key] }),
    set: async (patch) => {
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

// A deposit of `lux` to TO, executed `ago` ms before NOW.
const deposit = (hash, { lux = "500000000", ago = 180_000, ...over } = {}) => ({
  hash: hash.repeat(64).slice(0, 64),
  kind: "contract_call",
  contractId: BRIDGE,
  fnName: "depositETHToWithValue",
  amount: "0",
  deposit: lux,
  bridgeTo: TO,
  status: "executed",
  executedAt: NOW - ago,
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

beforeEach(async () => {
  vi.resetModules();
  for (const key of Object.keys(items)) delete items[key];
  epoch.now = 1;
  calls = [];
  fetch = vi.fn(async (url) => new Response(JSON.stringify({ items: calls, next_page_params: null })));
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
    expect(items.dusk_bridge_arrivals_v1).toEqual({ [rows[0].hash]: { hash: L2(2), at: NOW - 60_000 } });

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

  it("is looked for less often the longer nothing changes: 5 seconds, doubled every 6 looks, at most 5 minutes", () => {
    const { arrivalCheckDelay } = arrivals;
    expect([0, 5, 6, 11, 12, 18, 30, 36, 1000].map(arrivalCheckDelay)).toEqual([
      5_000, 5_000, 10_000, 10_000, 20_000, 40_000, 160_000, 300_000, 300_000,
    ]);
  });
});
