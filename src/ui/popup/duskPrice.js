// What a DUSK was worth in a currency CoinGecko prices it in, at the time of a payment, for an
// export that asks for it: CoinGecko's hourly prices, a window of them at a time, read once.
// Only the times go out, as a range, never an account. Its public API has the
// past year; older, or a request that fails, is no price, and the export says so.

import { fetchWithTimeout } from "../../shared/networkStatus.js";

const API = "https://api.coingecko.com/api/v3/coins/dusk-network/market_chart/range";
const HOUR_MS = 60 * 60_000;
// Up to 90 days come hourly: what's read with its margins stays within them.
const WINDOW_MS = 88 * 24 * HOUR_MS;
// A price further from the payment than this is no price of it.
const NEAREST_MS = 3 * HOUR_MS;
// How far back the public API goes: a range that starts earlier, it refuses.
const PAST_YEAR_MS = 365 * 24 * HOUR_MS;

/**
 * A lookup of what one DUSK was worth at a time, in `currency` (one of
 * app-core's PRICE_CURRENCIES): null where it isn't known, its windows read
 * once for this lookup.
 * @param {{ currency?: string, fetch?: typeof fetchWithTimeout, now?: () => number }} [opts]
 * @returns {(asked: { at: number }) => Promise<number | null>}
 */
export function duskPrices({ currency = "EUR", fetch = fetchWithTimeout, now = Date.now } = {}) {
  const vs = String(currency || "EUR").toLowerCase();
  const windows = new Map();
  // Kept clear of the API's end by an hour: this device's clock isn't the API's.
  const earliest = () => now() - PAST_YEAR_MS + HOUR_MS;
  const windowFrom = (start) => {
    if (!windows.has(start)) {
      const url = `${API}?vs_currency=${vs}&from=${Math.floor(Math.max(start - NEAREST_MS, earliest()) / 1000)}&to=${Math.ceil((start + WINDOW_MS + NEAREST_MS) / 1000)}`;
      windows.set(
        start,
        fetch(url, {}, 15_000)
          .then((res) => (res.ok ? res.json() : null))
          .then((read) => (Array.isArray(read?.prices) ? read.prices : []))
          .catch(() => [])
      );
    }
    return windows.get(start);
  };
  return async ({ at }) => {
    if (at < now() - PAST_YEAR_MS) return null;
    const prices = await windowFrom(Math.floor(at / WINDOW_MS) * WINDOW_MS);
    let nearest = null;
    for (const point of prices) {
      if (nearest === null || Math.abs(point[0] - at) < Math.abs(nearest[0] - at)) nearest = point;
    }
    return nearest && Math.abs(nearest[0] - at) <= NEAREST_MS && typeof nearest[1] === "number" ? nearest[1] : null;
  };
}
