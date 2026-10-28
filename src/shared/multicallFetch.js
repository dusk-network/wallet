// Contract reads sent through Multicall for Dusk: a fetch for the Dusk Domains
// lens reader that puts the reads it makes in one task (`POST
// <node>/on/contracts:<id>/<fn>`) into one `aggregate` query, at most
// MAX_BATCH of them, and answers each read with its own result, as the node
// would have. The reader decodes and checks every reply as before; only the
// transport changes.
//
// As the SDK's own batcher (src/frozen/batching.ts in @duskdomains/sdk 0.5.4,
// MIT), which its full client uses: a read that ran out of its share of gas
// is sent alone, a query that failed whole sends its reads alone (two in a
// row turn batching off for 5 minutes), and a rate limit (a 429, or a 503
// that says when to come back) is every read's answer. A query is cancelled
// once every read in it gave up.

import {
  ARGBUF_LEN,
  MAX_CALLS,
  MULTICALL_CONTRACT_ID,
  callBytes,
  decodeAggregate,
  encodeAggregate,
  envelopeLength,
  replyLength,
} from "../vendor/duskdomains-multicall.js";
import { networkForNode } from "./nodeNetwork.js";

export { MULTICALL_CONTRACT_ID };

/**
 * Reads one aggregate carries. On Testnet, 60 verified primary names (842M gas
 * cap each) passed in one; 32 stays well under the node's 3e9 query gas bound
 * (vm_config.block_gas_limit) and the 64 KiB reply.
 */
export const MAX_BATCH = 32;

/** Reply bytes a query is planned for, below the multicall's 65,536. */
const REPLY_BUDGET = 60_000;
/** A read's reply estimate before one was seen. */
const FIRST_REPLY = 2048;
const STREAK = 2;
const HOLDOFF_MS = 300_000;

// The next task, after this one's microtasks, without the throttling a
// background page puts on timers.
function nextTask(task) {
  if (typeof MessageChannel === "function") {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      task();
    };
    channel.port2.postMessage(null);
    return;
  }
  setTimeout(task, 0);
}

const hexToBytes = (hex) => Uint8Array.from(hex.match(/../g), (b) => parseInt(b, 16));

const bodyBytes = (body) => {
  if (body instanceof Uint8Array) return new Uint8Array(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0));
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
  return null;
};

const ok = (bytes) =>
  new Response(bytes.slice(), { status: 200, headers: { "Content-Type": "application/octet-stream" } });

// Whether a reply is the node limiting its rate, as the SDK's readers take it
// (`rateLimit` in its batching.ts): a 429, or a 503 that says when to come
// back, in seconds or as an HTTP date. Any other 503 is a failed query.
const isRateLimit = (res) => {
  if (res.status !== 503) return res.status === 429;
  const wait = res.headers.get("Retry-After")?.trim() ?? "";
  return /^\d+$/.test(wait) || (Number.isFinite(Date.parse(wait)) && /[a-z]/i.test(wait));
};

// A signal for a request several waiters share: it aborts once each of their
// own signals has, as nobody waits for the answer then. A waiter without a
// signal keeps the request. `release` stops listening to theirs.
const whileAnyWaits = (waiters) => {
  const controller = new AbortController();
  const signals = waiters.map(({ init }) => init?.signal);
  if (signals.some((signal) => !signal)) return { signal: controller.signal, release: () => {} };
  const waiting = new Set(signals);
  const onAbort = () => {
    for (const signal of waiting) if (signal.aborted) waiting.delete(signal);
    if (!waiting.size) controller.abort();
  };
  for (const signal of waiting) signal.addEventListener("abort", onAbort);
  onAbort();
  return {
    signal: controller.signal,
    release: () => {
      for (const signal of signals) signal.removeEventListener("abort", onAbort);
    },
  };
};

/**
 * @param {{
 *   nodeUrl: string,
 *   fetch?: typeof fetch,
 *   gasFor?: (contractId: string, fnName: string) => bigint,
 *   maxBatch?: number,
 * }} opts - `fetch` sends everything else and the aggregates; `gasFor` is a
 *   read's gas cap inside an aggregate, 0n for a fair share of the query's.
 * @returns {typeof fetch}
 */
