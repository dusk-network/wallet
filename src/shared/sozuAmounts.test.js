import { describe, expect, it } from "vitest";

import vectors from "./fixtures/sozu-vectors.json";
import {
  duskPerStDusk,
  encodeU64,
  feePercent,
  leastSozuStake,
  parseFeeRate,
  parsePool,
  readLux,
  sozuFee,
  sozuStakeQuote,
  sozuUnstakeOk,
  stDuskFor,
} from "./sozuAmounts.js";

// The vectors both wallets run: the same file is in the web wallet.
const fromHex = (hex) => Uint8Array.from(hex.match(/../g), (b) => parseInt(b, 16));
const pool = (name) => parsePool(vectors.pools[name]);
const deposit = (name) => (name ? parseFeeRate(fromHex(vectors.fees[name].deposit)) : null);

describe("Sozu's amounts, from the shared vectors", () => {
  it.each(vectors.feeRates)("reads the $fees $kind fee rate from its bytes, as $percent", ({ bytes, numerator, denominator, percent }) => {
    const rate = parseFeeRate(fromHex(bytes));
    expect(rate).toEqual({ numerator: BigInt(numerator), denominator: BigInt(denominator) });
    expect(feePercent(rate, "en")).toBe(percent);
  });

  it.each(vectors.duskPerStDusk)("prices one stDUSK from the $pool pool", ({ pool: name, lux }) => {
    expect(duskPerStDusk(pool(name))).toBe(lux === null ? null : BigInt(lux));
  });

  it.each(vectors.stakes)("quotes $amount lux on the $pool pool: fee $fee, worth $worth, $stDusk stDUSK", (v) => {
    const quote = sozuStakeQuote(BigInt(v.amount), pool(v.pool), deposit(v.fees));
    expect(quote).toEqual({ fee: BigInt(v.fee), worth: BigInt(v.worth), stDusk: BigInt(v.stDusk), ok: v.ok });
    // The fee rounds up, as the pool takes it.
    expect(sozuFee(BigInt(v.amount), deposit(v.fees))).toBe(BigInt(v.fee));
  });

  it.each(vectors.minimums)("finds the least stake on the $pool pool with the $fees fee: $least lux", (v) => {
    const least = leastSozuStake(pool(v.pool), deposit(v.fees));
    // Null: no stake goes ahead, as at a fee of 100%.
    expect(least).toBe(v.least === null ? null : BigInt(v.least));
    if (v.fees && least !== null) {
      // The least that goes ahead, and nothing under it does.
      expect(sozuStakeQuote(least, pool(v.pool), deposit(v.fees)).ok).toBe(true);
      expect(sozuStakeQuote(least - 1n, pool(v.pool), deposit(v.fees)).ok).toBe(false);
    }
  });

  it.each(vectors.unstakes)("takes an unstake of $amount from $balance: $ok", ({ balance, amount, ok }) => {
    expect(sozuUnstakeOk(BigInt(amount), BigInt(balance))).toBe(ok);
  });
});

describe("Sozu's amounts, as the web wallet's", () => {
  it("encodes an amount as a little-endian u64", () => {
    expect(Array.from(encodeU64(1_000_000_000_000n))).toEqual([0, 16, 165, 212, 232, 0, 0, 0]);
    expect(() => encodeU64(-1n)).toThrow(RangeError);
    expect(() => encodeU64(2n ** 64n)).toThrow(RangeError);
  });

  it("gets what DUSK gets in stDUSK at a rate, and nothing without one", () => {
    const testnet = pool("testnet-2026-10-26");
    expect(stDuskFor(100_000_000_000n, testnet)).toBe(32_519_192_291n);
    expect(stDuskFor(1n, parsePool({}))).toBeNull();
    expect(duskPerStDusk(null)).toBeNull();
    expect(leastSozuStake(null)).toBe(1n);
  });

  it("refuses fee bytes of another size, and reads a missing or negative amount as 0", () => {
    expect(() => parseFeeRate(new Uint8Array(8))).toThrow(RangeError);
    expect(sozuFee(5n, { numerator: 1n, denominator: 0n })).toBe(0n);
    expect(feePercent({ numerator: 1n, denominator: 0n }, "en")).toBe("0%");
    expect([readLux("12"), readLux(-3), readLux("x"), readLux(undefined)]).toEqual([12n, 0n, 0n, 0n]);
  });

  it("has no quote without the pool's rate or the deposit fee", () => {
    expect(sozuStakeQuote(5n, null, deposit("mainnet-2026-10-27"))).toBeNull();
    expect(sozuStakeQuote(5n, pool("mainnet-2026-10-28"), null)).toBeNull();
  });
});

// What the shared vectors don't hold: the 99.99% and 100% fees are there.
describe("Sozu's least stake at fees near 100%", () => {
  const testnet = pool("testnet-2026-10-26");
  const U64_MAX = 2n ** 64n - 1n;

  it("has no least when no stake can go ahead: a fee over 100%, or a least past any u64 amount", () => {
    expect(leastSozuStake(testnet, { numerator: 3n, denominator: 2n })).toBeNull();
    // A pool whose stDUSK is worth a u64's whole, and a fee of 1 lux in u64::MAX.
    expect(leastSozuStake({ stake: U64_MAX, supply: 1n }, { numerator: 1n, denominator: U64_MAX })).toBeNull();
  });

  it("doesn't count its way there: a fee a hair under 100% takes no time", () => {
    const fee = { numerator: 9_999_999n, denominator: 10_000_000n };
    const started = performance.now();
    expect(leastSozuStake(testnet, fee)).toBe(40_000_000n);
    expect(performance.now() - started).toBeLessThan(50);
  });

  it("gives what counting up gives, for small pools and fees", () => {
    for (let stake = 1n; stake <= 40n; stake += 3n) {
      for (let supply = 1n; supply <= 40n; supply += 7n) {
        for (let d = 1n; d <= 12n; d++) {
          for (let n = 0n; n < d; n++) {
            const fee = { numerator: n, denominator: d };
            const least = (stake + supply - 1n) / supply;
            let counted = least;
            while (counted - sozuFee(counted, fee) < least) counted += 1n;
            expect(leastSozuStake({ stake, supply }, fee), `${stake}/${supply} at ${n}/${d}`).toBe(counted);
          }
        }
      }
    }
  });
});
