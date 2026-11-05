import { describe, expect, it, vi } from "vitest";

import { duskEuroPrices } from "./duskPrice.js";

const DAY = 24 * 60 * 60_000;
const NOW = Date.UTC(2026, 10, 5);

// The public API: refuses a range that starts over a year back.
const api = () =>
  vi.fn(async (url) => {
    const params = new URL(url).searchParams;
    const from = Number(params.get("from")) * 1000;
    if (from < NOW - 365 * DAY) return { ok: false, json: async () => ({}) };
    return { ok: true, json: async () => ({ prices: [[from + 60_000, 0.25]] }) };
  });

describe("what a DUSK was worth at a payment", () => {
  it("has a price for a payment near the end of the year the API keeps", async () => {
    const fetch = api();
    const at = NOW - 364 * DAY;
    const price = duskEuroPrices({ fetch, now: () => NOW });
    const [url] = fetch.mock.calls[0] ?? [];
    expect(url).toBeUndefined();
    await price({ at });
    const from = Number(new URL(fetch.mock.calls[0][0]).searchParams.get("from")) * 1000;
    expect(from).toBeGreaterThanOrEqual(NOW - 365 * DAY);
    expect(from).toBeLessThanOrEqual(at);
  });

  it("asks nothing for a payment older than that", async () => {
    const fetch = api();
    await expect(duskEuroPrices({ fetch, now: () => NOW })({ at: NOW - 400 * DAY })).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
