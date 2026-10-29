import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import fixture from "./fixtures/activity-testnet.json";
import { fakeArchive } from "./fixtures/fakeArchive.js";
import { mergeActivity } from "./activityMerge.js";

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
    // The head, four windows, the details of the four entries found, at once,
    // and the arguments of the name reservation once its contract is known.
    expect(node.log.map((l) => (l.query.includes("lastBlockPair") ? "head" : l.query.includes("tx(hash:") ? "details" : "window"))).toEqual([
      "head",
      "window",
      "window",
      "details",
      "window",
      "window",
      "details",
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
    // One request has the head and everything above the kept heights; one more has the new entries' details,
    // and a last one the name reservation's arguments, once its contract is known.
    expect(refresh).toHaveLength(3);
    expect(refresh[0].query).toContain("pair: lastBlockPair { json }");
    expect(refresh[0].query).toContain(`moonlightHistory(sender: "${A}", fromBlock: ${4_656_000 - history.FINALITY_MARGIN + 1}, maxCount: 50)`);
    expect(refresh[0].query).not.toContain("toBlock");
    expect(refresh[1].query.match(/tx\(hash:/g)).toHaveLength(3);
    expect(refresh[2].query.match(/tx\(hash:/g)).toHaveLength(1);
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

describe("a wallet reset during a sync", () => {
  it("keeps nothing the sync reads after it", async () => {
    const node = fakeArchive();
    let release;
    const held = new Promise((resolve) => (release = resolve));
    let reached;
    const atWindow = new Promise((resolve) => (reached = resolve));
    node.before = async (query) => {
      if (query.includes("toBlock")) {
        reached();
        await held;
      }
    };
    const run = sync(A);
    await atWindow;
    await store.clearActivityStore();
    release();
    await expect(run).rejects.toBeInstanceOf(store.StaleActivityError);
    expect(await kept(A)).toEqual([]);
    expect(await store.getActivityMeta(store.activityOwnerKey("testnet", A))).toBeNull();
  });

  it("keeps nothing when the node's chain changed too", async () => {
    const node = fakeArchive();
    await sync(A);
    // The next run's first request waits; the wallet is reset meanwhile, and
    // the node answers for another chain.
    const held = Promise.withResolvers();
    const reached = Promise.withResolvers();
    node.before = async () => {
      reached.resolve();
      await held.promise;
    };
    const run = sync(A);
    await reached.promise;
    await store.clearActivityStore();
    node.before = null;
    node.genesis = "ff".repeat(32);
    held.resolve();
    await expect(run).rejects.toBeInstanceOf(store.StaleActivityError);
    expect(await kept(A)).toEqual([]);
    expect(await store.getActivityMeta(store.activityOwnerKey("testnet", A))).toBeNull();
  });
});

describe("a block with more than a page of the account's entries", () => {
  // Derived: 450 transfers from B in one block, each a copy of one recorded
  // entry with its own hash, more than one run's requests can page through.
  const H = 4_600_000;
  const template = entriesOf(B, "out").find((e) => e.events.length === 1);
  const crowded = Array.from({ length: 450 }, (_, i) => ({
    ...template,
    block_height: H,
    origin: i.toString(16).padStart(64, "0"),
  }));

  it("carries on paging it where the last run stopped", async () => {
    const node = fakeArchive({ accounts: { [B]: { sender: crowded, receiver: [] } }, finalized: H + 20 });
    for (let run = 0; run < 4; run++) await sync(B);
    const rows = await kept(B);
    expect(rows).toHaveLength(450);
    const read = await history.readActivity({ nodeUrl: NODE, account: B, limit: 1_000 });
    expect(read.complete).toBe(true);
    // No page of the block was read twice: each run carried on where the last stopped.
    const pages = node.historyQueries().map((l) => l.query.match(/pageCount: (\d+)/)?.[1]).filter(Boolean);
    expect(pages.length).toBeGreaterThan(0);
    expect(new Set(pages).size).toBe(pages.length);
  });
});

describe("a node without the archive", () => {
  it("is asked nothing for an hour after its first refusal, then again", async () => {
    const node = fakeArchive();
    node.archive = false;
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000_000_000);

    await expect(sync(A)).rejects.toBeInstanceOf(history.NoArchiveError);
    // The head, then the first window it refused.
    expect(node.log).toHaveLength(2);
    await expect(sync(A)).rejects.toBeInstanceOf(history.NoArchiveError);
    expect(node.log).toHaveLength(2);
    // Nothing kept to show, and the console told once.
    expect((await history.readActivity({ nodeUrl: NODE, account: A })).entries).toEqual([]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    history.noteActivityUnavailable(new history.NoArchiveError(NODE));
    history.noteActivityUnavailable(new history.NoArchiveError(NODE));
    expect(warn).toHaveBeenCalledTimes(1);

    // An hour on, it is asked again: now with the archive.
    now.mockReturnValue(1_000_000_000 + history.NO_ARCHIVE_RETRY_MS);
    node.archive = true;
    await sync(A);
    expect((await history.readActivity({ nodeUrl: NODE, account: A })).entries).toHaveLength(4);
  });

  it("keeps the refusal to that node", async () => {
    await store.putArchiveRefusal("https://testnet.nodes.dusk.network", Date.now());
    await expect(history.assertArchive("https://testnet.nodes.dusk.network")).rejects.toBeInstanceOf(history.NoArchiveError);
    await expect(history.assertArchive("https://my.archive.example")).resolves.toBeUndefined();
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

// Recorded on Testnet: alice.dusk's deposit of 0.5 DUSK to DuskEVM.
describe("a deposit to DuskEVM", async () => {
  const deposit = (await import("./fixtures/duskevm-deposit-history.json")).default;
  const { duskEvmContracts } = await import("@dusk-network/networks/duskevm");
  const HASH = deposit.entry.origin;
  const H = deposit.entry.block_height;
  const accounts = { [deposit.account]: { sender: [deposit.entry], receiver: [] } };
  const details = { ...fixture.details, ...deposit.details };

  it("keeps the DuskEVM address it paid, read from its call, whose arguments are asked of it alone", async () => {
    const node = fakeArchive({ accounts: { ...fixture.accounts, ...accounts }, details, finalized: H + 100 });
    await history.syncActivity({ nodeUrl: NODE, account: deposit.account });
    const { entries } = await history.readActivity({ nodeUrl: NODE, account: deposit.account });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ hash: HASH, counterparty: duskEvmContracts(2).bridge, success: true, bridgeTo: deposit.recipient });
    const asked = node.detailQueries().map((l) => l.query).join("\n");
    expect(asked).toContain(`tx(hash: "${HASH}") { err gasSpent blockHash blockTimestamp tx { gasPrice gasLimit callData { contractId fnName data } } }`);

    // Another account's transfers and calls: no arguments asked.
    node.log.length = 0;
    await sync(B);
    expect(node.detailQueries().length).toBeGreaterThan(0);
    expect(node.detailQueries().some((l) => /callData \{[^}]*\bdata\b/.test(l.query))).toBe(false);
  });

  it("reads it once for a deposit kept before the wallet read them, and not again when its call names none", async () => {
    const node = fakeArchive({ accounts, details, finalized: H + 100 });
    // Kept with its details, but not its DuskEVM address.
    const kept = { ...history.parseHistoryEntry(deposit.account, deposit.entry), detailsAt: 1, success: true };
    expect(history.needsDetails(kept, NODE)).toBe(true);
    const ownerKey = store.activityOwnerKey("testnet", deposit.account);
    await store.commitActivityStep(ownerKey, [{ ...kept, value: kept.value.toString() }], () => ({ covered: [[0, H + 90]], target: H + 90 }));
    await history.fillActivityDetails({ nodeUrl: NODE, account: deposit.account, entries: [kept] });
    const [entry] = await store.listActivityEntries(ownerKey);
    expect(entry.bridgeTo).toBe(deposit.recipient);
    expect(history.needsDetails(entry, NODE)).toBe(false);

    // A deposit call that doesn't decode: looked up, and left so.
    const broken = { ...details, [HASH]: { ...details[HASH], tx: { ...details[HASH].tx, callData: { ...details[HASH].tx.callData, data: "00ff" } } } };
    fakeArchive({ accounts, details: broken, finalized: H + 100 });
    const read = await history.fetchTxDetails(NODE, [HASH], { nodeUrl: NODE, args: new Set([HASH]) });
    expect(read.get(HASH).bridgeTo).toBeNull();
    expect(history.needsDetails({ ...kept, bridgeTo: null }, NODE)).toBe(false);
    expect(node.detailQueries()).toHaveLength(1);
  });

  it("needs its details while it has none, or its address isn't read, on a network with the bridge", () => {
    const bridge = duskEvmContracts(2).bridge;
    expect(history.needsDetails({ counterparty: "other" }, NODE)).toBe(true);
    expect(history.needsDetails({ detailsAt: 1, counterparty: "other" }, NODE)).toBe(false);
    expect(history.needsDetails({ detailsAt: 1, counterparty: bridge }, NODE)).toBe(true);
    expect(history.needsDetails({ detailsAt: 1, contractId: bridge }, NODE)).toBe(true);
    expect(history.needsDetails({ detailsAt: 1, counterparty: bridge, bridgeTo: null }, NODE)).toBe(false);
    // Mainnet has no bridge yet.
    expect(history.needsDetails({ detailsAt: 1, counterparty: bridge }, "https://nodes.dusk.network")).toBe(false);
  });
});

// Recorded on Testnet: A's registration of shpongle.dusk, and its reservation before it, with their calls' arguments.
describe("a .dusk name's registration", async () => {
  const { calls, reservations } = (await import("./fixtures/dusk-domains-registrations.json")).default;
  const call = calls.find((c) => c.name === "shpongle.dusk");
  const reservation = reservations.find((c) => c.name === "shpongle.dusk");
  const withData = (all, { hash, data }) => ({
    ...all,
    [hash]: { ...all[hash], tx: { ...all[hash].tx, callData: { ...all[hash].tx.callData, data } } },
  });
  const details = withData(withData(fixture.details, call), reservation);
  // The hashes whose call arguments a query asked for.
  const withArgs = (node) =>
    node.detailQueries().flatMap((l) => [...l.query.matchAll(/tx\(hash: "([0-9a-f]{64})"\)[^}]*\{ contractId fnName data \}/g)].map((m) => m[1]));

  it("keeps the name it registered, and the reservation both calls name, their arguments asked of them alone", async () => {
    const node = fakeArchive({ details });
    await sync(A);
    const { entries } = await history.readActivity({ nodeUrl: NODE, account: A });
    expect(entries.find((e) => e.hash === call.hash)).toMatchObject({
      fnName: "register",
      registeredName: "shpongle.dusk",
      reservation: reservation.data,
    });
    expect(entries.find((e) => e.hash === reservation.hash)).toMatchObject({ fnName: "commit", reservation: reservation.data });
    // The registration's with its details; the reservation's once its contract is known.
    expect(withArgs(node)).toEqual([call.hash, reservation.hash]);
    // Activity names the reservation by the name its registration revealed.
    const rows = mergeActivity({ history: entries, nodeUrl: NODE });
    expect(rows.find((r) => r.hash === reservation.hash).reservedName).toBe("shpongle.dusk");
  });

  it("reads it once for a registration kept before the wallet read them, and not again when its call doesn't read", async () => {
    const entry = entriesOf(A, "out").find((e) => e.origin === call.hash);
    const kept = { ...history.parseHistoryEntry(A, entry), detailsAt: 1, success: true, contractId: STORE, fnName: "register" };
    expect(history.needsDetails(kept, NODE)).toBe(true);
    // A reservation kept before the wallet read reservations, once.
    expect(history.needsDetails({ ...kept, fnName: "commit" }, NODE)).toBe(true);
    expect(history.needsDetails({ ...kept, fnName: "commit", reservation: null }, NODE)).toBe(false);
    const node = fakeArchive({ details: withData(details, { hash: call.hash, data: "00ff" }) });
    const read = await history.fetchTxDetails(NODE, [call.hash], { nodeUrl: NODE, account: A, names: new Set([call.hash]) });
    expect([read.get(call.hash).registeredName, read.get(call.hash).reservation]).toEqual([null, null]);
    expect(history.needsDetails({ ...kept, registeredName: null, reservation: null }, NODE)).toBe(false);
    expect(withArgs(node)).toEqual([call.hash]);
  });

  it("matches a registration to its reservation only for the account that sent it", async () => {
    fakeArchive({ details });
    const read = await history.fetchTxDetails(NODE, [call.hash, reservation.hash], { nodeUrl: NODE, account: B, names: new Set([call.hash, reservation.hash]) });
    // The reservation's own reads the same; the registration doesn't check out for another account.
    expect([read.get(call.hash).reservation, read.get(reservation.hash).reservation]).toEqual([null, reservation.data]);
  });
});
