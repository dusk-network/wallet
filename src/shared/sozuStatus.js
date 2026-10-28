// What an account has with Sozu, in one Multicall for Dusk query a refresh:
// the contracts Sozu's hub names, the pool's rate, the account's balances
// there, Sozu's fees and its two switches. Every argument but the account is
// fixed bytes and every reply is plain rkyv, so none of these reads needs a
// data driver; the caller encodes the account, as the pool's driver does.
//
// The hub's names are kept for the node and hub once read. Until then, the
// figures are read from the contracts known before, in the same query as the
// names; only when the hub names others are they read again from those.

import { parsePool } from "./sozuAmounts.js";

const fromHex = (hex) => Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));
const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** The names read from the hub, as the status keeps the contracts. */
export const SOZU_NAMES = Object.freeze(["pool", "substrate", "staked-dusk"]);

/**
 * `hub.contract(name)`'s argument: the name as an rkyv 0.7 String, as Sozu's
 * hub data driver (sozu-hub-dd 0.1.0) encodes it. Up to 7 bytes sit inline
 * with their length last; a longer name comes first, then its length and
 * offset.
 */
export const HUB_NAME_ARGS = Object.freeze({
  pool: "706f6f6c00000004",
  substrate: "73756273747261746500000009000000f4ffffff",
  "staked-dusk": "7374616b65642d6475736b000b000000f4ffffff",
});

/** The substrate's enums, one byte each: StakeFeeKind and FeatureKind. */
const KIND = Object.freeze({ deposit: 0, reward: 1, maintenance: 0, synchronization: 1 });

/**
 * `hub.contract`'s reply, an `Option<ContractId>`: a tag, 0 for none or 1,
 * then the 32 bytes of the ID.
 * @param {Uint8Array} bytes
 * @returns {string | null} the ID in hex, or null when the hub names none
 */
export function decodeContractId(bytes) {
  if (bytes?.length !== 33 || bytes[0] > 1) throw new Error("Sozu's hub didn't answer with a contract ID");
  return bytes[0] === 1 ? toHex(bytes.subarray(1)) : null;
}

/**
 * A reply of two u64s, little-endian: a pool's `Rate` and a substrate's
 * `FeeRate`, the numerator first.
 * @param {Uint8Array} bytes
 * @returns {{ numerator: bigint, denominator: bigint }}
 */
export function decodeRatio(bytes) {
  if (bytes?.length !== 16) throw new Error("Sozu didn't answer with a rate");
  const view = new DataView(bytes.buffer, bytes.byteOffset, 16);
  return { numerator: view.getBigUint64(0, true), denominator: view.getBigUint64(8, true) };
}

/**
 * A u64 reply, little-endian: a balance.
 * @param {Uint8Array} bytes
 * @returns {bigint}
 */
export function decodeU64(bytes) {
  if (bytes?.length !== 8) throw new Error("Sozu didn't answer with an amount");
  return new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, true);
}

/**
 * A bool reply: one byte, 0 or 1.
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
export function decodeBool(bytes) {
  if (bytes?.length !== 1 || bytes[0] > 1) throw new Error("Sozu didn't answer yes or no");
  return bytes[0] === 1;
}

/** What each hub named, by node and hub, kept while the wallet runs. */
const kept = new Map();

/**
 * @typedef {(contractId: string, fnName: string, args: Uint8Array) => Promise<Uint8Array>} SozuRead
 * @typedef {{ pool: string|null, substrate: string|null, "staked-dusk": string|null }} SozuContracts
 * @typedef {{ ids: SozuContracts, source: "hub" | "fallback" }} SozuNamed
 */

