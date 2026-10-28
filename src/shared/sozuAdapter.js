// Sozu as the wallet sends and shows it: a stake or an unstake as the
// wallet's transaction (the pool's call, from @dusk-network/networks), the
// stDUSK token, and the engine's status figures parsed for the views.

import { SOZU_FN, sozuCall } from "@dusk-network/networks/sozu";

import { TX_KIND } from "./constants.js";
import { LUX_DECIMALS } from "./amount.js";

export const SOZU_ST_DUSK_DRIVER = "sozu_staked_dusk";

export function makeSozuStDuskToken(contractId) {
  return Object.freeze({
    contractId,
    name: "Staked DUSK",
    symbol: "stDUSK",
    decimals: LUX_DECIMALS,
    driver: SOZU_ST_DUSK_DRIVER,
  });
}

function toU64(value, name = "amountLux") {
  try {
    const v = typeof value === "bigint" ? value : BigInt(value);
    if (v < 0n || v > 0xffff_ffff_ffff_ffffn) throw new Error("range");
    return v;
  } catch {
    throw new Error(`Invalid ${name}: expected u64 decimal string`);
  }
}

// A call of the pool from a public account, as the wallet sends it.
function sozuTx(config, fnName, amountLux) {
  if (!config?.contracts?.pool) throw new Error("Sozu pool is not configured for this network");
  const call = sozuCall(config.contracts.pool, fnName, toU64(amountLux));
  return Object.freeze({
    kind: TX_KIND.CONTRACT_CALL,
    privacy: "public",
    contractId: call.contractId,
    fnName: call.fnName,
    fnArgs: Array.from(call.fnArgs),
    amount: "0",
    deposit: call.deposit.toString(),
  });
}

/** A stake: the amount goes along as the call's deposit. */
export const buildSozuDepositTx = ({ config, amountLux } = {}) => sozuTx(config, SOZU_FN.STAKE, amountLux);

/** An unstake: nothing goes along; the pool pays out in the same transaction. */
export const buildSozuWithdrawTx = ({ config, amountLux } = {}) => sozuTx(config, SOZU_FN.UNSTAKE, amountLux);

export function parseSozuPoolState(value = {}) {
  if (value.totalStakeLux != null || value.tokenTotalSupply != null) {
    const totalStake = toU64(value.totalStakeLux ?? 0, "pool.totalStakeLux");
    const totalSupply = toU64(value.tokenTotalSupply ?? 0, "pool.tokenTotalSupply");
    return Object.freeze({
      totalStakeLux: totalStake.toString(),
      tokenTotalSupply: totalSupply.toString(),
      exchangeRate:
        totalSupply > 0n
          ? Number((totalStake * 1_000_000n) / totalSupply) / 1_000_000
          : typeof value.exchangeRate === "number"
          ? value.exchangeRate
          : null,
    });
  }
  const rate = value.exchangeRate ?? value.rate ?? value;
  const numerator = toU64(rate?.numerator ?? 0, "exchangeRate.numerator");
  const denominator = toU64(rate?.denominator ?? 0, "exchangeRate.denominator");
  return Object.freeze({
    totalStakeLux: numerator.toString(),
    tokenTotalSupply: denominator.toString(),
    exchangeRate:
      denominator > 0n
        ? Number((numerator * 1_000_000n) / denominator) / 1_000_000
        : null,
  });
}

export function parseSozuPosition(value = {}) {
  const balance = toU64(value.balance ?? value.poolBalanceLux ?? value.shares ?? 0, "position.balance");
  const stDuskBalance = toU64(value.stDuskBalance ?? value.stDuskBalanceLux ?? 0, "position.stDuskBalance");
  return Object.freeze({
    poolBalanceLux: balance.toString(),
    stDuskBalanceLux: stDuskBalance.toString(),
  });
}
