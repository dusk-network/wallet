import { describe, it, expect } from "vitest";
import {
  LUX_DECIMALS,
  LUX_SCALE,
  safeBigInt,
  formatLuxToDusk,
  clampDecimals,
  formatLuxShort,
  parseDuskToLux,
  groupThousands,
  formatDusk,
  formatDuskExact,
  formatFee,
  maxAmountLux,
} from "./amount.js";

describe("amount constants", () => {
  it("LUX_DECIMALS is 9", () => {
    expect(LUX_DECIMALS).toBe(9);
  });

  it("LUX_SCALE is 10^9", () => {
    expect(LUX_SCALE).toBe(10n ** 9n);
  });
});

describe("safeBigInt", () => {
  it("converts valid integer string", () => {
    expect(safeBigInt("123")).toBe(123n);
  });

  it("converts number", () => {
    expect(safeBigInt(456)).toBe(456n);
  });

  it("converts bigint passthrough", () => {
    expect(safeBigInt(789n)).toBe(789n);
  });

  it("returns fallback on invalid input", () => {
    expect(safeBigInt("not a number")).toBe(0n);
    expect(safeBigInt(null)).toBe(0n);
    expect(safeBigInt(undefined)).toBe(0n);
  });

  it("uses custom fallback", () => {
    expect(safeBigInt("invalid", 999n)).toBe(999n);
  });
});

describe("formatLuxToDusk", () => {
  it("formats zero", () => {
    expect(formatLuxToDusk("0")).toBe("0");
    expect(formatLuxToDusk(0n)).toBe("0");
  });

  it("formats whole DUSK amounts", () => {
    expect(formatLuxToDusk("1000000000")).toBe("1");
    expect(formatLuxToDusk("5000000000")).toBe("5");
    expect(formatLuxToDusk(10n * LUX_SCALE)).toBe("10");
  });

  it("formats fractional amounts", () => {
    expect(formatLuxToDusk("1500000000")).toBe("1.5");
    expect(formatLuxToDusk("1234567890")).toBe("1.23456789");
  });

  it("strips trailing zeros from decimals", () => {
    expect(formatLuxToDusk("1100000000")).toBe("1.1");
    expect(formatLuxToDusk("1010000000")).toBe("1.01");
  });

  it("handles sub-1 DUSK amounts", () => {
    expect(formatLuxToDusk("500000000")).toBe("0.5");
    expect(formatLuxToDusk("1")).toBe("0.000000001");
  });

  it("handles large amounts", () => {
    expect(formatLuxToDusk("1000000000000000000")).toBe("1000000000");
  });

  it("returns input string on invalid lux values", () => {
    expect(formatLuxToDusk("not-a-number")).toBe("not-a-number");
  });
});

describe("clampDecimals", () => {
  it("returns string unchanged if no decimals", () => {
    expect(clampDecimals("123")).toBe("123");
  });

  it("clamps to specified precision", () => {
    expect(clampDecimals("1.123456789", 4)).toBe("1.1234");
    expect(clampDecimals("1.123456789", 2)).toBe("1.12");
  });

  it("keeps shorter decimals unchanged", () => {
    expect(clampDecimals("1.12", 4)).toBe("1.12");
  });

  it("defaults to 4 decimals", () => {
    expect(clampDecimals("1.123456789")).toBe("1.1234");
  });

  it("handles edge case with only zeros after clamp", () => {
    expect(clampDecimals("1.0001", 2)).toBe("1.00");
  });
});

describe("formatLuxShort", () => {
  it("formats and clamps", () => {
    expect(formatLuxShort("1234567890", 4)).toBe("1.2345");
  });

  it("preserves very small non-zero values", () => {
    // 1 Lux = 0.000000001 DUSK, clamping to 4 would give "0.0000"
    // But since it's non-zero, should show full value
    expect(formatLuxShort("1", 4)).toBe("0.000000001");
  });

  it("defaults to 6 decimals", () => {
    expect(formatLuxShort("1234567890")).toBe("1.234567");
  });
});

