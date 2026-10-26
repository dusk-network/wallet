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
 * Clamp a decimal string to `maxDecimals`.
 *
 * Note: we intentionally keep trailing zeros introduced by clamping to avoid
 * inconsistent widths like `1.123` vs `1.1230` across screens.
 * @param {string} numStr
 * @param {number} maxDecimals
 */
export function clampDecimals(numStr, maxDecimals = 4) {
  const s = String(numStr ?? "");
  if (!s.includes(".")) return s;
  const [u, d] = s.split(".");
  const short = d.slice(0, maxDecimals);
  return short ? `${u}.${short}` : u;
}

/**
 * Convenience helper: format Lux -> DUSK and clamp.
 * @param {string|bigint|number} luxStr
 * @param {number} maxDecimals
 */
export function formatLuxShort(luxStr, maxDecimals = 6) {
  const full = formatLuxToDusk(luxStr);
  const clamped = clampDecimals(full, maxDecimals);

  // If clamping would hide a non-zero value (e.g. very small Lux amounts)
  // we fall back to the full (up to 9 decimals) representation.
  const lux = safeBigInt(luxStr);
  // Avoid hiding non-zero values when clamping would produce something
  // that looks like 0 (e.g. 0.0000).
  if (lux !== 0n && /^0(\.0+)?$/.test(clamped)) return full;

  return clamped;
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

// "1.1000" becomes "1.1", and "2.0000" becomes "2".
const trimZeros = (numStr) => String(numStr).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");

/**
 * DUSK as the wallet shows it, the one number format for amounts and fees
 * alike: at most `maxDecimals` (4) decimals, trailing zeros trimmed,
 * thousands grouped. An amount that would show as zero at that precision
 * shows in full.
 * @param {string|bigint|number} luxStr
 * @param {number} [maxDecimals]
 * @returns {string}
 */
export function formatDusk(luxStr, maxDecimals = UI_DISPLAY_DECIMALS) {
  return groupThousands(trimZeros(formatLuxShort(luxStr, maxDecimals)));
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
 * A fee in DUSK, in the one number format: exact up to 4 decimals. Past
 * that, a maximum (`max`, shown as "up to") rounds up, so it never reads
 * lower than it can be, and a fee paid rounds to the nearest (half up). A
 * fee paid too small to show at that precision shows in full, not as zero.
 * @param {string|bigint|number} luxStr
 * @param {{ max?: boolean }} [opts]
 * @returns {string}
 */
export function formatFee(luxStr, { max = false } = {}) {
  const lux = safeBigInt(luxStr, 0n);
  if (lux <= 0n) return "0";
  const step = 10n ** BigInt(LUX_DECIMALS - FEE_DECIMALS);
  const units = max ? (lux + step - 1n) / step : (lux + step / 2n) / step;
  if (units === 0n) return formatLuxToDusk(lux);
  const scale = 10n ** BigInt(FEE_DECIMALS);
  const frac = (units % scale).toString().padStart(FEE_DECIMALS, "0");
  return groupThousands(trimZeros(`${(units / scale).toString()}.${frac}`));
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
