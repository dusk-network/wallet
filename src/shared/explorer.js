import { detectPresetIdFromNodeUrl } from "./network.js";
import { NETWORK_PRESETS } from "./networkPresets.js";

function explorerBase(nodeUrl) {
  const presetId = detectPresetIdFromNodeUrl(nodeUrl);
  return NETWORK_PRESETS.find((p) => p.id === presetId)?.explorerBase ?? null;
}

/**
 * Returns a URL to view a transaction on the official Dusk explorer.
 *
 * For "local"/"custom" networks we return null because there is no canonical
 * hosted explorer.
 *
 * @param {string} nodeUrl
 * @param {string} hash
 * @returns {string|null}
 */
export function explorerTxUrl(nodeUrl, hash) {
  if (!hash || typeof hash !== "string") return null;

  const base = explorerBase(nodeUrl);
  if (!base) return null;
  return `${base}/transactions/transaction/?id=${encodeURIComponent(hash)}`;
}

/**
 * Returns a URL to view a public account's history on the Dusk explorer.
 * Local and custom networks have none.
 *
 * @param {string} nodeUrl
 * @param {string} account
 * @returns {string|null}
 */
export function explorerAccountUrl(nodeUrl, account) {
  const base = explorerBase(nodeUrl);
  const acct = typeof account === "string" ? account.trim() : "";
  return base && acct ? `${base}/accounts/?key=${encodeURIComponent(acct)}` : null;
}
