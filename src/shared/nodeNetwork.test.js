import { describe, expect, it } from "vitest";

import {
  chainIdForNode,
  chainIdOfInfo,
  labelForNode,
  listedChainId,
  networkForNode,
  networkKeyOf,
  networkLabelOf,
  networkOf,
  noteChainId,
} from "./nodeNetwork.js";

describe("a node's network", () => {
  it("is the file for the chain ID the node gives, whatever its address", () => {
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

    // A custom node of Testnet, once its settings say so (settings.js).
    noteChainId("https://my-node.example/rusk", 2);
    expect(chainIdForNode("https://my-node.example")).toBe(2);
    expect(networkForNode("https://my-node.example")?.name).toBe("testnet");
    expect(networkKeyOf(2, "https://my-node.example")).toBe("testnet");

    // Chosen again and unread, the node is Custom, not the network it was on.
    noteChainId("https://my-node.example", null);
    expect(chainIdForNode("https://my-node.example")).toBeNull();
    expect(networkForNode("https://my-node.example")).toBeNull();
  });

  it("is a network's own node's without asking, and nothing for a name that only looks like one", () => {
    expect(listedChainId("https://nodes.dusk.network")).toBe(1);
    expect(listedChainId("https://testnet.nodes.dusk.network/")).toBe(2);
    expect(chainIdForNode("https://devnet.nodes.dusk.network")).toBe(3);
    expect(chainIdForNode("https://testnet.example.com")).toBeNull();
    expect(networkKeyOf(null, "https://testnet.example.com")).toBe("custom");
    expect([listedChainId("not a url"), chainIdForNode("")]).toEqual([null, null]);
  });

  it("is local on this machine, and named and labelled as its file says", () => {
    expect([networkKeyOf(0, "https://rusk.example"), networkKeyOf(null, "http://127.0.0.1:8080"), networkKeyOf(null, "")]).toEqual([
      "local",
      "local",
      "custom",
    ]);
    expect([networkLabelOf(1, "https://rusk.example"), networkLabelOf(null, "http://localhost:8080"), networkLabelOf(null, "https://rusk.example")]).toEqual([
      "Mainnet",
      "Local",
      "Custom",
    ]);
    const transfer = "0100000000000000000000000000000000000000000000000000000000000000";
    expect([labelForNode("https://nodes.dusk.network", transfer), labelForNode("https://rusk.example.org", transfer), labelForNode("https://nodes.dusk.network", "")]).toEqual([
      "Transfer contract",
      null,
      null,
    ]);
  });
});
