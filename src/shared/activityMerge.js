// Activity's rows: this wallet's own transactions (txStore.js) with the
// selected account's history from the archive (activityHistory.js) and its
// shielded history, one row per transaction, newest first.
//
// A transaction both know is the chain's: the archive has it, so it is in a
// finalized block, and its outcome, amount, time and fee come from the
// archive. Until its details come, its outcome is unknown, unless the wallet
// saw it go through or fail. The wallet's own record adds what the chain
// doesn't say, such as the .dusk name typed for the recipient, the site that
// asked or the token sent, and the amount it meant to send when it didn't go
// through. Until the archive has it, the wallet's record shows it, pending
// or not.

import { TX_KIND } from "./constants.js";

// What the wallet's record of a transaction adds to the chain's.
const LOCAL_ONLY = ["toName", "origin", "asset", "payment", "ownerProfileIndex", "submittedAt", "pendingNullifiers", "reservationStatus"];

const lower = (hash) => String(hash ?? "").toLowerCase();

/**
 * A synced history entry as an Activity row, in the shape of the wallet's own
 * records (`amount`, `to`, `status`, …).
 * @param {object} entry - from activityHistory.readActivity
 * @param {{ nodeUrl?: string }} [ctx]
 */
export function historyRow(entry, { nodeUrl } = {}) {
  // A call this account made reads as a transfer until its call data comes
  // with its details; its value sent to itself moved nothing.
  const callData = entry.kind === TX_KIND.TRANSFER && entry.direction !== "in" && Boolean(entry.contractId && entry.fnName);
  const self = callData && entry.direction === "self";
  const kind = callData ? TX_KIND.CONTRACT_CALL : entry.kind;
  const direction = self ? "out" : entry.direction;
  const amount = self ? "0" : entry.value?.toString?.() ?? String(entry.value ?? "0");
  const call = kind === TX_KIND.CONTRACT_CALL;
  return {
    hash: lower(entry.hash),
    source: "archive",
    nodeUrl,
    privacy: "public",
    kind,
    direction,
    // Final on chain, but its outcome is unknown until its details come.
    success: entry.success ?? null,
    status: entry.success === true ? "executed" : entry.success === false ? "failed" : "unknown",
    error: entry.success === false ? entry.error : undefined,
    amount,
    counterparty: entry.counterparty ?? null,
    to: direction === "out" && !call ? entry.counterparty ?? undefined : undefined,
    from: direction === "in" ? entry.counterparty ?? undefined : undefined,
    contractId: entry.contractId ?? (call ? entry.counterparty ?? undefined : undefined),
    fnName: entry.fnName,
    deposit: call && amount !== "0" ? amount : undefined,
    memo: entry.memo || undefined,
    timestamp: entry.timestamp ?? undefined,
    blockHeight: entry.blockHeight,
    blockHash: entry.blockHash,
    feePaid: entry.fee != null ? entry.fee.toString() : undefined,
    gasSpent: entry.gasSpent,
    gasPrice: entry.gasPrice,
    gasLimit: entry.gasLimit,
    detailsAt: entry.detailsAt,
  };
}

/**
 * @param {{
 *   local?: object[], history?: object[], shielded?: object[],
 *   profileIndex?: number, nodeUrl?: string,
 *   names?: Map<string, string|null>,
 *   estimateTime?: (blockHeight: number) => number|undefined,
 * }} input - `local`: the wallet's records on this network (the overview's
 *   `txs`); `history`: the selected account's synced entries; `shielded`:
 *   rows of its shielded history; `names`: counterparties' verified names;
 *   `estimateTime`: a time for an entry not looked up yet, to sort it.
 * @returns {object[]}
 */
export function mergeActivity({ local = [], history = [], shielded = [], profileIndex, nodeUrl, names, estimateTime } = {}) {
  const rows = new Map();
  for (const entry of history) {
    const row = historyRow(entry, { nodeUrl });
    if (row.hash) rows.set(row.hash, row);
  }
  // The shielded side of a shield or unshield is the public row's, with the
  // fee the shielded side paid.
  for (const row of shielded) {
    const hash = lower(row?.hash);
    if (!hash) continue;
    const known = rows.get(hash);
    if (!known) rows.set(hash, { ...row, hash });
    else if (known.feePaid === undefined && row.feePaid !== undefined) rows.set(hash, { ...known, feePaid: row.feePaid });
  }
  for (const tx of local) {
    // The selected profile's own; a record without a profile is shown too.
    const idx = tx?.profileIndex;
    if (idx !== undefined && idx !== null && profileIndex !== undefined && Number(idx) !== Number(profileIndex)) continue;
    const hash = lower(tx?.hash);
    if (!hash) continue;
    const known = rows.get(hash);
    if (!known) {
      rows.set(hash, { ...tx, hash, source: "local" });
      continue;
    }
    const extra = Object.fromEntries(LOCAL_ONLY.filter((k) => tx[k] !== undefined).map((k) => [k, tx[k]]));
    // The chain's outcome when it is known (a shielded history row's is);
    // else the one the wallet saw, if it saw one; else unknown: final, its
    // outcome still to be looked up.
    const final = typeof known.success === "boolean" || (known.source === "shielded" && ["executed", "failed"].includes(known.status));
    const seen = tx.status === "executed" || tx.status === "failed";
    const outcome = final
      ? { status: known.status, error: known.error }
      : seen
      ? { status: tx.status, error: tx.error }
      : { status: "unknown", error: undefined };
    // Unless it went through, its value didn't move on chain: the amount it
    // was sent with shows what stayed in the wallet.
    const intent =
      final && known.status === "executed" ? {} : Object.fromEntries(["amount", "deposit"].filter((k) => tx[k] != null).map((k) => [k, tx[k]]));
    rows.set(hash, {
      ...known,
      ...extra,
      ...intent,
      ...outcome,
      source: "both",
      // What the wallet sent, when the chain names it less closely: a token
      // transfer is a contract call there.
      kind: tx.kind || known.kind,
      fnName: known.fnName ?? tx.fnName,
      contractId: known.contractId ?? tx.contractId,
      to: known.to ?? tx.to,
      privacy: tx.privacy ?? known.privacy,
      profileIndex: tx.profileIndex,
      gasLimit: known.gasLimit ?? tx.gasLimit,
      gasPrice: known.gasPrice ?? tx.gasPrice,
    });
  }

  const out = [...rows.values()].map((row) => {
    const name = row.counterparty ? names?.get(row.counterparty) : undefined;
    return typeof name === "string" ? { ...row, counterpartyName: name } : row;
  });
  const time = (row) =>
    Number(row.timestamp ?? row.finalizedAt ?? row.submittedAt) ||
    (Number.isFinite(row.blockHeight) ? Number(estimateTime?.(row.blockHeight)) || 0 : 0);
  return out.sort(
    (a, b) =>
      time(b) - time(a) ||
      (Number(b.blockHeight) || 0) - (Number(a.blockHeight) || 0) ||
      (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0)
  );
}
