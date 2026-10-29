import { networks, routes } from "@dusk-network/networks";
import { duskEvmContracts } from "@dusk-network/networks/duskevm";
import { describe, expect, it } from "vitest";

import { bridgeTransfer } from "./bridge.js";
import { bridgeServiceLine, bridgeServiceTransfer, bridgeServiceWarnings } from "./bridgeCalls.js";
import { noteChainId } from "./nodeNetwork.js";

const TESTNET = "https://testnet.nodes.dusk.network";
const MAINNET = "https://nodes.dusk.network";
const { bridge, portal } = duskEvmContracts(2);

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

describe("the bridge's accounts for DUSK leaving Dusk", () => {
  // The networks' service routes, as their files in @dusk-network/networks have them.
  const service = (net) => routes(net).find((route) => route.kind === "service");
  const mainnet = service(networks.mainnet);
  const testnet = service(networks.testnet);
  const EVM = "0x" + "ab".repeat(20);

  it("are the networks' service routes: the account, the 1 DUSK fee and the chain, and testnet's isn't running", () => {
    expect([mainnet.feeLux, testnet.feeLux]).toEqual([1_000_000_000n, 1_000_000_000n]);
    expect([mainnet.running, testnet.running]).toEqual([true, false]);
    expect([mainnet.chain.name, testnet.chain.name]).toEqual(["BNB Smart Chain", "Sepolia"]);
  });

  it("say what's sent, the fee and what arrives, in one line", () => {
    const paid = bridgeServiceTransfer({ nodeUrl: MAINNET, to: mainnet.account, memo: EVM, amount: "2000000000" });
    expect(paid).toMatchObject({ chain: "BNB Smart Chain", network: "mainnet", recipientOk: true, running: true, sentLux: 2_000_000_000n, feeLux: 1_000_000_000n, arrivesLux: 1_000_000_000n });
    expect(bridgeServiceLine(paid)).toBe("2 DUSK sent · 1 DUSK bridge fee · 1 DUSK arrives on BNB Smart Chain");
    expect(bridgeServiceWarnings(paid)).toEqual([]);

    // The fee takes all of 1 DUSK, and more than that of less.
    for (const amount of ["1000000000", "999999999", undefined]) {
      const all = bridgeServiceTransfer({ nodeUrl: MAINNET, to: mainnet.account, memo: EVM, amount });
      expect(all.arrivesLux).toBe(0n);
      expect(bridgeServiceWarnings(all).map((w) => w.kind)).toEqual(["fee"]);
    }
    expect(bridgeServiceLine(bridgeServiceTransfer({ nodeUrl: MAINNET, to: mainnet.account, memo: EVM, amount: "1000000001" }))).toBe(
      "1.000000001 DUSK sent · 1 DUSK bridge fee · 0.000000001 DUSK arrives on BNB Smart Chain"
    );

    // Without an address there in the memo, nothing arrives, whatever the amount.
    for (const memo of [undefined, "", "Order 1042", EVM.replace(/[a-f]/, (c) => c.toUpperCase())]) {
      expect(bridgeServiceLine(bridgeServiceTransfer({ nodeUrl: MAINNET, to: mainnet.account, memo, amount: "2000000000" }))).toBe(
        "2 DUSK sent · 1 DUSK bridge fee · Nothing arrives without a BNB Smart Chain address in the memo"
      );
    }
  });

  it("say testnet's route to Sepolia isn't running right now", () => {
    const paid = bridgeServiceTransfer({ nodeUrl: TESTNET, to: testnet.account, memo: EVM, amount: "5000000000" });
    expect(bridgeServiceWarnings(paid)).toEqual([
      {
        kind: "off",
        title: "Not running on testnet right now",
        text: "The bridge isn't paying out on Sepolia at the moment, so DUSK sent to it doesn't arrive there.",
      },
    ]);
    expect(bridgeServiceLine(paid)).toBe("5 DUSK sent · 1 DUSK bridge fee · Nothing arrives on Sepolia");
    // Another account, or another network's, is no bridge transfer.
    expect(bridgeServiceTransfer({ nodeUrl: TESTNET, to: mainnet.account, amount: "5000000000" })).toBeNull();
  });

  it("are the node's network's, by the chain ID it gave, whatever its address", () => {
    const node = "https://rusk.example.org";
    expect(bridgeServiceTransfer({ nodeUrl: node, to: mainnet.account, memo: EVM, amount: "2000000000" })).toBeNull();
    noteChainId(node, 1);
    expect(bridgeServiceTransfer({ nodeUrl: node, to: mainnet.account, memo: EVM, amount: "2000000000" })).toMatchObject({
      chain: "BNB Smart Chain",
      arrivesLux: 1_000_000_000n,
    });
  });
});
