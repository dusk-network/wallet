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

export async function sha256Hex(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const digest = await crypto.subtle.digest("SHA-256", b);
  return bytesToHex(new Uint8Array(digest));
}
