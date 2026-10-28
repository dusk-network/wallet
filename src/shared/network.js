import { chainIdForNode, networkLabelOf } from "./nodeNetwork.js";

// Shared network helpers.

/**
 * Detect the closest preset id for a node URL.
 * @param {string} nodeUrl
 * @returns {"local"|"testnet"|"devnet"|"mainnet"|"custom"}
 */
export function detectPresetIdFromNodeUrl(nodeUrl) {
  try {
    const { hostname } = new URL(nodeUrl);
    const h = hostname.toLowerCase();

    if (h === "localhost" || h === "127.0.0.1" || h === "0.0.0.0") return "local";
    if (h.includes("testnet")) return "testnet";
    if (h.includes("devnet")) return "devnet";
    if (h === "nodes.dusk.network") return "mainnet";
  } catch {
    // ignore
  }
  return "custom";
}

/**
 * A node's network as the wallet names it: its file's label, by the chain ID
 * the node gave (nodeNetwork.js), "Local" for a node on this machine, else
 * "Custom"; "Unknown" for an address that isn't one.
 * @param {string} nodeUrl
 * @param {number | null} [chainId] - the node's, where it's kept with what's named
 */
export function networkNameFromNodeUrl(nodeUrl, chainId) {
  try {
    new URL(nodeUrl);
  } catch {
    return "Unknown";
  }
  return networkLabelOf(Number.isInteger(chainId) ? chainId : chainIdForNode(nodeUrl), nodeUrl);
}
