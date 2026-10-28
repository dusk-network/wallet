import { describe, expect, it, vi } from "vitest";

import recorded from "./fixtures/multicall-testnet.json";
import { decodeAggregate, encodeAggregate } from "../vendor/duskdomains-multicall.js";
import { MAX_BATCH, MULTICALL_CONTRACT_ID, createMulticallFetch } from "./multicallFetch.js";
import { aggregateReply as reply } from "./fixtures/multicallCodec.js";
import { noteChainId } from "./nodeNetwork.js";

const NODE = "https://testnet.nodes.dusk.network";
const AGGREGATE = `${NODE}/on/contracts:${MULTICALL_CONTRACT_ID}/aggregate`;
const LENS = "7cb8b9dbd233657aa21d6dd77a4fb24261726d4a5a49d7ec8a246d8350cac913";
const bytes = (hex) => Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));
const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
// The lens reader's gas for a reverse read inside a multicall, as duskNames.js gives it.
const gasFor = (id, fn) => (id === LENS && fn === "reverse" ? 842_000_000n : 0n);
const read = (fn, body = [1, 2, 3]) => [`${NODE}/on/contracts:${LENS}/${fn}`, { method: "POST", body: new Uint8Array(body) }];

function node(answer) {
  return vi.fn(async (input, init) => answer(String(input), init));
}