export function createMulticallFetch({ nodeUrl, fetch: base = (...args) => fetch(...args), gasFor = () => 0n, maxBatch = MAX_BATCH }) {
  const prefix = `${String(nodeUrl).replace(/\/$/, "")}/on/contracts:`;
  // Multicall for Dusk on the node's network, from its file: none on a
  // network without it, or while the node's network isn't known, whose reads
  // go as they are.
  const multicallOf = () => networkForNode(String(nodeUrl ?? ""))?.contracts.multicall ?? null;
  const sizes = new Map();
  let queue = [];
  let pending = new Map();
  let scheduled = false;
  let streak = 0;
  let offUntil = -Infinity;

  const learn = (key, length) => {
    if (length > (sizes.get(key) ?? 0)) sizes.set(key, length);
  };

  // One read sent on its own, its answer given to every waiter; cancelled
  // once they all gave up.
  const alone = (call) => {
    const watch = whileAnyWaits(call.waiters);
    base(call.input, { ...call.waiters[0].init, signal: watch.signal })
      .then(
        (res) => {
          const copies = call.waiters.map((_, i) => (i === call.waiters.length - 1 ? res : res.clone()));
          call.waiters.forEach((waiter, i) => waiter.resolve(copies[i]));
        },
        (error) => {
          for (const waiter of call.waiters) waiter.reject(error);
        }
      )
      .finally(watch.release);
  };

  const plan = (calls) => {
    const batches = [];
    let current = [];
    let data = 0;
    let reply = 0;
    for (const call of calls) {
      const own = callBytes(call.fn, call.args);
      const estimate = sizes.get(`${call.id}/${call.fn}`) ?? FIRST_REPLY;
      if (
        current.length &&
        (current.length >= Math.min(maxBatch, MAX_CALLS) ||
          envelopeLength(current.length + 1, data + own) > ARGBUF_LEN ||
          replyLength(current.length + 1, reply + estimate) > REPLY_BUDGET)
      ) {
        batches.push(current);
        current = [];
        data = 0;
        reply = 0;
      }
      current.push(call);
      data += own;
      reply += estimate;
    }
    if (current.length) batches.push(current);
    return batches;
  };

  // One more query that failed: two in a row turn batching off.
  const strike = () => {
    if (++streak >= STREAK) {
      offUntil = Date.now() + HOLDOFF_MS;
      streak = 0;
    }
  };

  const failed = (batch) => {
    strike();
    for (const call of batch) alone(call);
  };

  const send = async (batch) => {
    // A batch of one gains nothing from the multicall.
    const multicall = multicallOf();
    if (batch.length === 1 || !multicall) return alone(batch[0]);
    let envelope;
    try {
      envelope = encodeAggregate(
        batch.map((c) => ({ contract: hexToBytes(c.id), fnName: c.fn, args: c.args, gasLimit: c.gas }))
      );
    } catch {
      return failed(batch);
    }
    // Cancelled once every read in it gave up waiting, so hung queries don't pile up.
    const watch = whileAnyWaits(batch.flatMap((call) => call.waiters));
    let res;
    let decoded;
    try {
      res = await base(`${prefix}${multicall}/aggregate`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", Accept: "application/octet-stream" },
        body: envelope,
        signal: watch.signal,
      });
      // A rate limit is the node's answer to every read in the query: each
      // gets its wait, and the node's Date, which a wait given as a date
      // counts from. Without it the reader counts from this clock instead.
      if (isRateLimit(res)) {
        const headers = { "Retry-After": res.headers.get("Retry-After") ?? "" };
        const date = res.headers.get("Date");
        if (date) headers.Date = date;
        for (const call of batch) {
          for (const waiter of call.waiters) waiter.resolve(new Response("Rate limited", { status: res.status, headers }));
        }
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      decoded = decodeAggregate(new Uint8Array(await res.arrayBuffer()), batch.length);
    } catch {
      // Nobody waits for the reads of a query they all gave up on: they aren't sent again.
      if (watch.signal.aborted) return strike();
      return failed(batch);
    } finally {
      watch.release();
    }
    streak = 0;
    batch.forEach((call, i) => {
      const result = decoded.results[i];
      if ("Ok" in result) {
        learn(`${call.id}/${call.fn}`, result.Ok.length);
        for (const waiter of call.waiters) waiter.resolve(ok(result.Ok));
        return;
      }
      // Its share of the query's gas was short: a query of its own has it all.
      if (result.Err === "OutOfGas") return alone(call);
      const message = typeof result.Err === "string" ? result.Err : result.Err.Panic;
      for (const waiter of call.waiters) waiter.resolve(new Response(message, { status: 500 }));
    });
  };

  const flush = () => {
    scheduled = false;
    const calls = queue;
    queue = [];
    pending = new Map();
    for (const batch of plan(calls)) void send(batch);
  };

  return function multicallFetch(input, init = {}) {
    const url = String(input?.href ?? input?.url ?? input);
    const match = url.startsWith(prefix) ? /^([0-9a-f]{64})\/([A-Za-z0-9_]+)$/.exec(url.slice(prefix.length)) : null;
    const args = match ? bodyBytes(init.body) : null;
    const multicall = multicallOf();
    if (!match || !args || !multicall || match[1] === multicall || String(init.method).toUpperCase() !== "POST" || Date.now() < offUntil) {
      return base(input, init);
    }
    return new Promise((resolve, reject) => {
      const signal = init.signal;
      if (signal?.aborted) return reject(signal.reason);
      signal?.addEventListener?.("abort", () => reject(signal.reason), { once: true });
      const [, id, fn] = match;
      const key = `${id}/${fn}/${Array.from(args, (b) => b.toString(16).padStart(2, "0")).join("")}`;
      let call = pending.get(key);
      // The same read twice in one task is one call.
      if (!call) {
        call = { id, fn, args, gas: gasFor(id, fn), input, waiters: [] };
        pending.set(key, call);
        queue.push(call);
      }
      call.waiters.push({ init, resolve, reject });
      if (!scheduled) {
        scheduled = true;
        nextTask(flush);
      }
    });
  };
}
