// The DuskEVM bridge's contracts on DuskDS, so Activity can label bridge
// transfers. Deposits to DuskEVM call the bridge (`depositETHToWithValue`);
// withdrawals back are proved and finalized at the portal, which pays the
// DUSK out. Mainnet has no bridge yet.

import { detectPresetIdFromNodeUrl } from "./network.js";

export const BRIDGE_CONTRACTS = Object.freeze({
  testnet: Object.freeze({
    bridge: "2257e5f8ff49cf7c9704a14ca35acbf48eb7ade11a079d98d5cd5655eea1b31d",
    portal: "14eeb3d4021aff09af2c515603a01f8d956a7f6411d11a1b1c0b0561a93fb1b9",
  }),
});

// The bridge's account on Dusk for DUSK leaving Dusk for an EVM chain: a
// transfer to it pays the bridge, and its memo names the EVM address the
// bridge pays out to. As the bridge's own config names them (src/config.js).
export const BRIDGE_SERVICE_ACCOUNTS = Object.freeze({
  mainnet: Object.freeze({
    account:
      "24jFms4JqYdWb19jFn3CUjNUQz1AeRozYnwsHuUkLbXAj2gRBq598aLAJmqmsaPcsCNJTgTaJTaUZCXpT3s9UeWBsHTmd5hQx95JymZSUsmtwoibiB8AMp4bZjAiLMjmAH3x",
    chain: "BNB Smart Chain",
    short: "BSC",
  }),
  testnet: Object.freeze({
    account:
      "25z9o6qCaVk1ReyHjmB4pyXcE3D1vRu4FVV1rR8ChYcosdTSktkANLDHq9GD6B4985Q1S2KrDZYBRrohWAjrNmACFUb3UMSRyYctJRzh3d28R1ZNC1ZyKm1HwXL4FF5Etftt",
    chain: "Ethereum (Sepolia)",
    short: "Sepolia",
  }),
});

const norm = (id) =>
  String(id ?? "")
    .trim()
    .toLowerCase()
    .replace(/^0x/, "");

/**
 * Whether a synced history entry paid the bridge's deposit contract on this
 * network: a deposit to DuskEVM, whose DuskEVM address is in its call.
 * @param {{ counterparty?: string|null, contractId?: string }} entry
 * @param {string} nodeUrl
 * @returns {boolean}
 */
export function depositsToBridge(entry, nodeUrl) {
  const contracts = BRIDGE_CONTRACTS[detectPresetIdFromNodeUrl(String(nodeUrl ?? ""))];
  return Boolean(contracts) && [entry?.counterparty, entry?.contractId].some((id) => norm(id) === contracts.bridge);
}

/**
 * What a transaction did through the bridge: "to" DuskEVM (a deposit), "from"
 * DuskEVM (a finalized withdrawal), "call" (a proof, or another call with no
 * DUSK moved), or null when it didn't touch the bridge.
 * @param {object} tx - an Activity row (activityMerge.js)
 * @param {string} [nodeUrl]
 * @returns {"to"|"from"|"call"|null}
 */
export function bridgeTransfer(tx, nodeUrl = tx?.nodeUrl) {
  const contracts = BRIDGE_CONTRACTS[detectPresetIdFromNodeUrl(String(nodeUrl ?? ""))];
  if (!contracts) return null;
  const ids = new Set(Object.values(contracts));
  const touched = [tx?.contractId, tx?.counterparty, tx?.to, tx?.from].some((id) => ids.has(norm(id)));
  if (!touched) return null;
  if (tx?.direction === "in") return "from";
  const moved = [tx?.amount, tx?.deposit].some((v) => /^\d+$/.test(String(v ?? "")) && BigInt(String(v)) > 0n);
  return moved ? "to" : "call";
}
