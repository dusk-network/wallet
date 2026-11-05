// Text someone else chose, as the wallet shows it: a sign request, a memo, a
// site's words. Bytes that change how text reads (a right-to-left override
// that shows 0001 as 1000) never reach the screen as they are, and what was
// changed is flagged. Display only: what's signed or sent stays the original.

const REPLACEMENT_CHAR = "�";

const BIDI_CONTROL = /\p{Bidi_Control}/u;
const FORMAT_CONTROL = /\p{Cf}/u;
const LINE_SEPARATOR = /[\n\r\u2028\u2029]/u;

/** A code unit as JSON would escape it: "\u202e". */
export function escapeCodeUnit(char) {
  return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
}

/**
 * True for a C0 control code point that is unsafe to render as-is on an
 * approval screen (excludes the whitespace controls tab/lf/cr, which are
 * fine in free text).
 */
export function isUnsafeC0ControlCodePoint(code) {
  if (code === 0x09 || code === 0x0a || code === 0x0d) return false;
  return code < 0x20 || code === 0x7f;
}

function isC1ControlCodePoint(code) {
  return code === 0x7f || (code >= 0x80 && code <= 0x9f);
}

/**
 * Bound a readable preview by source code points without splitting pairs.
 * Replace unsafe controls and visibly escape formatting/line separators.
 * Non-NFC sequences are flagged, never normalized. Originals remain available
 * in the full JSON view; these display substitutions must never be signed.
 * `keepLines`: for free text shown as lines, a tab and a line break stay.
 *
 * @param {string} raw
 * @param {number} [maxChars]
 * @param {{ keepLines?: boolean }} [opts]
 * @returns {{ display: string, flags: string[] }}
 */
export function sanitizeStringForDisplay(raw, maxChars = 2048, { keepLines = false } = {}) {
  const flags = new Set();
  const out = [];
  for (const char of raw) {
    const code = char.codePointAt(0);
    if (keepLines && (code === 0x09 || code === 0x0a || code === 0x0d)) {
      out.push(char);
    } else if (code >= 0xd800 && code <= 0xdfff) {
      flags.add("invalid_surrogate");
      out.push(REPLACEMENT_CHAR);
    } else if (BIDI_CONTROL.test(char)) {
      flags.add("bidi_control");
      out.push(REPLACEMENT_CHAR);
    } else if (FORMAT_CONTROL.test(char) || LINE_SEPARATOR.test(char)) {
      flags.add(LINE_SEPARATOR.test(char) ? "line_separator" : "invisible_format");
      out.push(char.replace(/[\s\S]/g, escapeCodeUnit));
    } else if (code === 0x09 || isUnsafeC0ControlCodePoint(code) || isC1ControlCodePoint(code)) {
      flags.add("control_chars");
      out.push(REPLACEMENT_CHAR);
    } else {
      out.push(char);
    }
  }
  if (raw.normalize("NFC") !== raw) flags.add("non_nfc");
  if (out.length > maxChars) flags.add("truncated");
  return { display: out.slice(0, maxChars).join(""), flags: [...flags] };
}

// What sanitizeStringForDisplay flags that a reader should look at twice: not
// that a preview was cut.
const REVIEW_FLAGS = new Set(["control_chars", "bidi_control", "invalid_surrogate", "invisible_format", "line_separator", "non_nfc"]);

/**
 * Whether text with these flags needs a second look.
 * @param {string[]} [flags]
 */
export const textNeedsReview = (flags = []) => flags.some((flag) => REVIEW_FLAGS.has(flag));

/**
 * Free text as the wallet shows it whole, and whether it needs a second look.
 * @param {unknown} raw
 * @param {{ keepLines?: boolean }} [opts]
 * @returns {{ text: string, flagged: boolean }}
 */
export function safeText(raw, opts) {
  const { display, flags } = sanitizeStringForDisplay(String(raw ?? ""), Infinity, opts);
  return { text: display, flagged: textNeedsReview(flags) };
}
