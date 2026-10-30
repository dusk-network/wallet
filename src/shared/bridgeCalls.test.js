import { networks, routes } from "@dusk-network/networks";
import { duskEvmContracts } from "@dusk-network/networks/duskevm";
import { describe, expect, it } from "vitest";

import { bridgeDepositRecipient, bridgeServiceLine, bridgeServiceTransfer, bridgeServiceWarnings, weiToDusk } from "./bridgeCalls.js";
import { hexToBytes } from "./bytes.js";
import fixtures from "./fixtures/duskevm-bridge-calls.json";
import { noteChainId } from "./nodeNetwork.js";

// "deposit-shoot" is byte for byte what the bridge sent the wallet on testnet.
const TESTNET = "https://testnet.nodes.dusk.network";
const MAINNET = "https://nodes.dusk.network";

describe("DuskEVM bridge calls", () => {
  it("names a deposit's DuskEVM recipient in any encoding a site sends its arguments in", () => {
    const { args, fnName, expected } = fixtures.calls.find((c) => c.name === "deposit-shoot");
    const tx = { nodeUrl: TESTNET, contractId: duskEvmContracts(2).bridge, fnName, amount: "0", deposit: expected.amountLux };
    const bytes = hexToBytes(args);
    for (const fnArgs of [args, args.slice(2), bytes, Array.from(bytes), `base64:${btoa(String.fromCharCode(...bytes))}`]) {
      expect(bridgeDepositRecipient({ ...tx, fnArgs })).toBe(expected.to);
    }
    expect(bridgeDepositRecipient({ ...tx, fnArgs: { bad: 1 } })).toBeUndefined();
  });

  it("turns DuskEVM's 18 decimals into DUSK", () => {
    expect(weiToDusk(1008000000000000000000n)).toEqual({ lux: 1008000000000n, text: "" });
    expect(weiToDusk(1n)).toEqual({ lux: null, text: "0.000000000000000001" });
    expect(weiToDusk(1500000000000000001n)).toEqual({ lux: null, text: "1.500000000000000001" });
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
