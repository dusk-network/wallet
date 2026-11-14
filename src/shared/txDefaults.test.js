import { describe, it, expect } from "vitest";
import { DEFAULT_TRANSFER_GAS_BY_PRIVACY, DEFAULT_GAS_BY_KIND, MIN_TRANSFER_GAS_BY_PRIVACY, MIN_CONTRACT_CALL_GAS_BY_PRIVACY, getDefaultGas, getMinimumGas, applyGasDefaults, applyTxDefaults, assertMinimumGas, isCompleteGas, GAS_PRICE_BUSY, defaultGasPriceOf, gasStatsRead } from "./txDefaults.js";
import { TX_KIND } from "./constants.js";

describe("DEFAULT_GAS_BY_KIND", () => {
  it("has a public fallback default for transfer", () => {
    expect(DEFAULT_GAS_BY_KIND[TX_KIND.TRANSFER]).toEqual({
      limit: "2500000",
      price: "1",
    });
  });

  it("has privacy-aware defaults for transfer", () => {
    expect(DEFAULT_TRANSFER_GAS_BY_PRIVACY.public).toEqual({
      limit: "2500000",
      price: "1",
    });
    expect(DEFAULT_TRANSFER_GAS_BY_PRIVACY.shielded).toEqual({
      limit: "50000000",
      price: "1",
    });
  });

  it("has defaults for shield", () => {
    expect(DEFAULT_GAS_BY_KIND[TX_KIND.SHIELD]).toEqual({
      limit: "50000000",
      price: "1",
    });
  });

  it("has defaults for unshield", () => {
    expect(DEFAULT_GAS_BY_KIND[TX_KIND.UNSHIELD]).toEqual({
      limit: "50000000",
      price: "1",
    });
  });

  it("has defaults for contract_call", () => {
    expect(DEFAULT_GAS_BY_KIND[TX_KIND.CONTRACT_CALL]).toEqual({
      limit: "500000000",
      price: "1",
    });
  });

  it("is frozen", () => {
    expect(Object.isFrozen(DEFAULT_GAS_BY_KIND)).toBe(true);
    expect(Object.isFrozen(DEFAULT_GAS_BY_KIND[TX_KIND.TRANSFER])).toBe(true);
    expect(Object.isFrozen(DEFAULT_TRANSFER_GAS_BY_PRIVACY)).toBe(true);
    expect(Object.isFrozen(DEFAULT_TRANSFER_GAS_BY_PRIVACY.shielded)).toBe(true);
    expect(Object.isFrozen(MIN_TRANSFER_GAS_BY_PRIVACY)).toBe(true);
    expect(Object.isFrozen(MIN_CONTRACT_CALL_GAS_BY_PRIVACY)).toBe(true);
  });
});

describe("getDefaultGas", () => {
  it("returns defaults for known kinds", () => {
    expect(getDefaultGas("transfer")).toEqual({ limit: "2500000", price: "1" });
    expect(getDefaultGas("shield")).toEqual({ limit: "50000000", price: "1" });
  });

  it("returns privacy-aware transfer defaults", () => {
    expect(getDefaultGas("transfer", { privacy: "public" })).toEqual({
      limit: "2500000",
      price: "1",
    });
    expect(getDefaultGas("transfer", { privacy: "shielded" })).toEqual({
      limit: "50000000",
      price: "1",
    });
  });

  it("returns conservative shielded staking defaults", () => {
    expect(getDefaultGas("stake", { privacy: "shielded" })).toEqual({
      limit: "500000000",
      price: "1",
    });
    expect(getDefaultGas("unstake", { privacy: "shielded" })).toEqual({
      limit: "500000000",
      price: "1",
    });
    expect(getDefaultGas("withdraw_reward", { privacy: "shielded" })).toEqual({
      limit: "500000000",
      price: "1",
    });
  });

  it("handles case insensitivity", () => {
    expect(getDefaultGas("TRANSFER")).toEqual({ limit: "2500000", price: "1" });
    expect(getDefaultGas("TRANSFER", { privacy: "Shielded" })).toEqual({ limit: "50000000", price: "1" });
    expect(getDefaultGas("Shield")).toEqual({ limit: "50000000", price: "1" });
  });

  it("returns null for unknown kinds", () => {
    expect(getDefaultGas("unknown")).toBeNull();
    expect(getDefaultGas("")).toBeNull();
    expect(getDefaultGas(null)).toBeNull();
  });
});

