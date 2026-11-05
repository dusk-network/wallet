// Chain identity helpers.
//
// We expose a CAIP-2 compatible chain id string:
//   dusk:<reference>
// where <reference> is the chain ID of the exact address a network's file
// lists, 0 on this machine, and a deterministic hash of the origin for any
// other node. No custom node can get a chain ID a network has: its hash stays
// out of the range chain IDs are in, whatever host it picks to land there.

import { isLocalNode, listedChainId } from "./nodeNetwork.js";

export const CAIP2_NAMESPACE = "dusk";

// The hash of a custom node's origin, moved past the chain IDs (a byte) if it
// lands among them.
const CUSTOM_REFERENCE_FLOOR = 0x100000000;

/**
 * Compute a CAIP-2 chain id from the currently selected node URL.
 *
 * @param {string} nodeUrl
 * @returns {string} CAIP-2 chain id (e.g. "dusk:1")
 */
export function chainIdFromNodeUrl(nodeUrl) {
  const ref = chainReferenceFromNodeUrl(nodeUrl);
  return chainIdFromReference(ref);
}

/**
 * Build a CAIP-2 chain id from a reference string.
 *
 * @param {string} reference
 * @param {string} [namespace]
 * @returns {string}
 */
export function chainIdFromReference(reference, namespace = CAIP2_NAMESPACE) {
  const ns = String(namespace ?? "").trim();
  const ref = String(reference ?? "").trim();
  if (!ns || !ref) return "";
  return `${ns}:${ref}`;
}

/**
 * Parse a CAIP-2 chain id into its namespace and reference.
 *
 * @param {string} chainId
 * @returns {{ namespace: string, reference: string } | null}
 */
export function parseCaip2(chainId) {
  const s = String(chainId ?? "").trim();
  const idx = s.indexOf(":");
  if (idx <= 0) return null;
  const ns = s.slice(0, idx);
  const ref = s.slice(idx + 1);
  if (!/^[-a-z0-9]{3,8}$/i.test(ns)) return null;
  if (!/^[-_a-zA-Z0-9]{1,32}$/.test(ref)) return null;
  return { namespace: ns.toLowerCase(), reference: ref };
}

/**
 * Normalize a chain id (CAIP-2, hex, or decimal) to a decimal reference string.
 * Returns "" when invalid or when the CAIP-2 namespace is not dusk.
 *
 * @param {string} chainId
 * @returns {string}
 */
export function chainReferenceFromChainId(chainId) {
  const s = String(chainId ?? "").trim();
  if (!s) return "";

  const caip = parseCaip2(s);
  if (caip) {
    if (caip.namespace !== CAIP2_NAMESPACE) return "";
    if (!/^\d+$/.test(caip.reference)) return "";
    return caip.reference;
  }

  return "";
}

function chainReferenceFromNodeUrl(nodeUrl) {
  const url = String(nodeUrl ?? "").trim();

  // Fixed IDs for the listed networks' own nodes, and for this machine.
  const listed = listedChainId(url);
  if (listed !== null) return String(listed);
  if (isLocalNode(url)) return "0";

  // For custom nodes, derive a stable ID from the URL origin.
  let basis = url;
  try {
    // Use origin (scheme+host+port) so changing path doesn't change chainId.
    basis = new URL(url).origin;
  } catch {
    // ignore; hash full string
  }

  const h = fnv1a32(basis);
  return String(h > 255 ? h : h + CUSTOM_REFERENCE_FLOOR);
}

/**
 * 32-bit FNV-1a hash (deterministic, fast, no crypto dependency).
 * @param {string} str
 * @returns {number} unsigned 32-bit
 */
export function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    // h *= 16777619 (with 32-bit overflow)
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return h >>> 0;
}
