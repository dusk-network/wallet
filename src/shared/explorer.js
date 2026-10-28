import { chainIdForNode, networkOf } from "./nodeNetwork.js";

// The Dusk explorer of the node's network, from its file in
// @dusk-network/networks; none on a local or unknown network.
function explorerBase(nodeUrl, chainId) {
  return networkOf(Number.isInteger(chainId) ? chainId : chainIdForNode(String(nodeUrl ?? "")))?.apps.explorer ?? null;
}

/**
 * Returns a URL to view a transaction on the official Dusk explorer.
 *
 * For a local network, or one the node hasn't named, we return null because
 * there is no canonical hosted explorer.
 *
 * @param {string} nodeUrl
 * @param {string} hash
 * @param {number | null} [chainId] - the network it was sent on, where it's kept
 * @returns {string|null}
 */
export function explorerTxUrl(nodeUrl, hash, chainId) {
  if (!hash || typeof hash !== "string") return null;

  const base = explorerBase(nodeUrl, chainId);
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
