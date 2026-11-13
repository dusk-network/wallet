// The payments from Send the overview lists as waiting for the network, or
// as not sent (shared/waitingSends.js), for the profile shown: what Home
// lists, what Send's Available and Max leave out, and what Review says is
// waiting already.

import { safeBigInt } from "../../shared/amount.js";

// The profile the overview shows.
const profileOf = (ov) => {
  const raw = Number(ov?.selectedAccountIndex ?? 0);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
};

// The profile's own, the oldest first.
const ofProfile = (ov) =>
  (Array.isArray(ov?.waitingSends) ? ov.waitingSends : []).filter((send) => Number(send?.profileIndex ?? 0) === profileOf(ov));

/** The profile's payments still waiting to go out: for the network, or being sent. */
export const waitingOf = (ov) => ofProfile(ov).filter((send) => send.waiting);

/** The profile's payments that stopped waiting without going out. */
export const unsentOf = (ov) => ofProfile(ov).filter((send) => !send.waiting);

/**
 * What the payments waiting to go out from the profile's public or shielded
 * balance take from it: each one's amount, and the most its fee costs.
 * @param {object} ov
 * @param {"public" | "shielded"} privacy
 * @returns {bigint}
 */
export function waitingLux(ov, privacy) {
  return waitingOf(ov)
    .filter((send) => (send.privacy === "shielded" ? "shielded" : "public") === privacy)
    .reduce((sum, send) => sum + safeBigInt(send.lux, 0n) + safeBigInt(send.feeLux, 0n), 0n);
}

/**
 * The payment waiting to go out that's the same as this one: the same
 * recipient, amount and memo. The oldest, or undefined.
 * @param {object} ov
 * @param {{ to: string, lux: bigint, memo?: string }} payment
 */
export function sameWaiting(ov, { to, lux, memo = "" }) {
  const recipient = String(to ?? "").trim();
  const text = String(memo ?? "").trim();
  return waitingOf(ov).find(
    (send) => send.to === recipient && safeBigInt(send.lux, -1n) === lux && String(send.memo ?? "").trim() === text
  );
}