describe("getMinimumGas", () => {
  it("returns privacy-aware transfer floors", () => {
    expect(getMinimumGas("transfer", { privacy: "public" })).toEqual({ limit: "2000000" });
    expect(getMinimumGas("transfer", { privacy: "shielded" })).toEqual({ limit: "30000000" });
  });

  it("returns a shielded contract-call floor", () => {
    expect(getMinimumGas("contract_call", { privacy: "shielded" })).toEqual({ limit: "100000000" });
    expect(getMinimumGas("contract_call", { privacy: "public" })).toBeNull();
  });

  it("returns shielded staking floors", () => {
    expect(getMinimumGas("stake", { privacy: "shielded" })).toEqual({ limit: "100000000" });
    expect(getMinimumGas("unstake", { privacy: "shielded" })).toEqual({ limit: "100000000" });
    expect(getMinimumGas("withdraw_reward", { privacy: "shielded" })).toEqual({ limit: "100000000" });
  });

  it("returns public staking floors", () => {
    expect(getMinimumGas("stake")).toEqual({ limit: "35000000" });
    expect(getMinimumGas("unstake", { privacy: "public" })).toEqual({ limit: "35000000" });
    expect(getMinimumGas("withdraw_reward")).toEqual({ limit: "35000000" });
  });

  it("returns shield and unshield floors", () => {
    expect(getMinimumGas("shield")).toEqual({ limit: "30000000" });
    expect(getMinimumGas("unshield")).toEqual({ limit: "30000000" });
  });

  it("keeps every default at or above its floor", () => {
    for (const kind of Object.values(TX_KIND)) {
      for (const privacy of ["public", "shielded"]) {
        const min = getMinimumGas(kind, { privacy });
        if (!min) continue;
        expect(BigInt(getDefaultGas(kind, { privacy }).limit)).toBeGreaterThanOrEqual(
          BigInt(min.limit)
        );
      }
    }
  });
});

describe("Sozu's gas", () => {
  it("gives the wallet's public calls of Sozu's pool their own limit and floor, not the contract call default", () => {
    const stake = { privacy: "public", fnName: "sozu_stake" };
    const unstake = { privacy: "public", fnName: "sozu_unstake" };
    expect(getDefaultGas("contract_call", stake)).toEqual({ limit: "5000000", price: "1" });
    expect(getMinimumGas("contract_call", stake)).toEqual({ limit: "2500000" });
    expect(getDefaultGas("contract_call", unstake)).toEqual({ limit: "10000000", price: "1" });
    expect(getMinimumGas("contract_call", unstake)).toEqual({ limit: "4000000" });
    // At 1 LUX, a failed stake costs at most 0.005 DUSK, an unstake 0.01.
    expect(BigInt(getDefaultGas("contract_call", stake).limit)).toBeLessThan(BigInt(DEFAULT_GAS_BY_KIND.contract_call.limit) / 50n);
  });

  it("leaves other calls, shielded ones and other kinds as they were", () => {
    expect(getDefaultGas("contract_call", { privacy: "public", fnName: "transfer" })).toBe(DEFAULT_GAS_BY_KIND.contract_call);
    expect(getMinimumGas("contract_call", { privacy: "public", fnName: "toString" })).toBeNull();
    expect(getMinimumGas("contract_call", { privacy: "shielded", fnName: "sozu_stake" })).toEqual({ limit: "100000000" });
    expect(getDefaultGas("transfer", { privacy: "public", fnName: "sozu_stake" })).toBe(DEFAULT_TRANSFER_GAS_BY_PRIVACY.public);
    // A site's call, which names no function to these defaults, keeps the contract call default.
    expect(applyTxDefaults({ kind: "contract_call", fnName: "sozu_stake" }).gas).toEqual(DEFAULT_GAS_BY_KIND.contract_call);
  });
});

