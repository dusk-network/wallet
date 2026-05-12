import { TX_KIND } from "../../../shared/constants.js";

export function txStatusLabel(status) {
  const s = String(status ?? "").toLowerCase();
  if (s === "executed") return "Executed";
  if (s === "failed") return "Failed during execution";
  if (s === "mempool") return "In mempool";
  if (s === "removed") return "Removed from mempool";
  if (s === "unknown") return "Unknown";
  if (s === "submitted") return "Pending";
  return s ? s.slice(0, 1).toUpperCase() + s.slice(1) : "Pending";
}

export function txActivityStatusLabel(status) {
  const s = String(status ?? "").toLowerCase();
  if (s === "executed") return "Finalized";
  return txStatusLabel(status);
}

export function txStatusTone(status) {
  const s = String(status ?? "").toLowerCase();
  if (s === "executed") return "ok";
  if (s === "failed") return "bad";
  return "pending";
}

export function transferRailLabel(tx) {
  const privacy = String(tx?.privacy ?? "").toLowerCase();
  if (privacy === "shielded") return "Shielded (Phoenix)";
  if (privacy === "public") return "Public (Moonlight)";
  return "Transfer";
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

export function txKindRailLabel(tx) {
  const kind = String(tx?.kind ?? "").toLowerCase();
  if (kind === TX_KIND.TRANSFER) return transferRailLabel(tx);
  return "";
}
