import { beforeEach, describe, expect, it, vi } from "vitest";

const items = vi.hoisted(() => ({}));
const broken = vi.hoisted(() => ({ on: false }));
vi.mock("./storage.js", () => ({
  STORAGE_KEYS: { NODE_CHAINS: "dusk_node_chains_v1" },
  storage: {
    get: async (key) => {
      if (broken.on) throw new Error("storage unavailable");
      return { [key]: items[key] };
    },
    set: async (patch) => Object.assign(items, patch),
  },
}));

import { chainIdOfInfo, knownChainId, listedChainId, networkKeyOf, networkOf, rememberChainId } from "./nodeNetwork.js";

beforeEach(() => {
  for (const key of Object.keys(items)) delete items[key];
  broken.on = false;
});

describe("a node's network", () => {
  it("is the file for the chain ID the node gives, whatever its address", async () => {
    expect(chainIdOfInfo({ chain_id: 2, version: "1.7.1" })).toBe(2);
    expect(chainIdOfInfo({ chainId: 1 })).toBe(1);
    expect([chainIdOfInfo({}), chainIdOfInfo(null), chainIdOfInfo({ chain_id: "x" }), chainIdOfInfo({ chain_id: -1 })]).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect([networkOf(1)?.label, networkOf(2)?.label, networkOf(3)?.label]).toEqual(["Mainnet", "Testnet", "Devnet"]);
    expect([networkOf(0), networkOf(9), networkOf(null), networkOf("2")]).toEqual([null, null, null, null]);

    // A custom node of Testnet, once it said so.
    await rememberChainId("https://my-node.example/rusk", 2);
    expect(await knownChainId("https://my-node.example")).toBe(2);
    expect(networkKeyOf(2, "https://my-node.example")).toBe("testnet");
  });

  it("is a network's own node's until that node answers, and what it answered after", async () => {
    expect(listedChainId("https://nodes.dusk.network")).toBe(1);
    expect(listedChainId("https://testnet.nodes.dusk.network/")).toBe(2);
    expect(await knownChainId("https://devnet.nodes.dusk.network")).toBe(3);
    // A name that only looks like one is no network's own node.
    expect(await knownChainId("https://testnet.example.com")).toBeNull();
    expect(networkKeyOf(null, "https://testnet.example.com")).toBe("custom");

    await rememberChainId("https://nodes.dusk.network", 2);
    expect(await knownChainId("https://nodes.dusk.network")).toBe(2);
  });

  it("is local on this machine, and nothing for an address that isn't one", async () => {
    expect([networkKeyOf(0, "https://rusk.example"), networkKeyOf(null, "http://127.0.0.1:8080"), networkKeyOf(null, "")]).toEqual([
      "local",
      "local",
      "custom",
    ]);
    expect(await knownChainId("not a url")).toBeNull();
    await rememberChainId("not a url", 2);
    await rememberChainId("https://my-node.example", null);
    expect(items).toEqual({});
  });

  it("knows, once loaded, what a worker that just started kept of each node, and what this context noted", async () => {
    vi.resetModules();
    const fresh = await import("./nodeNetwork.js");
    items.dusk_node_chains_v1 = { "https://rusk-a.example": 1, "https://rusk-b.example": 2 };
    fresh.noteChainId("https://rusk-b.example", 3);
    expect(fresh.chainIdForNode("https://rusk-a.example")).toBeNull();
    await fresh.loadKnownChains();
    // What this context noted stays; what was kept fills in the rest.
    expect([fresh.chainIdForNode("https://rusk-a.example"), fresh.chainIdForNode("https://rusk-b.example")]).toEqual([1, 3]);
    expect([fresh.networkForNode("https://rusk-a.example")?.name, fresh.labelForNode("https://rusk-a.example", "0100000000000000000000000000000000000000000000000000000000000000")]).toEqual([
      "mainnet",
      "Transfer contract",
    ]);
    expect([fresh.labelForNode("https://unknown.example", "0100000000000000000000000000000000000000000000000000000000000000"), fresh.networkLabelOf(null, "https://unknown.example")]).toEqual([
      null,
      "Custom",
    ]);
  });

  it("knows only the networks' own nodes while storage can't be read", async () => {
    broken.on = true;
    expect(await knownChainId("https://testnet.nodes.dusk.network")).toBe(2);
    expect(await knownChainId("https://rusk.example.io")).toBeNull();
  });
});
