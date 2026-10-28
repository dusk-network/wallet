// Shared defaults / helpers for transaction parameters.
//
// The wallet should present deterministic, user-friendly defaults that are
// safe enough for most interactions without scaring users with huge "max fee"
// values.
//
// Values are expressed in LUX (1 LUX = 10^-9 DUSK) as decimal strings.

import { SOZU_GAS as PACKAGE_SOZU_GAS } from "@dusk-network/networks/sozu";

import { TX_KIND } from "./constants.js";

/**
 * Default gas settings by transaction kind.
 *
 * Rationale (a failed transaction, out of gas included, is charged its whole
 * limit, so defaults need clear headroom; the public, shield and staking
 * figures are gas spent on mainnet and testnet under Rusk 1.7.1, October
 * 2026):
 * - Public/Moonlight transfers: 1.81-1.87M gas used, memos included
 * - Shielded/Phoenix transfers: 10.7-11.7M gas used on testnet under 1.7.1,
 *   and ~23.7M on Rusk master (10M for PLONK verification plus ~13.7M for
 *   Merkle/Poseidon work and bookkeeping). Rusk's unreleased
 *   admission rules (rusk-private #594, not in 1.7.1) also enforce a Phoenix
 *   spend-gas admission floor of ~24M plus the transaction's data charge, so
 *   an under-gassed shielded send is rejected at submission (GasLimitTooLow)
 *   or runs out of gas mid-execution.
 * - Shield: 28.5M gas used. Unshield is a Phoenix spend, as above.
 * - Public stake: 31.2-31.3M gas used; unstake and reward withdrawal:
 *   33.0-33.2M.
 * - Shielded staking operations pay from Phoenix notes and are deliberately
 *   kept at the same conservative envelope as shielded contract calls.
 *
 * So:
 * - transfer defaults are privacy-aware: public defaults to 2.5M (1.3x the
 *   highest public transfer), shielded defaults to 50M to clear the ~24M
 *   admission floor plus data charge (~25.7M real total on data-charging
 *   networks) with margin. 50M matches the shield/unshield defaults and the
 *   CLI wallet's transfer default.
 * - shield and public staking default to 50M (1.5x to 1.8x what they
 *   spend), and unshield to the shielded transfer default.
 * - 500,000,000 for contract_call is a conservative default safety cap.
 *
 * Minimums are client-side safety floors. They are not a substitute for
 * node-side simulation/admission checks, but they prevent the wallet from
 * submitting obviously under-gassed transactions that can leave Phoenix
 * reservations stuck until mempool expiry/removal. The shielded transfer
 * floor is 30M: above that ~24M Phoenix admission floor plus data charge,
 * yet below the 50M default so an advanced user can still dial a tighter
 * manual limit. Unshield shares it. The public transfer (2M), shield
 * (30M) and public staking (35M) floors sit 5% to 12% above the highest
 * spend measured.
 *
 * The web wallet uses the same numbers.
 */
export const DEFAULT_TRANSFER_GAS_BY_PRIVACY = Object.freeze({
  public: Object.freeze({
    limit: "2500000",
    price: "1",
  }),
  shielded: Object.freeze({
    limit: "50000000",
    price: "1",
  }),
});

export const MIN_TRANSFER_GAS_BY_PRIVACY = Object.freeze({
  public: Object.freeze({
    limit: "2000000",
  }),
  shielded: Object.freeze({
    limit: "30000000",
  }),
});

export const DEFAULT_GAS_BY_KIND = Object.freeze({
  [TX_KIND.TRANSFER]: Object.freeze({
    ...DEFAULT_TRANSFER_GAS_BY_PRIVACY.public,
  }),
  [TX_KIND.SHIELD]: Object.freeze({
    limit: "50000000",
    price: "1",
  }),
  [TX_KIND.UNSHIELD]: Object.freeze({
    limit: "50000000",
    price: "1",
  }),
  [TX_KIND.STAKE]: Object.freeze({
    limit: "50000000",
    price: "1",
  }),
  [TX_KIND.UNSTAKE]: Object.freeze({
    limit: "50000000",
    price: "1",
  }),
  [TX_KIND.WITHDRAW_REWARD]: Object.freeze({
    limit: "50000000",
    price: "1",
  }),
  [TX_KIND.CONTRACT_CALL]: Object.freeze({
    limit: "500000000",
    price: "1",
  }),
});

