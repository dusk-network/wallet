import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * A way back recorded on BNB Smart Chain (fixtures/migration-bsc.json): an
 * approval of the migration contract, the migration that spent it, and the
 * migration's payout on Dusk mainnet.
 */
export const recordedMigration = JSON.parse(readFileSync(path.resolve(process.cwd(), "src", "ui", "testing", "fixtures", "migration-bsc.json"), "utf8"));

/**
 * An EVM chain's JSON-RPC answering from what was recorded: receipts,
 * transactions and blocks by hash and number, and logs by contract, blocks
 * and topics (null any, a list any of its own), as a node gives them. Any
 * other URL than `url` isn't reached.
 * @param {string} url
 * @param {any} [recorded]
 */
export function recordedEvm(url, recorded = recordedMigration) {
  const calls = [];
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = async (input, init) => {
    if (String(input?.url ?? input) !== url) throw new Error(`offline: ${input}`);
    const { id, method, params } = JSON.parse(String(init?.body));
    calls.push(method);
    const answer = (result) => json({ id, jsonrpc: "2.0", result: result ?? null });
    if (method === "eth_blockNumber") return answer(recorded.head);
    if (method === "eth_getTransactionReceipt") return answer(recorded.receipts[String(params[0]).toLowerCase()]);
    if (method === "eth_getTransactionByHash") return answer(recorded.transactions[String(params[0]).toLowerCase()]);
    if (method === "eth_getBlockByNumber") return answer(recorded.blocks[params[0]]);
    if (method === "eth_getLogs") {
      const [{ address, fromBlock, toBlock, topics = [] }] = params;
      const within = (log) => BigInt(log.blockNumber) >= BigInt(fromBlock) && BigInt(log.blockNumber) <= BigInt(toBlock);
      const matches = (log) => topics.every((want, i) => want === null || (Array.isArray(want) ? want.includes(log.topics[i]) : want === log.topics[i]));
      return answer(recorded.logs.filter((log) => log.address.toLowerCase() === String(address).toLowerCase() && within(log) && matches(log)));
    }
    return json({ error: { code: -32601, message: `the method ${method} does not exist` }, id, jsonrpc: "2.0" });
  };
  return { calls, fetch };
}
