// What crosses a message between the wallet's parts: an error, and a stake's
// figures with their bigints as strings, as structured clone keeps them.

import { ERROR_CODES } from "./errors.js";

/** An error as a reply carries it. */
export function serializeError(err) {
  return {
    code: err?.code ?? ERROR_CODES.INTERNAL,
    message: err?.message ?? String(err),
    data: err?.data,
  };
}

/** A stake's amounts and reward, their bigints as strings. */
export function serializeStakeInfo(info) {
  const amount = info?.amount;
  return {
    amount: amount
      ? {
          value: amount.value?.toString?.() ?? String(amount.value),
          locked: amount.locked?.toString?.() ?? String(amount.locked),
          eligibility: amount.eligibility?.toString?.() ?? String(amount.eligibility),
          total: amount.total?.toString?.() ?? String(amount.total),
        }
      : null,
    reward: info?.reward?.toString?.() ?? String(info?.reward ?? 0),
    faults: Number(info?.faults ?? 0) || 0,
    hardFaults: Number(info?.hardFaults ?? 0) || 0,
  };
}
