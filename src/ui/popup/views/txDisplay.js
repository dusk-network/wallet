/**
 * A status in one word, the same in Activity and a transaction's details:
 * Pending until the network runs it, then Completed or Failed. Dropped (the
 * node took it out of its queue) and Not confirmed (the wallet stopped
 * waiting) are uncertain, so they tone as pending. Unknown is final on chain,
 * its outcome not looked up yet: nothing waits on it, so it tones neutral.
 * @param {string} status
 * @param {{ final?: boolean }} [opts] - `final`: the chain has it, final
 * @returns {"Pending"|"Completed"|"Failed"|"Dropped"|"Not confirmed"|"Unknown"}
 */
export function txStatusWord(status, { final = false } = {}) {
  const s = String(status ?? "").toLowerCase();
  if (s === "executed") return "Completed";
  if (s === "failed") return "Failed";
  if (s === "removed") return "Dropped";
  if (s === "unknown") return final ? "Unknown" : "Not confirmed";
  return "Pending";
}

/** @returns {"ok"|"bad"|"pending"|"neutral"} */
export function txStatusTone(status, { final = false } = {}) {
  const s = String(status ?? "").toLowerCase();
  if (s === "executed") return "ok";
  if (s === "failed") return "bad";
  if (s === "unknown" && final) return "neutral";
  return "pending";
}

export function txRecoveryReasonLabel(reason) {
  const raw = String(reason ?? "").trim();
  if (!raw) return "";

  const key = raw.toLowerCase();
  if (key === "watcher_timeout") {
    return "The wallet did not receive a final network event before the watcher timed out.";
  }
  if (key === "not_found") {
    return "The transaction was not found in the node's chain or mempool response.";
  }
  if (key === "removed_unconfirmed") {
    return "The node reported removal, but the wallet has not confirmed it yet.";
  }
  if (key === "removed") {
    return "The node reported that this transaction was removed from the mempool.";
  }
  if (key === "node_url_missing") {
    return "The wallet could not recheck this transaction because the original node URL is missing.";
  }
  if (key === "reconciliation_unavailable" || /graphql|query|fetch|network|hex|digit/i.test(raw)) {
    return "The wallet could not complete the latest network status check.";
  }

  return raw;
}
