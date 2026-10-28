import { h } from "../lib/dom.js";

// A test network says so at the top, in violet, as the bridge and the web
// wallet do: "Testnet · Test DUSK has no value". Mainnet shows nothing.

const TEST_NETWORKS = new Set(["testnet", "devnet", "local"]);

/**
 * Whether a network is a test one, whose DUSK has no value.
 * @param {string} name - "Mainnet", "Testnet", "Devnet" or "Local"
 * @returns {boolean}
 */
export function isTestNetwork(name) {
  return TEST_NETWORKS.has(String(name ?? "").trim().toLowerCase());
}

/**
 * Puts the strip first in `host` on a test network, and takes it away on any
 * other. Calling it again for the same network changes nothing.
 * @param {HTMLElement|null} host - the page's panel
 * @param {string} name - the network's name
 * @returns {HTMLElement|null} the strip, while it shows
 */
export function syncTestnetStrip(host, name) {
  if (!host) return null;
  const current = host.querySelector(".testnet-strip");
  if (!isTestNetwork(name)) {
    current?.remove();
    return null;
  }
  const label = String(name).trim();
  const text = `${label.charAt(0).toUpperCase()}${label.slice(1)} · Test DUSK has no value`;
  if (current) {
    if (current.textContent !== text) current.textContent = text;
    return current;
  }
  const strip = h("div", { class: "testnet-strip", role: "note", text });
  host.insertBefore(strip, host.firstChild);
  return strip;
}