export const SHIELDED_STAKING_GAS = Object.freeze({
  limit: "500000000",
  price: "1",
});

export const MIN_GAS_BY_KIND = Object.freeze({
  [TX_KIND.TRANSFER]: Object.freeze({
    ...MIN_TRANSFER_GAS_BY_PRIVACY.public,
  }),
  [TX_KIND.SHIELD]: Object.freeze({
    limit: "30000000",
  }),
  [TX_KIND.UNSHIELD]: Object.freeze({
    limit: "30000000",
  }),
  [TX_KIND.STAKE]: Object.freeze({
    limit: "35000000",
  }),
  [TX_KIND.UNSTAKE]: Object.freeze({
    limit: "35000000",
  }),
  [TX_KIND.WITHDRAW_REWARD]: Object.freeze({
    limit: "35000000",
  }),
});

export const MIN_CONTRACT_CALL_GAS_BY_PRIVACY = Object.freeze({
  shielded: Object.freeze({
    limit: "100000000",
  }),
});

export const MIN_SHIELDED_STAKING_GAS = Object.freeze({
  limit: "100000000",
});

/**
 * Gas for the wallet's own calls of Sozu's liquid staking pool, which are
 * public: @dusk-network/networks' limits and minimums, at the network's
 * price (the wallet's default until the node answers). A site's contract
 * call keeps the contract call default.
 */
export const SOZU_GAS = Object.freeze(
  Object.fromEntries(
    Object.entries(PACKAGE_SOZU_GAS).map(([fnName, { limit, minimum }]) => [
      fnName,
      Object.freeze({ limit: String(limit), price: "1", minimum: String(minimum) }),
    ])
  )
);

// Sozu's gas for one of the wallet's own public calls of its pool, by its function.
function sozuGasFor(kind, opts = {}) {
  const fnName = String(opts?.fnName ?? "");
  if (kind !== TX_KIND.CONTRACT_CALL || privacyIsShielded(opts) || !Object.hasOwn(SOZU_GAS, fnName)) return null;
  return SOZU_GAS[fnName];
}

/**
 * Return the default gas object for a given kind, or null.
 * @param {string} kind
 * @param {{privacy?: string, fnName?: string}} [opts] - `fnName` names a call
 *   of Sozu's pool, sozu_stake or sozu_unstake, which has its own gas
 */
export function getDefaultGas(kind, opts = {}) {
  const k = String(kind || "").toLowerCase();
  const sozu = sozuGasFor(k, opts);
  if (sozu) return Object.freeze({ limit: sozu.limit, price: sozu.price });
  if (k === TX_KIND.TRANSFER) {
    const privacy = String(opts?.privacy ?? "").trim().toLowerCase();
    if (privacy === "shielded") return DEFAULT_TRANSFER_GAS_BY_PRIVACY.shielded;
    if (privacy === "public") return DEFAULT_TRANSFER_GAS_BY_PRIVACY.public;
  }
  if (
    privacyIsShielded(opts) &&
    (k === TX_KIND.STAKE || k === TX_KIND.UNSTAKE || k === TX_KIND.WITHDRAW_REWARD)
  ) {
    return SHIELDED_STAKING_GAS;
  }
  return DEFAULT_GAS_BY_KIND[k] ?? null;
}

function privacyIsShielded(opts = {}) {
  return String(opts?.privacy ?? "").trim().toLowerCase() === "shielded";
}

/**
 * Return the client-side minimum gas floor for a given kind, or null.
 * @param {string} kind
 * @param {{privacy?: string, fnName?: string}} [opts] - `fnName` as getDefaultGas
 */
