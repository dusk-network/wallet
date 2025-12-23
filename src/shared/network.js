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
 * Heuristic mapping of node URL to display name.
 * NOTE: This intentionally matches the original MVP behavior:
 * anything not matching local/testnet/devnet is treated as "Mainnet".
 * @param {string} nodeUrl
 */
export function networkNameFromNodeUrl(nodeUrl) {
  try {
    const { hostname } = new URL(nodeUrl);
    const h = hostname.toLowerCase();

    // Local development
    if (h === "localhost" || h === "127.0.0.1" || h === "0.0.0.0") return "Local";
    if (h.includes("testnet")) return "Testnet";
    if (h.includes("devnet")) return "Devnet";
    if (h.includes("local")) return "Local";
    return "Mainnet";
  } catch {
    return "Unknown";
  }
}
