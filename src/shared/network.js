import { isLocalNode, listedNetwork, networkLabelOf } from "./nodeNetwork.js";

// Shared network helpers.

/**
 * The preset a node URL is: a network's by the exact address its file lists,
 * "local" for one on this machine, else "custom". Nothing in a host's name
 * makes it another: testnet.example.com is custom.
 * @param {string} nodeUrl
 * @returns {"local"|"testnet"|"devnet"|"mainnet"|"custom"}
 */
export function detectPresetIdFromNodeUrl(nodeUrl) {
  const net = listedNetwork(nodeUrl);
  if (net) return net.name;
  return isLocalNode(nodeUrl) ? "local" : "custom";
}

/**
 * A node's network as the wallet names it, by its address alone
 * (nodeNetwork.js): its file's label, "Local" for a node on this machine, else
 * "Custom"; "Unknown" for an address that isn't one.
 * @param {string} nodeUrl
 */
export function networkNameFromNodeUrl(nodeUrl) {
  try {
    new URL(nodeUrl);
  } catch {
    return "Unknown";
  }
  return networkLabelOf(nodeUrl);
}
