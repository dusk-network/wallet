import { describe, it, expect } from "vitest";
import {
  chainIdHexToDecimal,
  buildDuskUri,
  parseDuskUri,
  normalizeChainId,
  chainLabel,
} from "./duskUri.js";

describe("chainIdHexToDecimal", () => {
  it("converts CAIP-2 to decimal", () => {
    expect(chainIdHexToDecimal("dusk:1")).toBe("1");
    expect(chainIdHexToDecimal("dusk:2")).toBe("2");
  });

  it("returns empty string for invalid input", () => {
    expect(chainIdHexToDecimal("")).toBe("");
    expect(chainIdHexToDecimal(null)).toBe("");
    expect(chainIdHexToDecimal("not-a-number")).toBe("");
    expect(chainIdHexToDecimal("eip155:1")).toBe("");
  });
});

describe("buildDuskUri", () => {
  it("builds basic public URI", () => {
    const uri = buildDuskUri({ kind: "public", recipient: "abc123" });
    expect(uri).toBe("dusk:public-abc123");
  });

  it("builds shielded URI", () => {
    const uri = buildDuskUri({ kind: "shielded", recipient: "xyz789" });
    expect(uri).toBe("dusk:shielded-xyz789");
  });

  it("includes chain ID when provided", () => {
    const uri = buildDuskUri({ kind: "public", recipient: "abc123", chainId: "dusk:2" });
    expect(uri).toBe("dusk:public-abc123@dusk:2");
  });

  it("includes amount in DUSK", () => {
    const uri = buildDuskUri({ kind: "public", recipient: "abc", amountDusk: "1.5" });
    expect(uri).toBe("dusk:public-abc?amount=1.5");
  });

  it("prefers amountLux over amountDusk", () => {
    const uri = buildDuskUri({
      kind: "public",
      recipient: "abc",
      amountDusk: "1.5",
      amountLux: "1500000000",
    });
    expect(uri).toBe("dusk:public-abc?amountLux=1500000000");
  });

  it("includes memo and label", () => {
    const uri = buildDuskUri({
      kind: "public",
      recipient: "abc",
      memo: "Payment for coffee",
      label: "Bob",
    });
    expect(uri).toContain("memo=Payment+for+coffee");
    expect(uri).toContain("label=Bob");
  });

  it("returns empty string for missing recipient", () => {
    expect(buildDuskUri({ kind: "public", recipient: "" })).toBe("");
    expect(buildDuskUri({ kind: "public" })).toBe("");
  });

  it("defaults to public kind", () => {
    const uri = buildDuskUri({ recipient: "abc123" });
    expect(uri).toBe("dusk:public-abc123");
  });

  it("encodes special characters in recipient", () => {
    const uri = buildDuskUri({ kind: "public", recipient: "abc/def" });
    expect(uri).toBe("dusk:public-abc%2Fdef");
  });
});

describe("parseDuskUri", () => {
  it("parses basic public URI", () => {
    const result = parseDuskUri("dusk:public-abc123");
    expect(result).toMatchObject({
      kind: "public",
      to: "abc123",
      chainId: "",
      amountDusk: "",
      memo: "",
    });
  });

  it("parses shielded URI", () => {
    const result = parseDuskUri("dusk:shielded-xyz789");
    expect(result).toMatchObject({
      kind: "shielded",
      to: "xyz789",
    });
  });

  it("parses chain ID", () => {
    const result = parseDuskUri("dusk:public-abc@dusk:2");
    expect(result).toMatchObject({
      kind: "public",
      to: "abc",
      chainId: "dusk:2",
    });
  });

  it("returns null for invalid chain suffix", () => {
    expect(parseDuskUri("dusk:public-abc@dusk:abc")).toBeNull();
  });

  it("parses query parameters", () => {
    const result = parseDuskUri("dusk:public-abc?amount=1.5&memo=Hello&label=Alice");
    expect(result).toMatchObject({
      to: "abc",
      amountDusk: "1.5",
      memo: "Hello",
      label: "Alice",
    });
  });

  it("parses amountLux and converts to DUSK", () => {
    const result = parseDuskUri("dusk:public-abc?amountLux=1500000000");
    expect(result.amountLux).toBe("1500000000");
    expect(result.amountDusk).toBe("1.5");
  });

  it("handles raw recipient string (non-URI)", () => {
    const result = parseDuskUri("someBase58Address");
    expect(result).toMatchObject({
      kind: "unknown",
      to: "someBase58Address",
      raw: "someBase58Address",
    });
  });

  it("returns null for empty input", () => {
    expect(parseDuskUri("")).toBeNull();
    expect(parseDuskUri(null)).toBeNull();
  });

  it("returns null for unsupported dusk: URI formats", () => {
    expect(parseDuskUri("dusk:invalid-format")).toBeNull();
    expect(parseDuskUri("dusk:")).toBeNull();
  });

  it("handles case-insensitive dusk: prefix", () => {
    const result = parseDuskUri("DUSK:public-abc123");
    expect(result.kind).toBe("public");
    expect(result.to).toBe("abc123");
  });

  it("decodes URL-encoded recipient", () => {
    const result = parseDuskUri("dusk:public-abc%2Fdef");
    expect(result.to).toBe("abc/def");
  });

  it("tolerates invalid percent-encoding in recipient", () => {
    // decodeURIComponent throws on this sequence; we keep it best-effort.
    const result = parseDuskUri("dusk:public-%E0%A4");
    expect(result).toMatchObject({ kind: "public", to: "%E0%A4" });
  });

  it("handles URI with // after scheme", () => {
    const result = parseDuskUri("dusk://public-abc123");
    expect(result.to).toBe("abc123");
  });
});

describe("normalizeChainId", () => {
  it("normalizes CAIP-2 to decimal", () => {
    expect(normalizeChainId("dusk:1")).toBe("1");
    expect(normalizeChainId("dusk:2")).toBe("2");
  });

  it("returns empty for invalid input", () => {
    expect(normalizeChainId("")).toBe("");
    expect(normalizeChainId(null)).toBe("");
    expect(normalizeChainId("abc")).toBe("");
  });
});

describe("chainLabel", () => {
  it("returns known network names", () => {
    expect(chainLabel("dusk:1")).toBe("Mainnet");
    expect(chainLabel("dusk:2")).toBe("Testnet");
    expect(chainLabel("dusk:3")).toBe("Devnet");
    expect(chainLabel("dusk:0")).toBe("Local");
  });

  it("returns generic label for unknown chains", () => {
    expect(chainLabel("dusk:42")).toBe("Chain 42");
    expect(chainLabel("dusk:1337")).toBe("Chain 1337");
  });

  it("returns empty for invalid input", () => {
    expect(chainLabel("")).toBe("");
    expect(chainLabel(null)).toBe("");
  });
});
