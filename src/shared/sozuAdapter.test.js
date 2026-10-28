import { describe, expect, it } from "vitest";

import { TX_KIND } from "./constants.js";
import {
  buildSozuClaimTx,
  buildSozuDepositTx,
  buildSozuWithdrawTx,
  encodeSozuU64,
  estimateSozuPositionValue,
  makeSozuStDuskToken,
  parseSozuPoolState,
  parseSozuPosition,
  SOZU_ST_DUSK_DRIVER,
} from "./sozuAdapter.js";
import {
  getSozuConfig,
  getSozuHubBootstrap,
  hasSozuConfig,
} from "./sozuConfig.js";

describe("Sozu liquid staking adapter", () => {
  it("selects hardcoded v1 configs for supported networks", () => {
    expect(getSozuConfig("testnet")?.contracts.pool).toBe(
      "72883945ac1aa032a88543aacc9e358d1dfef07717094c05296ce675f23078f2"
    );
    expect(getSozuConfig("mainnet")?.contracts.hub).toBe(
      "b32c917e76abc6fcf2edbee0fa70231d8e19c405b18421794a11badfc66d2f26"
    );
    expect(hasSozuConfig("devnet")).toBe(false);
    expect(getSozuConfig("local")).toBe(null);
  });

  it("starts from the hub, with the contracts it named when written to use until it answers", () => {
    const testnet = getSozuHubBootstrap("testnet");
    expect(testnet.contracts).toEqual({ hub: "bae85f8c24730a5a19fbe3d3bd58248ac8c302b62fe414a8c640d8c0ed286b9e" });
    expect(testnet.fallbackContracts["staked-dusk"]).toBe("fdbf49102e76cf58224003451c6cb9e3403c54ff1d9042f8bc46ec25c6a4337c");
    expect(getSozuHubBootstrap("1").fallbackContracts["staked-dusk"]).toBe(
      "eb158fceeae76e59b28c1e6857eb50cf6a7a69532817fc455458096aab527980"
    );
    expect(getSozuHubBootstrap("devnet")).toBeNull();
  });

  it("encodes Sozu u64 args as little-endian bytes", () => {
    expect(Array.from(encodeSozuU64("1000000000000"))).toEqual([
      0x00,
      0x10,
      0xa5,
      0xd4,
      0xe8,
      0x00,
      0x00,
      0x00,
    ]);
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
    const config = getSozuConfig("testnet");
    const tx = buildSozuDepositTx({ config, amountLux: "1000000000000" });

    expect(tx).toMatchObject({
      kind: TX_KIND.CONTRACT_CALL,
      privacy: "public",
      contractId: config.contracts.pool,
      fnName: "sozu_stake",
      amount: "0",
      deposit: "1000000000000",
    });
    expect(tx.fnArgs).toEqual(Array.from(encodeSozuU64("1000000000000")));
  });

  it("builds withdraw contract-call params without deposit", () => {
    const config = getSozuConfig("testnet");
    const tx = buildSozuWithdrawTx({ config, amountLux: "123" });

    expect(tx).toMatchObject({
      kind: TX_KIND.CONTRACT_CALL,
      contractId: config.contracts.pool,
      fnName: "sozu_unstake",
      amount: "0",
      deposit: "0",
    });
    expect(tx.fnArgs).toEqual(Array.from(encodeSozuU64("123")));
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

  it("estimates position value from stDUSK balance and pool exchange rate", () => {
    expect(
      estimateSozuPositionValue(
        { stDuskBalanceLux: "200" },
        { totalStakeLux: "1500", tokenTotalSupply: "1000" }
      )
    ).toBe("300");
  });

  it("does not expose a fake claim action", () => {
    expect(() => buildSozuClaimTx()).toThrow("does not expose a wallet claim action");
  });
});
