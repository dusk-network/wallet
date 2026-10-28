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
    expect(least).toBe(BigInt(v.least));
    if (v.fees) {
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
    // A fee of the whole amount or more leaves the least as it is.
    expect(leastSozuStake(testnet, { numerator: 1n, denominator: 1n })).toBe(4n);
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
