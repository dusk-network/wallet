// Shared amount helpers.
//
// The Dusk protocol uses Lux as the atomic unit:
// 1 DUSK = 1e9 Lux.

export const LUX_DECIMALS = 9;
export const LUX_SCALE = 10n ** 9n;

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
 * Clamp a decimal string to `maxDecimals`, trimming trailing zeroes for readability.
 * @param {string} numStr
 * @param {number} maxDecimals
 */
export function clampDecimals(numStr, maxDecimals = 4) {
  const s = String(numStr ?? "");
  if (!s.includes(".")) return s;
  const [u, d] = s.split(".");
  const short = d.slice(0, maxDecimals).replace(/0+$/, "");
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
  if (lux !== 0n && (clamped === "0" || clamped === "0.0")) {
    return full;
  }

  return clamped;
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
