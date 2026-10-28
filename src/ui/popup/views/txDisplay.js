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

// Chain errors with a plain meaning, in the words Activity uses. The raw
// error stays under a transaction's Technical details.
const KNOWN_ERRORS = [
  [/phoenix is not enabled/i, "Shielded transactions are paused on the network."],
  [/\bout\s*of\s*gas\b|\bOutOfGas\b/i, "It ran out of gas. A higher gas limit lets it finish."],
  [/contract does not exist|\bDoesNotExist\b/i, "The contract it called isn't on this network."],
];

/**
 * A known chain error in plain words, or "" for one without them.
 * @param {string} error - as the chain or the watcher gave it
 * @returns {string}
 */
export function txErrorText(error) {
  const raw = String(error ?? "");
  return KNOWN_ERRORS.find(([re]) => re.test(raw))?.[1] ?? "";
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
