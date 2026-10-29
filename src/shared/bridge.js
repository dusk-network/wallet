// The DuskEVM bridge's contracts on DuskDS, so Activity can label bridge
// transfers, from the node's network's file in @dusk-network/networks.
// Deposits to DuskEVM call the bridge (`depositETHToWithValue`); withdrawals
// back are proved and finalized at the portal, which pays the DUSK out. A
// network without DuskEVM (Mainnet, for now) has none. The bridge's accounts
// for DUSK leaving Dusk are the network's service routes (bridgeCalls.js),
// and DUSK coming in from another chain is paid from its migration routes'
// payout accounts.

import { networks, routes } from "@dusk-network/networks";

import { TX_KIND } from "./constants.js";
import { networkForNode } from "./nodeNetwork.js";

const contractsOf = (net) => {
  const contracts = net?.duskEvm?.contracts;
  const bridge = contracts?.l1_standard_bridge?.contractId;
  const portal = contracts?.optimism_portal?.contractId;
  return bridge && portal ? Object.freeze({ bridge, portal }) : null;
};

/** The bridge and the portal on each network that has DuskEVM, by its name. */
export const BRIDGE_CONTRACTS = Object.freeze(
  Object.fromEntries(Object.values(networks).flatMap((net) => (contractsOf(net) ? [[net.name, contractsOf(net)]] : [])))
);

/**
 * The bridge and the portal on the node's network, as contract IDs, or null.
 * @param {string} nodeUrl
 * @returns {{ bridge: string, portal: string } | null}
 */
export const bridgeContractsOf = (nodeUrl) => contractsOf(networkForNode(String(nodeUrl ?? "")));

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
  const contracts = bridgeContractsOf(nodeUrl);
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
  const contracts = bridgeContractsOf(nodeUrl);
  if (!contracts) return null;
  const ids = new Set(Object.values(contracts));
  const touched = [tx?.contractId, tx?.counterparty, tx?.to, tx?.from].some((id) => ids.has(norm(id)));
  if (!touched) return null;
  if (tx?.direction === "in") return "from";
  const moved = [tx?.amount, tx?.deposit].some((v) => /^\d+$/.test(String(v ?? "")) && BigInt(String(v)) > 0n);
  return moved ? "to" : "call";
}

/**
 * A transfer through one of the network's bridge routes to or from another
 * chain: "to" one when it paid a service route's account, "from" one when a
 * migration route's payout account paid it, with the chain as the route names
 * it ("BNB Smart Chain", "Ethereum"); null for any other transaction.
 * @param {object} tx - an Activity row (activityMerge.js)
 * @param {string} [nodeUrl]
 * @returns {{ direction: "to"|"from", chain: string } | null}
 */
export function bridgeRouteTransfer(tx, nodeUrl = tx?.nodeUrl) {
  const net = networkForNode(String(nodeUrl ?? ""));
  if (!net || String(tx?.kind ?? "").toLowerCase() !== TX_KIND.TRANSFER || tx?.direction === "self") return null;
  const from = tx?.direction === "in";
  const account = String((from ? tx?.from : tx?.to) ?? "").trim();
  const route = account
    ? routes(net).find((r) => (from ? r.kind === "migration" && r.payoutAccount === account : r.kind === "service" && r.account === account))
    : null;
  return route ? { direction: from ? "from" : "to", chain: route.chain.name } : null;
}
