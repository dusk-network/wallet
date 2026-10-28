import { beforeEach, describe, expect, it, vi } from "vitest";

// Mainnet's provisioners, from one read of /on/node/provisioners (block 5,615,071).
import provisioners from "./fixtures/provisioners-mainnet.json";

const items = vi.hoisted(() => ({}));
vi.mock("./storage.js", () => ({
  STORAGE_KEYS: { NODE_CHAINS: "dusk_node_chains_v1", REWARD_RATES: "dusk_reward_rates_v1" },
  storage: {
    get: async (key) => ({ [key]: items[key] }),
    set: async (patch) => Object.assign(items, patch),
  },
}));

import { RATE_MAX_AGE_MS, nativeRewardRate } from "./rewardRate.js";

const MAINNET = "https://nodes.dusk.network";
const TIP = 5_615_071;
const DAY = RATE_MAX_AGE_MS;

// The node: its provisioners and its tip, as it answers them.
function node({ down = false } = {}) {
  return vi.fn(async (url) => {
    if (down) return new Response("", { status: 503 });
    if (url.endsWith("/on/node/provisioners")) return new Response(JSON.stringify(provisioners));
    if (url.endsWith("/on/graphql/query")) return new Response(JSON.stringify({ pair: { json: { last_block: [TIP, "aa"] } } }));
    return new Response("", { status: 404 });
  });
}

beforeEach(() => {
  for (const key of Object.keys(items)) delete items[key];
});

describe("native staking's yearly estimate", () => {
  it("is about 23% on Mainnet lately, from one read of the node's provisioners and its tip", async () => {
    const fetch = node();
    const rate = await nativeRewardRate(MAINNET, { fetch, now: 1_000 });
    expect(rate).toBeCloseTo(0.235, 3);
    expect(fetch.mock.calls.map(([url, init]) => [url, init.method])).toEqual([
      [`${MAINNET}/on/node/provisioners`, "POST"],
      [`${MAINNET}/on/graphql/query`, "POST"],
    ]);
  });

  it("is read once a day for each network, and kept", async () => {
    const fetch = node();
    await nativeRewardRate(MAINNET, { fetch, now: 1_000 });
    await nativeRewardRate(`${MAINNET}/`, { fetch, now: 1_000 + DAY - 1 });
    expect(fetch).toHaveBeenCalledTimes(2);
    // A day on, it's read again.
    await nativeRewardRate(MAINNET, { fetch, now: 1_000 + DAY });
    expect(fetch).toHaveBeenCalledTimes(4);
    // Callers at once share the read.
    const testnet = node();
    await Promise.all([1, 2, 3].map(() => nativeRewardRate("https://testnet.nodes.dusk.network", { fetch: testnet, now: 5 })));
    expect(testnet).toHaveBeenCalledTimes(2);
    expect(Object.keys(items.dusk_reward_rates_v1)).toEqual(["mainnet", "testnet"]);
  });

  it("is nothing when the node can't be read, and is asked again the next time", async () => {
    await expect(nativeRewardRate(MAINNET, { fetch: node({ down: true }), now: 1_000 })).resolves.toBeNull();
    expect(items.dusk_reward_rates_v1).toBeUndefined();
    const fetch = node();
    await expect(nativeRewardRate(MAINNET, { fetch, now: 1_001 })).resolves.toBeCloseTo(0.235, 3);
    await expect(nativeRewardRate("not a url", { fetch, now: 1_001 })).resolves.toBeNull();
  });
});
