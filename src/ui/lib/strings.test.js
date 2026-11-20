import { describe, it, expect } from "vitest";
import { shortAddress, shortEvmAddress, shortEvmHash, normalizeMnemonic, siteName } from "./strings.js";

describe("shortAddress", () => {
  it("keeps the first and last six characters, and short input as it is", () => {
    expect(shortAddress("0123456789abcdefghijklmnopqrstuvwxyz")).toBe("012345…uvwxyz");
    expect(shortAddress("0123456789abcdef")).toBe("012345…abcdef");
    // Six, six and the "…" would make these no shorter.
    for (const input of ["0123456789abcde", "acct0", ""]) expect(shortAddress(input)).toBe(input);
    expect([shortAddress(null), shortAddress(undefined)]).toEqual(["", ""]);
  });
});

describe("shortEvmAddress", () => {
  it("keeps 0x and four characters at each end, with its EIP-55 checksum", () => {
    expect(shortEvmAddress("0xab84edffd745af9420ac74fec73121fbee9fc86f")).toBe("0xAB84…C86F");
    expect(shortEvmAddress(" 0x5a3d8e1b7c2f4a6b9e0d1c3f5a7b9c2d4e6f8a01 ")).toBe("0x5A3d…8a01");
    // Anything else is cut as a Dusk ID is.
    expect(shortEvmAddress("0123456789abcdefghijklmnopqrstuvwxyz")).toBe("012345…uvwxyz");
    expect([shortEvmAddress(""), shortEvmAddress(undefined)]).toEqual(["", ""]);
  });
});

describe("shortEvmHash", () => {
  it("keeps 0x and four characters at each end of an EVM transaction's hash", () => {
    expect(shortEvmHash("0x029e2c6ebfe60452800c97eaa2ac36f40039812679c9cee414ea6a8b1877d61b")).toBe("0x029e…d61b");
    expect(shortEvmHash("ab".repeat(32))).toBe("ababab…ababab");
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
