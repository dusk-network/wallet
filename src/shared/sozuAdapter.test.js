import { describe, expect, it } from "vitest";
import { encodeU64 } from "@dusk-network/networks/sozu";

import { TX_KIND } from "./constants.js";
import {
  buildSozuDepositTx,
  buildSozuWithdrawTx,
  makeSozuStDuskToken,
  parseSozuPoolState,
  parseSozuPosition,
  SOZU_ST_DUSK_DRIVER,
} from "./sozuAdapter.js";
import { sozuConfigOf } from "./sozuConfig.js";

describe("Sozu liquid staking adapter", () => {
  it("takes Sozu's hub, and the contracts to read until it answers, from the node's network's file", () => {
    expect(sozuConfigOf(2)).toEqual({
      networkKey: "testnet",
      contracts: {
        hub: "bae85f8c24730a5a19fbe3d3bd58248ac8c302b62fe414a8c640d8c0ed286b9e",
        pool: "72883945ac1aa032a88543aacc9e358d1dfef07717094c05296ce675f23078f2",
        relayer: "51ced4fad52fc590def2736969c9e3e30013275a996c53714b81d8a08774aa37",
        substrate: "0077ecbf88aa20d6d0a6afa20bd26300a2b562fdbac368bf1e3c1325e8555941",
        "staked-dusk": "fdbf49102e76cf58224003451c6cb9e3403c54ff1d9042f8bc46ec25c6a4337c",
      },
    });
    expect(sozuConfigOf(1)?.contracts.hub).toBe("b32c917e76abc6fcf2edbee0fa70231d8e19c405b18421794a11badfc66d2f26");
    // Devnet has no Sozu; a local or unknown chain has no file.
    expect([sozuConfigOf(3), sozuConfigOf(0), sozuConfigOf(null)]).toEqual([null, null, null]);
  });

  it("builds stDUSK asset metadata with token precision and driver hint", () => {
    expect(makeSozuStDuskToken("44".repeat(32))).toEqual({
      contractId: "44".repeat(32),
      name: "Staked DUSK",
      symbol: "stDUSK",
      decimals: 9,
      driver: SOZU_ST_DUSK_DRIVER,
    });
  });

  it("builds deposit contract-call params with deposit equal to amount", () => {
    const config = sozuConfigOf(2);
    const tx = buildSozuDepositTx({ config, amountLux: "1000000000000" });

    expect(tx).toMatchObject({
      kind: TX_KIND.CONTRACT_CALL,
      privacy: "public",
      contractId: config.contracts.pool,
      fnName: "sozu_stake",
      amount: "0",
      deposit: "1000000000000",
    });
    expect(tx.fnArgs).toEqual(Array.from(encodeU64(1_000_000_000_000n)));
  });

  it("builds withdraw contract-call params without deposit", () => {
    const config = sozuConfigOf(2);
    const tx = buildSozuWithdrawTx({ config, amountLux: "123" });

    expect(tx).toMatchObject({
      kind: TX_KIND.CONTRACT_CALL,
      contractId: config.contracts.pool,
      fnName: "sozu_unstake",
      amount: "0",
      deposit: "0",
    });
    expect(tx.fnArgs).toEqual(Array.from(encodeU64(123n)));
  });

  it("parses pool and position state", () => {
    expect(
      parseSozuPoolState({
        exchangeRate: {
          numerator: "5366833972489941",
          denominator: "3553557929448253",
        },
      })
    ).toMatchObject({
      totalStakeLux: "5366833972489941",
      tokenTotalSupply: "3553557929448253",
      exchangeRate: 1.51027,
    });

    expect(
      parseSozuPoolState({
        totalStakeLux: "5366833972489941",
        tokenTotalSupply: "3553557929448253",
        exchangeRate: 1.51027,
      })
    ).toMatchObject({
      totalStakeLux: "5366833972489941",
      tokenTotalSupply: "3553557929448253",
      exchangeRate: 1.51027,
    });

    expect(parseSozuPosition({ balance: "42" })).toEqual({
      poolBalanceLux: "42",
      stDuskBalanceLux: "0",
    });

    expect(parseSozuPosition({ poolBalanceLux: "42", stDuskBalanceLux: "21" })).toEqual({
      poolBalanceLux: "42",
      stDuskBalanceLux: "21",
    });

    expect(parseSozuPosition({ balance: "42", stDuskBalance: "21" })).toEqual({
      poolBalanceLux: "42",
      stDuskBalanceLux: "21",
    });
  });
});
