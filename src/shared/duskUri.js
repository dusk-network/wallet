// Dusk payment URI helpers.
//
// Inspired by Ethereum's EIP-681 / EIP-831 style URIs and Bitcoin's BIP-21.
// This is a Dusk-native scheme used for QR codes / deep links.
//
// Canonical format (v1):
//   dusk:<prefix>-<recipient>[@<chain_id>][?query]
//
// Where:
// - prefix: "public" | "shielded"
// - recipient: base58 string (public account OR shielded address)
// - chain_id: CAIP-2 chain id (e.g. "dusk:1", "dusk:2")
//
// Query params (optional):
// - amount: decimal DUSK string (e.g. "1.25")
// - amountLux: integer Lux string (exact)
// - memo: optional memo/message
// - label: optional label
//
// Parsing intentionally supports ONLY the canonical v1 form above (plus an
// optional raw recipient string).

import { chainIdFromNodeUrl, chainReferenceFromChainId } from "./chain.js";
import { formatLuxToDusk } from "./amount.js";

/**
 * Convert a chain id (CAIP-2) to a decimal string.
 *
 * @param {string} chainIdHex
 * @returns {string} decimal string ("" on failure)
 */
export function chainIdHexToDecimal(chainIdHex) {
  return chainReferenceFromChainId(chainIdHex);
}

/**
 * Build a Dusk URI.
 *
 * @param {{
 *  kind: 'public'|'shielded',
 *  recipient: string,
 *  chainId?: string,
 *  nodeUrl?: string,
 *  amountDusk?: string,
 *  amountLux?: string,
 *  memo?: string,
 *  label?: string,
 * }} opts
 */
export function buildDuskUri(opts) {
  const kind = opts?.kind === "shielded" ? "shielded" : "public";
  const recipient = String(opts?.recipient ?? "").trim();
  if (!recipient) return "";

  // Prefer explicit chainId, otherwise derive from nodeUrl.
  const providedChainId = String(opts?.chainId ?? "").trim();
  const chainId =
    (providedChainId && chainReferenceFromChainId(providedChainId) ? providedChainId : "") ||
    (opts?.nodeUrl ? chainIdFromNodeUrl(opts.nodeUrl) : "");

  let head = `${kind}-${encodeURIComponent(recipient)}`;
  if (chainId) head += `@${chainId}`;

  const params = new URLSearchParams();
  const amountLux = String(opts?.amountLux ?? "").trim();
  const amountDusk = String(opts?.amountDusk ?? "").trim();
  if (amountLux) params.set("amountLux", amountLux);
  else if (amountDusk) params.set("amount", amountDusk);

  const memo = String(opts?.memo ?? "").trim();
  const label = String(opts?.label ?? "").trim();
  if (memo) params.set("memo", memo);
  if (label) params.set("label", label);

  const qs = params.toString();
  return `dusk:${head}${qs ? `?${qs}` : ""}`;
}

/**
 * Parse a Dusk URI (canonical v1) or a raw recipient string.
 *
 * Supported inputs:
 * - Raw base58 recipient string
 * - Canonical Dusk URI: `dusk:public-<recipient>@<chain>?amount=...&memo=...`
 * - Canonical Dusk URI: `dusk:shielded-<recipient>@<chain>?amount=...&memo=...`
 *
 * @param {string} input
 * @returns {{
 *  raw: string,
 *  kind: 'public'|'shielded'|'unknown',
 *  to: string,
 *  chainId: string,
 *  amountDusk: string,
 *  amountLux: string,
 *  memo: string,
 *  label: string,
 * } | null}
 */
export function parseDuskUri(input) {
  const raw = (input ?? "").toString().trim();
  if (!raw) return null;

  // Allow plain strings for convenience (e.g. QR contains only the recipient).
  if (!/^dusk:/i.test(raw)) {
    return {
      raw,
      kind: "unknown",
      to: raw,
      chainId: "",
      amountDusk: "",
      amountLux: "",
      memo: "",
      label: "",
    };
  }

  // Strip `dusk:` prefix and optional `//`
  let rest = raw.replace(/^dusk:/i, "");
  if (rest.startsWith("//")) rest = rest.slice(2);
  rest = rest.replace(/^\/+/, "");

  const qIdx = rest.indexOf("?");
  const headRaw = qIdx >= 0 ? rest.slice(0, qIdx) : rest;
  const query = qIdx >= 0 ? rest.slice(qIdx + 1) : "";
  const params = new URLSearchParams(query);

  // Handle @chain suffix
  let head = headRaw.trim();
  let chainId = "";
  const at = head.lastIndexOf("@");
  if (at > 0) {
    chainId = head.slice(at + 1).trim();
    head = head.slice(0, at).trim();
  }
  if (chainId && !chainReferenceFromChainId(chainId)) {
    return null;
  }

  // Determine kind + strip canonical prefixes
  let kind = "unknown";
  let to = "";
  const low = head.toLowerCase();
  if (low.startsWith("public-")) {
    kind = "public";
    to = head.slice("public-".length);
  } else if (low.startsWith("shielded-")) {
    kind = "shielded";
    to = head.slice("shielded-".length);
  } else {
    // Unknown/unsupported dusk:* URI
    return null;
  }

  try {
    to = decodeURIComponent(to).trim();
  } catch {
    to = (to || "").trim();
  }
  if (!to) return null;

  // Prefer exact Lux amounts if provided.
  const amountLux = (params.get("amountLux") || "").toString().trim();
  let amountDusk = (params.get("amount") || "").toString().trim();
  if (!amountDusk && amountLux) {
    amountDusk = formatLuxToDusk(amountLux);
  }

  const memo = (params.get("memo") || "").toString().trim();
  const label = (params.get("label") || "").toString().trim();

  return {
    raw,
    kind,
    to,
    chainId,
    amountDusk,
    amountLux,
    memo,
    label,
  };
}

/**
 * Best-effort normalization for comparing chain ids.
 * Accepts decimal ("2") or hex ("0x2").
 *
 * @param {string} chain
 * @returns {string} decimal string or ""
 */
export function normalizeChainId(chain) {
  return chainReferenceFromChainId(chain);
}

export function chainLabel(chainDec) {
  const raw = String(chainDec ?? "").trim();
  const c = /^\d+$/.test(raw) ? raw : normalizeChainId(raw);
  if (c === "1") return "Mainnet";
  if (c === "2") return "Testnet";
  if (c === "3") return "Devnet";
  if (c === "0") return "Local";
  return c ? `Chain ${c}` : "";
}