describe("applyGasDefaults", () => {
  it("fills missing limit and price", () => {
    const result = applyGasDefaults("transfer", {});
    expect(result).toEqual({ limit: "2500000", price: "1" });
  });

  it("fills privacy-aware transfer gas", () => {
    const result = applyGasDefaults("transfer", {}, { privacy: "shielded" });
    expect(result).toEqual({ limit: "50000000", price: "1" });
  });

  it("fills missing limit only", () => {
    const result = applyGasDefaults("transfer", { price: "2" });
    expect(result).toEqual({ limit: "2500000", price: "2" });
  });

  it("fills missing price only", () => {
    const result = applyGasDefaults("transfer", { limit: "5000000" });
    expect(result).toEqual({ limit: "5000000", price: "1" });
  });

  it("preserves provided values", () => {
    const result = applyGasDefaults("transfer", { limit: "5000000", price: "2" });
    expect(result).toEqual({ limit: "5000000", price: "2" });
  });

  it("fills defaults for explicit null (auto sentinel)", () => {
    expect(applyGasDefaults("transfer", null)).toEqual({ limit: "2500000", price: "1" });
  });

  it("returns undefined when no defaults exist and gas undefined", () => {
    expect(applyGasDefaults("unknown_kind", undefined)).toBeUndefined();
  });

  it("returns gas unchanged for unknown kind", () => {
    const gas = { limit: "100", price: "1" };
    expect(applyGasDefaults("unknown_kind", gas)).toEqual(gas);
  });

  it("handles empty string values", () => {
    const result = applyGasDefaults("transfer", { limit: "", price: "" });
    expect(result).toEqual({ limit: "2500000", price: "1" });
  });

  it("rejects under-floor shielded transfer gas", () => {
    expect(() =>
      applyGasDefaults("transfer", { limit: "10000000", price: "1" }, { privacy: "shielded" })
    ).toThrow(/at least 30000000/);
  });

  it("rejects under-floor shielded contract-call gas", () => {
    expect(() =>
      applyGasDefaults(
        "contract_call",
        { limit: "99999999", price: "1" },
        { privacy: "shielded" }
      )
    ).toThrow(/at least 100000000/);
  });

  it("rejects under-floor shielded staking gas", () => {
    expect(() =>
      applyGasDefaults("stake", { limit: "99999999", price: "1" }, { privacy: "shielded" })
    ).toThrow(/at least 100000000/);
  });

  it("rejects under-floor public staking gas", () => {
    expect(() => applyGasDefaults("unstake", { limit: "34999999", price: "1" })).toThrow(
      /at least 35000000/
    );
  });

  it("rejects under-floor shield gas", () => {
    expect(() => applyGasDefaults("shield", { limit: "29999999", price: "1" })).toThrow(
      /at least 30000000/
    );
  });
});

describe("applyTxDefaults", () => {
  it("applies public gas defaults to transfer params", () => {
    const params = { kind: "transfer", privacy: "public", to: "abc123" };
    const result = applyTxDefaults(params);
    expect(result).toEqual({
      kind: "transfer",
      privacy: "public",
      to: "abc123",
      gas: { limit: "2500000", price: "1" },
    });
  });

  it("applies shielded gas defaults to transfer params", () => {
    const params = { kind: "transfer", privacy: "shielded", to: "abc123" };
    const result = applyTxDefaults(params);
    expect(result).toEqual({
      kind: "transfer",
      privacy: "shielded",
      to: "abc123",
      gas: { limit: "50000000", price: "1" },
    });
  });

  it("preserves existing gas values", () => {
    const params = { kind: "transfer", to: "abc", gas: { limit: "5000000", price: "2" } };
    const result = applyTxDefaults(params);
    expect(result.gas).toEqual({ limit: "5000000", price: "2" });
  });

  it("returns params unchanged if no kind", () => {
    const params = { to: "abc123" };
    expect(applyTxDefaults(params)).toEqual(params);
  });

  it("returns non-object params unchanged", () => {
    expect(applyTxDefaults(null)).toBeNull();
    expect(applyTxDefaults(undefined)).toBeUndefined();
  });

  it("handles case insensitive kind", () => {
    const params = { kind: "TRANSFER", to: "abc" };
    const result = applyTxDefaults(params);
    expect(result.gas).toEqual({ limit: "2500000", price: "1" });
  });

  it("rejects under-floor shielded transfer params", () => {
    expect(() =>
      applyTxDefaults({
        kind: "transfer",
        privacy: "shielded",
        gas: { limit: "10000000", price: "1" },
      })
    ).toThrow(/at least 30000000/);
  });

  it("rejects under-floor shielded contract-call params", () => {
    expect(() =>
      applyTxDefaults({
        kind: "contract_call",
        privacy: "shielded",
        gas: { limit: "50000000", price: "1" },
      })
    ).toThrow(/at least 100000000/);
  });

  it("applies shielded staking defaults when payment uses address notes", () => {
    expect(applyTxDefaults({ kind: "stake", payment: "address", amount: "1" })).toEqual({
      kind: "stake",
      payment: "address",
      amount: "1",
      gas: { limit: "500000000", price: "1" },
    });
  });

  it("removes undefined gas field when no defaults exist", () => {
    const params = { kind: "unknown_kind", to: "abc", gas: undefined };
    const result = applyTxDefaults(params);
    expect(result).toEqual({ kind: "unknown_kind", to: "abc" });
    expect("gas" in result).toBe(false);
  });
});

