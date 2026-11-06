import { sanitizeStringForDisplay, textChecks, textNeedsReview } from "./safeText.js";

export const SIGN_MESSAGE_PREVIEW_MAX_CHARS = 500;
export const SIGN_MESSAGE_PREVIEW_MAX_BYTES = 4096;

// A C0 control or DEL, other than what free text has: tab, line feed, carriage return.
const UNSAFE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

const hasUnsafeControlCharacters = (text) => UNSAFE_CONTROL.test(String(text ?? ""));

function decodeUtf8(bytes) {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/**
 * Classify arbitrary signMessage bytes for approval display.
 *
 * The returned preview is display metadata only. It must not be used as signing
 * input, and callers must render `text` with textContent rather than HTML. Its
 * text is what's safe to show (safeText.js): characters that change how text
 * reads are neutralized as typed data's are, and `needsReview` says so.
 *
 * @param {Uint8Array|ArrayBuffer|ArrayLike<number>} bytes
 */
export function describeSignMessagePreview(bytes) {
  const msgBytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const byteLength = msgBytes.byteLength;

  if (byteLength > SIGN_MESSAGE_PREVIEW_MAX_BYTES) {
    return Object.freeze({
      kind: "opaque",
      byteLength,
      reason: "too_large",
      label: "Opaque bytes",
    });
  }

  let text = "";
  try {
    text = decodeUtf8(msgBytes);
  } catch {
    return Object.freeze({
      kind: "opaque",
      byteLength,
      reason: "invalid_utf8",
      label: "Opaque bytes",
    });
  }

  if (hasUnsafeControlCharacters(text)) {
    return Object.freeze({
      kind: "opaque",
      byteLength,
      reason: "control_characters",
      label: "Opaque bytes",
    });
  }

  const { display, flags } = sanitizeStringForDisplay(text, SIGN_MESSAGE_PREVIEW_MAX_CHARS, { keepLines: true });
  const truncated = flags.includes("truncated");

  return Object.freeze({
    kind: "text",
    byteLength,
    encoding: "utf-8",
    text: display,
    truncated,
    needsReview: textNeedsReview(flags),
    checks: Object.freeze(textChecks(flags)),
    label: truncated ? "Readable message preview (truncated)" : "Readable message",
  });
}
