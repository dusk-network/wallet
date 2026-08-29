export const SIGN_MESSAGE_PREVIEW_MAX_CHARS = 500;
export const SIGN_MESSAGE_PREVIEW_MAX_BYTES = 4096;

function toCodePoints(text) {
  return Array.from(String(text ?? ""));
}

/**
 * True for a C0 control code point that is unsafe to render as-is on an
 * approval screen (excludes the whitespace controls tab/lf/cr, which are
 * fine in free text). Exported so typedDataDisplay.js shares this exact
 * definition of "unsafe control character" for per-field string leaves
 * instead of maintaining a second, potentially drifting copy.
 */
export function isUnsafeC0ControlCodePoint(code) {
  if (code === 0x09 || code === 0x0a || code === 0x0d) return false;
  return code < 0x20 || code === 0x7f;
}

function hasUnsafeControlCharacters(text) {
  for (const ch of String(text ?? "")) {
    const code = ch.codePointAt(0);
    if (code == null) continue;
    if (isUnsafeC0ControlCodePoint(code)) return true;
  }
  return false;
}

function decodeUtf8(bytes) {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/**
 * Classify arbitrary signMessage bytes for approval display.
 *
 * The returned preview is display metadata only. It must not be used as signing
 * input, and callers must render `text` with textContent rather than HTML.
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

  const chars = toCodePoints(text);
  const truncated = chars.length > SIGN_MESSAGE_PREVIEW_MAX_CHARS;

  return Object.freeze({
    kind: "text",
    byteLength,
    encoding: "utf-8",
    text: truncated ? chars.slice(0, SIGN_MESSAGE_PREVIEW_MAX_CHARS).join("") : text,
    truncated,
    label: truncated ? "Readable message preview (truncated)" : "Readable message",
  });
}
