import { describe, expect, it } from "vitest";

import fixture from "./fixtures/activity-testnet.json";
import { activityEntry, parseHistoryEntry } from "./activityHistory.js";
import { historyRow, mergeActivity } from "./activityMerge.js";

const [A, B, C] = Object.keys(fixture.accounts);
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

  it("leaves an entry whose outcome isn't looked up yet unknown, not executed", () => {
    const unknown = { ...received(), success: null, timestamp: null, detailsAt: undefined };
    expect(historyRow(unknown)).toMatchObject({ status: "unknown", success: null });
  });

  it("marks a failed transaction failed with its error", () => {
    const failed = entry(B, 3407780);
    expect(historyRow(failed)).toMatchObject({ status: "failed", error: "Panic: DRC20Phoenix: invalid proof" });
  });

  it("reads a call that sent its value to its own account as the call it was, once its call data came", () => {
    // Derived: A's register call as it would read had it sent 5 DUSK to itself.
    const call = activityEntry({ ...registered(), direction: "self", kind: "transfer", counterparty: A, value: "5000000000", payer: true });
    expect(historyRow(call)).toMatchObject({ kind: "contract_call", direction: "out", amount: "0", contractId: STORE, fnName: "register" });
    expect(historyRow(call).to).toBeUndefined();
    expect(historyRow(call).deposit).toBeUndefined();
    // Before its details, it is the transfer it reads as.
    expect(historyRow({ ...call, contractId: undefined, fnName: undefined })).toMatchObject({ kind: "transfer", direction: "self" });
  });
});

describe("a deposit to DuskEVM from the chain", () => {
  it("keeps the DuskEVM address its call paid, which the wallet's own record of it may lack", async () => {
    const deposit = (await import("./fixtures/duskevm-deposit-history.json")).default;
    const kept = activityEntry({ ...parseHistoryEntry(deposit.account, deposit.entry), value: "500000000", detailsAt: 1, success: true, bridgeTo: deposit.recipient });
    expect(historyRow(kept)).toMatchObject({ kind: "contract_call", deposit: "500000000", bridgeTo: deposit.recipient });
    const local = { hash: kept.hash, kind: "contract_call", status: "submitted", profileIndex: 0, deposit: "500000000" };
    const [row] = mergeActivity({ local: [local], history: [kept], profileIndex: 0 });
    expect(row).toMatchObject({ source: "both", bridgeTo: deposit.recipient });
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
      bridgeTo: "0x5A3d8e1B7c2f4A6b9e0D1C3f5A7b9C2D4e6F8a01",
      registeredName: "shpongle.dusk",
      submittedAt: 1_792_687_500_000,
    };
    // The name a registration registered, read from its call by the archive's details or the wallet.
    expect(historyRow({ ...registered(), registeredName: "shpongle.dusk" }).registeredName).toBe("shpongle.dusk");
    const [row] = mergeActivity({ local: [pending], history: [registered()], profileIndex: 0 });
    expect(row).toMatchObject({
      source: "both",
      status: "executed",
      amount: "100000000000",
      timestamp: 1_792_687_511_000,
      toName: "shpongle.dusk",
      origin: "https://app.example",
      // Where a deposit to DuskEVM pays: the chain has it only in the call's bytes.
      bridgeTo: "0x5A3d8e1B7c2f4A6b9e0D1C3f5A7b9C2D4e6F8a01",
      registeredName: "shpongle.dusk",
      profileIndex: 0,
    });
  });

  it("takes a row the archive has as final: the outcome the wallet saw, else unknown until its details come", () => {
    const unknown = { ...registered(), success: null, detailsAt: undefined };
    for (const [status, shown] of [
      ["submitted", "unknown"],
      ["mempool", "unknown"],
      ["unknown", "unknown"],
      ["removed", "unknown"],
      ["failed", "failed"],
      ["executed", "executed"],
    ]) {
      const local = { hash: unknown.hash, kind: "contract_call", status, error: status === "failed" ? "OutOfGas" : undefined, profileIndex: 0 };
      const [row] = mergeActivity({ local: [local], history: [unknown], profileIndex: 0 });
      expect(row).toMatchObject({ source: "both", status: shown, error: shown === "failed" ? "OutOfGas" : undefined, detailsAt: undefined });
    }
  });

  it("takes a shielded row's outcome over the wallet's own that stopped waiting", () => {
    const hash = "ab".repeat(32);
    const local = { hash, kind: "transfer", privacy: "shielded", status: "unknown", recoveryReason: "watcher_timeout", amount: "5", profileIndex: 0 };
    for (const [status, error] of [["executed", undefined], ["failed", "Panic: out of gas"]]) {
      const shielded = [{ hash, source: "shielded", privacy: "shielded", kind: "transfer", direction: "out", amount: "5", feePaid: "1", status, error, blockHeight: 9 }];
      const [row] = mergeActivity({ local: [local], shielded, profileIndex: 0 });
      expect(row).toMatchObject({ source: "both", status, error });
    }
  });

  it("keeps the amount a send meant to move when it didn't go through, and the chain's when it did", () => {
    // B's call that failed on chain: its value never moved.
    const failed = entry(B, 3407780);
    const local = { hash: failed.hash, kind: "contract_call", fnName: "transfer_private", amount: "0", deposit: "2000000000", status: "failed", profileIndex: 0 };
    const [row] = mergeActivity({ local: [local], history: [failed], profileIndex: 0 });
    expect(row).toMatchObject({ source: "both", status: "failed", deposit: "2000000000" });
    // A's register went through: the chain's deposit stands.
    const done = registered();
    const [ok] = mergeActivity({ local: [{ ...local, hash: done.hash, deposit: "1" }], history: [done], profileIndex: 0 });
    expect(ok).toMatchObject({ status: "executed", deposit: "100000000000" });
  });

  it("gives an unshield the fee its shielded side paid", () => {
    // C's unshield at 3602438: the fee was paid from the shielded notes.
    const unshield = entry(C, 3602438);
    expect(unshield.fee).toBeNull();
    const shielded = [{ hash: unshield.hash, kind: "unshield", direction: "out", privacy: "shielded", source: "shielded", feePaid: "12429102" }];
    const [row] = mergeActivity({ history: [unshield], shielded });
    expect(row).toMatchObject({ kind: "unshield", direction: "in", source: "archive", feePaid: "12429102" });
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
