import { TX_KIND } from "./constants.js";
import { LUX_DECIMALS } from "./amount.js";

export const SOZU_FN = Object.freeze({
  STAKE: "sozu_stake",
  UNSTAKE: "sozu_unstake",
});

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

export function encodeSozuU64(value) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, toU64(value), true);
  return out;
}

function sozuContractCall({ config, fnName, amountLux, depositLux = 0n, privacy = "public" }) {
  const cfg = config;
  if (!cfg?.contracts?.pool) throw new Error("Sozu pool is not configured for this network");
  const amount = toU64(amountLux);
  if (amount <= 0n) throw new Error("amountLux must be > 0");

  return Object.freeze({
    kind: TX_KIND.CONTRACT_CALL,
    privacy,
    contractId: cfg.contracts.pool,
    fnName,
    fnArgs: Array.from(encodeSozuU64(amount)),
    amount: "0",
    deposit: toU64(depositLux, "depositLux").toString(),
  });
}

export function buildSozuDepositTx(params = {}) {
  const amount = toU64(params.amountLux);
  return sozuContractCall({
    config: params.config,
    fnName: SOZU_FN.STAKE,
    amountLux: amount,
    depositLux: amount,
    privacy: params.privacy,
  });
}

export function buildSozuWithdrawTx(params = {}) {
  return sozuContractCall({
    config: params.config,
    fnName: SOZU_FN.UNSTAKE,
    amountLux: params.amountLux,
    depositLux: 0n,
    privacy: params.privacy,
  });
}

export function buildSozuClaimTx() {
  throw new Error("Sozu v1 does not expose a wallet claim action");
}

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

export function estimateSozuPositionValue(position = {}, pool = {}) {
  const shares = toU64(position.stDuskBalanceLux ?? position.shares ?? 0, "position.stDuskBalanceLux");
  const totalStake = toU64(pool.totalStakeLux ?? pool.exchangeRate?.numerator ?? 0, "pool.totalStakeLux");
  const totalSupply = toU64(pool.tokenTotalSupply ?? pool.exchangeRate?.denominator ?? 0, "pool.tokenTotalSupply");
  return totalSupply > 0n ? ((shares * totalStake) / totalSupply).toString() : "0";
}

export function parseSozuPosition(value = {}) {
  const balance = toU64(value.balance ?? value.poolBalanceLux ?? value.shares ?? 0, "position.balance");
  const stDuskBalance = toU64(value.stDuskBalance ?? value.stDuskBalanceLux ?? 0, "position.stDuskBalance");
  return Object.freeze({
    poolBalanceLux: balance.toString(),
    stDuskBalanceLux: stDuskBalance.toString(),
  });
}
