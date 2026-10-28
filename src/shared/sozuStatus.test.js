import { describe, expect, it, vi } from "vitest";

import { createContractReads } from "./contractReads.js";
import { MULTICALL_CONTRACT_ID } from "./multicallFetch.js";
import { getSozuConfig } from "./sozuConfig.js";
import { HUB_NAME_ARGS, decodeBool, decodeContractId, decodeRatio, decodeU64, readSozuStatus } from "./sozuStatus.js";

const NODE = "https://testnet.nodes.dusk.network";
const KNOWN = getSozuConfig("testnet").contracts;
const ACCOUNT = Uint8Array.of(1, 2, 3, 4);

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (text) => Uint8Array.from(text.match(/../g) ?? [], (b) => parseInt(b, 16));
const u64 = (...values) => {
  const out = new Uint8Array(8 * values.length);
  values.forEach((v, i) => new DataView(out.buffer).setBigUint64(8 * i, BigInt(v), true));
  return out;
};
const some = (id) => Uint8Array.of(1, ...fromHex(id));
const NONE = new Uint8Array(33);

// A String as rkyv 0.7 lays it out: up to 7 bytes inline, the length last;
// longer, the bytes first, then the length and the offset back to them.
function rkyvString(text) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= 7) return Uint8Array.of(...bytes, ...new Uint8Array(7 - bytes.length), bytes.length);
  const padded = Math.ceil(bytes.length / 4) * 4;
  const out = new Uint8Array(padded + 8);
  out.set(bytes);
  new DataView(out.buffer).setUint32(padded, bytes.length, true);
  new DataView(out.buffer).setInt32(padded + 4, -padded, true);
  return out;
}

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
    const at = slot + 32 + v.getInt32(slot + 36, true);
    const name = (last & 0x80) === 0 ? b.subarray(slot + 32, slot + 32 + last) : b.subarray(at, at + v.getUint32(slot + 32, true));
    const args = slot + 40 + v.getInt32(slot + 40, true);
    calls.push({ contract: hex(b.subarray(slot, slot + 32)), fnName: new TextDecoder().decode(name), args: hex(b.subarray(args, args + v.getUint32(slot + 44, true))) });
  }
  return calls;
}

// An `aggregate` reply as the contract writes it (rkyv 0.7), a result an
// `Ok` with its bytes or, for null, an `Err`: the call panicked, "refused".
function aggregateReply(results) {
  const align = (n, to) => Math.ceil(n / to) * to;
  const slots = align(results.reduce((n, r) => n + (r?.length ?? 0), 0), 4);
  const root = align(slots + 16 * results.length, 8);
  const out = new Uint8Array(root + 16);
  const view = new DataView(out.buffer);
  let at = 0;
  results.forEach((r, i) => {
    const slot = slots + 16 * i;
    if (r === null) {
      // Err, then Panic, then its message: 7 bytes, inline.
      out[slot] = 1;
      out[slot + 4] = 0;
      out.set(rkyvString("refused"), slot + 8);
      return;
    }
    out.set(r, at);
    view.setInt32(slot + 4, at - (slot + 4), true);
    view.setUint32(slot + 8, r.length, true);
    at += r.length;
  });
  view.setBigUint64(root, 7n, true);
  view.setInt32(root + 8, slots - (root + 8), true);
  view.setUint32(root + 12, results.length, true);
  return out;
}

// A node with Sozu's contracts: the hub names `named`, as it does at the
// time, and every contract answers its reads; the switches are `switches`.
// `fail` names reads that panic, as "<fn>/<args hex>".
function sozuNode({ named = KNOWN, fail = [], nodeUrl = NODE, switches = { "00": Uint8Array.of(0), "01": Uint8Array.of(1) } } = {}) {
  const figures = {
    exchange_rate: u64(8_142_876_697_294_578n, 2_647_997_731_233_173n),
    stake_fee_rate: { "00": u64(25, 10_000), "01": u64(10, 100) },
    is_feature_enabled: switches,
  };
  const answer = ({ contract, fnName, args }) => {
    if (fail.includes(`${fnName}/${args}`)) return null;
    if (fnName === "contract") {
      const name = Object.keys(HUB_NAME_ARGS).find((n) => HUB_NAME_ARGS[n] === args);
      return named[name] ? some(named[name]) : NONE;
    }
    if (fnName === "balance_of") return contract === named.pool ? u64(1_500_000_000_000n) : u64(487_000_000_000n);
    const figure = figures[fnName];
    return figure instanceof Uint8Array ? figure : figure?.[args] ?? null;
  };
  return vi.fn(async (input, init) => {
    if (String(input) !== `${nodeUrl}/on/contracts:${MULTICALL_CONTRACT_ID}/aggregate`) return new Response("Not sent through Multicall", { status: 500 });
    return new Response(aggregateReply(envelopeCalls(init.body).map(answer)));
  });
}

