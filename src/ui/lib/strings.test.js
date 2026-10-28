import { describe, it, expect } from "vitest";
import { truncateMiddle, shortAddress, shortHash, normalizeMnemonic, siteName } from "./strings.js";

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

describe("shortAddress", () => {
  it("keeps the first and last six characters, and short input as it is", () => {
    expect(shortAddress("0123456789abcdefghijklmnopqrstuvwxyz")).toBe("012345…uvwxyz");
    expect(shortAddress("0123456789abcdef")).toBe("012345…abcdef");
    // Six, six and the "…" would make these no shorter.
    for (const input of ["0123456789abcde", "acct0", ""]) expect(shortAddress(input)).toBe(input);
    expect([shortAddress(null), shortAddress(undefined)]).toEqual(["", ""]);
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

describe("siteName", () => {
  it("names a site as its approval does: its host and port, and a local http:// site's whole origin", () => {
    expect(siteName("https://app.dusk.network")).toBe("app.dusk.network");
    expect(siteName("https://app.example:8443")).toBe("app.example:8443");
    expect(siteName("http://127.0.0.1:5354")).toBe("http://127.0.0.1:5354");
    expect(siteName("http://localhost")).toBe("http://localhost");
    expect(siteName("not a url")).toBe("not a url");
    expect(siteName(undefined)).toBe("");
  });
});
