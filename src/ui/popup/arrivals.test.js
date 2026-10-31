import { ETH_BRIDGE_FINALIZED_TOPIC } from "@dusk-network/app-core/bridge";
import { networks } from "@dusk-network/networks";
import { evmAddressOf } from "@dusk-network/networks/duskevm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fakeChain, topicOf, wordOf } from "../../shared/fixtures/chain.js";
import { ACCOUNT, rowOf, TESTNET } from "../../shared/fixtures/rows.js";

// chrome.storage, as a map; the transaction store's reset count.
const items = vi.hoisted(() => ({}));
const epoch = vi.hoisted(() => ({ now: 1 }));
vi.mock("../../shared/storage.js", () => ({
  STORAGE_KEYS: {
    BRIDGE_ARRIVALS: "dusk_bridge_arrivals_v1",
    BRIDGE_ARRIVALS_V2: "dusk_bridge_arrivals_v2",
    SETTINGS: "dusk_settings_v1",
    NETWORK_STATUS: "dusk_network_status_v1",
  },
  storage: {
    get: async (key) => ({ [key]: structuredClone(items[key]) }),
    set: async (patch) => Object.assign(items, structuredClone(patch)),
    remove: async (keys) => {
      for (const key of [keys].flat()) delete items[key];
    },
  },
}));
vi.mock("../../shared/txStore.js", async (importOriginal) => ({ ...(await importOriginal()), getTxEpoch: vi.fn(async () => epoch.now) }));
// The archive, where the account sent nothing to the bridge but the deposits
// in a block the tests' rows say it sent, all on one page.
const listed = vi.hoisted(() => []);
vi.mock("../../shared/activityHistory.js", async (importOriginal) => ({
  ...(await importOriginal()),
  archiveAt: () => ({
    query: async (query) => {
      const range = /fromBlock: (\d+)(?:, toBlock: (\d+))?/.exec(query);
      const json =
        range && !query.includes("pageCount")
          ? listed.filter((entry) => entry.block_height >= Number(range[1]) && entry.block_height <= Number(range[2] ?? Infinity))
          : [];
      return { out: json.length ? { json } : null };
    },
  }),
}));

const evm = networks.testnet.duskEvm;
const BRIDGE = evm.contracts.l1_standard_bridge.contractId;
const TO = "0xAB84EDFFd745AF9420ac74FeC73121FBEE9fC86F";
const L2 = (n) => `0x${String(n).repeat(64).slice(0, 64)}`;
const NOW = Date.parse("2026-10-28T12:00:00Z");
const HEAD = 3_952_000n;

// Activity's row of a deposit of `lux` to TO this wallet sent, in a Dusk block `ago` ms before NOW; the
// archive lists it once it's in a block.
const deposit = (hash, { lux = "500000000", ago = 180_000, ...over } = {}) => {
  const row = rowOf({
    hash: hash.repeat(64).slice(0, 64),
    kind: "contract_call",
    contractId: BRIDGE,
    fnName: "depositETHToWithValue",
    amount: "0",
    deposit: lux,
    bridgeTo: TO,
    status: "executed",
    blockHeight: "4697290",
    finalizedAt: NOW - ago,
    nodeUrl: TESTNET,
    ...over,
  });
  if (row.status === "executed" && row.blockHeight) {
    listed.push({
      block_height: Number(row.blockHeight),
      events: [{ data: { receiver: BRIDGE, sender: ACCOUNT, value: String(lux) }, reverted: false, target: networks.testnet.contracts.transfer, topic: "deposit" }],
      origin: row.hash,
    });
  }
  return row;
};
// The bridge's payment on DuskEVM of `lux` to TO, in `block`, from the DuskEVM address of ACCOUNT, or `from`.
const payment = (hash, block, { lux = 500_000_000n, from = evmAddressOf(ACCOUNT) } = {}) => ({
  address: evm.predeploys.l2StandardBridge,
  block,
  data: `0x${wordOf(lux * 1_000_000_000n)}${wordOf(0x40)}${wordOf(0)}`,
  hash,
  topics: [ETH_BRIDGE_FINALIZED_TOPIC, topicOf(from), topicOf(TO)],
});

let duskEvm;
let fetch;
let arrivals;
let kept;
// The wallet the account is of: its first public account.
const WALLET = "wallet-of-account";
const look = (rows, at = NOW) => arrivals.checkArrivals(rows, { walletId: WALLET, account: ACCOUNT, nodeUrl: TESTNET, now: at });