// The figures, all started at once so they go in the query of the moment.
function readFigures(read, ids, account) {
  const at = (id, fnName, args, decode) =>
    id ? read(id, fnName, args).then(decode) : Promise.reject(new Error("Sozu's contracts aren't known"));
  const reads = [
    at(ids.pool, "exchange_rate", new Uint8Array(0), decodeRatio),
    at(ids.pool, "balance_of", account, decodeU64),
    ids["staked-dusk"] ? at(ids["staked-dusk"], "balance_of", account, decodeU64) : Promise.resolve(0n),
    at(ids.substrate, "stake_fee_rate", Uint8Array.of(KIND.deposit), decodeRatio),
    at(ids.substrate, "stake_fee_rate", Uint8Array.of(KIND.reward), decodeRatio),
    at(ids.substrate, "is_feature_enabled", Uint8Array.of(KIND.maintenance), decodeBool),
    at(ids.substrate, "is_feature_enabled", Uint8Array.of(KIND.synchronization), decodeBool),
  ];
  return Promise.allSettled(reads).then((settled) => {
    const [rate, balance, stDusk, deposit, reward, maintenance, synchronization] = settled.map((r) =>
      r.status === "fulfilled" ? r.value : undefined
    );
    const failed = settled.find((r) => r.status === "rejected");
    const both = (a, b) => a !== undefined && b !== undefined;
    return {
      pool: rate ? parsePool(rate) : null,
      position: both(balance, stDusk) ? { balance, stDusk } : null,
      fees: both(deposit, reward) ? { deposit, reward } : null,
      features: both(maintenance, synchronization) ? { maintenance, synchronization } : null,
      error: failed ? failed.reason?.message ?? String(failed.reason) : "",
    };
  });
}

/**
 * Reads what an account has with Sozu, in one query: the hub's names unless
 * they're kept, and from the pool and the substrate, every figure the
 * staking screens need.
 *
 * @param {{
 *   read: SozuRead,
 *   nodeUrl: string,
 *   contracts: { hub: string } & Partial<SozuContracts>,
 *   account: Uint8Array,
 *   names?: Map<string, SozuNamed>,
 * }} opts - `contracts` are the hub and the contracts known before it
 *   answers; `account` is `balance_of`'s argument, as the pool's driver
 *   encodes the account; `names` keeps what each hub named.
 * @returns {Promise<{
 *   contracts: { hub: string } & SozuContracts,
 *   source: "hub" | "fallback",
 *   pool: { stake: bigint, supply: bigint } | null,
 *   position: { balance: bigint, stDusk: bigint } | null,
 *   fees: { deposit: { numerator: bigint, denominator: bigint }, reward: { numerator: bigint, denominator: bigint } } | null,
 *   features: { maintenance: boolean, synchronization: boolean } | null,
 *   error: string,
 * }>} each figure null when it couldn't be read, and `error` says why
 */
export async function readSozuStatus({ read, nodeUrl, contracts, account, names = kept }) {
  const key = `${nodeUrl}\n${contracts.hub}`;
  const known = Object.fromEntries(SOZU_NAMES.map((name) => [name, contracts[name] ?? null]));
  const held = names.get(key);
  // One task: the hub's names, unless kept, with the figures.
  const asked = held
    ? null
    : Promise.all(SOZU_NAMES.map((name) => read(contracts.hub, "contract", fromHex(HUB_NAME_ARGS[name])).then(decodeContractId)));
  let ids = held?.ids ?? known;
  let source = held?.source ?? "fallback";
  let figures = readFigures(read, ids, account);

  if (asked) {
    const named = await asked.catch(() => null);
    if (named) {
      // A name the hub doesn't have keeps the contract known before.
      const hub = Object.fromEntries(SOZU_NAMES.map((name, i) => [name, named[i] ?? known[name]]));
      source = named.every(Boolean) ? "hub" : "fallback";
      names.set(key, { ids: hub, source });
      if (SOZU_NAMES.some((name) => hub[name] !== ids[name])) {
        ids = hub;
        figures = readFigures(read, ids, account);
      }
    }
  }

  return { contracts: { hub: contracts.hub, ...ids }, source, ...(await figures) };
}
