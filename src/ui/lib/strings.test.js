import { describe, it, expect } from "vitest";
import { truncateMiddle, shortHash, normalizeMnemonic } from "./strings.js";

describe("truncateMiddle", () => {
  it("returns short strings unchanged", () => {
    expect(truncateMiddle("short")).toBe("short");
    expect(truncateMiddle("exactly19chars!!")).toBe("exactly19chars!!");
  });

  it("truncates long strings with ellipsis", () => {
    const long = "0123456789abcdefghijklmnopqrstuvwxyz";
    // Default is head=8, tail=8: "01234567" + "…" + "stuvwxyz"
    expect(truncateMiddle(long)).toBe("01234567…stuvwxyz");
  });

  it("uses custom head/tail lengths", () => {
    const long = "0123456789abcdefghijklmnopqrstuvwxyz";
    expect(truncateMiddle(long, 4, 4)).toBe("0123…wxyz");
    expect(truncateMiddle(long, 10, 5)).toBe("0123456789…vwxyz");
  });

  it("handles null/undefined", () => {
    expect(truncateMiddle(null)).toBe(null);
    expect(truncateMiddle(undefined)).toBe(undefined);
    expect(truncateMiddle("")).toBe("");
  });
});

describe("shortHash", () => {
  it("returns empty string for empty input", () => {
    expect(shortHash("")).toBe("");
    expect(shortHash(null)).toBe("");
    expect(shortHash(undefined)).toBe("");
  });

  it("returns short hashes unchanged", () => {
    expect(shortHash("abc123")).toBe("abc123");
    expect(shortHash("exactly18chars!!")).toBe("exactly18chars!!");
  });

  it("truncates long hashes to 10…8 format", () => {
    const hash = "0x1234567890abcdef1234567890abcdef1234567890abcdef";
    expect(shortHash(hash)).toBe("0x12345678…90abcdef");
  });

  it("uses consistent format for tx hashes", () => {
    const hash = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
    const result = shortHash(hash);
    // shortHash uses 10 head + ellipsis + 8 tail = 19 chars
    expect(result.length).toBe(19);
    expect(result).toBe("a1b2c3d4e5…e5f6a1b2");
  });
});

describe("normalizeMnemonic", () => {
  it("trims whitespace", () => {
    expect(normalizeMnemonic("  word1 word2  ")).toBe("word1 word2");
  });

  it("lowercases all words", () => {
    expect(normalizeMnemonic("Word1 WORD2 WoRd3")).toBe("word1 word2 word3");
  });

  it("normalizes multiple spaces to single space", () => {
    expect(normalizeMnemonic("word1    word2   word3")).toBe("word1 word2 word3");
  });

  it("handles tabs and newlines", () => {
    expect(normalizeMnemonic("word1\nword2\tword3")).toBe("word1 word2 word3");
  });

  it("handles null/undefined", () => {
    expect(normalizeMnemonic(null)).toBe("");
    expect(normalizeMnemonic(undefined)).toBe("");
  });

  it("handles typical 12-word mnemonic", () => {
    const input = "  Abandon  abandon ABANDON abandon  abandon abandon abandon abandon abandon abandon abandon about  ";
    const expected = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    expect(normalizeMnemonic(input)).toBe(expected);
  });
});
