import { describe, expect, it } from "vitest";
import vectors from "@dusk-network/networks/fixtures/sozu-vectors.json";
import {
  duskPerStDusk,
  feePercent,
  leastSozuStake,
  parseFeeRate,
  parsePool,
  sozuFee,
  sozuStake,
  sozuUnstakeAllowed,
} from "@dusk-network/networks/sozu";

// The Sozu test vectors both wallets run, from @dusk-network/networks: the
// rules the wallet's Sozu screens count by.
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
    const quote = sozuStake(BigInt(v.amount), pool(v.pool), deposit(v.fees));
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
      expect(sozuStake(least, pool(v.pool), deposit(v.fees)).ok).toBe(true);
      expect(sozuStake(least - 1n, pool(v.pool), deposit(v.fees)).ok).toBe(false);
    }
  });

  it.each(vectors.unstakes)("takes an unstake of $amount from $balance: $ok", ({ balance, amount, ok }) => {
    expect(sozuUnstakeAllowed(BigInt(amount), BigInt(balance))).toBe(ok);
  });
});
