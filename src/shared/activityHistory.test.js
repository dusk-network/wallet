import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import fixture from "./fixtures/activity-testnet.json";
import { fakeArchive } from "./fixtures/fakeArchive.js";

// Recorded on Testnet: A registered a .dusk name and received two transfers;
// B has years of transfers, contract calls, a shield, stake rewards and an
// unstake; Z received an unshield.
const [A, B, Z] = Object.keys(fixture.accounts);
const NODE = fixture.nodeUrl;
const FINALIZED = fixture.head.last_finalized_block[0];
const STORE = "4e2de1ed4f1fd53de83f4809a75367301c7645a546030fa199aff804e6854199";
const DUSK = 1_000_000_000n;

let history;
let store;

beforeEach(async () => {
  // A new database per test, and the modules that opened the last one.
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
  history = await import("./activityHistory.js");
  store = await import("./activityStore.js");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const entriesOf = (account, direction) => fixture.accounts[account][direction === "out" ? "sender" : "receiver"];
const entryAt = (account, height) =>
  [...entriesOf(account, "out"), ...entriesOf(account, "in")].find((e) => e.block_height === height);
const uniqueHashes = (account) =>
  new Set([...entriesOf(account, "out"), ...entriesOf(account, "in")].map((e) => e.origin));

const sync = (account, opts = {}) => history.syncActivity({ nodeUrl: NODE, account, ...opts });
const kept = async (account) => {
  const ownerKey = store.activityOwnerKey("testnet", account);
  return store.listActivityEntries(ownerKey, { limit: 10_000 });
};

describe("parseHistoryEntry", () => {
  const parse = (account, height) => history.parseHistoryEntry(account, entryAt(account, height));

  it("reads a transfer received, with its sender", () => {
    expect(parse(A, 4655845)).toEqual({
      hash: "8e247a33967153b229ce4f45f61e0f14808d8a417c4a4b37eabb269a8eb08e34",
      blockHeight: 4655845,
      direction: "in",
      kind: "transfer",
      counterparty: entryAt(A, 4655845).events[0].data.sender,
      value: 1100n * DUSK,
      memo: "",
      payer: false,
    });
  });

  it("reads a contract call's deposit as what was sent, and a call without one as fee only", () => {
    expect(parse(A, 4658012)).toMatchObject({ direction: "out", kind: "contract_call", value: 100n * DUSK, counterparty: STORE, payer: true });
    expect(parse(A, 4658000)).toMatchObject({ direction: "out", kind: "contract_call", value: 0n, counterparty: null, payer: true });
  });

  it("reads a transfer sent, and one without a receiver as sent to the account itself, with its memo", () => {
    const sent = entriesOf(B, "out").find((e) => e.events.some((ev) => ev.topic === "moonlight" && ev.data.receiver && ev.data.value !== "0"));
    expect(history.parseHistoryEntry(B, sent)).toMatchObject({ direction: "out", kind: "transfer", counterparty: sent.events.at(-1).data.receiver });
    // dusk-core leaves the receiver out when it is the sender.
    expect(parse(B, 2517146)).toMatchObject({ direction: "self", kind: "transfer", value: DUSK, counterparty: B, memo: "extension test" });
  });

  it("reads a shield as sent to the shielded address, and an unshield as received", () => {
    expect(parse(B, 2517213)).toMatchObject({
      direction: "out",
      kind: "shield",
      value: 13_351_700_000n,
      counterparty: "3rTbMbu2ffd3kuUiq766HJBh3eYHpKbwZFZtXLFtadRMFw6dLqxAUr1n5PtAXfb3xnBhGssELCC64cxd4dSYyjEj",
    });
    expect(parse(Z, 3602438)).toMatchObject({ direction: "in", kind: "unshield", value: 8_987_551_049n, counterparty: null, payer: false });
  });

  it("names stake rewards and unstakes from the stake contract's events", () => {
    expect(parse(B, 3412754)).toMatchObject({ direction: "in", kind: "withdraw_reward", value: 1_609_142_758_405_397n });
    expect(parse(B, 4643699)).toMatchObject({ direction: "in", kind: "unstake", value: 500_000n * DUSK });
  });

  it("reads a deposit to the stake contract as a stake", () => {
    // Derived from B's deposit to a contract: the same events, to the stake contract.
    const entry = structuredClone(entryAt(B, 3412903));
    entry.events.find((e) => e.topic === "deposit").data.receiver = history.STAKE_CONTRACT;
    entry.events.push({ target: history.STAKE_CONTRACT, topic: "stake", data: {}, reverted: false });
    expect(history.parseHistoryEntry(B, entry)).toMatchObject({ direction: "out", kind: "stake", value: 1000n * DUSK });
  });

  it("leaves reverted events out", () => {
    // Derived from A's registration: a call that failed after taking its
    // deposit, which the archive flags as reverted, keeps the deposit.
    const entry = structuredClone(entryAt(A, 4658012));
    entry.events.find((e) => e.topic === "deposit").reverted = true;
    expect(history.parseHistoryEntry(A, entry)).toMatchObject({ direction: "out", kind: "contract_call", value: 0n });
  });

  it("refuses entries without a hash or height", () => {
    expect(history.parseHistoryEntry(A, { ...entryAt(A, 4655845), origin: "nope" })).toBeNull();
    expect(history.parseHistoryEntry(A, { ...entryAt(A, 4655845), block_height: -1 })).toBeNull();
  });
});

describe("coverage", () => {
  it("joins touching ranges and finds the highest gap", () => {
    let covered = history.addCoverage([], 100, 200);
    covered = history.addCoverage(covered, 0, 49);
    expect(covered).toEqual([[100, 200], [0, 49]]);
    expect(history.topGap(covered, 300)).toEqual([201, 300]);
    expect(history.topGap(covered, 200)).toEqual([50, 99]);
    covered = history.addCoverage(covered, 50, 99);
    expect(covered).toEqual([[0, 200]]);
    expect(history.topGap(covered, 200)).toBeNull();
    expect(history.shownDownTo([[150, 300], [0, 99]], 300)).toBe(150);
  });
});

describe("syncActivity", () => {
  it("syncs an account from the newest window down, widening while it is sparse", async () => {
    const node = fakeArchive();
    const result = await sync(A);

    const target = FINALIZED - history.FINALITY_MARGIN;
    const windows = node.historyQueries().map((l) => [...l.query.matchAll(/fromBlock: (\d+), toBlock: (\d+)/g)][0].slice(1).map(Number));
    // A day, then each window 8 times wider while it held few entries.
    expect(windows).toEqual([
      [target - 8_639, target],
      [target - 8_640 - 69_119, target - 8_640],
      [target - 77_760 - 552_959, target - 77_760],
      [0, target - 630_720],
    ]);
    // The head, four windows, and the details of the four entries found, at once.
    expect(node.log.map((l) => (l.query.includes("lastBlockPair") ? "head" : l.query.includes("tx(hash:") ? "details" : "window"))).toEqual([
      "head",
      "window",
      "window",
      "details",
      "window",
      "window",
    ]);
    expect(result.meta.covered).toEqual([[0, target]]);

    const read = await history.readActivity({ nodeUrl: NODE, account: A });
    expect(read.complete).toBe(true);
    expect(read.entries.map((e) => [e.blockHeight, e.direction, e.kind, e.value])).toEqual([
      [4658012, "out", "contract_call", 100n * DUSK],
      [4658000, "out", "contract_call", 0n],
      [4657992, "in", "transfer", 1000n * DUSK],
      [4655845, "in", "transfer", 1100n * DUSK],
    ]);
    const [register, commit] = read.entries;
    expect(register).toMatchObject({ success: true, fee: 2_897_558n, fnName: "register", contractId: STORE, timestamp: 1_792_687_511_000 });
    expect(commit).toMatchObject({ success: true, fee: 1_959_593n, fnName: "commit" });
    // A fee is the sender's: none on what the account received.
    expect(read.entries[2].fee).toBeNull();
  });

  it("narrows a window whose page fills, and keeps every entry over the runs that follow", async () => {
    const node = fakeArchive();
    const all = uniqueHashes(B);
    for (let run = 0; run < 6; run++) {
      const before = node.log.length;
      await sync(B);
      const queries = node.log.slice(before);
      expect(queries.filter((l) => !l.query.includes("tx(hash:")).length).toBeLessThanOrEqual(history.RUN_REQUESTS);
      expect(queries.filter((l) => l.query.includes("tx(hash:")).length).toBeLessThanOrEqual(history.RUN_DETAIL_REQUESTS);
      // Whatever is shown is everything at those heights: no gap above the lowest.
      const read = await history.readActivity({ nodeUrl: NODE, account: B, limit: 1_000 });
      const truth = [...all].filter((h) => {
        const e = [...entriesOf(B, "out"), ...entriesOf(B, "in")].find((x) => x.origin === h);
        return e.block_height >= read.coveredTo;
      });
      expect(new Set(read.entries.map((e) => e.hash))).toEqual(new Set(truth));
      if (read.complete) break;
    }
    // Some window filled its page of 50.
    expect(node.historyQueries().some((l) => (l.data.out?.json?.length ?? 0) === history.PAGE)).toBe(true);
    const rows = await kept(B);
    expect(rows.length).toBe(all.size);
    expect(new Set(rows.map((r) => r.hash))).toEqual(all);
    const read = await history.readActivity({ nodeUrl: NODE, account: B, limit: 1_000 });
    expect(read.complete).toBe(true);
    // Heights strictly in order, newest first.
    expect(read.entries.map((e) => e.blockHeight)).toEqual([...read.entries.map((e) => e.blockHeight)].sort((x, y) => y - x));
  });

  it("asks only above the heights it kept on a refresh", async () => {
    const node = fakeArchive({ finalized: 4_656_000 });
    await sync(A);
    expect((await history.readActivity({ nodeUrl: NODE, account: A })).entries.map((e) => e.blockHeight)).toEqual([4655845]);

    node.finalized = FINALIZED;
    const before = node.log.length;
    const result = await sync(A);
    const refresh = node.log.slice(before);
    // One request has the head and everything above the kept heights; one more has the new entries' details.
    expect(refresh).toHaveLength(2);
    expect(refresh[0].query).toContain("pair: lastBlockPair { json }");
    expect(refresh[0].query).toContain(`moonlightHistory(sender: "${A}", fromBlock: ${4_656_000 - history.FINALITY_MARGIN + 1}, maxCount: 50)`);
    expect(refresh[0].query).not.toContain("toBlock");
    expect(refresh[1].query.match(/tx\(hash:/g)).toHaveLength(3);
    expect(result.meta.covered).toEqual([[0, FINALIZED - history.FINALITY_MARGIN]]);
    expect((await history.readActivity({ nodeUrl: NODE, account: A })).entries.map((e) => e.blockHeight)).toEqual([
      4658012, 4658000, 4657992, 4655845,
    ]);
  });

  it("reads entries in the finality margin again without keeping them twice", async () => {
    // 4658012 is above the first refresh's target and read again by the next.
    const node = fakeArchive({ finalized: 4_658_000 });
    await sync(A);
    node.finalized = 4_658_020;
    await sync(A);
    node.finalized = FINALIZED;
    const before = node.detailQueries().length;
    await sync(A);

    const twice = node.historyQueries().filter((l) => l.data.out?.json?.some((e) => e.block_height === 4658012));
    expect(twice).toHaveLength(2);
    const rows = await kept(A);
    expect(rows.filter((r) => r.blockHeight === 4658012)).toHaveLength(1);
    expect(rows).toHaveLength(4);
    // Its details stayed with it: none looked up again.
    expect(node.detailQueries().length).toBe(before);
    expect(rows.find((r) => r.blockHeight === 4658012)).toMatchObject({ fnName: "register" });
  });

  it("stops at its request budget and carries on in the next run", async () => {
    const node = fakeArchive();
    await sync(A, { maxRequests: 2, maxDetailRequests: 0 });
    expect(node.log).toHaveLength(2);
    let read = await history.readActivity({ nodeUrl: NODE, account: A });
    expect(read.complete).toBe(false);
    await sync(A, { maxRequests: 3 });
    read = await history.readActivity({ nodeUrl: NODE, account: A });
    expect(read.entries).toHaveLength(4);
    expect(await kept(A)).toHaveLength(4);
  });

  it("starts over when the node's chain is another one", async () => {
    const node = fakeArchive();
    await sync(A);
    node.genesis = "ff".repeat(32);
    node.finalized = 4_656_000;
    await sync(A);
    const rows = await kept(A);
    expect(rows.map((r) => r.blockHeight)).toEqual([4655845]);
  });
});

describe("fetchRecentActivity", () => {
  it("gives the newest entries with their time and outcome", async () => {
    fakeArchive();
    const entries = await history.fetchRecentActivity({ archiverUrl: NODE, account: B, limit: 3 });
    expect(entries).toHaveLength(3);
    for (const e of entries) {
      expect(Object.keys(e)).toEqual(expect.arrayContaining(["hash", "blockHeight", "timestamp", "direction", "counterparty", "value", "memo", "success"]));
      expect(typeof e.value).toBe("bigint");
    }
    expect(entries[0].blockHeight).toBeGreaterThanOrEqual(entries[1].blockHeight);
  });

  it("keeps giving what it has when the archive is unreachable, and says so once", async () => {
    const node = fakeArchive();
    await sync(A);
    node.down = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = await history.fetchRecentActivity({ archiverUrl: NODE, account: A });
    const second = await history.fetchRecentActivity({ archiverUrl: NODE, account: A });
    expect(first.map((e) => e.blockHeight)).toEqual([4658012, 4658000, 4657992, 4655845]);
    expect(second).toEqual(first);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("gives nothing, without throwing, before any sync worked", async () => {
    const node = fakeArchive();
    node.down = true;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(history.fetchRecentActivity({ archiverUrl: NODE, account: A })).resolves.toEqual([]);
  });
});

describe("fetchTxDetails", () => {
  it("reads outcomes, errors and fees", async () => {
    fakeArchive();
    const failed = "10e446480bd93cd2ae24d221b738ec5cd109951717ca82b092cab0b53f949f00";
    const ok = "8e247a33967153b229ce4f45f61e0f14808d8a417c4a4b37eabb269a8eb08e34";
    const details = await history.fetchTxDetails(NODE, [failed, ok, "00".repeat(32)]);
    expect(details.get(failed)).toMatchObject({ success: false, error: "Panic: DRC20Phoenix: invalid proof", fee: "200000000" });
    expect(details.get(ok)).toMatchObject({ success: true, fee: "1849580", timestamp: 1_792_665_841_000 });
    // A transaction the node doesn't have gets no details.
    expect(details.has("00".repeat(32))).toBe(false);
  });
});

describe("historyArchiverUrl", () => {
  it("reads a network's history from its own node when the archiver is on another network", () => {
    const testnet = "https://testnet.nodes.dusk.network";
    const mainnet = "https://nodes.dusk.network";
    expect(history.historyArchiverUrl({ nodeUrl: testnet, archiverUrl: mainnet })).toBe(testnet);
    expect(history.historyArchiverUrl({ nodeUrl: mainnet, archiverUrl: mainnet })).toBe(mainnet);
    expect(history.historyArchiverUrl({ nodeUrl: "https://my.node", archiverUrl: "https://my.archive" })).toBe("https://my.archive");
    expect(history.historyArchiverUrl({ nodeUrl: testnet })).toBe(testnet);
  });
});