describe("assertMinimumGas", () => {
  it("preserves gas at the floor", () => {
    expect(
      assertMinimumGas(
        "transfer",
        { limit: "30000000", price: "1" },
        { privacy: "shielded" }
      )
    ).toEqual({ limit: "30000000", price: "1" });
  });
});

describe("isCompleteGas", () => {
  it("returns true for null/undefined (auto)", () => {
    expect(isCompleteGas(null)).toBe(true);
    expect(isCompleteGas(undefined)).toBe(true);
  });

  it("returns true when both limit and price are set", () => {
    expect(isCompleteGas({ limit: "100", price: "1" })).toBe(true);
  });

  it("returns true when both are missing", () => {
    expect(isCompleteGas({})).toBe(true);
  });

  it("returns false when only limit is set", () => {
    expect(isCompleteGas({ limit: "100" })).toBe(false);
    expect(isCompleteGas({ limit: "100", price: "" })).toBe(false);
    expect(isCompleteGas({ limit: "100", price: null })).toBe(false);
  });

  it("returns false when only price is set", () => {
    expect(isCompleteGas({ price: "1" })).toBe(false);
    expect(isCompleteGas({ limit: "", price: "1" })).toBe(false);
  });

  it("returns false for non-object", () => {
    expect(isCompleteGas("string")).toBe(false);
    expect(isCompleteGas([])).toBe(false);
    expect(isCompleteGas(123)).toBe(false);
  });
});

describe("the default gas price", () => {
  // Lena's, three rounds: the extension's unstake paid 2 where the web wallet's paid 1. Sozu's operator's activation,
  // at 2, waited alone in the mempool, and the median of one is 2. What waits all fits in the next block: the minimum.
  it("is the minimum while what waits in the mempool fits in the next block, and its median, capped, once it doesn't", () => {
    expect(defaultGasPriceOf({ mempool: [{ gasPrice: "2", gasLimit: "6000000" }] })).toMatchObject({ price: 1n, busy: false });
    expect(defaultGasPriceOf({ mempool: [] })).toMatchObject({ price: 1n, busy: false });
    const full = (price) => Array.from({ length: 1000 }, () => ({ gasPrice: String(price), gasLimit: "2500000" }));
    expect(defaultGasPriceOf({ mempool: full(3) })).toMatchObject({ price: 3n, busy: false });
    expect(defaultGasPriceOf({ mempool: full(900) })).toMatchObject({ price: 5n, busy: true, median: 900n });
    // What waits wins over a median, and either one is the node's word; nothing is the minimum.
    expect(defaultGasPriceOf({ mempool: [{ gasPrice: "2", gasLimit: "6000000" }], median: "2" })).toMatchObject({ price: 1n });
    expect([gasStatsRead({ mempool: [] }), gasStatsRead({ median: "2" }), gasStatsRead({})]).toEqual([true, true, false]);
  });

  // Marek's: the default followed the mempool's median with no ceiling, so a spammed mempool raised every default fee.
  // Lena's: the extension's unstake paid price 2 where the web wallet's paid 1. Both wallets use app-core's one rule now.
  it("follows the network's median up to a ceiling of five times the minimum, and says the network is busy over it", () => {
    expect(defaultGasPriceOf({ median: "2" })).toMatchObject({ price: 2n, busy: false });
    expect(defaultGasPriceOf({ median: "900", average: "400" })).toMatchObject({ price: 5n, busy: true, median: 900n });
    // Never under the minimum; and without a median, as before the node answers, the minimum.
    expect(defaultGasPriceOf({ median: "0" })).toMatchObject({ price: 1n, busy: false });
    expect(defaultGasPriceOf(null)).toMatchObject({ price: 1n, busy: false });
    expect(GAS_PRICE_BUSY).toBe("The network is busy. You can raise the gas price for it to go out sooner.");
  });
});
