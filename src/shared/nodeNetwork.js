// The network a node is on: the file @dusk-network/networks has for the
// chain ID the node gives in /on/node/info, never a guess from its address,
// so a custom node gets its network's contracts, labels and routes. The
// background keeps the chain ID each node gave last, by its origin
// (networkStatus.js reads it with each check of the node), and hands it to
// the popup with the overview and to an approval window with its request;
// the engine reads its own node's. Each of them notes what it learns here,
// so code that knows only a node's URL finds its network at once
// (networkForNode). Until a node has answered once, a network's own node,
// as its file lists it, stands for that network.

import { labelFor, networkFor, networks } from "@dusk-network/networks";

import { storage, STORAGE_KEYS } from "./storage.js";

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

// The chain ID each node origin gave, as this context learned it.
const noted = new Map();

/**
 * Notes the chain ID a node gave, as the overview, an approval's request or
 * the node itself says it.
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

async function kept() {
  try {
    const items = await storage.get(STORAGE_KEYS.NODE_CHAINS);
    const all = items?.[STORAGE_KEYS.NODE_CHAINS];
    return all && typeof all === "object" ? all : {};
  } catch {
    return {};
  }
}

let loading = null;

/**
 * Notes every chain ID kept, once for this context: what a background that
 * just started knows of each node before its next check.
 * @returns {Promise<void>}
 */
export function loadKnownChains() {
  loading ??= kept().then((all) => {
    for (const [origin, id] of Object.entries(all)) {
      if (Number.isInteger(id) && !noted.has(origin)) noted.set(origin, id);
    }
  });
  return loading;
}

/**
 * The chain ID a node gave last, else the one of the network whose own node
 * it is; null for a node that hasn't answered and isn't one.
 * @param {string} nodeUrl
 * @returns {Promise<number | null>}
 */
export async function knownChainId(nodeUrl) {
  const origin = originOf(nodeUrl);
  if (!origin) return null;
  const id = (await kept())[origin];
  if (Number.isInteger(id)) {
    noted.set(origin, id);
    return id;
  }
  return chainIdForNode(nodeUrl);
}

/**
 * Keeps the chain ID a node gave, for its origin.
 * @param {string} nodeUrl
 * @param {number | null} chainId
 */
export async function rememberChainId(nodeUrl, chainId) {
  const origin = originOf(nodeUrl);
  if (!origin || !Number.isInteger(chainId)) return;
  noted.set(origin, chainId);
  const all = await kept();
  if (all[origin] === chainId) return;
  await storage.set({ [STORAGE_KEYS.NODE_CHAINS]: { ...all, [origin]: chainId } });
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
