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
