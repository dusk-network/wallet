import { TX_KIND } from "./constants.js";

export const SOZU_FN = Object.freeze({
  STAKE: "sozu_stake",
  UNSTAKE: "sozu_unstake",
});

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
  const balance = toU64(value.balance ?? value.shares ?? 0, "position.balance");
  return Object.freeze({
    shareBalanceLux: balance.toString(),
  });
}
