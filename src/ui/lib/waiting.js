// The payments from Send the overview lists as waiting for the network, as
// not sent, or as gone out after they waited (shared/waitingSends.js), for
// the profile shown: what Home lists, what Send's Available and Max leave
// out, and what Review says is waiting already.

import { formatDuskExact, formatLuxForInput, safeBigInt } from "../../shared/amount.js";
import { MEANWHILE_READ_MS, SENT_MEANWHILE_TEXT } from "../../shared/waitingSends.js";

/**
 * Who pays and on which network, as a Review was asked for: the wallet, the
 * profile and the node. A draft for one is refused by another (send.js).
 * @param {object} ov
 */
export const reviewContextOf = (ov) => `${ov?.accounts?.[0] ?? ""} ${Number(ov?.selectedAccountIndex ?? 0) || 0} ${ov?.nodeUrl ?? ""}`;

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
export const unsentOf = (ov) => ofProfile(ov).filter((send) => !send.waiting && !send.went);

/** The profile's payments gone out after they waited, said Sent till their block's in. */
export const wentOf = (ov) => ofProfile(ov).filter((send) => !send.waiting && send.went);

/**
 * What the payments waiting to go out from the profile's public or shielded
 * balance take from it: each one's amount, and the most its fee costs. Not
 * the one a Review sends in its place (`except`, its draft's `replaces`),
 * which waits only till that one goes (Astra's: Review took the held
 * payment's amount and fee as well as its own).
 * @param {object} ov
 * @param {"public" | "shielded"} privacy
 * @param {{ except?: string }} [opts]
 * @returns {bigint}
 */
export function waitingLux(ov, privacy, { except = "" } = {}) {
  return waitingOf(ov)
    .filter((send) => (send.privacy === "shielded" ? "shielded" : "public") === privacy && !(except && send.sendId === except))
    .reduce((sum, send) => sum + safeBigInt(send.lux, 0n) + safeBigInt(send.feeLux, 0n), 0n);
}

/**
 * The payment waiting to go out that's the same as this one: the same
 * recipient, amount and memo. The oldest, or undefined. Never the one a
 * Review sends in its place (`except`).
 * @param {object} ov
 * @param {{ to: string, lux: bigint, memo?: string }} payment
 * @param {{ except?: string }} [opts]
 */
export function sameWaiting(ov, { to, lux, memo = "" }, { except = "" } = {}) {
  const recipient = String(to ?? "").trim();
  const text = String(memo ?? "").trim();
  return waitingOf(ov).find(
    (send) => !(except && send.sendId === except) && send.to === recipient && safeBigInt(send.lux, -1n) === lux && String(send.memo ?? "").trim() === text
  );
}

/**
 * Send's draft of a payment kept here, for its Review: what it pays, to
 * whom, with what memo, from the wallet, profile and network it was made on,
 * in the place of the one Home or Sent said wasn't sent, or held for Send it
 * too (`replaces`), which it takes once it's sent from there.
 * @param {object} send - one of the overview's waitingSends
 * @param {object} ov
 * @param {{ hidden?: boolean }} [opts] - its amount hidden, as balances are
 */
export function againDraft(send, ov, { hidden = false } = {}) {
  const lux = safeBigInt(send?.lux, 0n);
  return {
    to: String(send?.to ?? ""),
    privacy: send?.privacy === "shielded" ? "shielded" : "public",
    amountLux: lux.toString(),
    amountDusk: formatLuxForInput(lux),
    amountMasked: hidden,
    memo: String(send?.memo ?? ""),
    replaces: String(send?.sendId ?? ""),
    // From the wallet, profile and network it was made on, as Home lists it: Review refuses it from any other.
    reviewedFor: reviewContextOf(ov),
  };
}

// A memo said in a sentence: none that holds a control or direction character.
const sayable = (memo) => {
  const text = String(memo ?? "").trim();
  return text && !/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/.test(text) ? text : "";
};

/**
 * Whether what the account sent meanwhile is this very payment: to the same
 * recipient, the same amount, the same memo.
 * @param {object} send - a held payment, with what was sent meanwhile (`meanwhile`)
 */
export function sameSentMeanwhile(send) {
  const memo = String(send?.memo ?? "").trim();
  return (Array.isArray(send?.meanwhile) ? send.meanwhile : []).some(
    (other) =>
      String(other?.to ?? "").toLowerCase() === String(send?.to ?? "").toLowerCase() &&
      safeBigInt(other?.lux, -1n) === safeBigInt(send?.lux, -2n) &&
      String(other?.memo ?? "").trim() === memo
  );
}

/** What a payment held for Send it too says while what its account sent meanwhile is read. */
export const CHECKING_MEANWHILE_TEXT = "Checking what your account sent…";

/**
 * Whether a payment held for Send it too still reads what its account sent
 * meanwhile (`checking`, since when): its Send it too and Don't send wait for
 * the answer, though no longer than the node is given for it, and a little.
 * @param {object} send
 * @param {number} [now]
 */
export function checksMeanwhile(send, now = Date.now()) {
  const since = Number(send?.checking);
  return Boolean(send?.held) && since > 0 && now - since < MEANWHILE_READ_MS + 5_000;
}

/**
 * What a payment held for Send it too says of what its account sent while it
 * waited, from the chain: "Your account sent 0.001 DUSK to your Profile 2 at
 * 10:02 while this waited." with its memo, and "That looks like this same
 * payment." where it's this one (Marek's, Lena's, Chen's: "something else"
 * was the very same payment, from another device). "Checking what your
 * account sent…" while it's read; the plain sentence where the node named
 * nothing.
 * @param {object} send - a held payment, with `meanwhile`
 * @param {{ toText: (address: string) => string, whenText: (at: number) => string, hidden?: boolean }} words
 * @returns {string}
 */
export function sentMeanwhileText(send, { toText, whenText, hidden = false }) {
  if (checksMeanwhile(send)) return CHECKING_MEANWHILE_TEXT;
  const sent = Array.isArray(send?.meanwhile) ? send.meanwhile : [];
  if (!sent.length) return SENT_MEANWHILE_TEXT;
  const [first] = sent;
  const amount = hidden ? "••••" : formatDuskExact(String(first.lux ?? "0"));
  const when = Number(first.at) > 0 ? ` ${whenText(Number(first.at))}` : "";
  const memo = sayable(first.memo);
  const more = sent.length > 1 ? `, and ${sent.length - 1} more,` : "";
  const what = `Your account sent ${amount} DUSK to ${toText(String(first.to ?? ""))}${when}${memo ? ` with the memo “${memo}”` : ""}${more} while this waited.`;
  return sameSentMeanwhile(send) ? `${what} That looks like this same payment.` : what;
}
