import { describe, it, expect } from "vitest";
import { explorerAccountUrl, explorerTxUrl } from "./explorer.js";

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

describe("explorerAccountUrl", () => {
  it("returns mainnet account history on DuskScan", () => {
    const url = explorerAccountUrl(
      "https://nodes.dusk.network",
      "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927"
    );

    expect(url).toBe(
      "https://duskscan.net/address/26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927"
    );
  });

  it("returns testnet account history on DuskScan", () => {
    expect(explorerAccountUrl("https://testnet.nodes.dusk.network", "acct1")).toBe(
      "https://testnet.duskscan.net/address/acct1"
    );
  });

  it("encodes reserved characters in accounts", () => {
    expect(explorerAccountUrl("https://nodes.dusk.network", "acct/1")).toBe(
      "https://duskscan.net/address/acct%2F1"
    );
  });

  it("returns null when account history is not supported", () => {
    expect(explorerAccountUrl("https://devnet.nodes.dusk.network", "acct1")).toBeNull();
    expect(explorerAccountUrl("https://my-custom-node.example.com", "acct1")).toBeNull();
    expect(explorerAccountUrl("https://nodes.dusk.network", "")).toBeNull();
  });
});
