// The network a node is on: the file @dusk-network/networks has for the
// chain ID the node gives in /on/node/info, never a guess from its address,
// so a custom node gets its network's contracts, labels and routes. The
// chain ID is read when a node is chosen and kept with the node in the
// wallet's settings (settings.js); every context that loads its settings,
// or is handed them (the popup's overview, an approval's request, the
// engine's config), notes it here, so code that knows only a node's URL
// finds its network at once (networkForNode). A network's own node, as its
// file lists it, is known without asking.

import { labelFor, networkFor, networks } from "@dusk-network/networks";

const originOf = (url) => {
  try {
    return new URL(String(url ?? "").trim()).origin;
  } catch {
    return "";
  }
};

/**
 * The chain ID in a node's /on/node/info reply (`chain_id`; w3sper's
 * `chainId`), or null.
 * @param {unknown} info
 * @returns {number | null}
 */
export function chainIdOfInfo(info) {
  const id = Number(info?.chain_id ?? info?.chainId);
  return Number.isInteger(id) && id >= 0 && id <= 255 ? id : null;
}

/**
 * The network with this chain ID, or null: a local chain, or one there's no
 * file for.
 * @param {unknown} chainId
 * @returns {import("@dusk-network/networks").Network | null}
 */
export function networkOf(chainId) {
  return typeof chainId === "number" && Number.isInteger(chainId) ? networkFor(chainId) : null;
}

/**
 * The chain ID of a network whose own node `nodeUrl` is, as its file lists
 * it, or null.
 * @param {string} nodeUrl
 * @returns {number | null}
 */
export function listedChainId(nodeUrl) {
  const origin = originOf(nodeUrl);
  if (!origin) return null;
  const net = Object.values(networks).find((n) => originOf(n.urls.node) === origin);
  return net ? net.chainId : null;
}

// The chain ID of each node origin this context had settings for.
const noted = new Map();

/**
 * Notes the chain ID a node gave, as the settings this context loaded or was
 * handed keep it.
 * @param {string} nodeUrl
 * @param {unknown} chainId
 */
export function noteChainId(nodeUrl, chainId) {
  const origin = originOf(nodeUrl);
  if (origin && Number.isInteger(chainId)) noted.set(origin, chainId);
}

/**
 * A node's chain ID as this context knows it: the one it noted, else the
 * one of the network whose own node it is, else null.
 * @param {string} nodeUrl
 * @returns {number | null}
 */
export function chainIdForNode(nodeUrl) {
  const id = noted.get(originOf(nodeUrl));
  return Number.isInteger(id) ? id : listedChainId(nodeUrl);
}

/**
 * The network a node is on, as this context knows it, or null.
 * @param {string} nodeUrl
 */
export function networkForNode(nodeUrl) {
  return networkOf(chainIdForNode(nodeUrl));
}

/**
 * The key a network's kept data goes under: its file's name ("mainnet",
 * "testnet", "devnet"), "local" for a node on this machine, else "custom".
 * @param {number | null} chainId
 * @param {string} nodeUrl
 * @returns {string}
 */
export function networkKeyOf(chainId, nodeUrl) {
  const net = networkOf(chainId);
  if (net) return net.name;
  let host = "";
  try {
    host = new URL(String(nodeUrl ?? "")).hostname.toLowerCase();
  } catch {
    // no node yet
  }
  return chainId === 0 || ["localhost", "127.0.0.1", "0.0.0.0"].includes(host) ? "local" : "custom";
}

/**
 * A network's name as the wallet shows it: its file's label ("Testnet"),
 * "Local" for a node on this machine, else "Custom".
 * @param {number | null} chainId
 * @param {string} nodeUrl
 * @returns {string}
 */
export function networkLabelOf(chainId, nodeUrl) {
  const net = networkOf(chainId);
  if (net) return net.label;
  return networkKeyOf(chainId, nodeUrl) === "local" ? "Local" : "Custom";
}

/**
 * What the node's network's file calls a contract or an account ("Sozu
 * pool", "BSC bridge"), or null.
 * @param {string} nodeUrl
 * @param {unknown} id - a contract ID, with or without 0x, or an account
 * @returns {string | null}
 */
export function labelForNode(nodeUrl, id) {
  const net = networkForNode(nodeUrl);
  return net && typeof id === "string" && id.trim() ? labelFor(net, id) : null;
}
