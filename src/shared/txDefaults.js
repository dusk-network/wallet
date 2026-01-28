// Shared defaults / helpers for transaction parameters.
//
// The wallet should present deterministic, user-friendly defaults that are
// safe enough for most interactions without scaring users with huge "max fee"
// values.
//
// Values are expressed in LUX (1 LUX = 10^-9 DUSK) as decimal strings.

import { TX_KIND } from "./constants.js";

/**
 * Default gas settings by transaction kind.
 *
 * Rationale (current practical guidance):
 * - Public transfers: ~120k gas used
 * - Shielded transfers: ~1.1M gas used
 * - Heavy operations (stake/unstake/withdraw): can reach ~27M
 *
 * So:
 * - 10,000,000 for kind=transfer is very safe for both public + shielded,
 *   while keeping max fee reasonable.
 * - 500,000,000 for contract_call is a conservative default safety cap.
 */
export const DEFAULT_GAS_BY_KIND = Object.freeze({
  [TX_KIND.TRANSFER]: Object.freeze({
    limit: "10000000",
    price: "1",
  }),
  [TX_KIND.SHIELD]: Object.freeze({
    limit: "50000000",
    price: "1",
  }),
  [TX_KIND.UNSHIELD]: Object.freeze({
    limit: "50000000",
    price: "1",
  }),
  [TX_KIND.CONTRACT_CALL]: Object.freeze({
    limit: "500000000",
    price: "1",
  }),
});

/**
 * Return the default gas object for a given kind, or null.
 * @param {string} kind
 */
export function getDefaultGas(kind) {
  const k = String(kind || "").toLowerCase();
  return DEFAULT_GAS_BY_KIND[k] ?? null;
}

/**
 * Apply defaults to a gas object.
 *
 * Rules:
 * - If gas is `null`, treat as explicit "auto" and keep null.
 * - If gas is undefined or missing fields, fill from defaults.
 * - Returns `undefined` if no defaults exist and no gas provided.
 *
 * @param {string} kind
 * @param {any} gas
 */
export function applyGasDefaults(kind, gas) {
  const def = getDefaultGas(kind);
  if (!def) return gas === undefined ? undefined : gas;

  // Explicit "auto" sentinel.
  if (gas === null) return null;

  const out =
    gas && typeof gas === "object" && !Array.isArray(gas) ? { ...gas } : {};

  if (out.limit === undefined || out.limit === null || out.limit === "") {
    out.limit = def.limit;
  }
  if (out.price === undefined || out.price === null || out.price === "") {
    out.price = def.price;
  }

  return out;
}

/**
 * Apply defaults to a tx params object.
 * @param {any} params
 */
export function applyTxDefaults(params) {
  if (!params || typeof params !== "object") return params;
  const kind = String(params.kind || "").toLowerCase();
  if (!kind) return params;

  const gas = applyGasDefaults(kind, params.gas);
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
