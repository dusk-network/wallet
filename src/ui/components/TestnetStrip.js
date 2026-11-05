import { isLocalNode, listedNetwork, networkOf, nodeHost, signsOnNetwork } from "../../shared/nodeNetwork.js";
import { h } from "../lib/dom.js";

// What the top of a page says about the node it's on. A test network says so,
// in violet, as the bridge and the web wallet do: "Testnet · Test DUSK has no
// value". A node that isn't a network's own says which it is, in neutral words:
// "Custom node · my-node.example", and where what's signed there counts when
// that's another network. A node contradicting the chain it's fixed to says
// why nothing is signed on it. Mainnet's own node shows nothing.

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

function stripOf(name, { nodeUrl, chainId, refusal }) {
  const label = String(name ?? "").trim();
  if (refusal) return { text: refusal, role: "alert", className: "testnet-strip node-strip node-strip--refused" };
  if (isTestNetwork(nodeUrl, chainId)) return { text: `${label} · Test DUSK has no value`, role: "note", className: "testnet-strip" };
  if (listedNetwork(nodeUrl) || !nodeHost(nodeUrl)) return null;
  const counts = signsOnNetwork(nodeUrl, chainId);
  return {
    text: [`${label} node · ${nodeHost(nodeUrl)}`, counts ? `What you sign here counts on ${counts}.` : ""].filter(Boolean).join(" · "),
    role: "note",
    className: "testnet-strip node-strip",
  };
}

/**
 * Puts the strip first in `host` where there's something to say, and takes it
 * away where there isn't. Calling it again for the same network changes nothing.
 * @param {HTMLElement|null} host - the page's panel
 * @param {string} name - the network's name, by the node's address
 * @param {{ nodeUrl?: string, chainId?: number | null, refusal?: string }} [node] -
 *   the node, the chain it signs for, and why nothing is signed on it
 * @returns {HTMLElement|null} the strip, while it shows
 */
export function syncTestnetStrip(host, name, { nodeUrl = "", chainId = null, refusal = "" } = {}) {
  if (!host) return null;
  const current = host.querySelector(".testnet-strip");
  const strip = stripOf(name, { nodeUrl, chainId, refusal });
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