const queries = (node) => node.mock.calls.map(([, init]) => envelopeCalls(init.body).map((c) => `${c.contract.slice(0, 8)}.${c.fnName}`));

describe("readSozuStatus", () => {
  it("reads the hub's names with every figure in one Multicall for Dusk query, and again on each refresh", async () => {
    const node = sozuNode();
    const read = createContractReads({ nodeUrl: NODE, fetch: node });
    const names = new Map();
    const status = await readSozuStatus({ read, nodeUrl: NODE, contracts: KNOWN, account: ACCOUNT, names });

    expect(status).toEqual({
      contracts: { hub: KNOWN.hub, pool: KNOWN.pool, substrate: KNOWN.substrate, "staked-dusk": KNOWN["staked-dusk"] },
      source: "hub",
      pool: { stake: 8_142_876_697_294_578n, supply: 2_647_997_731_233_173n },
      position: { balance: 1_500_000_000_000n, stDusk: 487_000_000_000n },
      fees: { deposit: { numerator: 25n, denominator: 10_000n }, reward: { numerator: 10n, denominator: 100n } },
      features: { maintenance: false, synchronization: true },
      error: "",
    });
    expect(queries(node)).toEqual([
      [
        "bae85f8c.contract",
        "bae85f8c.contract",
        "bae85f8c.contract",
        "72883945.exchange_rate",
        "72883945.balance_of",
        "fdbf4910.balance_of",
        "0077ecbf.stake_fee_rate",
        "0077ecbf.stake_fee_rate",
        "0077ecbf.is_feature_enabled",
        "0077ecbf.is_feature_enabled",
      ],
    ]);
    // Fixed arguments: the names as rkyv Strings, the kinds as one byte, the account as given.
    const sent = envelopeCalls(node.mock.calls[0][1].body);
    expect(sent.slice(0, 3).map((c) => c.args)).toEqual(["pool", "substrate", "staked-dusk"].map((n) => hex(rkyvString(n))));
    expect(sent.slice(3).map((c) => c.args)).toEqual(["", "01020304", "01020304", "00", "01", "00", "01"]);

    // The next refresh asks the hub again, in the same one query: it can name others at any time.
    await readSozuStatus({ read, nodeUrl: NODE, contracts: KNOWN, account: ACCOUNT, names });
    expect(queries(node)).toEqual([queries(node)[0], queries(node)[0]]);
  });

  it("follows the hub when it names another pool later in the session", async () => {
    const named = { ...KNOWN };
    const node = sozuNode({ named });
    const read = createContractReads({ nodeUrl: NODE, fetch: node });
    const names = new Map();
    await readSozuStatus({ read, nodeUrl: NODE, contracts: KNOWN, account: ACCOUNT, names });

    // An upgrade: the hub names a new pool. The next refresh reads it there.
    named.pool = "ee".repeat(32);
    const status = await readSozuStatus({ read, nodeUrl: NODE, contracts: KNOWN, account: ACCOUNT, names });
    expect(status.contracts.pool).toBe("ee".repeat(32));
    expect(status.position.balance).toBe(1_500_000_000_000n);
    expect(queries(node).map((q) => q.length)).toEqual([10, 10, 7]);
    expect(queries(node)[2][0]).toBe("eeeeeeee.exchange_rate");
  });

  it("keeps what the hub named last for a name it can't answer or names none for, and follows it for the others", async () => {
    const named = { ...KNOWN };
    const fail = [];
    const node = sozuNode({ named, fail });
    const read = createContractReads({ nodeUrl: NODE, fetch: node });
    const names = new Map();
    await readSozuStatus({ read, nodeUrl: NODE, contracts: KNOWN, account: ACCOUNT, names });

    // An upgrade names a new pool, in a refresh where the stDUSK name panics.
    named.pool = "ee".repeat(32);
    named["staked-dusk"] = "dd".repeat(32);
    fail.push(`contract/${HUB_NAME_ARGS["staked-dusk"]}`);
    const status = await readSozuStatus({ read, nodeUrl: NODE, contracts: KNOWN, account: ACCOUNT, names });
    expect(status).toMatchObject({
      contracts: { pool: "ee".repeat(32), substrate: KNOWN.substrate, "staked-dusk": KNOWN["staked-dusk"] },
      source: "hub",
      position: { balance: 1_500_000_000_000n },
    });
    expect(queries(node).map((q) => q.length)).toEqual([10, 10, 7]);
    expect(queries(node)[2][0]).toBe("eeeeeeee.exchange_rate");

    // Later the hub answers, but names no pool: the new one stays, not the
    // one known before the upgrade.
    fail.length = 0;
    Object.assign(named, { pool: null, "staked-dusk": KNOWN["staked-dusk"] });
    const unnamed = await readSozuStatus({ read, nodeUrl: NODE, contracts: KNOWN, account: ACCOUNT, names });
    expect(unnamed).toMatchObject({ contracts: { pool: "ee".repeat(32), "staked-dusk": KNOWN["staked-dusk"] }, source: "fallback" });
    expect(queries(node).map((q) => q.length)).toEqual([10, 10, 7, 10]);
    expect(queries(node)[3][3]).toBe("eeeeeeee.exchange_rate");

    // With nothing named for this node yet, both are the ones known before.
    named["staked-dusk"] = "dd".repeat(32);
    fail.push(`contract/${HUB_NAME_ARGS["staked-dusk"]}`);
    const fresh = await readSozuStatus({ read, nodeUrl: NODE, contracts: KNOWN, account: ACCOUNT, names: new Map() });
    expect(fresh).toMatchObject({ contracts: { pool: KNOWN.pool, "staked-dusk": KNOWN["staked-dusk"] }, source: "fallback" });
  });

  it("reads the figures again from the contracts the hub names when they're others, and keeps those", async () => {
    const moved = { pool: "ee".repeat(32), substrate: "cc".repeat(32), "staked-dusk": KNOWN["staked-dusk"] };
    const node = sozuNode({ named: moved });
    const read = createContractReads({ nodeUrl: NODE, fetch: node });
    const names = new Map();
    const status = await readSozuStatus({ read, nodeUrl: NODE, contracts: KNOWN, account: ACCOUNT, names });

    expect(status.contracts).toEqual({ hub: KNOWN.hub, ...moved });
    expect(status.position.balance).toBe(1_500_000_000_000n);
    expect(queries(node).map((q) => q.length)).toEqual([10, 7]);
    expect(queries(node)[1].slice(0, 2)).toEqual(["eeeeeeee.exchange_rate", "eeeeeeee.balance_of"]);

    // The next refresh starts from them, with the hub asked again in the same query.
    await readSozuStatus({ read, nodeUrl: NODE, contracts: KNOWN, account: ACCOUNT, names });
    expect(queries(node).map((q) => q.length)).toEqual([10, 7, 10]);
    expect(queries(node)[2].slice(3, 5)).toEqual(["eeeeeeee.exchange_rate", "eeeeeeee.balance_of"]);
    // Another node asks its own hub.
    const OTHER = "https://other.example";
    const other = sozuNode({ nodeUrl: OTHER });
    await readSozuStatus({ read: createContractReads({ nodeUrl: OTHER, fetch: other }), nodeUrl: OTHER, contracts: KNOWN, account: ACCOUNT, names });
    expect(queries(other)[0].slice(0, 3)).toEqual(["bae85f8c.contract", "bae85f8c.contract", "bae85f8c.contract"]);
  });

  it("keeps a contract known before when the hub names none, and says the hub didn't name them all", async () => {
    const node = sozuNode({ named: { ...KNOWN, "staked-dusk": null } });
    const status = await readSozuStatus({ read: createContractReads({ nodeUrl: NODE, fetch: node }), nodeUrl: NODE, contracts: KNOWN, account: ACCOUNT, names: new Map() });
    expect(status.contracts["staked-dusk"]).toBe(KNOWN["staked-dusk"]);
    expect(status.source).toBe("fallback");
    expect(node).toHaveBeenCalledTimes(1);
  });

  it("uses the contracts known before when the hub can't be read, and asks it again next time", async () => {
    const read = vi.fn(async (id, fnName, args) => {
      if (fnName === "contract") throw new Error("Hub unreachable");
      return fnName === "exchange_rate" || fnName === "stake_fee_rate" ? u64(4, 3) : fnName === "balance_of" ? u64(9) : Uint8Array.of(0);
    });
    const names = new Map();
    const status = await readSozuStatus({ read, nodeUrl: NODE, contracts: KNOWN, account: ACCOUNT, names });
    expect(status).toMatchObject({ source: "fallback", contracts: { pool: KNOWN.pool }, position: { balance: 9n, stDusk: 9n }, error: "" });
    await readSozuStatus({ read, nodeUrl: NODE, contracts: KNOWN, account: ACCOUNT, names });
    expect(read.mock.calls.filter(([, fnName]) => fnName === "contract")).toHaveLength(6);
  });

  it("leaves out only what couldn't be read, and says why", async () => {
    // The substrate refuses the reward fee: no fees, but everything else.
    const node = sozuNode({ fail: ["stake_fee_rate/01"] });
    const status = await readSozuStatus({ read: createContractReads({ nodeUrl: NODE, fetch: node }), nodeUrl: NODE, contracts: KNOWN, account: ACCOUNT, names: new Map() });
    expect(status.fees).toBeNull();
    expect(status.features).toEqual({ maintenance: false, synchronization: true });
    expect(status.pool).not.toBeNull();
    expect(status.error).toBe("refused");
    expect(node).toHaveBeenCalledTimes(1);

    // No stDUSK contract: no stDUSK either, and nothing read for it.
    const read = vi.fn(async (id, fnName) => (fnName === "contract" ? NONE : fnName === "balance_of" ? u64(5) : fnName === "is_feature_enabled" ? Uint8Array.of(0) : u64(1, 400)));
    const bare = await readSozuStatus({ read, nodeUrl: NODE, contracts: { hub: KNOWN.hub, pool: KNOWN.pool, substrate: KNOWN.substrate }, account: ACCOUNT, names: new Map() });
    expect(bare.position).toEqual({ balance: 5n, stDusk: 0n });
    expect(read.mock.calls.filter(([, fnName]) => fnName === "balance_of")).toHaveLength(1);

    // No pool known at all: no figures, and why.
    const none = await readSozuStatus({ read: vi.fn(async () => NONE), nodeUrl: NODE, contracts: { hub: KNOWN.hub }, account: ACCOUNT, names: new Map() });
    expect(none).toMatchObject({
      pool: null,
      position: null,
      fees: null,
      features: { maintenance: null, synchronization: null },
      error: "Sozu's contracts aren't known",
    });
  });

  it("keeps each switch on its own: deposits paused stay paused when synchronization can't be read", async () => {
    const node = sozuNode({ switches: { "00": Uint8Array.of(1) }, fail: ["is_feature_enabled/01"] });
    const status = await readSozuStatus({ read: createContractReads({ nodeUrl: NODE, fetch: node }), nodeUrl: NODE, contracts: KNOWN, account: ACCOUNT, names: new Map() });
    expect(status.features).toEqual({ maintenance: true, synchronization: null });
    expect(status.fees).not.toBeNull();
  });
});

describe("Sozu's replies, read by hand", () => {
  it("names the hub's String arguments as rkyv lays them out", () => {
    for (const name of ["pool", "substrate", "staked-dusk"]) expect(HUB_NAME_ARGS[name]).toBe(hex(rkyvString(name)));
  });

  it("decodes a contract ID or none, a rate, an amount and a yes or no, and refuses anything else", () => {
    expect(decodeContractId(some("ab".repeat(32)))).toBe("ab".repeat(32));
    expect(decodeContractId(NONE)).toBeNull();
    expect(decodeRatio(u64(1, 400))).toEqual({ numerator: 1n, denominator: 400n });
    expect(decodeU64(u64(42))).toBe(42n);
    expect([decodeBool(Uint8Array.of(0)), decodeBool(Uint8Array.of(1))]).toEqual([false, true]);
    expect(() => decodeContractId(Uint8Array.of(0))).toThrow();
    expect(() => decodeContractId(Uint8Array.of(2, ...new Uint8Array(32)))).toThrow();
    expect(() => decodeRatio(new Uint8Array(8))).toThrow();
    expect(() => decodeU64(new Uint8Array(16))).toThrow();
    expect(() => decodeBool(Uint8Array.of(2))).toThrow();
  });
});
