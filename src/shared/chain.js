// Chain identity helpers.
//
// Dusk isn't EVM, but dApps often want a MetaMask/EIP-1193-style `chainId`
// and a `chainChanged` event.
//
// We expose a stable-ish hex string with a 0x prefix.
// - Known presets map to fixed IDs.
// - Custom nodes derive a 32-bit ID from the node URL origin.

import { detectPresetIdFromNodeUrl } from "./network.js";

/**
 * Compute an EIP-1193-style chainId string from the currently selected node URL.
 *
 * @param {string} nodeUrl
 * @returns {string} hex string with 0x prefix
 */
export function chainIdFromNodeUrl(nodeUrl) {
  const url = String(nodeUrl ?? "").trim();
  const preset = detectPresetIdFromNodeUrl(url);

  // Fixed IDs for known networks.
  // NOTE: These are NOT Ethereum chain IDs; they are Dusk wallet identifiers.
  if (preset === "mainnet") return "0x1";
  if (preset === "testnet") return "0x2";
  if (preset === "devnet") return "0x3";
  if (preset === "local") return "0x0";

  // For custom nodes, derive a stable ID from the URL origin.
  let basis = url;
  try {
    // Use origin (scheme+host+port) so changing path doesn't change chainId.
    basis = new URL(url).origin;
  } catch {
    // ignore; hash full string
  }

  const h = fnv1a32(basis);
  return "0x" + h.toString(16).padStart(8, "0");
}

/**
 * 32-bit FNV-1a hash (deterministic, fast, no crypto dependency).
 * TODO: Find EVM equivalent, or use CAIP-2
 * @param {string} str
 * @returns {number} unsigned 32-bit
 */
export function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    // h *= 16777619 (with 32-bit overflow)
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return h >>> 0;
}
