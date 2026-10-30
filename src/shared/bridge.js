// The DuskEVM bridge's contracts on DuskDS, so Activity can label bridge
// transfers, from the node's network's file (@dusk-network/networks/duskevm).
// Deposits to DuskEVM call the bridge (`depositETHToWithValue`); withdrawals
// back are proved and finalized at the portal, which pays the DUSK out. A
// network without DuskEVM (Mainnet, for now) has none. The bridge's accounts
// for DUSK leaving Dusk are the network's service routes (bridgeCalls.js),
// and DUSK coming in from another chain is paid from its migration routes'
// payout accounts.

import { isBridgeContract } from "@dusk-network/networks/duskevm";

import { networkForNode } from "./nodeNetwork.js";

/**
 * What a transaction did through the bridge: "to" DuskEVM (a deposit), "from"
 * DuskEVM (a finalized withdrawal), "call" (a proof, or another call with no
 * DUSK moved), or null when it didn't touch the bridge.
 * @param {object} tx - an Activity row (activityMerge.js)
 * @param {string} [nodeUrl]
 * @returns {"to"|"from"|"call"|null}
 */
export function bridgeTransfer(tx, nodeUrl = tx?.nodeUrl) {
  const net = networkForNode(String(nodeUrl ?? ""));
  const touched = Boolean(net) && [tx?.contractId, tx?.counterparty, tx?.to, tx?.from].some((id) => isBridgeContract(net, id));
  if (!touched) return null;
  if (tx?.direction === "in") return "from";
  const moved = [tx?.amount, tx?.deposit].some((v) => /^\d+$/.test(String(v ?? "")) && BigInt(String(v)) > 0n);
  return moved ? "to" : "call";
}