beforeEach(async () => {
  vi.resetModules();
  for (const key of Object.keys(items)) delete items[key];
  listed.length = 0;
  epoch.now = 1;
  // DuskEVM: a block every 2 seconds, its newest now.
  duskEvm = fakeChain({ blockMs: 2_000, head: HEAD, headAt: NOW, logs: [], url: evm.rpcUrl });
  fetch = vi.fn(async (url, init) => (duskEvm.answers(url) ? duskEvm.answer(url, init) : Promise.reject(new Error("offline"))));
  vi.stubGlobal("fetch", fetch);
  arrivals = await import("./arrivals.js");
  kept = await import("../../shared/bridgeArrival.js");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a deposit to DuskEVM on its way", () => {
  it("is found on DuskEVM by the bridge's event from the account's DuskEVM address, and kept: nothing is asked for it again, here or in another page", async () => {
    // Another account's payment of the same to TO, then the account's own, a minute ago.
    duskEvm.chain.logs.push(payment(L2(1), HEAD - 45n, { from: `0x${"11".repeat(20)}` }), payment(L2(2), HEAD - 30n));
    const rows = [deposit("a"), deposit("b", { status: "submitted" })];

    await expect(look(rows)).resolves.toBe(1);
    expect(duskEvm.methods()).toContain("eth_getLogs");
    expect(kept.keptArrivals().get(rows[0].hash)).toEqual({ hash: L2(2), at: NOW - 60_000 });
    // Kept under the reset count the look began with.
    expect(items.dusk_bridge_arrivals_v2).toEqual({ epoch: 1, wallets: { [WALLET]: { [rows[0].hash]: { hash: L2(2), at: NOW - 60_000 } } } });

    duskEvm.asked.length = 0;
    await expect(look(rows)).resolves.toBe(0);
    vi.resetModules();
    const page = await import("../../shared/bridgeArrival.js");
    await page.loadArrivals(WALLET);
    expect([duskEvm.methods(), page.keptArrivals().get(rows[0].hash)?.hash, page.awaitingArrival(rows[0], TESTNET, NOW)]).toEqual([[], L2(2), false]);
  });

  it("is looked for again from where the last look stopped, until it's there", async () => {
    const row = deposit("a", { ago: 30_000 });

    await expect(look([row])).resolves.toBe(0);
    expect(kept.keptArrivals().size).toBe(0);

    // Twenty seconds on, the bridge paid it.
    duskEvm.chain.head += 10n;
    duskEvm.chain.headAt += 20_000;
    duskEvm.chain.logs.push(payment(L2(3), HEAD + 6n));
    duskEvm.asked.length = 0;

    await expect(look([row], NOW + 20_000)).resolves.toBe(1);
    expect(duskEvm.asked.find(({ method }) => method === "eth_getLogs")?.params[0].fromBlock).toBe(`0x${(HEAD + 1n).toString(16)}`);
    expect(kept.keptArrivals().get(row.hash)).toEqual({ hash: L2(3), at: NOW + 12_000 });
  });

  it("finds nothing, and keeps nothing, when DuskEVM can't be read", async () => {
    duskEvm.chain.logs.push(payment(L2(2), HEAD - 30n));
    fetch.mockResolvedValue(new Response("", { status: 502 }));

    await expect(look([deposit("a")])).resolves.toBe(0);
    expect([kept.keptArrivals().size, items.dusk_bridge_arrivals_v2]).toEqual([0, undefined]);
  });

  it("takes a deposit's time from its Dusk block, never the wallet's clock: nothing is asked until the block's time is known", async () => {
    // The wallet's clock half an hour behind; the account's payment of the same 20 minutes before this one's block.
    const clock = { executedAt: NOW - 180_000 - 1_800_000, submittedAt: NOW - 190_000 - 1_800_000 };
    duskEvm.chain.logs.push(payment(L2(1), HEAD - 690n), payment(L2(2), HEAD - 30n));
    const sent = deposit("a", { ...clock, finalizedAt: undefined });

    expect(kept.awaitingArrival(sent, TESTNET, NOW)).toBe(false);
    await expect(look([sent])).resolves.toBe(0);
    expect(fetch).not.toHaveBeenCalled();

    // Its block's time, from the node: its own payment, after it.
    await expect(look([deposit("a", clock)])).resolves.toBe(1);
    expect(kept.keptArrivals().get(sent.hash)?.hash).toBe(L2(2));
  });
});
