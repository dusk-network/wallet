/**
 * Dusk typed-data hash v1 (wallet JS port of chit packages/dusk-typed-data).
 *
 * encodeType(𝒯) concatenates encodeType(S) for S in {primary + transitive struct
 * deps}, sorted by UTF-8 bytes of those strings.
 */
import { sha256 as nobleSha256 } from "@noble/hashes/sha2";

const PREAMBLE = utf8("DUSK_TYPED_DATA_V1\0");
const ORIGIN_TAG = utf8("DUSK_ORIGIN_BIND_V1\0");
const MAX_ENCODED = 1024 * 1024;
const ATOMIC = new Set([
  "string",
  "bytes",
  "bytes32",
  "uint64",
  "uint32",
  "uint8",
  "bool",
]);
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ARRAY_FIXED = /^(.+)\[([1-9][0-9]*)\]$/;
const DOMAIN_TYPE = "DuskTypedDataDomain";
const ZERO32 = new Uint8Array(32);

/**
 * @param {object} params
 */
export function validateTypedDataParams(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("params must be an object");
  }
  if (typeof params.primaryType !== "string" || !params.primaryType.trim()) {
    throw new Error("primaryType is required");
  }
  if (!params.types || typeof params.types !== "object" || Array.isArray(params.types)) {
    throw new Error("types must be an object");
  }
  if (!(params.primaryType in params.types)) {
    throw new Error("primaryType missing from types");
  }
  if (!params.domain || typeof params.domain !== "object" || Array.isArray(params.domain)) {
    throw new Error("domain is required");
  }
  if (!params.message || typeof params.message !== "object" || Array.isArray(params.message)) {
    throw new Error("message must be an object");
  }
  requireDomainType(params.types);
}

/**
 * @param {{
 *   domain: { name: string, version: string, chainId: string, verifyingContract?: string },
 *   types: Record<string, Array<{ name: string, type: string }>>,
 *   primaryType: string,
 *   message: Record<string, unknown>,
 *   origin: string,
 * }} input
 * @returns {{ digest: Uint8Array }}
 */
export function hashTypedData(input) {
  validateTypedDataParams(input);
  return { digest: typedDigest(input) };
}

/**
 * @param {Parameters<typeof hashTypedData>[0]} input
 * @returns {string}
 */
export function hashTypedDataHex(input) {
  return toHex(hashTypedData(input).digest);
}

function typedDigest(input) {
  if (typeof input.origin !== "string") {
    throw new Error("origin must be a string");
  }
  const types = input.types;
  requireDomainType(types);
  const domainValues = domainMessage(input.domain);
  const size = { n: 0 };
  const domainSeparator = structHash(DOMAIN_TYPE, domainValues, types, size);
  const originBind = originBindHash(input.origin);
  const structHashPrimary = structHash(input.primaryType, input.message, types, size);
  return sha256(concat(PREAMBLE, domainSeparator, originBind, structHashPrimary));
}

function originBindHash(origin) {
  const originBytes = utf8(origin);
  return sha256(concat(ORIGIN_TAG, len32(originBytes.length), originBytes));
}

function domainMessage(domain) {
  if (
    typeof domain.name !== "string" ||
    typeof domain.version !== "string" ||
    typeof domain.chainId !== "string"
  ) {
    throw new Error("domain.name, domain.version, domain.chainId required strings");
  }
  let verifyingContract;
  if (domain.verifyingContract === undefined) {
    verifyingContract = toHex(ZERO32);
  } else if (typeof domain.verifyingContract !== "string") {
    throw new Error("domain.verifyingContract must be hex string");
  } else {
    verifyingContract = domain.verifyingContract;
  }
  return {
    name: domain.name,
    version: domain.version,
    chainId: domain.chainId,
    verifyingContract,
  };
}

