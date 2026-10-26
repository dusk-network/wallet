import { describe, expect, it } from "vitest";

import fixture from "./fixtures/activity-testnet.json";
import { activityEntry, parseHistoryEntry } from "./activityHistory.js";
import { historyRow, mergeActivity } from "./activityMerge.js";

const [A, B] = Object.keys(fixture.accounts);
const NODE = fixture.nodeUrl;
const STORE = "4e2de1ed4f1fd53de83f4809a75367301c7645a546030fa199aff804e6854199";

// A's history as readActivity gives it: parsed entries with their details.
function entry(account, height) {
  const raw = [...fixture.accounts[account].sender, ...fixture.accounts[account].receiver].find((e) => e.block_height === height);
  const parsed = parseHistoryEntry(account, raw);
  const tx = fixture.details[parsed.hash];
  return activityEntry({
    ...parsed,
    value: parsed.value.toString(),
    timestamp: tx.blockTimestamp * 1000,
    success: !tx.err,
    error: tx.err ?? undefined,
    fee: String(tx.gasSpent * tx.tx.gasPrice),
    fnName: tx.tx.callData?.fnName,
    contractId: tx.tx.callData?.contractId,
    detailsAt: 1,
  });
}

const received = () => entry(A, 4657992);
const registered = () => entry(A, 4658012);

describe("historyRow", () => {
  it("gives a received transfer its sender, and a call its contract and deposit", () => {
    expect(historyRow(received(), { nodeUrl: NODE })).toMatchObject({
      kind: "transfer",
      direction: "in",
      status: "executed",
      amount: "1000000000000",
      from: received().counterparty,
      to: undefined,
      privacy: "public",
      source: "archive",
    });
    expect(historyRow(registered())).toMatchObject({
      kind: "contract_call",
      direction: "out",
      to: undefined,
      contractId: STORE,
      fnName: "register",
      deposit: "100000000000",
      feePaid: "2897558",
    });
  });

  it("marks a failed transaction failed with its error", () => {
    const failed = entry(B, 3407780);
    expect(historyRow(failed)).toMatchObject({ status: "failed", error: "Panic: DRC20Phoenix: invalid proof" });
  });
});

describe("mergeActivity", () => {
  it("replaces the wallet's pending record with the final entry, keeping the name typed for the recipient", () => {
    const pending = {
      hash: registered().hash,
      kind: "contract_call",
      status: "submitted",
      profileIndex: 0,
      origin: "https://app.example",
      toName: "shpongle.dusk",
      submittedAt: 1_792_687_500_000,
    };
    const [row] = mergeActivity({ local: [pending], history: [registered()], profileIndex: 0 });
    expect(row).toMatchObject({
      source: "both",
      status: "executed",
      amount: "100000000000",
      timestamp: 1_792_687_511_000,
      toName: "shpongle.dusk",
      origin: "https://app.example",
      profileIndex: 0,
    });
  });

  it("keeps the wallet's own sends the archive doesn't have yet, shielded ones included, newest first", () => {
    const local = [
      { hash: "aa".repeat(32), kind: "transfer", privacy: "public", status: "mempool", submittedAt: 1_792_700_000_000, profileIndex: 0 },
      { hash: "bb".repeat(32), kind: "transfer", privacy: "shielded", status: "executed", submittedAt: 1_700_000_000_000, profileIndex: 0 },
    ];
    const rows = mergeActivity({ local, history: [registered(), received()], profileIndex: 0 });
    expect(rows.map((r) => [r.hash.slice(0, 4), r.source, r.status])).toEqual([
      ["aaaa", "local", "mempool"],
      [registered().hash.slice(0, 4), "archive", "executed"],
      [received().hash.slice(0, 4), "archive", "executed"],
      ["bbbb", "local", "executed"],
    ]);
  });

  it("shows the selected profile's own records, and records without a profile", () => {
    const local = [
      { hash: "aa".repeat(32), status: "submitted", submittedAt: 3, profileIndex: 1 },
      { hash: "bb".repeat(32), status: "submitted", submittedAt: 2, profileIndex: 0 },
      { hash: "cc".repeat(32), status: "submitted", submittedAt: 1 },
    ];
    expect(mergeActivity({ local, profileIndex: 0 }).map((r) => r.hash.slice(0, 2))).toEqual(["bb", "cc"]);
    // Locked: every profile's.
    expect(mergeActivity({ local }).map((r) => r.hash.slice(0, 2))).toEqual(["aa", "bb", "cc"]);
  });

  it("names counterparties only with a verified name", () => {
    const names = new Map([[received().counterparty, "faucet.dusk"]]);
    const other = entry(A, 4655845);
    names.set(other.counterparty, null);
    const rows = mergeActivity({ history: [received(), other], names });
    expect(rows.map((r) => r.counterpartyName)).toEqual(["faucet.dusk", undefined]);
  });

  it("keeps one row for a shield or unshield both histories have", () => {
    const shield = entry(B, 2517213);
    const shielded = [{ hash: shield.hash.toUpperCase(), kind: "shield", privacy: "shielded", source: "shielded" }];
    const rows = mergeActivity({ history: [shield], shielded });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "archive", kind: "shield", privacy: "public" });
  });

  it("sorts entries not looked up yet by the time their height gives", () => {
    const later = { ...received(), timestamp: null, detailsAt: undefined, blockHeight: 4_687_000, hash: "dd".repeat(32) };
    const rows = mergeActivity({
      history: [received(), later],
      local: [{ hash: "ee".repeat(32), status: "submitted", submittedAt: 1_792_000_000_000 }],
      estimateTime: (h) => 1_792_979_099_000 - (4_687_170 - h) * 10_000,
    });
    expect(rows.map((r) => r.hash.slice(0, 2))).toEqual(["dd", received().hash.slice(0, 2), "ee"]);
  });
});
