import { describe, it, expect } from "vitest";
import { detectPresetIdFromNodeUrl, networkNameFromNodeUrl } from "./network.js";

describe("detectPresetIdFromNodeUrl", () => {
  it("detects local URLs", () => {
    expect(detectPresetIdFromNodeUrl("http://localhost:8080")).toBe("local");
    expect(detectPresetIdFromNodeUrl("http://127.0.0.1:8080")).toBe("local");
    expect(detectPresetIdFromNodeUrl("http://0.0.0.0:8080")).toBe("local");
  });

  it("detects testnet URLs", () => {
    expect(detectPresetIdFromNodeUrl("https://testnet.nodes.dusk.network")).toBe("testnet");
    expect(detectPresetIdFromNodeUrl("https://nodes.testnet.dusk.network")).toBe("testnet");
  });

  it("detects devnet URLs", () => {
    expect(detectPresetIdFromNodeUrl("https://devnet.nodes.dusk.network")).toBe("devnet");
    expect(detectPresetIdFromNodeUrl("https://nodes.devnet.dusk.network")).toBe("devnet");
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

  it("returns Mainnet for unknown URLs", () => {
    expect(networkNameFromNodeUrl("https://example.com")).toBe("Mainnet");
  });

  it("returns Unknown for invalid URLs", () => {
    expect(networkNameFromNodeUrl("not-a-url")).toBe("Unknown");
    expect(networkNameFromNodeUrl("")).toBe("Unknown");
  });

  it("detects local in hostname", () => {
    expect(networkNameFromNodeUrl("https://local.example.com")).toBe("Local");
  });
});
