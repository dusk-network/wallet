const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_MAP = new Map([...BASE58_ALPHABET].map((ch, index) => [ch, index]));

function base58DecodedLength(value) {
  const input = String(value ?? "").trim();
  if (!input) return 0;

  const bytes = [];
  for (const ch of input) {
    const val = BASE58_MAP.get(ch);
    if (val === undefined) return 0;

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

  return bytes.length + leadingZeros;
}

export function classifyDuskIdentifier(value) {
  const len = base58DecodedLength(value);
  if (len === 96) return "account";
  if (len === 64) return "address";
  return "undefined";
}
