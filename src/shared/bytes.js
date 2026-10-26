// Shared byte encoding helpers.

export function isHexString(s) {
  return typeof s === "string" && /^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0;
}

export function hexToBytes(hex) {
  let s = String(hex || "").trim();
  if (s.startsWith("0x") || s.startsWith("0X")) s = s.slice(2);
  if (s === "") return new Uint8Array();
  if (!isHexString(s)) throw new Error("Invalid hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}

export function bytesToTransportHex(bytes) {
  return `0x${bytesToHex(bytes)}`;
}

export function base64ToBytes(b64) {
  const s = String(b64 || "").trim().replace(/^base64:/i, "");
  if (!s) return new Uint8Array();
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Best-effort conversion of various encodings to bytes.
 * Supports: Uint8Array, ArrayBuffer, number[], hex (0x.. or raw), base64 (with or without base64: prefix)
 */
export function toBytes(value) {
  if (value == null) return new Uint8Array();
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return new Uint8Array(value);

  if (typeof value === "string") {
    const s = value.trim();

    // Prefer explicit hex.
    if (s.startsWith("0x") || isHexString(s)) {
      return hexToBytes(s);
    }

    // Support explicit base64.
    if (/^base64:/i.test(s)) {
      return base64ToBytes(s);
    }

    // Best-effort base64.
    try {
      return base64ToBytes(s);
    } catch {
      // ignore
    }
  }

  throw new Error("Unsupported byte encoding (use hex string, base64 string, or number[])");
}

/**
 * The bytes of a message to sign, from an explicit encoding only: a
 * Uint8Array, an ArrayBuffer, an array of byte values, hex (0x-prefixed, or
 * bare as Dusk Connect writes it) or `base64:`-prefixed base64. Anything
 * else, plain text above all, is refused rather than guessed at: decoding
 * "I agree" as base64 signs other bytes than the ones the site showed.
 *
 * @param {unknown} value
 * @returns {Uint8Array}
 */
export function messageBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) {
    if (!value.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
      throw new Error("Message bytes must be integers from 0 to 255");
    }
    return Uint8Array.from(value);
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (/^0x/i.test(s) || isHexString(s)) return hexToBytes(s);
    if (/^base64:/i.test(s)) return base64ToBytes(s);
  }
  throw new Error("Unsupported message encoding (use 0x-hex, base64:-prefixed base64, or bytes)");
}

export async function sha256Hex(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const digest = await crypto.subtle.digest("SHA-256", b);
  return bytesToHex(new Uint8Array(digest));
}
