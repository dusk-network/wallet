import { describe, it, expect } from "vitest";
import { chainIdFromNodeUrl, chainReferenceFromChainId, fnv1a32 } from "./chain.js";

describe("chainIdFromNodeUrl", () => {
  it("returns dusk:1 for mainnet", () => {
    expect(chainIdFromNodeUrl("https://nodes.dusk.network")).toBe("dusk:1");
  });

  it("returns dusk:2 for testnet", () => {
    expect(chainIdFromNodeUrl("https://testnet.nodes.dusk.network")).toBe("dusk:2");
  });

  it("returns dusk:3 for devnet", () => {
    expect(chainIdFromNodeUrl("https://devnet.nodes.dusk.network")).toBe("dusk:3");
  });

  it("returns dusk:0 for local", () => {
    expect(chainIdFromNodeUrl("http://localhost:8080")).toBe("dusk:0");
    expect(chainIdFromNodeUrl("http://127.0.0.1:8080")).toBe("dusk:0");
  });

  it("returns derived hash for custom URLs", () => {
    const result = chainIdFromNodeUrl("https://my-custom-node.example.com");
    expect(result).toMatch(/^dusk:\d+$/);
    // Should be consistent
    expect(chainIdFromNodeUrl("https://my-custom-node.example.com")).toBe(result);
  });

  it("uses origin only for hashing (path changes don't affect chainId)", () => {
    const result1 = chainIdFromNodeUrl("https://example.com/path1");
    const result2 = chainIdFromNodeUrl("https://example.com/path2");
    expect(result1).toBe(result2);
  });

  it("handles empty input", () => {
    const result = chainIdFromNodeUrl("");
    // Should still return a valid CAIP-2 string (hash of empty string)
    expect(result).toMatch(/^dusk:\d+$/);
  });
});

describe("chainReferenceFromChainId", () => {
  it("parses CAIP-2 ids", () => {
    expect(chainReferenceFromChainId("dusk:1")).toBe("1");
    expect(chainReferenceFromChainId("dusk:0")).toBe("0");
  });

  it("parses hex chain ids", () => {
    expect(chainReferenceFromChainId("0x1")).toBe("1");
    expect(chainReferenceFromChainId("0xff")).toBe("255");
  });

  it("parses decimal chain ids", () => {
    expect(chainReferenceFromChainId("2")).toBe("2");
  });

  it("rejects non-dusk namespaces", () => {
    expect(chainReferenceFromChainId("eip155:1")).toBe("");
  });
});

describe("fnv1a32", () => {
  it("returns consistent hash for same input", () => {
    expect(fnv1a32("hello")).toBe(fnv1a32("hello"));
  });

  it("returns different hash for different inputs", () => {
    expect(fnv1a32("hello")).not.toBe(fnv1a32("world"));
  });

  it("returns unsigned 32-bit value", () => {
    const hash = fnv1a32("test string");
    expect(hash).toBeGreaterThanOrEqual(0);
    expect(hash).toBeLessThanOrEqual(0xffffffff);
  });

  it("handles empty string", () => {
    // FNV offset basis
    expect(fnv1a32("")).toBe(0x811c9dc5);
  });

  it("handles special characters", () => {
    const hash = fnv1a32("https://example.com:8080");
    expect(typeof hash).toBe("number");
    expect(hash).toBeGreaterThanOrEqual(0);
  });
});
