// Sozu's contracts on the node's network, from its file in
// @dusk-network/networks: its hub, and the contracts the hub named when the
// file was written, which the wallet uses until the hub answers. The hub can
// name others at any time; the wallet's engine reads them from it with each
// status (readSozuStatus).

import { networkOf } from "./nodeNetwork.js";

/**
 * @param {number | null} chainId - the node's
 * @returns {{ networkKey: string, contracts: { hub: string, pool: string, relayer: string, substrate: string, "staked-dusk": string } } | null}
 */
export function sozuConfigOf(chainId) {
  const net = networkOf(chainId);
  if (!net?.sozu) return null;
  const { pool, relayer, stDusk, substrate } = net.sozu.fallbacks;
  return Object.freeze({
    networkKey: net.name,
    contracts: Object.freeze({ hub: net.sozu.hub, pool, relayer, substrate, "staked-dusk": stDusk }),
  });
}
