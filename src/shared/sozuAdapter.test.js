import { describe, expect, it } from "vitest";

import { TX_KIND } from "./constants.js";
import {
  buildSozuClaimTx,
  buildSozuDepositTx,
  buildSozuWithdrawTx,
  encodeSozuU64,
  estimateSozuPositionValue,
  parseSozuPoolState,
  parseSozuPosition,
} from "./sozuAdapter.js";
import {
  getSozuConfig,
  getSozuHubBootstrap,
  hasSozuConfig,
  resolveSozuConfig,
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

  it("resolves hub-discovered contracts over hardcoded fallback", () => {
    const bootstrap = getSozuHubBootstrap("testnet");
    const cfg = resolveSozuConfig({
      bootstrap,
      discoveredContracts: {
        pool: "11".repeat(32),
        relayer: "22".repeat(32),
        substrate: "33".repeat(32),
        "staked-dusk": "44".repeat(32),
      },
    });

    expect(cfg.source).toBe("hub");
    expect(cfg.contracts.hub).toBe(bootstrap.contracts.hub);
    expect(cfg.contracts.pool).toBe("11".repeat(32));
    expect(cfg.contracts["staked-dusk"]).toBe("44".repeat(32));
  });

  it("falls back to static pool config when hub discovery is incomplete", () => {
    const cfg = resolveSozuConfig({
      networkKey: "testnet",
      discoveredContracts: { relayer: "22".repeat(32) },
    });

    expect(cfg.source).toBe("fallback");
    expect(cfg.contracts.pool).toBe(getSozuConfig("testnet").contracts.pool);
    expect(cfg.contracts.relayer).toBe("22".repeat(32));
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

    expect(parseSozuPosition({ balance: "42" })).toEqual({
      shareBalanceLux: "42",
    });
  });

  it("estimates position value from shares and pool exchange rate", () => {
    expect(
      estimateSozuPositionValue(
        { shareBalanceLux: "200" },
        { totalStakeLux: "1500", tokenTotalSupply: "1000" }
      )
    ).toBe("300");
  });

  it("does not expose a fake claim action", () => {
    expect(() => buildSozuClaimTx()).toThrow("does not expose a wallet claim action");
  });
});
