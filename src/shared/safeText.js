// Text someone else chose, as the wallet shows it: a sign request, a memo, a
// site's words. Bytes that change how text reads (a right-to-left override
// that shows 0001 as 1000) never reach the screen as they are, and what was
// changed is flagged (@dusk-network/app-core/text). Right-to-left words and
// their digits are set apart, so what's around them reads in the order of the
// bytes: "Pay א 10 א 1000" never shows as "Pay א 1000 א 10". Display only:
// what's signed or sent stays the original.

import { displayText } from "@dusk-network/app-core/text";

/**
 * Text bounded for a preview, by characters of its source and never through
 * one, in the words a typed-data row keeps it. `keepLines`: for free text shown
 * as lines, a line break stays.
 *
 * @param {string} raw
 * @param {number} [maxChars]
 * @param {{ keepLines?: boolean }} [opts]
 * @returns {{ display: string, flags: string[] }}
 */
export function sanitizeStringForDisplay(raw, maxChars = 2048, { keepLines = false } = {}) {
  const { text, flags } = displayText(raw, { maxChars, lineBreaks: keepLines, isolate: true });
  return { display: text, flags };
}

/**
 * Whether text with these flags needs a second look: anything but a preview
 * being cut.
 * @param {string[]} [flags]
 */
export const textNeedsReview = (flags = []) => flags.some((flag) => flag !== "truncated");

// What's about a text's numbers alone: nothing in it is changed or hidden.
const NUMBER_FLAGS = new Set(["mixed_digits", "rtl_digits"]);

/**
 * What text with these flags asks a person to check: hidden characters, shown
 * as their codes; a number whose digits mix scripts, as 1٠5 with an
 * Arabic-Indic zero; a number in digits that read right to left, as N'Ko's.
 * @param {string[]} [flags]
 * @returns {{ hidden: boolean, mixedDigits: boolean, rtlDigits: boolean }}
 */
export const textChecks = (flags = []) => ({
  hidden: flags.some((flag) => flag !== "truncated" && !NUMBER_FLAGS.has(flag)),
  mixedDigits: flags.includes("mixed_digits"),
  rtlDigits: flags.includes("rtl_digits"),
});

/**
 * Free text as the wallet shows it whole, whether it needs a second look, and
 * what to check.
 * @param {unknown} raw
 * @param {{ keepLines?: boolean }} [opts]
 * @returns {{ text: string, flagged: boolean, checks: ReturnType<typeof textChecks> }}
 */
export function safeText(raw, { keepLines = false } = {}) {
  const { text, flags } = displayText(raw, { lineBreaks: keepLines, isolate: true });
  return { text, flagged: textNeedsReview(flags), checks: textChecks(flags) };
}
