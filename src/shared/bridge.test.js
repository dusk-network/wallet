import { describe, expect, it } from "vitest";

import { BRIDGE_CONTRACTS, BRIDGE_SERVICE_ACCOUNTS, bridgeTransfer } from "./bridge.js";
import { bridgeServiceLine, bridgeServiceTransfer, bridgeServiceWarnings } from "./bridgeCalls.js";

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

describe("the bridge's accounts for DUSK leaving Dusk", () => {
  const { mainnet, testnet } = BRIDGE_SERVICE_ACCOUNTS;
  const EVM = "0x" + "ab".repeat(20);

  it("carry the bridge's own fee, 1 DUSK from the amount (its VITE_SERVICE_BRIDGE_FEE_LUX), and testnet's isn't running", () => {
    expect([mainnet.feeLux, testnet.feeLux]).toEqual(["1000000000", "1000000000"]);
    expect([mainnet.running, testnet.running]).toEqual([true, false]);
  });

  it("say what's sent, the fee and what arrives, in one line", () => {
    const service = bridgeServiceTransfer({ nodeUrl: MAINNET, to: mainnet.account, memo: EVM, amount: "2000000000" });
    expect(service).toMatchObject({ chain: "BNB Smart Chain", short: "BSC", network: "mainnet", recipientOk: true, running: true, sentLux: 2_000_000_000n, feeLux: 1_000_000_000n, arrivesLux: 1_000_000_000n });
    expect(bridgeServiceLine(service)).toBe("2 DUSK sent · 1 DUSK bridge fee · 1 DUSK arrives on BNB Smart Chain");
    expect(bridgeServiceWarnings(service)).toEqual([]);

    // The fee takes all of 1 DUSK, and more than that of less.
    for (const amount of ["1000000000", "999999999", undefined]) {
      const all = bridgeServiceTransfer({ nodeUrl: MAINNET, to: mainnet.account, memo: EVM, amount });
      expect(all.arrivesLux).toBe(0n);
      expect(bridgeServiceWarnings(all).map((w) => w.kind)).toEqual(["fee"]);
    }
    expect(bridgeServiceLine(bridgeServiceTransfer({ nodeUrl: MAINNET, to: mainnet.account, amount: "1000000001" }))).toBe(
      "1.000000001 DUSK sent · 1 DUSK bridge fee · 0.000000001 DUSK arrives on BNB Smart Chain"
    );
  });

  it("say testnet's route to Sepolia isn't running right now", () => {
    const service = bridgeServiceTransfer({ nodeUrl: TESTNET, to: testnet.account, memo: EVM, amount: "5000000000" });
    expect(bridgeServiceWarnings(service)).toEqual([
      {
        kind: "off",
        title: "Not running on testnet right now",
        text: "The bridge isn't paying out on Sepolia at the moment, so DUSK sent to it doesn't arrive there.",
      },
    ]);
    expect(bridgeServiceLine(service)).toBe("5 DUSK sent · 1 DUSK bridge fee · Nothing arrives on Ethereum (Sepolia)");
    // Another account, or another network's, is no bridge transfer.
    expect(bridgeServiceTransfer({ nodeUrl: TESTNET, to: mainnet.account, amount: "5000000000" })).toBeNull();
  });
});