function requireDomainType(types) {
  const fields = types[DOMAIN_TYPE];
  if (!fields) {
    throw new Error("types must include DuskTypedDataDomain");
  }
  const want = [
    ["name", "string"],
    ["version", "string"],
    ["chainId", "string"],
    ["verifyingContract", "bytes32"],
  ];
  if (fields.length !== want.length) {
    throw new Error("DuskTypedDataDomain field list mismatch");
  }
  for (let i = 0; i < want.length; i++) {
    if (fields[i].name !== want[i][0] || fields[i].type !== want[i][1]) {
      throw new Error("DuskTypedDataDomain fields must match canonical order");
    }
  }
}

function structHash(typeName, values, types, size) {
  if (parseArrayType(typeName) || ATOMIC.has(typeName)) {
    throw new Error(`not a struct type: ${typeName}`);
  }
  if (!IDENT.test(typeName)) {
    throw new Error(`invalid type name: ${typeName}`);
  }
  const fields = types[typeName];
  if (!fields) {
    throw new Error(`unknown type: ${typeName}`);
  }
  checkFields(typeName, fields);
  if (values === null || typeof values !== "object" || Array.isArray(values)) {
    throw new Error(`value for ${typeName} must be object`);
  }
  const th = typeHash(typeName, types);
  const parts = [th];
  const seen = new Set();
  for (const f of fields) {
    if (!(f.name in values)) {
      throw new Error(`missing field ${typeName}.${f.name}`);
    }
    seen.add(f.name);
    parts.push(enc(f.type, values[f.name], types, size));
  }
  for (const k of Object.keys(values)) {
    if (!seen.has(k)) {
      throw new Error(`unexpected field ${typeName}.${k}`);
    }
  }
  return sha256(concat(...parts));
}

function typeHash(typeName, types) {
  const names = new Set();
  collectStructs(typeName, types, names);
  const encoded = [];
  for (const n of names) {
    encoded.push(encodeTypeLocal(n, types[n]));
  }
  encoded.sort(compareUtf8);
  return sha256(utf8(encoded.join("")));
}

function collectStructs(typeName, types, acc) {
  const arr = parseArrayType(typeName);
  if (arr) {
    collectStructs(arr.elem, types, acc);
    return;
  }
  if (ATOMIC.has(typeName)) {
    return;
  }
  rejectDynamic(typeName);
  if (!IDENT.test(typeName)) {
    throw new Error(`invalid type name: ${typeName}`);
  }
  if (acc.has(typeName)) {
    return;
  }
  const fields = types[typeName];
  if (!fields) {
    throw new Error(`unknown type: ${typeName}`);
  }
  acc.add(typeName);
  for (const f of fields) {
    collectStructs(f.type, types, acc);
  }
}

function encodeTypeLocal(name, fields) {
  const inner = fields.map((f) => `${f.type} ${f.name}`).join(",");
  return `${name}(${inner})`;
}

function checkFields(typeName, fields) {
  const names = new Set();
  for (const f of fields) {
    if (typeof f.name !== "string" || typeof f.type !== "string") {
      throw new Error(`${typeName}: bad field def`);
    }
    if (/\s/.test(f.type)) {
      throw new Error(`${typeName}: whitespace in type name forbidden`);
    }
    if (names.has(f.name)) {
      throw new Error(`${typeName}: duplicate field ${f.name}`);
    }
    names.add(f.name);
  }
}

function enc(typeName, value, types, size) {
  rejectDynamic(typeName);
  const arr = parseArrayType(typeName);
  if (arr) {
    if (!Array.isArray(value) || value.length !== arr.n) {
      throw new Error(`${typeName}: expected array length ${arr.n}`);
    }
    const parts = value.map((v) => enc(arr.elem, v, types, size));
    return concat(...parts);
  }
  if (ATOMIC.has(typeName)) {
    return account(encAtomic(typeName, value), size);
  }
  if (!IDENT.test(typeName)) {
    throw new Error(`invalid type name: ${typeName}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${typeName}: expected object`);
  }
  return account(structHash(typeName, value, types, size), size);
}

