// Sozu's amounts, as its contracts count them: the web wallet's
// src/lib/sozu/amounts.js, ported as it is, with the stake and unstake rules
// both wallets follow. Both run the same test vectors
// (fixtures/sozu-vectors.json). Amounts are lux, as bigints.

/** Lux in one DUSK, and in one stDUSK. */
const ONE = 1_000_000_000n;

const U64_MAX = 0xffff_ffff_ffff_ffffn;

/**
 * An amount as Sozu's pool takes it: a u64, in 8 bytes, little-endian.
 * @param {bigint} value
 * @returns {Uint8Array}
 */
export function encodeU64(value) {
  if (value < 0n || value > U64_MAX) {
    throw new RangeError("The amount doesn't fit in a u64");
  }
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
}

/**
 * @param {unknown} value
 * @returns {bigint}
 */
const toLux = (value) => {
  try {
    const lux = BigInt(/** @type {string | number | bigint} */ (value ?? 0));
    return lux > 0n ? lux : 0n;
  } catch {
    return 0n;
  }
};

/**
 * The pool's rate as its `exchange_rate` gives it: the DUSK staked through
 * the pool over the stDUSK there is.
 * @param {unknown} rate
 * @returns {{ stake: bigint, supply: bigint }}
 */
export function parsePool(rate) {
  const { denominator, numerator } = /** @type {Record<string, unknown>} */ (rate ?? {});
  return { stake: toLux(numerator), supply: toLux(denominator) };
}

/**
 * A fee rate as Sozu's substrate gives it (`stake_fee_rate`): two
 * little-endian u64s, the numerator, then the denominator.
 * @param {Uint8Array} bytes
 * @returns {{ numerator: bigint, denominator: bigint }}
 */
export function parseFeeRate(bytes) {
  if (bytes.length !== 16) {
    throw new RangeError("A fee rate is 16 bytes");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, 16);
  return {
    denominator: view.getBigUint64(8, true),
    numerator: view.getBigUint64(0, true),
  };
}

/**
 * The fee Sozu takes from `amount` at `rate`, in lux, rounded up as its pool
 * rounds it.
 * @param {bigint} amount
 * @param {{ numerator: bigint, denominator: bigint }} rate
 */
export const sozuFee = (amount, { denominator, numerator }) =>
  denominator > 0n && amount > 0n ? (amount * numerator + denominator - 1n) / denominator : 0n;

/**
 * A fee rate as a percentage: "0.25%", "15%".
 * @param {{ numerator: bigint, denominator: bigint }} rate
 * @param {string} [locale]
 */
export const feePercent = ({ denominator, numerator }, locale) =>
  new Intl.NumberFormat(locale, {
    maximumFractionDigits: 2,
    style: "percent",
  }).format(denominator > 0n ? Number(numerator) / Number(denominator) : 0);

/**
 * About how much stDUSK a stake of `amount` gets now, before any fee Sozu
 * takes; null without a rate.
 * @param {bigint} amount
 * @param {{ stake: bigint, supply: bigint } | null} pool
 * @returns {bigint | null}
 */
export const stDuskFor = (amount, pool) =>
  pool && pool.stake > 0n && pool.supply > 0n ? (amount * pool.supply) / pool.stake : null;

/**
 * The least a stake gets any stDUSK for at the rate now, in lux, after the
 * deposit fee where it's known: 1 without a rate.
 * @param {{ stake: bigint, supply: bigint } | null} pool
 * @param {{ numerator: bigint, denominator: bigint } | null} [depositFee]
 * @returns {bigint}
 */
export function leastSozuStake(pool, depositFee = null) {
  const least = pool && pool.stake > 0n && pool.supply > 0n ? (pool.stake + pool.supply - 1n) / pool.supply : 1n;
  if (!depositFee || depositFee.numerator >= depositFee.denominator) {
    return least;
  }
  // What's left after the fee, rounded up, must be at least that.
  let amount = least;
  while (amount - sozuFee(amount, depositFee) < least) {
    amount += 1n;
  }
  return amount;
}

/**
 * What one stDUSK is worth now, in lux; null without a rate.
 * @param {{ stake: bigint, supply: bigint } | null} pool
 * @returns {bigint | null}
 */
export const duskPerStDusk = (pool) => (pool && pool.stake > 0n && pool.supply > 0n ? (ONE * pool.stake) / pool.supply : null);

/**
 * An amount the pool's reads give, as lux.
 * @param {unknown} value
 */
export const readLux = toLux;

/**
 * A stake of `amount` at the pool's rate now: Sozu's deposit fee, rounded
 * up; what's left, which the stDUSK is worth now; and the stDUSK it gets,
 * rounded down, 1:1 while the pool is empty, as the pool mints it. It goes
 * ahead (`ok`) only when the fee leaves something and that gets at least 1
 * lux of stDUSK: anything less, the pool refuses, and the call is charged
 * its whole gas limit. Null without the pool's rate or the fee.
 * @param {bigint} amount
 * @param {{ stake: bigint, supply: bigint } | null} pool
 * @param {{ numerator: bigint, denominator: bigint } | null} depositFee
 * @returns {{ fee: bigint, worth: bigint, stDusk: bigint, ok: boolean } | null}
 */
export function sozuStakeQuote(amount, pool, depositFee) {
  if (!pool || !depositFee) return null;
  const fee = sozuFee(amount, depositFee);
  const worth = amount > fee ? amount - fee : 0n;
  const stDusk = worth > 0n ? stDuskFor(worth, pool) ?? worth : 0n;
  return { fee, worth, stDusk, ok: amount > fee && stDusk >= 1n };
}

/**
 * Whether Sozu's pool takes an unstake of `amount`: more than 0, and no
 * more than its `balance_of` the account, which is the most there is.
 * @param {bigint} amount
 * @param {bigint} balance
 */
export const sozuUnstakeOk = (amount, balance) => amount > 0n && amount <= balance;
