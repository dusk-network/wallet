import { describe, it, expect } from "vitest";
import {
  DEFAULT_GAS_BY_KIND,
  getDefaultGas,
  applyGasDefaults,
  applyTxDefaults,
  isCompleteGas,
} from "./txDefaults.js";
import { TX_KIND } from "./constants.js";

describe("DEFAULT_GAS_BY_KIND", () => {
  it("has defaults for transfer", () => {
    expect(DEFAULT_GAS_BY_KIND[TX_KIND.TRANSFER]).toEqual({
      limit: "10000000",
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
  });
});

describe("getDefaultGas", () => {
  it("returns defaults for known kinds", () => {
    expect(getDefaultGas("transfer")).toEqual({ limit: "10000000", price: "1" });
    expect(getDefaultGas("shield")).toEqual({ limit: "50000000", price: "1" });
  });

  it("handles case insensitivity", () => {
    expect(getDefaultGas("TRANSFER")).toEqual({ limit: "10000000", price: "1" });
    expect(getDefaultGas("Shield")).toEqual({ limit: "50000000", price: "1" });
  });

  it("returns null for unknown kinds", () => {
    expect(getDefaultGas("unknown")).toBeNull();
    expect(getDefaultGas("")).toBeNull();
    expect(getDefaultGas(null)).toBeNull();
  });
});

describe("applyGasDefaults", () => {
  it("fills missing limit and price", () => {
    const result = applyGasDefaults("transfer", {});
    expect(result).toEqual({ limit: "10000000", price: "1" });
  });

  it("fills missing limit only", () => {
    const result = applyGasDefaults("transfer", { price: "2" });
    expect(result).toEqual({ limit: "10000000", price: "2" });
  });

  it("fills missing price only", () => {
    const result = applyGasDefaults("transfer", { limit: "5000000" });
    expect(result).toEqual({ limit: "5000000", price: "1" });
  });

  it("preserves provided values", () => {
    const result = applyGasDefaults("transfer", { limit: "5000000", price: "2" });
    expect(result).toEqual({ limit: "5000000", price: "2" });
  });

  it("returns null for explicit null (auto sentinel)", () => {
    expect(applyGasDefaults("transfer", null)).toBeNull();
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
    expect(result).toEqual({ limit: "10000000", price: "1" });
  });
});

describe("applyTxDefaults", () => {
  it("applies gas defaults to transfer params", () => {
    const params = { kind: "transfer", to: "abc123" };
    const result = applyTxDefaults(params);
    expect(result).toEqual({
      kind: "transfer",
      to: "abc123",
      gas: { limit: "10000000", price: "1" },
    });
  });

  it("preserves existing gas values", () => {
    const params = { kind: "transfer", to: "abc", gas: { limit: "5000", price: "2" } };
    const result = applyTxDefaults(params);
    expect(result.gas).toEqual({ limit: "5000", price: "2" });
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
    expect(result.gas).toEqual({ limit: "10000000", price: "1" });
  });

  it("removes undefined gas field when no defaults exist", () => {
    const params = { kind: "unknown_kind", to: "abc", gas: undefined };
    const result = applyTxDefaults(params);
    expect(result).toEqual({ kind: "unknown_kind", to: "abc" });
    expect("gas" in result).toBe(false);
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
