import { describe, it, expect } from "vitest";
import {
  DEFAULT_TRANSFER_GAS_BY_PRIVACY,
  DEFAULT_GAS_BY_KIND,
  MIN_TRANSFER_GAS_BY_PRIVACY,
  MIN_CONTRACT_CALL_GAS_BY_PRIVACY,
  getDefaultGas,
  getMinimumGas,
  applyGasDefaults,
  applyTxDefaults,
  assertMinimumGas,
  isCompleteGas,
} from "./txDefaults.js";
import { TX_KIND } from "./constants.js";

describe("DEFAULT_GAS_BY_KIND", () => {
  it("has a public fallback default for transfer", () => {
    expect(DEFAULT_GAS_BY_KIND[TX_KIND.TRANSFER]).toEqual({
      limit: "2000000",
      price: "1",
    });
  });

  it("has privacy-aware defaults for transfer", () => {
    expect(DEFAULT_TRANSFER_GAS_BY_PRIVACY.public).toEqual({
      limit: "2000000",
      price: "1",
    });
    expect(DEFAULT_TRANSFER_GAS_BY_PRIVACY.shielded).toEqual({
      limit: "15000000",
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
    expect(getDefaultGas("transfer")).toEqual({ limit: "2000000", price: "1" });
    expect(getDefaultGas("shield")).toEqual({ limit: "50000000", price: "1" });
  });

  it("returns privacy-aware transfer defaults", () => {
    expect(getDefaultGas("transfer", { privacy: "public" })).toEqual({
      limit: "2000000",
      price: "1",
    });
    expect(getDefaultGas("transfer", { privacy: "shielded" })).toEqual({
      limit: "15000000",
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
    expect(getDefaultGas("TRANSFER")).toEqual({ limit: "2000000", price: "1" });
    expect(getDefaultGas("TRANSFER", { privacy: "Shielded" })).toEqual({ limit: "15000000", price: "1" });
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
    expect(getMinimumGas("transfer", { privacy: "shielded" })).toEqual({ limit: "15000000" });
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
});

describe("applyGasDefaults", () => {
  it("fills missing limit and price", () => {
    const result = applyGasDefaults("transfer", {});
    expect(result).toEqual({ limit: "2000000", price: "1" });
  });

  it("fills privacy-aware transfer gas", () => {
    const result = applyGasDefaults("transfer", {}, { privacy: "shielded" });
    expect(result).toEqual({ limit: "15000000", price: "1" });
  });

  it("fills missing limit only", () => {
    const result = applyGasDefaults("transfer", { price: "2" });
    expect(result).toEqual({ limit: "2000000", price: "2" });
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
    expect(applyGasDefaults("transfer", null)).toEqual({ limit: "2000000", price: "1" });
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
    expect(result).toEqual({ limit: "2000000", price: "1" });
  });

  it("rejects under-floor shielded transfer gas", () => {
    expect(() =>
      applyGasDefaults("transfer", { limit: "10000000", price: "1" }, { privacy: "shielded" })
    ).toThrow(/at least 15000000/);
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
});

describe("applyTxDefaults", () => {
  it("applies public gas defaults to transfer params", () => {
    const params = { kind: "transfer", privacy: "public", to: "abc123" };
    const result = applyTxDefaults(params);
    expect(result).toEqual({
      kind: "transfer",
      privacy: "public",
      to: "abc123",
      gas: { limit: "2000000", price: "1" },
    });
  });

  it("applies shielded gas defaults to transfer params", () => {
    const params = { kind: "transfer", privacy: "shielded", to: "abc123" };
    const result = applyTxDefaults(params);
    expect(result).toEqual({
      kind: "transfer",
      privacy: "shielded",
      to: "abc123",
      gas: { limit: "15000000", price: "1" },
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
    expect(result.gas).toEqual({ limit: "2000000", price: "1" });
  });

  it("rejects under-floor shielded transfer params", () => {
    expect(() =>
      applyTxDefaults({
        kind: "transfer",
        privacy: "shielded",
        gas: { limit: "10000000", price: "1" },
      })
    ).toThrow(/at least 15000000/);
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
        { limit: "15000000", price: "1" },
        { privacy: "shielded" }
      )
    ).toEqual({ limit: "15000000", price: "1" });
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
