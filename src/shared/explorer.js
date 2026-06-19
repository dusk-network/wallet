import { detectPresetIdFromNodeUrl } from "./network.js";
import { NETWORK_PRESETS } from "./networkPresets.js";

const DUSK_EXPLORER_BASE = "https://duskexplorer.com";

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

  const presetId = detectPresetIdFromNodeUrl(nodeUrl);

  const base = NETWORK_PRESETS.find((p) => p.id === presetId)?.explorerBase ?? null;
  if (!base) return null;
  return `${base}/transactions/transaction/?id=${encodeURIComponent(hash)}`;
}

/**
 * Returns a URL to view public account history on duskexplorer.com.
 *
 * The DUDE currently tracks mainnet public/Moonlight accounts. For other
 * networks we fall back to the explorer's address list instead of implying an
 * account-specific testnet/devnet history exists there.
 *
 * @param {string} nodeUrl
 * @param {string} account
 * @returns {string}
 */
export function explorerAccountUrl(nodeUrl, account) {
  const presetId = detectPresetIdFromNodeUrl(nodeUrl);
  const acct = typeof account === "string" ? account.trim() : "";
  if (presetId === "mainnet" && acct) {
    return `${DUSK_EXPLORER_BASE}/address/${acct}/`;
  }
  return `${DUSK_EXPLORER_BASE}/addresses/`;
}
