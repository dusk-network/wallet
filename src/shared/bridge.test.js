import { describe, expect, it } from "vitest";

import { BRIDGE_CONTRACTS, bridgeTransfer } from "./bridge.js";

const TESTNET = "https://testnet.nodes.dusk.network";
const MAINNET = "https://nodes.dusk.network";
const { bridge, portal } = BRIDGE_CONTRACTS.testnet;

describe("bridge transfers", () => {
  it("names a deposit to DuskEVM, a withdrawal back and a proof", () => {
    expect(bridgeTransfer({ kind: "contract_call", contractId: bridge, deposit: "5000000000" }, TESTNET)).toBe("to");
    // An archive row before its details: the deposit names the bridge.
    expect(bridgeTransfer({ direction: "out", counterparty: bridge, amount: "5000000000" }, TESTNET)).toBe("to");
    expect(bridgeTransfer({ direction: "in", contractId: portal, amount: "5000000000" }, TESTNET)).toBe("from");
    expect(bridgeTransfer({ direction: "out", contractId: `0x${portal.toUpperCase()}`, amount: "0" }, TESTNET)).toBe("call");
  });

  it("leaves other transactions and networks without a bridge alone", () => {
    expect(bridgeTransfer({ direction: "out", contractId: "ab".repeat(32), amount: "1" }, TESTNET)).toBeNull();
    expect(bridgeTransfer({ direction: "out", contractId: bridge, amount: "1" }, MAINNET)).toBeNull();
    // The row's own network when none is given.
    expect(bridgeTransfer({ nodeUrl: TESTNET, direction: "out", counterparty: bridge, amount: "1" })).toBe("to");
  });
});