describe("createMulticallFetch", () => {
  it("sends the lens reads of one task as the aggregate the node answered, and gives each read its result", async () => {
    const base = node((url, init) => {
      expect(url).toBe(AGGREGATE);
      return new Response(bytes(recorded.aggregate.reply), { status: recorded.aggregate.status });
    });
    const fetch = createMulticallFetch({ nodeUrl: NODE, fetch: base, gasFor });
    const answers = await Promise.all(
      recorded.reads.map((r) => fetch(`${NODE}${r.url}`, { method: "POST", body: bytes(r.body) }))
    );

    expect(base).toHaveBeenCalledTimes(1);
    // The envelope is byte for byte the one Testnet answered.
    expect(hex(base.mock.calls[0][1].body)).toBe(recorded.aggregate.envelope);
    const results = decodeAggregate(bytes(recorded.aggregate.reply), recorded.reads.length).results;
    for (const [i, res] of answers.entries()) {
      expect(res.status).toBe(200);
      expect(hex(new Uint8Array(await res.arrayBuffer()))).toBe(hex(results[i].Ok));
    }
  });

  it("makes one call of the same read twice", async () => {
    let calls;
    const base = node((url, init) => {
      calls = decodeEnvelopeCount(init.body);
      return new Response(reply([{ Ok: bytes("0a") }, { Ok: bytes("0b") }]));
    });
    const fetch = createMulticallFetch({ nodeUrl: NODE, fetch: base, gasFor });
    const [a, b, again] = await Promise.all([fetch(...read("reverse", [1])), fetch(...read("reverse", [2])), fetch(...read("reverse", [1]))]);
    expect(calls).toBe(2);
    expect(await a.text()).toBe("\n");
    expect(await again.text()).toBe("\n");
    expect(await b.text()).toBe("\u000b");
  });

  it("sends a lone read as it is", async () => {
    const base = node(() => new Response(bytes("aa")));
    const fetch = createMulticallFetch({ nodeUrl: NODE, fetch: base, gasFor });
    await fetch(...read("binding"));
    expect(base).toHaveBeenCalledTimes(1);
    expect(base.mock.calls[0][0]).toBe(`${NODE}/on/contracts:${LENS}/binding`);
  });

  it("sends a read that ran out of its share of gas again alone", async () => {
    const base = node((url) =>
      url === AGGREGATE ? new Response(reply([{ Ok: bytes("01") }, { Err: "OutOfGas" }])) : new Response(bytes("02"))
    );
    const fetch = createMulticallFetch({ nodeUrl: NODE, fetch: base, gasFor });
    const [first, second] = await Promise.all([fetch(...read("reverse", [1])), fetch(...read("reverse", [2]))]);
    expect(hex(new Uint8Array(await first.arrayBuffer()))).toBe("01");
    expect(hex(new Uint8Array(await second.arrayBuffer()))).toBe("02");
    expect(base.mock.calls.map(([url]) => url)).toEqual([AGGREGATE, `${NODE}/on/contracts:${LENS}/reverse`]);
    expect(Array.from(base.mock.calls[1][1].body)).toEqual([2]);
  });

  it("sends the reads of a query that failed whole alone, and stops batching after two in a row", async () => {
    const base = node((url) => (url === AGGREGATE ? new Response("boom", { status: 500 }) : new Response(bytes("aa"))));
    const fetch = createMulticallFetch({ nodeUrl: NODE, fetch: base, gasFor });
    const pair = () => Promise.all([fetch(...read("reverse", [1])), fetch(...read("reverse", [2]))]);
    for (const res of await pair()) expect(res.status).toBe(200);
    await pair();
    expect(base.mock.calls.filter(([url]) => url === AGGREGATE)).toHaveLength(2);
    await pair();
    // Held off: the third pair went straight to the node.
    expect(base.mock.calls.filter(([url]) => url === AGGREGATE)).toHaveLength(2);
    expect(base).toHaveBeenCalledTimes(8);
  });

  it("sends the reads alone after a 503 that says nothing of when to come back", async () => {
    const base = node((url) => (url === AGGREGATE ? new Response("busy", { status: 503 }) : new Response(bytes("aa"))));
    const fetch = createMulticallFetch({ nodeUrl: NODE, fetch: base, gasFor });
    const answers = await Promise.all([fetch(...read("reverse", [1])), fetch(...read("reverse", [2]))]);
    expect(answers.map((r) => r.status)).toEqual([200, 200]);
    expect(base.mock.calls.map(([url]) => url)).toEqual([AGGREGATE, `${NODE}/on/contracts:${LENS}/reverse`, `${NODE}/on/contracts:${LENS}/reverse`]);
  });

  it.each([["seconds", "3"], ["an HTTP date", "Wed, 21 Oct 2026 07:28:00 GMT"]])(
    "takes a 503 with a wait in %s as a rate limit",
    async (_label, wait) => {
      const base = node(() => new Response("busy", { status: 503, headers: { "Retry-After": wait } }));
      const fetch = createMulticallFetch({ nodeUrl: NODE, fetch: base, gasFor });
      const answers = await Promise.all([fetch(...read("reverse", [1])), fetch(...read("reverse", [2]))]);
      expect(answers.map((r) => [r.status, r.headers.get("Retry-After")])).toEqual([[503, wait], [503, wait]]);
      expect(base).toHaveBeenCalledTimes(1);
    }
  );

  it("cancels a query once every read in it gave up, and sends nothing again", async () => {
    let signal;
    const base = node((url, init) => {
      signal = init.signal;
      return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    });
    const fetch = createMulticallFetch({ nodeUrl: NODE, fetch: base, gasFor });
    const one = new AbortController();
    const two = new AbortController();
    const answers = [
      fetch(`${NODE}/on/contracts:${LENS}/reverse`, { method: "POST", body: new Uint8Array([1]), signal: one.signal }),
      fetch(`${NODE}/on/contracts:${LENS}/reverse`, { method: "POST", body: new Uint8Array([2]), signal: two.signal }),
    ];
    await vi.waitFor(() => expect(base).toHaveBeenCalledTimes(1));
    one.abort();
    expect(signal.aborted).toBe(false);
    two.abort();
    expect(signal.aborted).toBe(true);
    await Promise.allSettled(answers);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(base).toHaveBeenCalledTimes(1);
  });

  it("keeps a query for a read that can't give up", async () => {
    let signal;
    const base = node((url, init) => {
      signal = init.signal;
      return new Response(reply([{ Ok: bytes("01") }, { Ok: bytes("02") }]));
    });
    const fetch = createMulticallFetch({ nodeUrl: NODE, fetch: base, gasFor });
    const one = new AbortController();
    const answers = Promise.allSettled([
      fetch(`${NODE}/on/contracts:${LENS}/reverse`, { method: "POST", body: new Uint8Array([1]), signal: one.signal }),
      fetch(...read("reverse", [2])),
    ]);
    one.abort();
    await answers;
    expect(signal.aborted).toBe(false);
  });

  it("gives every read a rate limit's status and wait", async () => {
    const base = node(() => new Response("slow down", { status: 429, headers: { "Retry-After": "2" } }));
    const fetch = createMulticallFetch({ nodeUrl: NODE, fetch: base, gasFor });
    const answers = await Promise.all([fetch(...read("reverse", [1])), fetch(...read("reverse", [2]))]);
    expect(answers.map((r) => [r.status, r.headers.get("Retry-After")])).toEqual([
      [429, "2"],
      [429, "2"],
    ]);
    expect(base).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a 503 with a wait as a date", 503, "Mon, 26 Oct 2026 04:00:05 GMT"],
    ["a 429 with a wait in seconds", 429, "2"],
  ])("gives every read of %s the node's own Date, which a date's wait counts from", async (_label, status, wait) => {
    const headers = { Date: "Mon, 26 Oct 2026 04:00:00 GMT", "Retry-After": wait };
    const base = node(() => new Response("slow down", { status, headers }));
    const fetch = createMulticallFetch({ nodeUrl: NODE, fetch: base, gasFor });
    const answers = await Promise.all([fetch(...read("reverse", [1])), fetch(...read("reverse", [2]))]);
    expect(answers.map((r) => [r.status, r.headers.get("Date"), r.headers.get("Retry-After")])).toEqual([
      [status, headers.Date, wait],
      [status, headers.Date, wait],
    ]);
    expect(base).toHaveBeenCalledTimes(1);
  });

  it("adds no Date to a rate limit's reads when the node sent none", async () => {
    const base = node(() => new Response("slow down", { status: 429, headers: { "Retry-After": "2" } }));
    const fetch = createMulticallFetch({ nodeUrl: NODE, fetch: base, gasFor });
    const [answer] = await Promise.all([fetch(...read("reverse", [1])), fetch(...read("reverse", [2]))]);
    expect(answer.headers.get("Date")).toBeNull();
  });

  it(`puts at most ${MAX_BATCH} reads in one aggregate`, async () => {
    const sizes = [];
    const base = node((url, init) => {
      const n = decodeEnvelopeCount(init.body);
      sizes.push(n);
      return new Response(reply(Array.from({ length: n }, (_, i) => ({ Ok: new Uint8Array([i]) }))));
    });
    const fetch = createMulticallFetch({ nodeUrl: NODE, fetch: base, gasFor });
    const round = () => Promise.all(Array.from({ length: 70 }, (_, i) => fetch(...read("reverse", [i, i >> 8]))));
    // Before it has seen a reply, a read is planned at 2 KiB, so the reply fits its 64 KiB.
    let answers = await round();
    expect(sizes).toEqual([29, 29, 12]);
    expect(answers.every((r) => r.status === 200)).toBe(true);
    // With these small replies seen, the cap is the count.
    sizes.length = 0;
    answers = await round();
    expect(sizes).toEqual([32, 32, 6]);
    expect(answers.every((r) => r.status === 200)).toBe(true);
  });

  it("batches only on a network whose file has Multicall for Dusk, by the chain ID the node gave", async () => {
    const reads = async (nodeUrl) => {
      const base = node(() => new Response(bytes("aa")));
      const fetch = createMulticallFetch({ nodeUrl, fetch: base, gasFor });
      const at = (fn) => [`${nodeUrl}/on/contracts:${LENS}/${fn}`, { method: "POST", body: new Uint8Array([1]) }];
      await Promise.all([fetch(...at("binding")), fetch(...at("reverse"))]);
      return base.mock.calls.map(([url]) => url.slice(nodeUrl.length));
    };
    // Devnet has none, and a node that hasn't said its network may have none.
    expect(await reads("https://devnet.nodes.dusk.network")).toEqual([`/on/contracts:${LENS}/binding`, `/on/contracts:${LENS}/reverse`]);
    const custom = "https://rusk.example.net";
    expect(await reads(custom)).toHaveLength(2);
    noteChainId(custom, 2);
    // Testnet's: one aggregate (whose reply here is no aggregate, so each read goes alone after it).
    expect(await reads(custom)).toEqual([
      `/on/contracts:${MULTICALL_CONTRACT_ID}/aggregate`,
      `/on/contracts:${LENS}/binding`,
      `/on/contracts:${LENS}/reverse`,
    ]);
  });

  it("leaves other requests alone", async () => {
    const base = node(() => new Response("{}"));
    const fetch = createMulticallFetch({ nodeUrl: NODE, fetch: base, gasFor });
    await Promise.all([
      fetch(`${NODE}/on/graphql/query`, { method: "POST", body: "query { x }" }),
      fetch("https://example.com/driver.wasm"),
      fetch(...read("reverse", [1])),
    ]);
    expect(base.mock.calls.map(([url]) => url)).toEqual([
      `${NODE}/on/graphql/query`,
      "https://example.com/driver.wasm",
      `${NODE}/on/contracts:${LENS}/reverse`,
    ]);
  });
});

// How many calls an envelope carries: its root's length field.
function decodeEnvelopeCount(body) {
  const u8 = new Uint8Array(body);
  return new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(u8.length - 4, true);
}

describe("the vendored codec", () => {
  it("encodes the envelope Testnet answered", () => {
    // reverse, binding, lens_interface, reverse: the lens reader's reads.
    const calls = recorded.reads.map((r) => {
      const fn = r.url.split("/").pop();
      return { contract: bytes(LENS), fnName: fn, args: bytes(r.body), gasLimit: gasFor(LENS, fn) };
    });
    expect(hex(encodeAggregate(calls))).toBe(recorded.aggregate.envelope);
    expect(decodeAggregate(reply([{ Ok: bytes("beef") }, { Err: "OutOfGas" }], 9n), 2)).toEqual({
      height: 9n,
      results: [{ Ok: bytes("beef") }, { Err: "OutOfGas" }],
    });
  });
});
