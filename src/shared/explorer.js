import { networkForNode } from "./nodeNetwork.js";

// The Dusk explorer of the node's network, from its file in
// @dusk-network/networks; none on a local or unknown network.
function explorerBase(nodeUrl) {
  return networkForNode(String(nodeUrl ?? ""))?.apps.explorer ?? null;
}

/**
 * Returns a URL to view a transaction on the official Dusk explorer.
 *
 * For a local network, or one the node hasn't named, we return null because
 * there is no canonical hosted explorer.
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
 * Local and unknown networks have none.
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
