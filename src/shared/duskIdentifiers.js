const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_MAP = new Map([...BASE58_ALPHABET].map((ch, index) => [ch, index]));

/**
 * A base58 string's bytes, or null when it isn't base58.
 * @param {unknown} value
 * @returns {Uint8Array | null}
 */
export function base58Decode(value) {
  const input = String(value ?? "").trim();
  if (!input) return null;

  // Little-endian while it's built.
  const bytes = [];
  for (const ch of input) {
    const val = BASE58_MAP.get(ch);
    if (val === undefined) return null;

    let carry = val;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  let leadingZeros = 0;
  for (const ch of input) {
    if (ch !== "1") break;
    leadingZeros++;
  }

  return Uint8Array.from([...new Array(leadingZeros).fill(0), ...bytes.reverse()]);
}

const base58DecodedLength = (value) => base58Decode(value)?.length ?? 0;

export function classifyDuskIdentifier(value) {
  const len = base58DecodedLength(value);
  if (len === 96) return "account";
  if (len === 64) return "address";
  return "undefined";
}
