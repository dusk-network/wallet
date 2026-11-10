// The names of the files the wallet saves: when each was made, to the minute,
// so no two share one, and for a payment request, what it asks.

import { formatDuskPlain } from "@dusk-network/app-core/amounts";

const pad = (n) => String(n).padStart(2, "0");

/**
 * When a file was made, in the device's time: "2026-11-10-0412".
 * @param {number} [at]
 */
export function madeAt(at = Date.now()) {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/**
 * `name` with when it was made before its extension: "dusk-profile-1-testnet-all-2026-11-10-0412.csv".
 * @param {string} name
 * @param {number} [at]
 */
export const stamped = (name, at) => String(name).replace(/(\.[a-z0-9]+)?$/i, (ext) => `-${madeAt(at)}${ext}`);

/**
 * A request picture's name, from what it asks, as the web wallet names one:
 * "dusk-testnet-request-0.05-DUSK-Factura-33", the memo's Latin letters and
 * digits without their accents, a hyphen between, 40 characters at most;
 * then when it was made.
 * @param {{ lux: bigint | string | null, memo?: string }} asked
 * @param {{ network?: string, at?: number }} [opts] - `network`: a test network's name, or ""
 */
export function requestFileName({ lux, memo = "" }, { network = "", at } = {}) {
  const words = Array.from(String(memo ?? "").normalize("NFKD").replace(/\p{M}+/gu, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, ""))
    .slice(0, 40)
    .join("")
    .replace(/-+$/, "");
  const amount = lux === null || lux === undefined ? "" : `${formatDuskPlain(BigInt(lux))}-DUSK`;
  return stamped(["dusk", network.toLowerCase(), "request", amount, words].filter(Boolean).join("-").concat(".png"), at);
}
