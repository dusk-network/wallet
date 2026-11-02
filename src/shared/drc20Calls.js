// A site's DRC20 call as its approval shows it: whom it pays or lets spend,
// and its amount exactly, read from the call's bytes with each token driver
// the wallet has (walletEngine.js):
//
// - drc20_standard: the DRC20 standard in dusk-network/contracts
//   (standards/dusk-contract-standards). Its calls are structs, such as
//   TransferCall { to, amount }, and name accounts as principals:
//   {"Moonlight": "<base58>"}, {"Phoenix": "<base58>"} or {"Contract": "<hex>"}.
// - drc20: older tokens, with { External } or { Contract } accounts and `value`.
// - sozu_staked_dusk: Sozu's stDUSK, the same calls as tuples, an account
//   in base58 and a contract in hex.
//
// A reading counts only when it encodes back to exactly the call's bytes, so
// it says all the call says, and a call shows only when exactly one driver
// reads it so. The standard's driver writes a u64 as a bare JSON integer,
// which JSON.parse rounds above 2^53: that amount is read from the bytes.

const U64_MAX = 18446744073709551615n;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const CONTRACT_ID = /^[0-9a-f]{64}$/i;

// Each driver's calls the approval reads: their parties, then the amount, by
// field name. The standard's are its struct calls (src/token/drc20/types.rs);
// Sozu's tuples hold the parties, then the amount.
const CALLS = {
  drc20_standard: {
    transfer: [["to"], "amount"],
    approve: [["spender"], "amount"],
    transfer_from: [["owner", "to"], "amount"],
    increase_allowance: [["spender"], "added_amount"],
    decrease_allowance: [["spender"], "subtracted_amount"],
  },
  drc20: {
    transfer: [["to"], "value"],
    approve: [["spender"], "value"],
    transfer_from: [["owner", "to"], "value"],
  },
  sozu_staked_dusk: {
    transfer: [["to"]],
    approve: [["spender"]],
    transfer_from: [["owner", "to"]],
  },
};

// How each driver writes an account, by the kind the approval names. The
// approval calls the standard's Phoenix principal a shielded address; it is
// the 32-byte Schnorr key a shielded holder signs with.
const PRINCIPALS = {
  drc20_standard: new Map([
    ["Moonlight", "account"],
    ["Phoenix", "shielded"],
    ["Contract", "contract"],
  ]),
  drc20: new Map([
    ["External", "account"],
    ["Contract", "contract"],
  ]),
};

/** The token calls the approval reads, by name. */
export const DRC20_CALL_NAMES = Object.freeze(Object.keys(CALLS.drc20_standard));

/**
 * @typedef {{ kind: "account" | "shielded" | "contract", value: string }} Drc20Party
 *   `account`: a public account, in base58; `shielded`: a Phoenix principal's
 *   key, in base58; `contract`: a contract ID, 64 hex characters
 * @typedef {{ driver: string, fn: string, amount: string, to?: Drc20Party, spender?: Drc20Party, owner?: Drc20Party }} Drc20Call
 *   `amount`: the call's u64 in the token's smallest unit, in decimal
 */

/**
 * Read a DRC20 call's arguments.
 * @param {Record<string, { decodeInputFn: Function, encodeInputFn: Function }>} drivers - by key, as above
 * @param {string} fnName
 * @param {Uint8Array} bytes - the call's arguments
 * @returns {Drc20Call | { unread: true } | null} null when no driver reads the
 *   bytes; `unread` when one does, but not as one call the wallet knows
 */
export function readDrc20Call(drivers, fnName, bytes) {
  const fn = String(fnName ?? "");
  const readings = [];
  for (const [key, calls] of Object.entries(CALLS)) {
    const driver = drivers?.[key];
    if (!driver || !Object.hasOwn(calls, fn)) continue;
    let decoded;
    try {
      decoded = driver.decodeInputFn(fn, bytes);
    } catch {
      continue;
    }
    let call = null;
    try {
      call = readCall(key, driver, fn, decoded, bytes);
    } catch {
      // A driver that can't write its own reading back.
    }
    readings.push(call && { driver: key, fn, ...call });
  }
  if (!readings.length) return null;
  const readable = readings.filter(Boolean);
  return readable.length === 1 ? readable[0] : { unread: true };
}

