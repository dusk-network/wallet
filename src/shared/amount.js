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

/**
 * Lux as DUSK for display: at most `maxDecimals` decimals, thousands grouped.
 * @param {string|bigint|number} luxStr
 * @param {number} [maxDecimals]
 * @returns {string}
 */
export function formatDusk(luxStr, maxDecimals = UI_DISPLAY_DECIMALS) {
  return groupThousands(formatLuxShort(luxStr, maxDecimals));
}

/** Fees show with this many decimals everywhere, so 0.0500 and 0.0025 read alike. */
export const FEE_DECIMALS = 4;

/**
 * A fee in DUSK with exactly FEE_DECIMALS decimals, rounded half up. A fee
 * too small to show at that precision is shown in full rather than as zero.
 * @param {string|bigint|number} luxStr
 * @returns {string}
 */
export function formatFee(luxStr) {
  const lux = safeBigInt(luxStr, 0n);
  if (lux <= 0n) return `0.${"0".repeat(FEE_DECIMALS)}`;
  const step = 10n ** BigInt(LUX_DECIMALS - FEE_DECIMALS);
  const units = (lux + step / 2n) / step;
  if (units === 0n) return formatLuxToDusk(lux);
  const scale = 10n ** BigInt(FEE_DECIMALS);
  const frac = (units % scale).toString().padStart(FEE_DECIMALS, "0");
  return `${groupThousands((units / scale).toString())}.${frac}`;
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
