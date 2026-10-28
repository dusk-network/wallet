import { describe, expect, it, vi } from "vitest";

import { createContractReads } from "./contractReads.js";
import { MULTICALL_CONTRACT_ID } from "./multicallFetch.js";

const NODE = "https://testnet.nodes.dusk.network";
const AGGREGATE = `${NODE}/on/contracts:${MULTICALL_CONTRACT_ID}/aggregate`;
const POOL = "72883945ac1aa032a88543aacc9e358d1dfef07717094c05296ce675f23078f2";
const TOKEN = "fdbf4910".padEnd(64, "0");

const utf8 = new TextEncoder();
const text = new TextDecoder();

// A contract as w3sper's `Contract` gives it: its ID and its driver's encoding.
const contract = (id) => ({ id, encode: async (fnName, args) => utf8.encode(`${fnName}:${JSON.stringify(args ?? null)}`) });

// A driver that decodes an answer as JSON, and says which function it decoded for.
const driver = { decodeOutputFn: (fnName, bytes) => ({ fnName, value: JSON.parse(text.decode(bytes)) }) };

// The calls of an `aggregate` envelope (rkyv 0.7): contract, function, argument.
function envelopeCalls(body) {
  const b = new Uint8Array(body);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const root = b.length - 8;
  const array = root + v.getInt32(root, true);
  const calls = [];
  for (let i = 0; i < v.getUint32(root + 4, true); i++) {
    const slot = array + i * 56;
    const last = b[slot + 39];
    const name =
      (last & 0x80) === 0
        ? b.subarray(slot + 32, slot + 32 + last)
        : b.subarray(slot + 32 + v.getInt32(slot + 36, true), slot + 32 + v.getInt32(slot + 36, true) + v.getUint32(slot + 32, true));
    const args = b.subarray(slot + 40 + v.getInt32(slot + 40, true), slot + 40 + v.getInt32(slot + 40, true) + v.getUint32(slot + 44, true));
    calls.push({
      contract: Array.from(b.subarray(slot, slot + 32), (x) => x.toString(16).padStart(2, "0")).join(""),
      fnName: text.decode(name),
      args: text.decode(args),
    });
  }
  return calls;
}

// An `aggregate` reply as the contract writes it (rkyv 0.7): each result's
// bytes, then one 16-byte slot per result, then the root.
function reply(results, height = 7n) {
  const align = (n, to) => Math.ceil(n / to) * to;
  const data = results.reduce((n, r) => n + r.length, 0);
  const slots = align(data, 4);
  const root = align(slots + 16 * results.length, 8);
  const out = new Uint8Array(root + 16);
  const view = new DataView(out.buffer);
  let at = 0;
  results.forEach((r, i) => {
    const slot = slots + 16 * i;
    out.set(r, at);
    view.setInt32(slot + 4, at - (slot + 4), true);
    view.setUint32(slot + 8, r.length, true);
    at += r.length;
  });
  view.setBigUint64(root, height, true);
  view.setInt32(root + 8, slots - (root + 8), true);
  view.setUint32(root + 12, results.length, true);
  return out;
}

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
  it("sends the reads made together as one Multicall for Dusk query, each encoded and decoded by its driver", async () => {
    const base = node();
    const read = createContractReads({ nodeUrl: `${NODE}/`, fetch: base });

    const answers = await Promise.all([
      read(contract(POOL), driver, "exchange_rate"),
      read(contract(POOL), driver, "balance_of", "acct0"),
      read(contract(TOKEN), driver, "balance_of", "acct0"),
    ]);

    expect(base).toHaveBeenCalledTimes(1);
    expect(String(base.mock.calls[0][0])).toBe(AGGREGATE);
    expect(envelopeCalls(base.mock.calls[0][1].body)).toEqual([
      { contract: POOL, fnName: "exchange_rate", args: "exchange_rate:null" },
      { contract: POOL, fnName: "balance_of", args: 'balance_of:"acct0"' },
      { contract: TOKEN, fnName: "balance_of", args: 'balance_of:"acct0"' },
    ]);
    expect(answers).toEqual([
      { fnName: "exchange_rate", value: "exchange_rate:null" },
      { fnName: "balance_of", value: 'balance_of:"acct0"' },
      { fnName: "balance_of", value: 'balance_of:"acct0"' },
    ]);
  });

  it("sends a read alone in its task as it is", async () => {
    const base = node();
    const read = createContractReads({ nodeUrl: NODE, fetch: base });

    await expect(read(contract(POOL), driver, "exchange_rate")).resolves.toEqual({
      fnName: "exchange_rate",
      value: "exchange_rate:null",
    });
    expect(base).toHaveBeenCalledTimes(1);
    expect(String(base.mock.calls[0][0])).toBe(`${NODE}/on/contracts:${POOL}/exchange_rate`);
  });

  it("fails a read the node refused, with what it said", async () => {
    const base = vi.fn(async () => new Response("Contract does not exist", { status: 500 }));
    const read = createContractReads({ nodeUrl: NODE, fetch: base });

    await expect(read(contract(POOL), driver, "exchange_rate")).rejects.toThrow("Contract does not exist");
  });
});