function encAtomic(typeName, value) {
  switch (typeName) {
    case "string": {
      if (typeof value !== "string") {
        throw new Error("string field requires JSON string");
      }
      const b = utf8(value);
      return concat(len32(b.length), b);
    }
    case "bytes": {
      const raw = decodeHex(value, "bytes");
      return concat(len32(raw.length), raw);
    }
    case "bytes32": {
      const raw = decodeHex(value, "bytes32");
      if (raw.length !== 32) {
        throw new Error("bytes32 requires exactly 32 bytes (no padding)");
      }
      return raw;
    }
    case "uint64":
      return be(parseUint(value, 64), 8);
    case "uint32":
      return be(parseUint(value, 32), 4);
    case "uint8":
      return be(parseUint(value, 8), 1);
    case "bool": {
      if (typeof value !== "boolean") {
        throw new Error("bool field requires JSON boolean");
      }
      return new Uint8Array([value ? 1 : 0]);
    }
    default:
      throw new Error(`unsupported atomic ${typeName}`);
  }
}

function parseUint(value, bits) {
  let n;
  if (typeof value === "number") {
    if (!Number.isInteger(value) || !Number.isSafeInteger(value)) {
      throw new Error("uint JSON number must be a safe integer");
    }
    n = BigInt(value);
  } else if (typeof value === "string") {
    if (!/^(0|[1-9][0-9]*)$/.test(value)) {
      throw new Error("uint string must be decimal");
    }
    n = BigInt(value);
  } else {
    throw new Error("uint requires number or decimal string");
  }
  if (n < 0n) {
    throw new Error("uint cannot be negative");
  }
  const max = (1n << BigInt(bits)) - 1n;
  if (n > max) {
    throw new Error(`uint${bits} overflow`);
  }
  return n;
}

function be(n, width) {
  const out = new Uint8Array(width);
  let x = n;
  for (let i = width - 1; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

function decodeHex(value, label) {
  if (typeof value !== "string") {
    throw new Error(`${label} requires 0x-hex string`);
  }
  let h = value;
  if (h.startsWith("0x") || h.startsWith("0X")) {
    h = h.slice(2);
  }
  if (h.length % 2 !== 0) {
    throw new Error(`${label}: odd hex length`);
  }
  if (!/^[0-9a-fA-F]*$/.test(h)) {
    throw new Error(`${label}: non-hex`);
  }
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function parseArrayType(typeName) {
  const m = ARRAY_FIXED.exec(typeName);
  if (!m) {
    return null;
  }
  return { elem: m[1], n: Number(m[2]) };
}

function rejectDynamic(typeName) {
  if (typeName.includes(" ")) {
    throw new Error("whitespace in type name forbidden");
  }
  if (/\[\]/.test(typeName) && !ARRAY_FIXED.test(typeName)) {
    throw new Error("dynamic T[] not supported in v1");
  }
}

function account(bytes, size) {
  size.n += bytes.length;
  if (size.n > MAX_ENCODED) {
    throw new Error("encoded size exceeds 1 MiB cap");
  }
  return bytes;
}

function utf8(s) {
  return new TextEncoder().encode(s);
}

function len32(n) {
  if (n < 0 || n > 0xffffffff) {
    throw new Error("length out of u32");
  }
  const b = new Uint8Array(4);
  const v = n >>> 0;
  b[0] = (v >>> 24) & 0xff;
  b[1] = (v >>> 16) & 0xff;
  b[2] = (v >>> 8) & 0xff;
  b[3] = v & 0xff;
  return b;
}

function concat(...parts) {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function sha256(data) {
  return nobleSha256(data);
}

function toHex(bytes) {
  let s = "0x";
  for (const b of bytes) {
    s += b.toString(16).padStart(2, "0");
  }
  return s;
}

function compareUtf8(a, b) {
  const ba = utf8(a);
  const bb = utf8(b);
  const n = Math.min(ba.length, bb.length);
  for (let i = 0; i < n; i++) {
    if (ba[i] !== bb[i]) {
      return ba[i] - bb[i];
    }
  }
  return ba.length - bb.length;
}
