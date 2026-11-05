import { describe, it, expect } from "vitest";
import { detectPresetIdFromNodeUrl, networkNameFromNodeUrl } from "./network.js";
import { noteChainId } from "./nodeNetwork.js";

describe("detectPresetIdFromNodeUrl", () => {
  it("detects local URLs", () => {
    expect(detectPresetIdFromNodeUrl("http://localhost:8080")).toBe("local");
    expect(detectPresetIdFromNodeUrl("http://127.0.0.1:8080")).toBe("local");
    expect(detectPresetIdFromNodeUrl("http://0.0.0.0:8080")).toBe("local");
  });

  it("detects testnet's own URL", () => {
    expect(detectPresetIdFromNodeUrl("https://testnet.nodes.dusk.network")).toBe("testnet");
  });

  it("detects devnet's own URL", () => {
    expect(detectPresetIdFromNodeUrl("https://devnet.nodes.dusk.network")).toBe("devnet");
  });

  it("goes by the exact address the networks' files list, never what a host looks like", () => {
    for (const url of [
      "https://nodes.testnet.dusk.network",
      "https://testnet.evil.example",
      "https://devnet.evil.example",
      "https://nodes.dusk.network.evil.example",
      "https://nodes.dusk.network:8443",
      "http://nodes.dusk.network",
      "http://testnet.nodes.dusk.network",
    ]) {
      expect(detectPresetIdFromNodeUrl(url), url).toBe("custom");
    }
  });

  it("detects mainnet URL", () => {
    expect(detectPresetIdFromNodeUrl("https://nodes.dusk.network")).toBe("mainnet");
  });

  it("returns custom for unknown URLs", () => {
    expect(detectPresetIdFromNodeUrl("https://my-custom-node.example.com")).toBe("custom");
    expect(detectPresetIdFromNodeUrl("https://example.com")).toBe("custom");
  });

  it("returns custom for invalid URLs", () => {
    expect(detectPresetIdFromNodeUrl("not-a-url")).toBe("custom");
    expect(detectPresetIdFromNodeUrl("")).toBe("custom");
  });
});

describe("networkNameFromNodeUrl", () => {
  it("returns Local for local URLs", () => {
    expect(networkNameFromNodeUrl("http://localhost:8080")).toBe("Local");
    expect(networkNameFromNodeUrl("http://127.0.0.1:8080")).toBe("Local");
    expect(networkNameFromNodeUrl("http://0.0.0.0:8080")).toBe("Local");
  });

  it("returns Testnet for testnet URLs", () => {
    expect(networkNameFromNodeUrl("https://testnet.nodes.dusk.network")).toBe("Testnet");
  });

  it("returns Devnet for devnet URLs", () => {
    expect(networkNameFromNodeUrl("https://devnet.nodes.dusk.network")).toBe("Devnet");
  });

  it("returns Mainnet for mainnet URLs", () => {
    expect(networkNameFromNodeUrl("https://nodes.dusk.network")).toBe("Mainnet");
  });

  it("calls any other node Custom, whatever its name looks like and whichever chain it says it's on", () => {
    expect(networkNameFromNodeUrl("https://example.com")).toBe("Custom");
    expect(networkNameFromNodeUrl("https://testnet.example.com")).toBe("Custom");
    for (const chainId of [0, 1, 2, 3]) {
      noteChainId("https://example.com", chainId);
      expect(networkNameFromNodeUrl("https://example.com/rusk")).toBe("Custom");
    }
    noteChainId("https://nodes.dusk.network.evil.example", 1);
    expect(networkNameFromNodeUrl("https://nodes.dusk.network.evil.example")).toBe("Custom");
  });

  it("returns Unknown for invalid URLs", () => {
    expect(networkNameFromNodeUrl("not-a-url")).toBe("Unknown");
    expect(networkNameFromNodeUrl("")).toBe("Unknown");
  });

  it("doesn't take a host named local for this machine", () => {
    expect(networkNameFromNodeUrl("https://local.example.com")).toBe("Custom");
  });
});
