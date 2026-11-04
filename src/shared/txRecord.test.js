import { describe, expect, it } from "vitest";

import { noteChainId } from "./nodeNetwork.js";
import { submittedTxMeta } from "./txRecord.js";

const sent = (nodeUrl) => submittedTxMeta({ kind: "transfer" }, { origin: "Wallet", nodeUrl, profileIndex: 0 });

describe("a sent transaction's record", () => {
  it("keeps the network it was sent on, as the wallet's settings named the node's then", () => {
    // A custom node of Testnet's, as the settings the sender loaded say.
    noteChainId("https://my-node.example", 2);
    expect(sent("https://my-node.example")).toMatchObject({ nodeUrl: "https://my-node.example", chainId: 2 });
    expect(sent("https://nodes.dusk.network").chainId).toBe(1);
    // One that couldn't say is kept with none, and named by its node later.
    expect(sent("https://unread.example").chainId).toBeNull();
  });
});

describe("what a send keeps of its memo", () => {
  const memo = "0xAB84EDFFd745AF9420ac74FeC73121FBEE9fC86F";
  const kept = (params) => submittedTxMeta(params, { origin: "Wallet", nodeUrl: "https://nodes.dusk.network" }).memo;

  it("keeps a public transfer's, which says where the bridge pays until the chain's row comes", () => {
    expect(kept({ kind: "transfer", privacy: "public", memo })).toBe(memo);
  });

  it("keeps no other's here", () => {
    expect(kept({ kind: "transfer", privacy: "shielded", memo })).toBeUndefined();
    expect(kept({ kind: "contract_call", privacy: "public", memo })).toBeUndefined();
    expect(kept({ kind: "transfer", privacy: "public" })).toBeUndefined();
  });
});
