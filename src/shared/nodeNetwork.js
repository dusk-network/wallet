// A node's network, in two parts that never mix.
//
// What it's called: Mainnet, Testnet and Devnet for the exact addresses their
// files in @dusk-network/networks list, Local for this machine, and Custom for
// anything else, however it describes itself (networkLabelOf).
//
// Which chain it signs for: a listed address's from its file, never from the
// node; another node's as it gave it in /on/node/info when it was added, kept
// with the wallet's settings and fixed from then on (settings.js). Every
// signature carries that chain ID (walletEngine.js), and one the node later
// contradicts is refused (chainRefusal). A custom node gets the contracts,
// routes and explorer of the network that chain ID is, under its own name:
// every context that loads its settings, or is handed them (the popup's
// overview, an approval's request, the engine's config), notes it here, so code
// that knows only a node's URL finds them at once (networkForNode).

import { labelFor, networkFor, networks } from "@dusk-network/networks";

const originOf = (url) => {
  try {
    return new URL(String(url ?? "").trim()).origin;
  } catch {
    return "";
  }
};

const hostOf = (url) => {
  try {
    return new URL(String(url ?? "").trim()).host;
  } catch {
    return "";
  }
};

const LOOPBACK = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);

/** A node's host, with any port, as the wallet names it: "hostile-node.example:8443". */
export const nodeHost = (nodeUrl) => hostOf(nodeUrl);

/**
 * Whether a node is on this machine, by its address alone.
 * @param {string} nodeUrl
 */
