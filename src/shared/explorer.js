import { detectPresetIdFromNodeUrl } from "./network.js";
import { NETWORK_PRESETS } from "./networkPresets.js";

const DUSKSCAN_BASES = {
  mainnet: "https://duskscan.net",
  testnet: "https://testnet.duskscan.net",
};

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
 * Returns a URL to view public account history on DuskScan.
 *
 * @param {string} nodeUrl
 * @param {string} account
 * @returns {string|null}
 */
export function explorerAccountUrl(nodeUrl, account) {
  const base = DUSKSCAN_BASES[detectPresetIdFromNodeUrl(nodeUrl)];
  const acct = typeof account === "string" ? account.trim() : "";
  return base && acct ? `${base}/address/${encodeURIComponent(acct)}` : null;
}
