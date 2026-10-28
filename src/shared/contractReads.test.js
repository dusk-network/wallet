import { describe, expect, it, vi } from "vitest";

import { createContractReads } from "./contractReads.js";
import { MULTICALL_CONTRACT_ID } from "./multicallFetch.js";
import { aggregateReply as reply, envelopeCalls } from "./fixtures/multicallCodec.js";

const NODE = "https://testnet.nodes.dusk.network";
const AGGREGATE = `${NODE}/on/contracts:${MULTICALL_CONTRACT_ID}/aggregate`;
const POOL = "72883945ac1aa032a88543aacc9e358d1dfef07717094c05296ce675f23078f2";
const TOKEN = "fdbf4910".padEnd(64, "0");

const utf8 = new TextEncoder();
const text = new TextDecoder();

// What the node answers a read alone: its argument back, as JSON.
const answerOf = ({ args }) => utf8.encode(JSON.stringify(args));

function node() {
  return vi.fn(async (input, init) => {
    const url = String(input);
    if (url === AGGREGATE) return new Response(reply(envelopeCalls(init.body).map(answerOf)));
    const [, , fnName] = url.match(/contracts:([0-9a-f]{64})\/(\w+)$/);
    return new Response(answerOf({ args: text.decode(init.body), fnName }));
  });
}

describe("createContractReads", () => {
  it("sends the reads made together as one Multicall for Dusk query, each with its argument, and gives each its reply", async () => {
    const base = node();
    const read = createContractReads({ nodeUrl: `${NODE}/`, fetch: base });

    const answers = await Promise.all([
      read(POOL, "exchange_rate", new Uint8Array(0)),
      read(POOL, "balance_of", utf8.encode("acct0")),
      read(TOKEN, "balance_of", utf8.encode("acct0")),
    ]);

    expect(base).toHaveBeenCalledTimes(1);
    expect(String(base.mock.calls[0][0])).toBe(AGGREGATE);
    expect(envelopeCalls(base.mock.calls[0][1].body)).toEqual([
      { contract: POOL, fnName: "exchange_rate", args: "" },
      { contract: POOL, fnName: "balance_of", args: "acct0" },
      { contract: TOKEN, fnName: "balance_of", args: "acct0" },
    ]);
    expect(answers.map((bytes) => text.decode(bytes))).toEqual(['""', '"acct0"', '"acct0"']);
    expect(answers.every((bytes) => bytes instanceof Uint8Array)).toBe(true);
  });

  it("sends a read alone in its task as it is", async () => {
    const base = node();
    const read = createContractReads({ nodeUrl: NODE, fetch: base });

    expect(text.decode(await read(POOL, "balance_of", utf8.encode("acct0")))).toBe('"acct0"');
    expect(base).toHaveBeenCalledTimes(1);
    expect(String(base.mock.calls[0][0])).toBe(`${NODE}/on/contracts:${POOL}/balance_of`);
  });

  it("fails a read the node refused, with what it said", async () => {
    const base = vi.fn(async () => new Response("Contract does not exist", { status: 500 }));
    const read = createContractReads({ nodeUrl: NODE, fetch: base });

    await expect(read(POOL, "exchange_rate", new Uint8Array(0))).rejects.toThrow("Contract does not exist");
    const silent = createContractReads({ nodeUrl: NODE, fetch: vi.fn(async () => new Response("", { status: 503 })) });
    await expect(silent(POOL, "exchange_rate", new Uint8Array(0))).rejects.toThrow("HTTP 503");
  });
});
