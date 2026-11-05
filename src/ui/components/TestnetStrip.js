import { isLocalNode, listedNetwork, networkOf, nodeHost, outsideEndpoints, outsideText, signsOnNetwork } from "../../shared/nodeNetwork.js";
import { h } from "../lib/dom.js";

// What the top of a page says about the node it's on. A test network says so,
// in violet, as the bridge and the web wallet do: "Testnet · Test DUSK has no
// value". A node that isn't a network's own says which it is, in neutral words:
// "Custom node · my-node.example", and where what's signed there counts when
// that's another network. A prover or an archiver that isn't the network's own
// says whose it is: "Proofs and history from x.example". A node contradicting
// the chain it's fixed to says why nothing is signed on it. Mainnet's own node,
// with its own prover and archiver, shows nothing.

/**
 * Whether a network's DUSK has no value: Testnet's and Devnet's own nodes, by
 * their addresses, and a node on this machine on a chain of its own.
 * @param {string} nodeUrl
 * @param {number | null} [chainId] - the chain it signs for
 * @returns {boolean}
 */
export function isTestNetwork(nodeUrl, chainId = null) {
  const net = listedNetwork(nodeUrl);
  if (net) return net.name !== "mainnet";
  return isLocalNode(nodeUrl) && !networkOf(chainId);
}

function stripOf(name, { nodeUrl, chainId, refusal, proverUrl, archiverUrl }) {
  const label = String(name ?? "").trim();
  if (refusal) return { text: refusal, role: "alert", className: "testnet-strip node-strip node-strip--refused" };
  const outside = outsideText(outsideEndpoints({ nodeUrl, proverUrl, archiverUrl }));
  const join = (...parts) => parts.filter(Boolean).join(" · ");
  if (isTestNetwork(nodeUrl, chainId)) return { text: join(`${label} · Test DUSK has no value`, outside), role: "note", className: "testnet-strip" };
  if (listedNetwork(nodeUrl) || !nodeHost(nodeUrl)) return outside ? { text: join(label, outside), role: "note", className: "testnet-strip node-strip" } : null;
  const counts = signsOnNetwork(nodeUrl, chainId);
  return {
    text: join(`${label} node · ${nodeHost(nodeUrl)}`, counts ? `What you sign here counts on ${counts}.` : "", outside),
    role: "note",
    className: "testnet-strip node-strip",
  };
}

/**
 * Puts the strip first in `host` where there's something to say, and takes it
 * away where there isn't. Calling it again for the same network changes nothing.
 * @param {HTMLElement|null} host - the page's panel
 * @param {string} name - the network's name, by the node's address
 * @param {{ nodeUrl?: string, chainId?: number | null, refusal?: string, proverUrl?: string, archiverUrl?: string }} [node] -
 *   the node, the chain it signs for, why nothing is signed on it, and the
 *   prover and archiver the wallet uses with it
 * @returns {HTMLElement|null} the strip, while it shows
 */
export function syncTestnetStrip(host, name, { nodeUrl = "", chainId = null, refusal = "", proverUrl = "", archiverUrl = "" } = {}) {
  if (!host) return null;
  const current = host.querySelector(".testnet-strip");
  const strip = stripOf(name, { nodeUrl, chainId, refusal, proverUrl, archiverUrl });
  if (!strip) {
    current?.remove();
    return null;
  }
  if (current) {
    if (current.textContent !== strip.text) current.textContent = strip.text;
    if (current.className !== strip.className) current.className = strip.className;
    if (current.getAttribute("role") !== strip.role) current.setAttribute("role", strip.role);
    return current;
  }
  const el = h("div", { class: strip.className, role: strip.role, text: strip.text });
  host.insertBefore(el, host.firstChild);
  return el;
}
