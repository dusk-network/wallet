import { formatDusk as formatDuskShared } from "@dusk-network/networks/format";

// Shared amount helpers.
//
// The Dusk protocol uses Lux as the atomic unit:
// 1 DUSK = 1e9 Lux.

export const LUX_DECIMALS = 9;
export const LUX_SCALE = 10n ** 9n;

// UI formatting: keep a consistent decimal width across the app.
// Full precision is still available in tooltips/titles.
export const UI_DISPLAY_DECIMALS = 4;

/**
 * Best-effort BigInt conversion.
 * @param {any} v
 * @param {bigint} fallback
 */
export function safeBigInt(v, fallback = 0n) {
  try {
    return BigInt(v);
  } catch {
    return fallback;
  }
}

/**
 * Format a Lux bigint string into a human-readable DUSK string.
 * @param {string|bigint|number} luxStr
 */
export function formatLuxToDusk(luxStr) {
  try {
    const lux = BigInt(luxStr);
    if (lux === 0n) return "0";

    const units = lux / LUX_SCALE;
    const dec = lux % LUX_SCALE;
    if (dec === 0n) return units.toString();

    const decStr = dec
      .toString()
      .padStart(LUX_DECIMALS, "0")
      .replace(/0+$/, "");

    return `${units.toString()}.${decStr}`;
  } catch {
    return String(luxStr ?? "0");
  }
}

/**
 * A number as shown to people, its whole part grouped in thousands:
 * "1484.9235" becomes "1,484.9235". Inputs keep the plain form; anything that
 * isn't a plain decimal comes back as it is.
 * @param {string|number} numStr
 * @returns {string}
 */
export function groupThousands(numStr) {
  const s = String(numStr ?? "");
  const m = /^(-?)(\d+)(\.\d+)?$/.exec(s);
  if (!m) return s;
  return `${m[1]}${m[2].replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${m[3] ?? ""}`;
}

/**
 * An amount in DUSK as every Dusk app writes one (@dusk-network/networks): at
 * most 4 decimals, but 2 significant digits under 0.01, and never 0 for an
 * amount that isn't; rounded down, so a balance never reads more than there
 * is. In the wallet's separators: "1,484.9235". Anything that isn't a whole
 * number of Lux comes back as it is.
 * @param {string|bigint|number} luxStr
 * @returns {string}
 */
export function formatDusk(luxStr) {
  const lux = safeBigInt(luxStr, null);
  return lux === null ? String(luxStr ?? "0") : formatDuskShared(lux, { round: "down", locale: "en-US" }).text;
}

/**
 * An amount on a Review, exactly as it will be sent: every decimal it has,
 * thousands grouped.
 * @param {string|bigint|number} luxStr
 * @returns {string}
 */
export function formatDuskExact(luxStr) {
  return groupThousands(formatLuxToDusk(luxStr));
}

/** Decimals a fee rounds to: the same 4 as every other amount. */
export const FEE_DECIMALS = UI_DISPLAY_DECIMALS;

/**
 * A fee in DUSK as every Dusk app writes one (@dusk-network/networks): at
 * most 4 decimals, but 2 significant digits under 0.01, and never 0 for a
 * fee that isn't. A maximum (`max`, shown as "up to") rounds up, so it never
 * reads lower than it can be; a fee paid rounds to the nearest. In the
 * wallet's separators: "1,500.0001".
 * @param {string|bigint|number} luxStr
 * @param {{ max?: boolean }} [opts]
 * @returns {string}
 */
export function formatFee(luxStr, { max = false } = {}) {
  const lux = safeBigInt(luxStr, 0n);
  if (lux <= 0n) return "0";
  return formatDuskShared(lux, { round: max ? "up" : "nearest", locale: "en-US" }).text;
}

/**
 * The most a Max puts in an amount field: `availableLux` less what it keeps
 * back, cut down to the 4 decimals amounts show with, so it never reads more
 * than there is.
 * @param {bigint} availableLux
 * @param {bigint} keepLux
 * @returns {bigint}
 */
export function maxAmountLux(availableLux, keepLux = 0n) {
  const step = 10n ** BigInt(LUX_DECIMALS - UI_DISPLAY_DECIMALS);
  const rest = availableLux - keepLux;
  return rest > 0n ? (rest / step) * step : 0n;
}

/**
 * Parse a user-entered DUSK decimal string into Lux (atomic units) string.
 * @param {string} duskStr
 */
export function parseDuskToLux(duskStr) {
  const s = String(duskStr ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new Error("Invalid amount. Use a number like 1 or 0.123");
  }
  const [u, d = ""] = s.split(".");
  const dec = (d + "0".repeat(LUX_DECIMALS)).slice(0, LUX_DECIMALS);
  return (BigInt(u) * LUX_SCALE + BigInt(dec)).toString();
}
