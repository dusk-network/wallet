import { describe, it, expect } from "vitest";
import { chainIdFromNodeUrl, fnv1a32 } from "./chain.js";

describe("chainIdFromNodeUrl", () => {
  it("returns 0x1 for mainnet", () => {
    expect(chainIdFromNodeUrl("https://nodes.dusk.network")).toBe("0x1");
  });

  it("returns 0x2 for testnet", () => {
    expect(chainIdFromNodeUrl("https://testnet.nodes.dusk.network")).toBe("0x2");
  });

  it("returns 0x3 for devnet", () => {
    expect(chainIdFromNodeUrl("https://devnet.nodes.dusk.network")).toBe("0x3");
  });

  it("returns 0x0 for local", () => {
    expect(chainIdFromNodeUrl("http://localhost:8080")).toBe("0x0");
    expect(chainIdFromNodeUrl("http://127.0.0.1:8080")).toBe("0x0");
  });

  it("returns derived hash for custom URLs", () => {
    const result = chainIdFromNodeUrl("https://my-custom-node.example.com");
    expect(result).toMatch(/^0x[0-9a-f]{8}$/);
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
    // Should still return a valid hex string (hash of empty string)
    expect(result).toMatch(/^0x[0-9a-f]{8}$/);
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
