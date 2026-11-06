import { vi } from "vitest";

const DAY = 86_400_000;
const u64 = (n) => Array.from({ length: 8 }, (_, i) => Number((BigInt(n) >> BigInt(8 * i)) & 0xffn).toString(16).padStart(2, "0")).join("");
// A pool's reward event: its stake and its stDUSK, 24 and 16 bytes from the end.
const reward = (stake, supply) => `${"00".repeat(40)}${u64(stake)}${u64(supply)}${"00".repeat(8)}`;

/**
 * The archive's answer to a query, as a pool's restakes are listed: one near
 * the tip, and one 30 days before, the pool's stake going from `from` to `to`
 * lux for each 1,000 stDUSK.
 * @param {{ pool: string, tip?: number, now: number, from: bigint, to: bigint }} what
 * @returns {(query: string) => Promise<object>}
 */
export function sozuArchiveQuery({ pool, tip = 4_800_000, now, from, to }) {
  const restakes = [
    { height: tip - 100, id: "a1".repeat(32), at: now - 600_000, stake: to, supply: 1_000_000_000_000n },
    { height: tip - 30 * 8_640, id: "b2".repeat(32), at: now - 600_000 - 30 * DAY, stake: from, supply: 1_000_000_000_000n },
  ];
  return async (text) => {
    const query = String(text ?? "");
    const data = /tip: block\(height: -1\)/.test(query) ? { tip: { header: { height: tip } } } : {};
    for (const [, alias, low, high] of query.matchAll(/(\w+): blockTxs\(range: \[(\d+), (\d+)\]/g)) {
      data[alias] = restakes
        .filter((r) => r.height >= Number(low) && r.height <= Number(high))
        .map((r) => ({ blockHeight: r.height, blockTimestamp: r.at / 1000, err: null, id: r.id, tx: { json: JSON.stringify({ call: { contract: pool, fn_name: "recycle" } }) } }));
    }
    for (const [, alias, height] of query.matchAll(/(\w+): contractEvents\(height: (\d+)\)/g)) {
      const r = restakes.find((each) => each.height === Number(height));
      data[alias] = { json: r ? [{ data: reward(r.stake, r.supply), origin: r.id, reverted: false, source: pool, topic: "reward" }] : [] };
    }
    return data;
  };
}

/**
 * The same archive as a `fetch`, for a test whose archive client is the real one.
 * @param {{ pool: string, tip?: number, now: number, from: bigint, to: bigint }} what
 */
export function sozuArchive(what) {
  const answer = sozuArchiveQuery(what);
  return vi.fn(async (_url, init) => new Response(JSON.stringify({ data: await answer(init?.body) }), { headers: { "content-type": "application/json" } }));
}
