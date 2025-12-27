import { detectPresetIdFromNodeUrl } from "./network.js";
import { NETWORK_PRESETS } from "./networkPresets.js";

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
