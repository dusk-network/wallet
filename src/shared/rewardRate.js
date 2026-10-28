// About what native staking pays a year across the network lately, as
// @dusk-network/networks/rates estimates it from the node's provisioners and
// its tip: read at most once a day for each network, and kept. A read that
// failed is tried again the next time.

import { nativeRateEstimate } from "@dusk-network/networks/rates";

import { fetchWithTimeout } from "./networkStatus.js";
import { networkForNode } from "./nodeNetwork.js";
import { storage, STORAGE_KEYS } from "./storage.js";

/** How long an estimate is kept: a day. */
export const RATE_MAX_AGE_MS = 86_400_000;

const originOf = (url) => {
  try {
    return new URL(String(url ?? "")).origin;
  } catch {
    return "";
  }
};

// The network an estimate is kept for: Dusk's by name, any other by its node.
const keyOf = (nodeUrl) => networkForNode(nodeUrl)?.name ?? originOf(nodeUrl);

async function keptRates() {
  try {
    const items = await storage.get(STORAGE_KEYS.REWARD_RATES);
    const all = items?.[STORAGE_KEYS.REWARD_RATES];
    return all && typeof all === "object" ? all : {};
  } catch {
    return {};
  }
}

const reads = new Map();

async function readRate(origin, fetch) {
  const post = (path, body) =>
    fetch(`${origin}${path}`, { method: "POST", body }, 15_000).then((res) => {
      if (!res.ok) throw new Error(`${path} answered ${res.status}`);
      return res.json();
    });
  const [provisioners, pair] = await Promise.all([
    post("/on/node/provisioners"),
    post("/on/graphql/query", "query { pair: lastBlockPair { json } }"),
  ]);
  const tipHeight = Number(pair?.pair?.json?.last_block?.[0]);
  if (!Array.isArray(provisioners) || !Number.isInteger(tipHeight)) throw new Error("The node's answer isn't a provisioners list and a tip");
  return nativeRateEstimate({ provisioners, tipHeight });
}

/**
 * About what native staking pays a year on the node's network, as a
 * fraction (0.23 for 23%), or null when nothing is staked or it couldn't be
 * read: the estimate kept from the last day, else one read of the node.
 * @param {string} nodeUrl
 * @param {{ now?: number, fetch?: typeof fetchWithTimeout }} [opts]
 * @returns {Promise<number | null>}
 */
export async function nativeRewardRate(nodeUrl, { now = Date.now(), fetch = fetchWithTimeout } = {}) {
  const key = keyOf(nodeUrl);
  const origin = originOf(nodeUrl);
  if (!key || !origin) return null;
  const kept = (await keptRates())[key];
  if (kept && now - kept.at >= 0 && now - kept.at < RATE_MAX_AGE_MS && (kept.rate === null || typeof kept.rate === "number")) {
    return kept.rate;
  }
  let read = reads.get(key);
  if (!read) {
    read = readRate(origin, fetch)
      .then(async (rate) => {
        await storage.set({ [STORAGE_KEYS.REWARD_RATES]: { ...(await keptRates()), [key]: { at: now, rate } } }).catch(() => {});
        return rate;
      })
      .finally(() => reads.delete(key));
    reads.set(key, read);
  }
  return read.catch(() => null);
}
