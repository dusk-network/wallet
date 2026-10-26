import { formatDusk, safeBigInt } from "../../shared/amount.js";
import { TX_KIND } from "../../shared/constants.js";
import { balance } from "../components/Balance.js";
import { shortAddress } from "../lib/strings.js";

// The word a toast ends on, by the status the wallet's watcher reports.
function statusWord(status) {
  const s = String(status ?? "").toLowerCase();
  if (s === "executed") return "completed";
  if (s === "failed" || s === "removed") return "failed";
  return "is still pending";
}

function tone(status) {
  const s = String(status ?? "").toLowerCase();
  if (s === "executed") return "ok";
  if (s === "failed" || s === "removed") return "bad";
  return "info";
}

// "1,000 DUSK", the amount hidden while balances are.
function amountParts(lux, hidden, unit = "DUSK") {
  return [balance(hidden, formatDusk(lux)), ` ${unit}`];
}

/**
 * What a transaction did, as toast parts: "5 DUSK to qxwSid…kQ2Bgr", "Stake
 * of 1,000 DUSK", or "Transaction" when the wallet has no record of it.
 * @param {object|null} tx - the wallet's record (overview txs)
 * @param {{ hidden?: boolean, contactName?: (address: string) => string }} [opts]
 * @returns {Array<string|Node>}
 */
export function txSummaryParts(tx, { hidden = false, contactName } = {}) {
  const kind = String(tx?.kind ?? "").toLowerCase();
  const has = (v) => v !== undefined && v !== null && safeBigInt(v, 0n) > 0n;
  const who = (addr) => {
    const a = String(addr ?? "").trim();
    return contactName?.(a) || shortAddress(a);
  };

  if (kind === TX_KIND.TRANSFER && has(tx.amount)) {
    return [...amountParts(tx.amount, hidden), ...(tx.to ? [" to ", who(tx.to)] : [])];
  }
  const ofAmount = (label, lux) => (has(lux) ? [`${label} of `, ...amountParts(lux, hidden)] : [label]);
  if (kind === TX_KIND.STAKE) return ofAmount("Stake", tx.amount);
  if (kind === TX_KIND.UNSTAKE) return ofAmount("Unstake", tx.amount);
  if (kind === TX_KIND.WITHDRAW_REWARD) return ofAmount("Reward claim", tx.amount);
  if (kind === TX_KIND.SHIELD) return ofAmount("Shield", tx.amount);
  if (kind === TX_KIND.UNSHIELD) return ofAmount("Unshield", tx.amount);
  if (kind === TX_KIND.CONTRACT_CALL) {
    const asset = tx?.asset && typeof tx.asset === "object" ? tx.asset : {};
    if (asset.kind === "sozu") {
      return asset.action === "sozu_unstake" ? ["Liquid unstake"] : ofAmount("Liquid stake", tx.deposit);
    }
    return ["Contract call"];
  }
  return ["Transaction"];
}

/**
 * The toast for a status the watcher reports: "5 DUSK to qxwSid…kQ2Bgr
 * completed", with View when there is a transaction to open. Amounts hide
 * with Hide balances; the sentence stays.
 * @param {object|null} tx
 * @param {string} status - executed | failed | removed | mempool | unknown
 * @param {{ hidden?: boolean, contactName?: Function, onView?: Function }} [opts]
 */
export function txStatusToast(tx, status, { hidden = false, contactName, onView } = {}) {
  return {
    parts: [...txSummaryParts(tx, { hidden, contactName }), ` ${statusWord(status)}`],
    tone: tone(status),
    action: onView ? { label: "View", onClick: onView } : null,
  };
}