export function isLocalNode(nodeUrl) {
  try {
    return LOOPBACK.has(new URL(String(nodeUrl ?? "").trim()).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * The chain ID in a node's /on/node/info reply (`chain_id`; w3sper's
 * `chainId`), or null.
 * @param {unknown} info
 * @returns {number | null}
 */
export function chainIdOfInfo(info) {
  const raw = info?.chain_id ?? info?.chainId;
  const id = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : NaN;
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
 * The network whose own node `nodeUrl` is, exactly as its file lists it, or null.
 * @param {string} nodeUrl
 * @returns {import("@dusk-network/networks").Network | null}
 */
export function listedNetwork(nodeUrl) {
  const origin = originOf(nodeUrl);
  return (origin && Object.values(networks).find((n) => originOf(n.urls.node) === origin)) || null;
}

/**
 * What goes under a .dusk name read through this node: nothing on a network's own
 * node. Any other can answer what it likes, so it says whose word the name is.
 * @param {string} nodeUrl
 * @returns {string}
 */
export function nameCheckNote(nodeUrl) {
  return listedNetwork(nodeUrl) ? "" : `Checked by ${nodeHost(nodeUrl)}, a node the wallet doesn't know. Check the address too.`;
}

/**
 * The chain ID of a network whose own node `nodeUrl` is, as its file lists
 * it, or null.
 * @param {string} nodeUrl
 * @returns {number | null}
 */
export function listedChainId(nodeUrl) {
  return listedNetwork(nodeUrl)?.chainId ?? null;
}

/**
 * The chain ID a node signs for, by what the settings keep: a listed address's
 * from its file, another's as it was fixed when it was added, or null while
 * it hasn't said yet.
 * @param {{ nodeChains?: Record<string, number> } | null | undefined} settings
 * @param {string} nodeUrl
 * @returns {number | null}
 */
export function pinnedChainOf(settings, nodeUrl) {
  const listed = listedChainId(nodeUrl);
  if (listed !== null) return listed;
  const kept = settings?.nodeChains?.[originOf(nodeUrl)];
  return Number.isInteger(kept) ? kept : null;
}

// The chain ID of each node origin this context had settings for.
const noted = new Map();

/**
 * Notes the chain ID a node signs for, as the settings this context loaded or
 * was handed keep it: none forgets what was noted of it before.
 * @param {string} nodeUrl
 * @param {unknown} chainId
 */
export function noteChainId(nodeUrl, chainId) {
  const origin = originOf(nodeUrl);
  if (!origin) return;
  if (Number.isInteger(chainId)) noted.set(origin, chainId);
  else noted.delete(origin);
}

/**
 * The chain ID a node signs for, as this context knows it: a listed address's
 * from its file, whatever was noted of it, else the one noted, else null.
 * @param {string} nodeUrl
 * @returns {number | null}
 */
export function chainIdForNode(nodeUrl) {
  const listed = listedChainId(nodeUrl);
  if (listed !== null) return listed;
  const id = noted.get(originOf(nodeUrl));
  return Number.isInteger(id) ? id : null;
}

/**
 * The network a node's contracts and routes are found on, as this context
 * knows its chain ID, or null. Not what it's called: networkLabelOf says that.
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
  return chainId === 0 || isLocalNode(nodeUrl) ? "local" : "custom";
}

/**
 * What a node is called, by its address alone: its network's label for the
 * exact address that network's file lists ("Testnet"), "Local" for a node on
 * this machine, else "Custom". Nothing a node says changes it.
 * @param {string} nodeUrl
 * @returns {string}
 */
export function networkLabelOf(nodeUrl) {
  const net = listedNetwork(nodeUrl);
  if (net) return net.label;
  return isLocalNode(nodeUrl) ? "Local" : "Custom";
}

/**
 * A node as a line of text names it: "Mainnet" or "Custom · my-node.example".
 * @param {string} nodeUrl
 * @returns {string}
 */
export function networkTextOf(nodeUrl) {
  const label = networkLabelOf(nodeUrl);
  const host = hostOf(nodeUrl);
  return listedNetwork(nodeUrl) || !host ? label : `${label} · ${host}`;
}

/**
 * What a node that isn't a network's own counts its signatures on, when that's
 * another network's chain ID: "Mainnet", or "" for any other.
 * @param {string} nodeUrl
 * @param {number | null | undefined} chainId
 * @returns {string}
 */
export function signsOnNetwork(nodeUrl, chainId) {
  return listedNetwork(nodeUrl) ? "" : networkOf(chainId)?.label ?? "";
}

const chainWords = (id) => {
  const net = networkOf(id);
  return net ? `${net.label} (chain ${id})` : `chain ${id}`;
};

// "my-node.example now says it's on Mainnet (chain 1), not Testnet (chain 2)."
const contradiction = (nodeUrl, pinned, answered) =>
  `${hostOf(nodeUrl) || "This node"} now says it's on ${chainWords(answered)}, not ${chainWords(pinned)}.`;

/**
 * Why nothing is signed on this node, in plain words, or "" when it may be: it
 * says another chain than the one it's fixed to, or a custom node's chain isn't
 * known yet (`required`, for what must carry it). `ahead`: said before anything
 * is asked to be signed, rather than as a signature is refused.
 * @param {string} nodeUrl
 * @param {number | null} pinned - the chain ID it signs for
 * @param {number | null} answered - what it says now, null when it didn't say
 * @param {{ required?: boolean, ahead?: boolean }} [opts]
 * @returns {string}
 */
export function chainRefusal(nodeUrl, pinned, answered, { required = true, ahead = false } = {}) {
  if (pinned === null) {
    if (!required) return "";
    const host = hostOf(nodeUrl) || "this node";
    return ahead
      ? `The wallet can't read which network ${host} is on yet, so it won't sign on it. Try again in a moment.`
      : `The wallet couldn't read which network ${host} is on, so nothing was signed. Try again in a moment.`;
  }
  if (answered === null || answered === pinned) return "";
  const why = "because a signature here could count on the other network.";
  return `${contradiction(nodeUrl, pinned, answered)} ${ahead ? "The wallet won't sign on it," : "Nothing was signed,"} ${why}`;
}

/**
 * What choosing a node again says when it now says another chain than it was
 * added with: to the menu that can't accept that, or the question Settings asks
 * before it does.
 * @param {string} nodeUrl
 * @param {number} pinned
 * @param {number} answered
 * @returns {{ notice: string, question: string }}
 */
export function chainChangeWords(nodeUrl, pinned, answered) {
  const said = contradiction(nodeUrl, pinned, answered);
  return {
    notice: `${said} To use it anyway, save it in Settings.`,
    question: `${said} Use it on ${chainWords(answered)} from now on? What you sign there will count there.`,
  };
}

/**
 * What Rusk wants on its HTTP API, as the wallet's engine (w3sper) asks it: a
 * node that checks the version answers 400 to a request without one.
 */
export const RUSK_HEADERS = Object.freeze({
  "Content-Type": "application/octet-stream",
  Accept: "application/json",
  "Rusk-Version": "1.0.0-rc.0",
});

/**
 * The chain ID a node says it's on right now, or null when it doesn't say in
 * time. For comparing with the chain it's fixed to, never for signing with.
 * @param {string} nodeUrl
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<number | null>}
 */
export async function askNodeChainId(nodeUrl, { timeoutMs = 4000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const reply = await fetch(new URL("/on/node/info", String(nodeUrl)).toString(), {
      method: "POST",
      headers: RUSK_HEADERS,
      body: new Uint8Array(0),
      signal: controller.signal,
    });
    return reply?.ok ? chainIdOfInfo(await reply.json()) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
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
