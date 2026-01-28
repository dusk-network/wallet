import { describe, it, expect } from "vitest";
import { explorerTxUrl } from "./explorer.js";

describe("explorerTxUrl", () => {
  it("returns mainnet explorer URL", () => {
    const url = explorerTxUrl("https://nodes.dusk.network", "abc123hash");
    expect(url).toBe("https://apps.dusk.network/explorer/transactions/transaction/?id=abc123hash");
  });

  it("returns testnet explorer URL", () => {
    const url = explorerTxUrl("https://testnet.nodes.dusk.network", "abc123");
    expect(url).toBe("https://apps.testnet.dusk.network/explorer/transactions/transaction/?id=abc123");
  });

  it("returns devnet explorer URL", () => {
    const url = explorerTxUrl("https://devnet.nodes.dusk.network", "abc123");
    expect(url).toBe("https://apps.devnet.dusk.network/explorer/transactions/transaction/?id=abc123");
  });

  it("returns null for local network (no explorer)", () => {
    expect(explorerTxUrl("http://localhost:8080", "abc123")).toBeNull();
    expect(explorerTxUrl("http://127.0.0.1:8080", "abc123")).toBeNull();
  });

  it("returns null for custom networks (no explorer)", () => {
    expect(explorerTxUrl("https://my-custom-node.example.com", "abc123")).toBeNull();
  });

  it("returns null for empty hash", () => {
    expect(explorerTxUrl("https://nodes.dusk.network", "")).toBeNull();
    expect(explorerTxUrl("https://nodes.dusk.network", null)).toBeNull();
  });

  it("encodes special characters in hash", () => {
    const url = explorerTxUrl("https://nodes.dusk.network", "hash/with/slashes");
    expect(url).toBe("https://apps.dusk.network/explorer/transactions/transaction/?id=hash%2Fwith%2Fslashes");
  });

  it("handles hash with 0x prefix", () => {
    const url = explorerTxUrl("https://nodes.dusk.network", "0xabcdef123456");
    expect(url).toContain("id=0xabcdef123456");
  });
});
