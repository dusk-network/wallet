// A Testnet archive node for tests, answering from the recorded history in
// activity-testnet.json the way the node does. Test-only: nothing in the
// extension imports this.

import { expect, vi } from "vitest";

import fixture from "./activity-testnet.json";

// The archive's `moonlightHistory` paging (rusk node/src/archive/moonlight.rs,
// `limit`): heights up to toBlock, from the first at fromBlock or above, then
// `maxCount` from page `pageCount`, oldest first; null when empty.
export function page(list, { fromBlock = 0, toBlock, maxCount, pageCount = 1 }) {
  let items = list.filter((e) => toBlock === undefined || e.block_height <= toBlock);
  const lower = items.findIndex((e) => e.block_height >= fromBlock);
  items = lower < 0 ? [] : items.slice(lower);
  if (maxCount !== undefined) items = items.slice((pageCount - 1) * maxCount, pageCount * maxCount);
  return items.length ? { json: items } : null;
}

/**
 * Stub `fetch` with a node holding the recorded history. Change `finalized`
 * (its last finalized block), `genesis` or `down` (every request fails) as a
 * test goes; `log` keeps each query and its answer.
 */
export function fakeArchive({ accounts = fixture.accounts, finalized = fixture.head.last_finalized_block[0], genesis = fixture.head.genesis } = {}) {
  const node = { finalized, genesis, down: false, log: [] };
  const fetchMock = vi.fn(async (url, init) => {
    expect(String(url)).toBe(`${fixture.nodeUrl}/on/graphql/query`);
    if (node.down) throw new TypeError("fetch failed");
    const query = String(init.body);
    const data = {};
    if (query.includes("pair: lastBlockPair { json }")) {
      data.pair = { json: { last_block: [node.finalized + 1, "aa"], last_finalized_block: [node.finalized, "bb"] } };
    }
    if (query.includes("genesis: block(height: 0) { header { hash } }")) data.genesis = { header: { hash: node.genesis } };
    for (const m of query.matchAll(/(\w+): moonlightHistory\((sender|receiver): "([^"]+)"((?:, \w+: \d+)*)\) \{ json \}/g)) {
      const args = Object.fromEntries([...m[4].matchAll(/(\w+): (\d+)/g)].map(([, k, v]) => [k, Number(v)]));
      // The archive has finalized blocks only.
      const list = (accounts[m[3]]?.[m[2]] ?? []).filter((e) => e.block_height <= node.finalized);
      data[m[1]] = page(list, args);
    }
    for (const m of query.matchAll(/(t\d+): tx\(hash: "([0-9a-f]{64})"\)/g)) data[m[1]] = fixture.details[m[2]] ?? null;
    node.log.push({ query, data });
    return { ok: true, status: 200, text: async () => JSON.stringify(data) };
  });
  vi.stubGlobal("fetch", fetchMock);
  node.historyQueries = () => node.log.filter((l) => l.query.includes("moonlightHistory"));
  node.detailQueries = () => node.log.filter((l) => l.query.includes("tx(hash:"));
  return node;
}
