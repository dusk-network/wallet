import { networks, routes } from "@dusk-network/networks";
import { duskEvmContracts } from "@dusk-network/networks/duskevm";
import { describe, expect, it } from "vitest";

import { bridgeDepositRecipient, bridgeServiceLine, bridgeServiceTransfer, bridgeServiceWarnings, noBridgeRecipientText, weiToDusk } from "./bridgeCalls.js";
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
  // A figure exactly as written: not inside a longer number, not signed or bounded unless written so, and not followed by
  // more digits, letters or a decimal part (1 DUSK ≠ 11 or 21 DUSK, 0.000000001 ≠ 10.000000001).
  const exactly = (text) => new RegExp(`(?<![\\d.,+\\-−<>≤≥~])(?<![+\\-−<>≤≥~]\\s)${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\dA-Za-z]|[.,]\\d)`);
  // A line's part, by the word that says what it is: what's sent, the fee, or what arrives.
  const part = (line, word) => line.split(" · ").find((p) => word.test(p)) ?? "";
  // Every part that says what arrives: one, never a second that promises an amount.
  const arrivals = (line) => line.split(" · ").filter((p) => /arriv/i.test(p));

  it("are the networks' service routes: the account, the 1 DUSK fee and the chain, and testnet's isn't running", () => {
    expect([mainnet.feeLux, testnet.feeLux]).toEqual([1_000_000_000n, 1_000_000_000n]);
    expect([mainnet.running, testnet.running]).toEqual([true, false]);
    expect([mainnet.chain.name, testnet.chain.name]).toEqual(["BNB Smart Chain", "Sepolia"]);
  });

  it("say the fee and what arrives, in one line", () => {
    const paid = bridgeServiceTransfer({ nodeUrl: MAINNET, to: mainnet.account, memo: EVM, amount: "2000000000" });
    expect(paid).toMatchObject({ chain: "BNB Smart Chain", network: "mainnet", recipientOk: true, running: true, sentLux: 2_000_000_000n, feeLux: 1_000_000_000n, arrivesLux: 1_000_000_000n });
    // The 2 DUSK sent, the 1 DUSK fee and the 1 DUSK that arrives, each in its own part.
    expect(part(bridgeServiceLine(paid), /sent/i)).toMatch(exactly("2 DUSK"));
    expect(part(bridgeServiceLine(paid), /fee/i)).toMatch(exactly("1 DUSK"));
    expect(arrivals(bridgeServiceLine(paid))).toHaveLength(1);
    expect(part(bridgeServiceLine(paid), /arriv/i)).toMatch(exactly("1 DUSK"));
    expect(bridgeServiceWarnings(paid)).toEqual([]);

    // The fee takes all of 1 DUSK, and more than that of less.
    for (const amount of ["1000000000", "999999999", undefined]) {
      const all = bridgeServiceTransfer({ nodeUrl: MAINNET, to: mainnet.account, memo: EVM, amount });
      expect(all.arrivesLux).toBe(0n);
      expect(bridgeServiceWarnings(all).map((w) => w.kind)).toEqual(["fee"]);
    }
    // What arrives, to the last lux.
    const lastLux = bridgeServiceLine(bridgeServiceTransfer({ nodeUrl: MAINNET, to: mainnet.account, memo: EVM, amount: "1000000001" }));
    expect(part(lastLux, /arriv/i)).toMatch(exactly("0.000000001 DUSK"));
    expect(part(lastLux, /fee/i)).toMatch(exactly("1 DUSK"));
    expect(part(lastLux, /sent/i)).toMatch(exactly("1.000000001 DUSK"));

    // Without an address there in the memo, nothing arrives, whatever the amount.
    for (const memo of [undefined, "", "Order 1042", EVM.replace(/[a-f]/, (c) => c.toUpperCase())]) {
      const line = bridgeServiceLine(bridgeServiceTransfer({ nodeUrl: MAINNET, to: mainnet.account, memo, amount: "2000000000" }));
      expect(line).toContain(noBridgeRecipientText("BNB Smart Chain"));
      expect(part(line, /fee/i)).toMatch(exactly("1 DUSK"));
      expect(arrivals(line)).toHaveLength(1);
      expect(part(line, /arriv/i)).not.toMatch(/\d/);
    }
  });

  it("say testnet's route to Sepolia isn't running right now", () => {
    const paid = bridgeServiceTransfer({ nodeUrl: TESTNET, to: testnet.account, memo: EVM, amount: "5000000000" });
    expect(bridgeServiceWarnings(paid)).toEqual([{ kind: "off", title: expect.any(String), text: expect.any(String) }]);
    // The fee, and nothing that arrives on Sepolia: no amount at all where it says what arrives.
    const line = bridgeServiceLine(paid);
    expect(part(line, /fee/i)).toMatch(exactly("1 DUSK"));
    // One part says what arrives: nothing, on Sepolia; none promises an amount.
    expect(arrivals(line)).toHaveLength(1);
    expect(part(line, /arriv/i)).toMatch(/nothing/i);
    expect(part(line, /arriv/i)).toMatch(/Sepolia/);
    expect(arrivals(line).join(" ")).not.toMatch(/\d/);
    // Nor any other part but the fee and what's sent: no payout line at all.
    expect(line.split(" · ").filter((p) => !/fee|sent/i.test(p)).join(" · ")).not.toMatch(/\d/);
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
