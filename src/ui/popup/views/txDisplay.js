import { stDuskWorth } from "@dusk-network/app-core/sozu";

import { formatDuskExact } from "../../../shared/amount.js";
import { balance } from "../../components/Balance.js";

/**
 * A status in one word, the same in Activity and a transaction's details, and
 * in the words the Sent screen uses: Confirming once the network has it, until
 * it runs, then Completed or Failed. One the node dropped from its queue before it ran
 * (removed) is Failed, as Sent says it, and tones as failed; Not confirmed
 * (the wallet stopped waiting) tones as pending. Unknown is final on chain, its
 * outcome not looked up yet: nothing waits on it, so it tones neutral. Held:
 * handed over, the node never had it, and it goes as it was signed only with
 * Send it now (unsent); Not sent: another of its account's transactions took
 * its place, and it never will (not_sent). Never Confirming for either.
 * @param {string} status
 * @param {{ final?: boolean }} [opts] - `final`: the chain has it, final
 * @returns {"Confirming"|"Completed"|"Failed"|"Not confirmed"|"Unknown"|"Held"|"Not sent"}
 */
export function txStatusWord(status, { final = false } = {}) {
  const s = String(status ?? "").toLowerCase();
  if (s === "executed") return "Completed";
  if (s === "failed" || s === "removed") return "Failed";
  if (s === "unsent") return "Held";
  if (s === "not_sent") return "Not sent";
  if (s === "unknown") return final ? "Unknown" : "Not confirmed";
  return "Confirming";
}

// Chain errors with a plain meaning, in the words Activity uses. The raw
// error stays under a transaction's Details.
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
  // Dropped before it ran says Failed, so it looks it.
  if (s === "failed" || s === "removed") return "bad";
  if ((s === "unknown" && final) || s === "not_sent") return "neutral";
  return "pending";
}

export function txRecoveryReasonLabel(reason) {
  const raw = String(reason ?? "").trim();
  if (!raw) return "";

  const key = raw.toLowerCase();
  if (key === "watcher_timeout") {
    return "The wallet stopped waiting before the network confirmed it.";
  }
  // Its connection to the network went while it waited, as with no signal.
  if (key === "watcher_unavailable") {
    return "The wallet lost its connection to the network while it waited. It looks it up again once it's back.";
  }
  // Handed over as the connection went: whether the node got it is looked up by its ID.
  if (key === "handover_unclear") {
    return "The connection went as it was sent. The wallet looks it up by its ID.";
  }
  if (key === "not_found") {
    return "The network has no record of it.";
  }
  if (key === "removed_unconfirmed") {
    return "The network said it dropped it. The wallet hasn't confirmed that yet.";
  }
  if (key === "removed") {
    return "The network dropped it before it ran.";
  }
  if (key === "not_reached") {
    return "The connection went as it was sent, and the network never got it.";
  }
  if (key === "replaced") {
    return "Another transaction from this account took its place.";
  }
  if (key === "node_url_missing") {
    return "The wallet could not recheck this transaction because the original node URL is missing.";
  }
  if (key === "reconciliation_unavailable" || /graphql|query|fetch|network|hex|digit/i.test(raw)) {
    return "The wallet could not complete the latest network status check.";
  }

  return raw;
}

/**
 * What a stake or an unstake with Sozu got or gave back in stDUSK, to the lux,
 * hidden with the balances, and what one stDUSK was worth then (app-core's
 * stDuskWorth), as the web wallet says them: for a transaction's details and
 * its Completed screen. None without what the pool's event says (`fact`).
 * @param {import("@dusk-network/app-core/sozu").SozuFact | undefined} fact
 * @param {boolean} hidden - balancesHidden(ov)
 * @returns {{ label: string, value: Array<string|HTMLElement> | string }[]}
 */
export function stDuskLines(fact, hidden) {
  if (!fact) return [];
  const worth = stDuskWorth(fact.pool);
  return [
    { label: fact.kind === "stake" ? "You got" : "You gave back", value: [balance(hidden, formatDuskExact(String(fact.stDusk))), " stDUSK"] },
    ...(worth === null ? [] : [{ label: "Rate", value: `1 stDUSK = ${formatDuskExact(String(worth))} DUSK` }]),
  ];
}