// The call as `key`'s driver read it: its parties and amount, when it is one
// the wallet knows and encodes back to exactly `bytes`; else null.
function readCall(key, driver, fn, decoded, bytes) {
  const [names, field] = CALLS[key][fn];
  if (key === "sozu_staked_dusk") {
    if (!Array.isArray(decoded) || decoded.length !== names.length + 1) return null;
    const parties = names.map((name, i) => [name, tupleParty(decoded[i])]);
    return known(parties, u64Text(decoded.at(-1)), () => encodesTo(driver, fn, JSON.stringify(decoded), bytes));
  }
  const struct = decoded && typeof decoded === "object" && !Array.isArray(decoded) && Object.keys(decoded).length === names.length + 1;
  if (!struct) return null;
  const parties = names.map((name) => [name, principal(decoded[name], PRINCIPALS[key])]);
  if (key === "drc20") {
    return known(parties, u64Text(decoded[field]), () => encodesTo(driver, fn, JSON.stringify(decoded), bytes));
  }
  // The standard's amount came as a JSON number, which may be rounded: read it from the bytes.
  if (typeof decoded[field] !== "number" || !parties.every(([, party]) => party)) return null;
  const amount = u64At(driver, fn, decoded, field, bytes);
  return known(parties, amount?.toString() ?? null, () => encodesTo(driver, fn, integerJson({ ...decoded, [field]: amount }), bytes));
}

// A call the wallet knows: each party read, an amount, and the reading encodes back.
function known(parties, amount, encodesBack) {
  if (amount === null || !parties.every(([, party]) => party) || !encodesBack()) return null;
  return { ...Object.fromEntries(parties), amount };
}

// A tuple's party, which Sozu's driver writes untagged: a contract ID, 64
// hex characters, or a public account, in base58.
function tupleParty(value) {
  if (typeof value !== "string") return null;
  if (CONTRACT_ID.test(value)) return { kind: "contract", value };
  return BASE58.test(value) ? { kind: "account", value } : null;
}

function principal(value, kinds) {
  const entries = value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value) : [];
  if (entries.length !== 1) return null;
  const [[name, text]] = entries;
  const kind = kinds.get(name);
  return kind && typeof text === "string" && (kind === "contract" ? CONTRACT_ID : BASE58).test(text) ? { kind, value: text } : null;
}

function u64Text(value) {
  return typeof value === "string" && /^\d{1,20}$/.test(value) && BigInt(value) <= U64_MAX ? BigInt(value).toString() : null;
}

// The u64 the driver writes for `field`: at the 8 bytes that differ between
// the call encoded with 0 there and with the largest u64, read as the
// driver writes it, little-endian. Null without such 8 bytes.
function u64At(driver, fn, decoded, field, bytes) {
  const at = (value) => driver.encodeInputFn(fn, integerJson({ ...decoded, [field]: value }));
  const low = at(0n);
  const high = at(U64_MAX);
  if (low.length !== bytes.length || high.length !== bytes.length) return null;
  const differ = [...low.keys()].filter((i) => low[i] !== high[i]);
  if (differ.length !== 8 || differ[7] - differ[0] !== 7) return null;
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(differ[0], true);
}

// JSON with a bigint written as a bare integer, exactly, as the standard's
// driver reads a u64. Its calls hold no arrays.
function integerJson(value) {
  if (typeof value === "bigint") return value.toString();
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .map(([name, item]) => `${JSON.stringify(name)}:${integerJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function encodesTo(driver, fn, json, bytes) {
  const out = driver.encodeInputFn(fn, json);
  return out.length === bytes.length && out.every((byte, i) => byte === bytes[i]);
}