export function getMinimumGas(kind, opts = {}) {
  const k = String(kind || "").toLowerCase();
  const sozu = sozuGasFor(k, opts);
  if (sozu) return Object.freeze({ limit: sozu.minimum });
  const privacy = String(opts?.privacy ?? "").trim().toLowerCase();
  if (k === TX_KIND.TRANSFER) {
    if (privacy === "shielded") return MIN_TRANSFER_GAS_BY_PRIVACY.shielded;
    if (privacy === "public") return MIN_TRANSFER_GAS_BY_PRIVACY.public;
  }
  if (k === TX_KIND.CONTRACT_CALL && privacy === "shielded") {
    return MIN_CONTRACT_CALL_GAS_BY_PRIVACY.shielded;
  }
  if (
    privacy === "shielded" &&
    (k === TX_KIND.STAKE || k === TX_KIND.UNSTAKE || k === TX_KIND.WITHDRAW_REWARD)
  ) {
    return MIN_SHIELDED_STAKING_GAS;
  }
  return MIN_GAS_BY_KIND[k] ?? null;
}

function parseGasLimit(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid gas limit");
    return BigInt(value);
  }
  const s = String(value).trim();
  if (!/^\d+$/.test(s)) throw new Error("Invalid gas limit");
  return BigInt(s);
}

/**
 * Enforce client-side minimum gas floors.
 * @param {string} kind
 * @param {any} gas
 * @param {{privacy?: string}} [opts]
 */
export function assertMinimumGas(kind, gas, opts = {}) {
  if (!gas || typeof gas !== "object" || Array.isArray(gas)) return gas;
  const min = getMinimumGas(kind, opts);
  if (!min?.limit) return gas;

  const limit = parseGasLimit(gas.limit);
  if (limit === null) return gas;
  const minLimit = BigInt(min.limit);
  if (limit < minLimit) {
    const privacy = String(opts?.privacy ?? "").trim().toLowerCase();
    const prefix =
      String(kind || "").toLowerCase() === TX_KIND.CONTRACT_CALL && privacy === "shielded"
        ? "Shielded contract call"
        : privacy === "shielded"
        ? "Shielded transaction"
        : "Transaction";
    throw new Error(`${prefix} gas limit must be at least ${min.limit}`);
  }
  return gas;
}

/**
 * Apply defaults to a gas object.
 *
 * Rules:
 * - If gas is null/undefined or missing fields, fill from defaults.
 * - Returns `undefined` if no defaults exist and no gas provided.
 *
 * @param {string} kind
 * @param {any} gas
 * @param {Object} [opts]
 * @param {string} [opts.dynamicPrice] - Override default price with live network value.
 * @param {string} [opts.privacy] - Privacy rail for transfer defaults.
 */
export function applyGasDefaults(kind, gas, { dynamicPrice, privacy } = {}) {
  const def = getDefaultGas(kind, { privacy });
  if (!def) return gas === undefined ? undefined : gas;

  const out =
    gas && typeof gas === "object" && !Array.isArray(gas) ? { ...gas } : {};

  if (out.limit === undefined || out.limit === null || out.limit === "") {
    out.limit = def.limit;
  }
  if (out.price === undefined || out.price === null || out.price === "") {
    // Use dynamic price if provided, otherwise fall back to static default
    out.price = dynamicPrice ?? def.price;
  }

  return assertMinimumGas(kind, out, { privacy });
}

/**
 * Apply defaults to a tx params object.
 * @param {any} params
 * @param {Object} [opts]
 * @param {string} [opts.dynamicPrice] - Override default gas price with live network value.
 */
export function applyTxDefaults(params, { dynamicPrice } = {}) {
  if (!params || typeof params !== "object") return params;
  const kind = String(params.kind || "").toLowerCase();
  if (!kind) return params;

  const gas = applyGasDefaults(kind, params.gas, {
    dynamicPrice,
    privacy: params.privacy ?? (params.payment === "address" ? "shielded" : undefined),
  });
  const out = { ...params };

  if (gas === undefined) {
    // Keep undefined (means "auto" for most call sites).
    delete out.gas;
  } else {
    out.gas = gas;
  }

  return out;
}

/**
 * Enforce the invariant: gas must contain *both* limit and price, or neither.
 *
 * This prevents constructing partially-specified gas objects that may break
 * tx building.
 *
 * @param {any} gas
 * @returns {boolean}
 */
export function isCompleteGas(gas) {
  if (gas == null) return true; // undefined/null => treat as auto
  if (typeof gas !== "object" || Array.isArray(gas)) return false;
  const hasLimit = gas.limit !== undefined && gas.limit !== null && gas.limit !== "";
  const hasPrice = gas.price !== undefined && gas.price !== null && gas.price !== "";
  return hasLimit === hasPrice;
}
