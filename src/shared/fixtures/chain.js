// Another chain for a test, as @dusk-network/app-core/bridge reads it: its
// JSON-RPC, and the logs a transfer's credit is among. Test-only: nothing in
// the extension imports this.

const hex = (n) => `0x${BigInt(n).toString(16)}`;

/** An address as an indexed log topic: 32 bytes, lower case. */
export const topicOf = (address) => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;

/** A 32-byte word of a log's data. */
export const wordOf = (n) => BigInt(n).toString(16).padStart(64, "0");

/**
 * A chain's JSON-RPC at `chain.url`, as `chain` is when it's asked: `head`
 * its newest block, made at `headAt`, each block `blockMs` after the one
 * before, and `logs` ({ address, block, data, hash, topics }), which
 * `eth_getLogs` gives as the chain does: of the contract asked, in the blocks
 * asked, with the topics asked. `asked` keeps each request.
 */
export function fakeChain(chain) {
  const asked = [];
  const timeOf = (n) => Math.floor((chain.headAt - Number(chain.head - n) * chain.blockMs) / 1000);
  const answer = (method, params) => {
    if (method === "eth_blockNumber") return hex(chain.head);
    if (method === "eth_getBlockByNumber") {
      const n = params[0] === "latest" ? chain.head : BigInt(params[0]);
      return { number: hex(n), timestamp: hex(timeOf(n)) };
    }
    const [{ address, fromBlock, toBlock, topics }] = params;
    return chain.logs
      .filter(
        (log) =>
          log.address.toLowerCase() === address &&
          log.block >= BigInt(fromBlock) &&
          log.block <= BigInt(toBlock) &&
          topics.every((topic, i) => topic === null || topic === log.topics[i])
      )
      .map((log) => ({ address: log.address, blockNumber: hex(log.block), data: log.data, topics: log.topics, transactionHash: log.hash }));
  };
  return {
    chain,
    asked,
    methods: () => asked.map(({ method }) => method),
    answers: (url) => String(url) === chain.url,
    async answer(url, init) {
      const { id, method, params } = JSON.parse(String(init?.body));
      asked.push({ method, params });
      return new Response(JSON.stringify({ id, jsonrpc: "2.0", result: answer(method, params) }));
    },
  };
}
