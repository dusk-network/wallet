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

/**
 * A transaction's nullifiers as lower-case hex, from hex strings or byte
 * arrays; anything else in the list is left out.
 * @param {unknown} value
 * @returns {string[]}
 */
export function normalizeNullifiers(value) {
  const out = [];
  for (const n of Array.isArray(value) ? value : []) {
    try {
      if (typeof n === "string") {
        const hex = n.trim();
        if (/^[0-9a-fA-F]+$/.test(hex)) out.push(hex.toLowerCase());
        continue;
      }
      const u8 = n instanceof Uint8Array ? n : new Uint8Array(n);
      const hex = bytesToHex(u8);
      if (hex) out.push(hex);
    } catch {
      // ignore invalid nullifier shapes
    }
  }
  return out;
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

const isByte = (b) => Number.isInteger(b) && b >= 0 && b <= 255;

// A Uint8Array after Chrome's extension messaging, which serializes it as
// JSON: { "0": 72, "1": 105 }. Only a plain object whose keys are exactly
// "0" to "n-1", each an integer from 0 to 255, and at least one of them: an
// ArrayBuffer comes through as {} too, and its bytes are lost.
function jsonUint8Array(value) {
  if (value === null || typeof value !== "object") return null;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return null;
  const keys = Object.keys(value);
  if (!keys.length) return null;
  const out = new Uint8Array(keys.length);
  for (let i = 0; i < keys.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(value, String(i))) return null;
    const b = value[String(i)];
    if (!isByte(b)) return null;
    out[i] = b;
  }
  return out;
}

/**
 * The bytes of a message to sign, from an explicit encoding only: a
 * Uint8Array (also as Chrome's messaging delivers one, an object with keys
 * "0" to "n-1"), an ArrayBuffer, an array of byte values, hex (0x-prefixed,
 * or bare as Dusk Connect writes it) or `base64:`-prefixed base64. Anything
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
    if (!value.every(isByte)) {
      throw new Error("Message bytes must be integers from 0 to 255");
    }
    return Uint8Array.from(value);
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (/^0x/i.test(s) || isHexString(s)) return hexToBytes(s);
    if (/^base64:/i.test(s)) return base64ToBytes(s);
  }
  const transported = jsonUint8Array(value);
  if (transported) return transported;
  throw new Error("Unsupported message encoding (use 0x-hex, base64:-prefixed base64, or bytes)");
}

export async function sha256Hex(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const digest = await crypto.subtle.digest("SHA-256", b);
  return bytesToHex(new Uint8Array(digest));
}
