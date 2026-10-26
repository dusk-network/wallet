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

const norm = (id) =>
  String(id ?? "")
    .trim()
    .toLowerCase()
    .replace(/^0x/, "");

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
