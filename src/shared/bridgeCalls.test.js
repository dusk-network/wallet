import { duskEvmContracts } from "@dusk-network/networks/duskevm";
import { describe, expect, it } from "vitest";

import { bridgeDepositRecipient, weiToDusk } from "./bridgeCalls.js";
import { hexToBytes } from "./bytes.js";
import fixtures from "./fixtures/duskevm-bridge-calls.json";

// "deposit-shoot" is byte for byte what the bridge sent the wallet on testnet.
const TESTNET = "https://testnet.nodes.dusk.network";

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