describe("parseDuskToLux", () => {
  it("parses whole numbers", () => {
    expect(parseDuskToLux("1")).toBe("1000000000");
    expect(parseDuskToLux("10")).toBe("10000000000");
  });

  it("parses decimals", () => {
    expect(parseDuskToLux("1.5")).toBe("1500000000");
    expect(parseDuskToLux("0.5")).toBe("500000000");
  });

  it("parses full precision", () => {
    expect(parseDuskToLux("1.234567890")).toBe("1234567890");
  });

  it("pads short decimals", () => {
    expect(parseDuskToLux("1.1")).toBe("1100000000");
  });

  it("truncates excess precision", () => {
    // More than 9 decimals - should truncate
    expect(parseDuskToLux("1.1234567899999")).toBe("1123456789");
  });

  it("throws on invalid input", () => {
    expect(() => parseDuskToLux("abc")).toThrow("Invalid amount");
    expect(() => parseDuskToLux("-1")).toThrow("Invalid amount");
    expect(() => parseDuskToLux("1.2.3")).toThrow("Invalid amount");
  });

  it("handles whitespace", () => {
    expect(parseDuskToLux("  1.5  ")).toBe("1500000000");
  });
});

describe("display formatting", () => {
  it("groups the whole part in thousands and leaves the rest alone", () => {
    expect(groupThousands("1484.9235")).toBe("1,484.9235");
    expect(groupThousands("1234567")).toBe("1,234,567");
    expect(groupThousands("999.123456")).toBe("999.123456");
    expect(groupThousands("-1000")).toBe("-1,000");
    expect(groupThousands("—")).toBe("—");
    expect(formatDusk("1484923500000")).toBe("1,484.9235");
    expect(formatDusk("1000000000000")).toBe("1,000");
  });

  it("shows amounts in one format: at most 4 decimals, no trailing zeros, thousands grouped", () => {
    expect(formatDusk("1100020000")).toBe("1.1");
    expect(formatDusk("2000010000")).toBe("2");
    expect(formatDusk("100000000")).toBe("0.1");
    expect(formatDusk("1234567890123")).toBe("1,234.5678");
    // Too small to show at 4 decimals: in full, never as zero.
    expect(formatDusk("40000")).toBe("0.00004");
    expect(formatDusk("0")).toBe("0");
  });

  it("shows an amount under review exactly, every decimal of it", () => {
    expect(formatDuskExact("1234567891234")).toBe("1,234.567891234");
    expect(formatDuskExact("100000000")).toBe("0.1");
  });

  it("shows a fee exactly up to 4 decimals, rounding a maximum up and a fee paid to the nearest", () => {
    // Up to 4 decimals, exact either way.
    expect([formatFee("2500000"), formatFee("2500000", { max: true })]).toEqual(["0.0025", "0.0025"]);
    // Past them: a fee paid to the nearest, a maximum up, so it never reads lower than it can be.
    expect([formatFee("1840001"), formatFee("1840001", { max: true })]).toEqual(["0.0018", "0.0019"]);
    expect([formatFee("1853542"), formatFee("1853542", { max: true })]).toEqual(["0.0019", "0.0019"]);
    expect([formatFee("1849999"), formatFee("1850000")]).toEqual(["0.0018", "0.0019"]);
    // Too small for 4 decimals: paid, in full; a maximum, up to the smallest step.
    expect([formatFee("40000"), formatFee("40000", { max: true })]).toEqual(["0.00004", "0.0001"]);
    expect(formatFee("0", { max: true })).toBe("0");
  });

  it("shows fees in the same format, rounded half up so a fee never reads lower", () => {
    expect(formatFee("50000000")).toBe("0.05");
    expect(formatFee("2500000")).toBe("0.0025");
    expect(formatFee("500000000")).toBe("0.5");
    expect(formatFee("1234567")).toBe("0.0012");
    expect(formatFee("1250000")).toBe("0.0013");
    expect(formatFee("1853542")).toBe("0.0019");
    expect(formatFee("1500000000000")).toBe("1,500");
    // Too small to show at that precision: in full, never as zero.
    expect(formatFee("40000")).toBe("0.00004");
    expect(formatFee("0")).toBe("0");
  });
});

describe("maxAmountLux", () => {
  it("keeps back what it's asked to, cut down to the 4 decimals amounts show with", () => {
    expect(maxAmountLux(1_480_550_766_286n, 100_000_000n)).toBe(1_480_450_700_000n);
    expect(formatLuxToDusk(maxAmountLux(1_480_550_766_286n, 100_000_000n))).toBe("1480.4507");
    expect(maxAmountLux(5_000_000_000n)).toBe(5_000_000_000n);
    // Never below zero.
    expect(maxAmountLux(50_000_000n, 100_000_000n)).toBe(0n);
    expect(maxAmountLux(100_000_000n, 100_000_000n)).toBe(0n);
  });
});
