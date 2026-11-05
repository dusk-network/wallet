import { describe, expect, it } from "vitest";

import {
  chainIdForNode,
  chainIdOfInfo,
  chainRefusal,
  labelForNode,
  listedChainId,
  networkForNode,
  networkKeyOf,
  networkLabelOf,
  networkOf,
  networkTextOf,
  nodeHost,
  noteChainId,
  pinnedChainOf,
  signsOnNetwork,
} from "./nodeNetwork.js";

describe("a node's network", () => {
  it("is the file for the chain ID the node gives, whatever its address", () => {
    expect(chainIdOfInfo({ chain_id: 2, version: "1.7.1" })).toBe(2);
    expect(chainIdOfInfo({ chainId: 1 })).toBe(1);
    expect([chainIdOfInfo({}), chainIdOfInfo(null), chainIdOfInfo({ chain_id: "x" }), chainIdOfInfo({ chain_id: -1 }), chainIdOfInfo({ chain_id: true }), chainIdOfInfo({ chain_id: "" })]).toEqual([
      null,
      null,
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
    // Nothing noted of a listed address changes its chain ID.
    noteChainId("https://testnet.nodes.dusk.network", 1);
    expect(chainIdForNode("https://testnet.nodes.dusk.network")).toBe(2);
    noteChainId("https://testnet.nodes.dusk.network", null);
  });

  it("signs for what the settings fixed, a listed address's from its file", () => {
    const settings = { nodeChains: { "https://my-node.example": 2, "https://testnet.nodes.dusk.network": 1 } };
    expect(pinnedChainOf(settings, "https://my-node.example/rusk")).toBe(2);
    expect(pinnedChainOf(settings, "https://testnet.nodes.dusk.network")).toBe(2);
    expect(pinnedChainOf(settings, "https://other.example")).toBeNull();
    expect(pinnedChainOf(null, "https://other.example")).toBeNull();
  });

  it("says in plain words why it won't sign, and nothing when it may", () => {
    const node = "https://hostile-node.example";
    expect(chainRefusal(node, 2, 1)).toBe(
      "hostile-node.example now says it's on Mainnet (chain 1), not Testnet (chain 2). Nothing was signed, because a signature here could count on the other network."
    );
    expect(chainRefusal(node, 7, 9)).toBe(
      "hostile-node.example now says it's on chain 9, not chain 7. Nothing was signed, because a signature here could count on the other network."
    );
    expect(chainRefusal(node, null, null)).toBe("The wallet couldn't read which network hostile-node.example is on, so nothing was signed. Try again in a moment.");
    // Said before anything is asked to be signed.
    expect(chainRefusal(node, 2, 1, { ahead: true })).toBe(
      "hostile-node.example now says it's on Mainnet (chain 1), not Testnet (chain 2). The wallet won't sign on it, because a signature here could count on the other network."
    );
    expect(chainRefusal(node, null, null, { ahead: true })).toBe("The wallet can't read which network hostile-node.example is on yet, so it won't sign on it. Try again in a moment.");
    // A node that agrees, or says nothing, is signed for; what doesn't carry a chain ID doesn't need one.
    expect([chainRefusal(node, 2, 2), chainRefusal(node, 2, null), chainRefusal(node, null, 1, { required: false })]).toEqual(["", "", ""]);
  });

  it("is local on this machine, and named by its address alone", () => {
    expect([networkKeyOf(0, "https://rusk.example"), networkKeyOf(null, "http://127.0.0.1:8080"), networkKeyOf(null, "")]).toEqual([
      "local",
      "local",
      "custom",
    ]);
    expect([
      networkLabelOf("https://nodes.dusk.network"),
      networkLabelOf("https://testnet.nodes.dusk.network"),
      networkLabelOf("https://devnet.nodes.dusk.network"),
      networkLabelOf("http://localhost:8080"),
      networkLabelOf("http://[::1]:8080"),
      networkLabelOf("https://rusk.example"),
    ]).toEqual(["Mainnet", "Testnet", "Devnet", "Local", "Local", "Custom"]);
    noteChainId("https://rusk.example", 1);
    expect(networkLabelOf("https://rusk.example")).toBe("Custom");
    // With its host, in a line, a network's own node needing none.
    expect([networkTextOf("https://rusk.example:8443"), networkTextOf("https://nodes.dusk.network"), networkTextOf("http://127.0.0.1:8080"), nodeHost("https://rusk.example:8443/x")]).toEqual([
      "Custom · rusk.example:8443",
      "Mainnet",
      "Local · 127.0.0.1:8080",
      "rusk.example:8443",
    ]);
    // Where what's signed counts, for a node that isn't that network's own.
    expect([signsOnNetwork("https://rusk.example", 1), signsOnNetwork("https://rusk.example", 7), signsOnNetwork("https://nodes.dusk.network", 1)]).toEqual(["Mainnet", "", ""]);
    noteChainId("https://rusk.example", null);
    const transfer = "0100000000000000000000000000000000000000000000000000000000000000";
    expect([labelForNode("https://nodes.dusk.network", transfer), labelForNode("https://rusk.example.org", transfer), labelForNode("https://nodes.dusk.network", "")]).toEqual([
      "Transfer contract",
      null,
      null,
    ]);
  });
});
