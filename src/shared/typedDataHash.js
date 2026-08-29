/**
 * Dusk typed-data hash v1 (wallet JS port of chit packages/dusk-typed-data).
 *
 * Normative spec: docs/typed-data-v1.md (Connect repo), sections 4-11.
 *
 * encodeType(S) is encodeTypeLocal(S) followed by encodeTypeLocal(D) for every
 * struct D in deps(S) \ {S}, sorted by UTF-8 bytes of the type name. The
 * *primary* type's own local encoding always comes first (spec 6.1) - it is
 * NOT merged into the sorted list of dependencies.
 *
 * Encoded width is a function of the type alone (spec 4.1): `string` and
 * `bytes` both encode to a 32-byte sha256 digest of their content, so there is
 * no value-dependent size budget to enforce as part of digest validity (spec
 * 11). Resource limits are a separate, signer-side policy - see
 * `checkPolicyLimits`, which is never called from the hashing path.
 */
import { sha256 as nobleSha256 } from "@noble/hashes/sha2";

const PREAMBLE = utf8("DUSK_TYPED_DATA_V1\0");
const ORIGIN_TAG = utf8("DUSK_ORIGIN_BIND_V1\0");
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
// n must be `[1-9][0-9]*` - this already rejects `T[0]`, `T[01]`, and `T[]`
// (no digits at all does not match) by construction.
const ARRAY_FIXED = /^(.+)\[([1-9][0-9]*)\]$/;
const DOMAIN_TYPE = "DuskTypedDataDomain";
const ZERO32 = new Uint8Array(32);
const RESERVED_FIELD_NAMES = new Set(["__proto__", "constructor", "prototype"]);

// Signer-side resource floor, spec section 11. Not part of digest validity;
// see `checkPolicyLimits`.
const POLICY_LIMITS = {
  maxStructTypes: 32,
  maxFieldsPerStruct: 64,
  maxNestingDepth: 8,
  maxArrayElements: 256,
  maxStringBytes: 65536,
  maxTotalDecodedBytes: 262144,
};

/**
 * @param {string} code stable error code, see docs/typed-data-v1.md section 10
 * @param {string} message
 * @returns {never}
 */
function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  throw err;
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {object} params
 */
export function validateTypedDataParams(params) {
  if (!isPlainObject(params)) {
    fail("E_PARAMS_SHAPE", "params must be an object");
  }
  if (!isPlainObject(params.types)) {
    fail("E_PARAMS_SHAPE", "types must be an object");
  }
  if (!isPlainObject(params.domain)) {
    fail("E_PARAMS_SHAPE", "domain must be an object");
  }
  if (!isPlainObject(params.message)) {
    fail("E_PARAMS_SHAPE", "message must be an object");
  }

  validatePrimaryType(params.primaryType, params.types);
  requireDomainType(params.types);
  domainMessage(params.domain);

  if (typeof params.origin !== "string") {
    fail("E_ORIGIN_TYPE", "origin must be a string");
  }
}

/**
 * Signer-side resource limits, spec section 11. These are a FLOOR: verifiers
 * MUST accept any otherwise-valid payload within them, and signers SHOULD
 * reject payloads above them as local policy. They MUST NOT influence the
 * digest, so this is a separate function `hashTypedData` never calls.
 *
 * @param {Parameters<typeof hashTypedData>[0]} input
 */
export function checkPolicyLimits(input) {
  validateTypedDataParams(input);
  const types = input.types;

  const structTypes = new Set();
  collectStructDeps(DOMAIN_TYPE, types, structTypes, new Set());
  collectStructDeps(input.primaryType, types, structTypes, new Set());
  if (structTypes.size > POLICY_LIMITS.maxStructTypes) {
    fail(
      "E_POLICY_LIMIT",
      `distinct struct types ${structTypes.size} exceeds floor ${POLICY_LIMITS.maxStructTypes}`
    );
  }
  for (const name of structTypes) {
    const fields = types[name];
    if (fields.length > POLICY_LIMITS.maxFieldsPerStruct) {
      fail(
        "E_POLICY_LIMIT",
        `${name} has ${fields.length} fields, exceeds floor ${POLICY_LIMITS.maxFieldsPerStruct}`
      );
    }
  }

  walkValueForPolicy(DOMAIN_TYPE, domainMessage(input.domain), types, 1);
  walkValueForPolicy(input.primaryType, input.message, types, 1);

  const totalBytes = utf8(JSON.stringify(input)).length;
  if (totalBytes > POLICY_LIMITS.maxTotalDecodedBytes) {
    fail(
      "E_POLICY_LIMIT",
      `decoded input ${totalBytes} bytes exceeds floor ${POLICY_LIMITS.maxTotalDecodedBytes}`
    );
  }
}

function walkValueForPolicy(typeExpr, value, types, depth) {
  if (depth > POLICY_LIMITS.maxNestingDepth) {
    fail("E_POLICY_LIMIT", `nesting depth exceeds floor ${POLICY_LIMITS.maxNestingDepth}`);
  }
  const t = classifyType(typeExpr);
  if (t.kind === "array") {
    if (!Array.isArray(value)) {
      return;
    }
    if (value.length > POLICY_LIMITS.maxArrayElements) {
      fail(
        "E_POLICY_LIMIT",
        `array length ${value.length} exceeds floor ${POLICY_LIMITS.maxArrayElements}`
      );
    }
    for (const v of value) {
      walkValueForPolicy(t.elem, v, types, depth + 1);
    }
    return;
  }
  if (t.kind === "atomic") {
    if ((t.name === "string" || t.name === "bytes") && typeof value === "string") {
      const byteLen = t.name === "string" ? utf8(value).length : hexByteLength(value);
      if (byteLen > POLICY_LIMITS.maxStringBytes) {
        fail(
          "E_POLICY_LIMIT",
          `${t.name} value ${byteLen} bytes exceeds floor ${POLICY_LIMITS.maxStringBytes}`
        );
      }
    }
    return;
  }
  if (!isPlainObject(value)) {
    return;
  }
  const fields = types[t.name] || [];
  for (const f of fields) {
    if (hasOwn(value, f.name)) {
      walkValueForPolicy(f.type, value[f.name], types, depth + 1);
    }
  }
}

function hexByteLength(value) {
  const h = value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
  return Math.floor(h.length / 2);
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

/**
 * Like `hashTypedData`, but also returns the intermediates from spec section
 * 9 (per-struct typeHash, domainSeparator, originBind, structHash of the
 * primary type) so a mismatch against another implementation localizes to a
 * single stage. Used to produce the golden vector format in spec section 15.
 *
 * @param {Parameters<typeof hashTypedData>[0]} input
 * @returns {{
 *   typeHashes: Record<string, string>,
 *   domainSeparator: string,
 *   originBind: string,
 *   structHash: string,
 *   digestHex: string,
 * }}
 */
export function hashTypedDataDebug(input) {
  validateTypedDataParams(input);
  const types = input.types;
  const domainValues = domainMessage(input.domain);

  const reachable = new Set();
  collectStructDeps(DOMAIN_TYPE, types, reachable, new Set());
  collectStructDeps(input.primaryType, types, reachable, new Set());
  const typeHashes = {};
  for (const name of reachable) {
    typeHashes[name] = toHex(typeHash(name, types));
  }

  const domainSeparator = structHash(DOMAIN_TYPE, domainValues, types);
  const originBind = originBindHash(input.origin);
  const structHashPrimary = structHash(input.primaryType, input.message, types);
  const digest = sha256(concat(PREAMBLE, domainSeparator, originBind, structHashPrimary));

  return {
    typeHashes,
    domainSeparator: toHex(domainSeparator),
    originBind: toHex(originBind),
    structHash: toHex(structHashPrimary),
    digestHex: toHex(digest),
  };
}

function typedDigest(input) {
  const types = input.types;
  const domainValues = domainMessage(input.domain);
  const domainSeparator = structHash(DOMAIN_TYPE, domainValues, types);
  const originBind = originBindHash(input.origin);
  const structHashPrimary = structHash(input.primaryType, input.message, types);
  return sha256(concat(PREAMBLE, domainSeparator, originBind, structHashPrimary));
}

function originBindHash(origin) {
  return sha256(concat(ORIGIN_TAG, sha256(utf8(origin))));
}

function domainMessage(domain) {
  if (!isPlainObject(domain)) {
    fail("E_PARAMS_SHAPE", "domain must be an object");
  }
  if (
    typeof domain.name !== "string" ||
    typeof domain.version !== "string" ||
    typeof domain.chainId !== "string"
  ) {
    fail("E_DOMAIN_VALUE", "domain.name, domain.version, domain.chainId required strings");
  }
  let verifyingContract;
  if (domain.verifyingContract === undefined) {
    verifyingContract = toHex(ZERO32);
  } else if (typeof domain.verifyingContract !== "string") {
    fail("E_DOMAIN_VALUE", "domain.verifyingContract must be a hex string");
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
  if (!hasOwn(types, DOMAIN_TYPE)) {
    fail("E_DOMAIN_TYPE", "types must include DuskTypedDataDomain");
  }
  const fields = types[DOMAIN_TYPE];
  const want = [
    ["name", "string"],
    ["version", "string"],
    ["chainId", "string"],
    ["verifyingContract", "bytes32"],
  ];
  if (!Array.isArray(fields) || fields.length !== want.length) {
    fail("E_DOMAIN_TYPE", "DuskTypedDataDomain field list mismatch");
  }
  for (let i = 0; i < want.length; i++) {
    const f = fields[i];
    if (!f || f.name !== want[i][0] || f.type !== want[i][1]) {
      fail("E_DOMAIN_TYPE", "DuskTypedDataDomain fields must match canonical order");
    }
  }
}

function validatePrimaryType(primaryType, types) {
  if (typeof primaryType !== "string") {
    fail("E_PRIMARY_MISSING", "primaryType is required");
  }
  if (primaryType === DOMAIN_TYPE) {
    fail("E_PRIMARY_INVALID", "primaryType must not be DuskTypedDataDomain");
  }
  if (ATOMIC.has(primaryType)) {
    fail("E_PRIMARY_INVALID", "primaryType must not be an atomic type");
  }
  if (ARRAY_FIXED.test(primaryType)) {
    fail("E_PRIMARY_INVALID", "primaryType must not be an array type");
  }
  if (!IDENT.test(primaryType)) {
    fail("E_PRIMARY_INVALID", "primaryType must be a valid identifier");
  }
  if (!hasOwn(types, primaryType)) {
    fail("E_PRIMARY_MISSING", "primaryType missing from types");
  }
}

/**
 * Classify one type expression: atomic, fixed array, or struct reference.
 * This is the single place that enforces spec section 4's syntax rules, so
 * every caller (dependency-graph walk, value encoding) agrees on E_TYPE_INVALID.
 */
function classifyType(typeExpr) {
  if (typeof typeExpr !== "string") {
    fail("E_TYPE_INVALID", "type expression must be a string");
  }
  if (/\s/.test(typeExpr)) {
    fail("E_TYPE_INVALID", `whitespace in type expression: ${typeExpr}`);
  }
  const m = ARRAY_FIXED.exec(typeExpr);
  if (m) {
    return { kind: "array", elem: m[1], n: Number(m[2]) };
  }
  if (typeExpr.includes("[") || typeExpr.includes("]")) {
    // T[], T[0], T[01], or any other malformed array expression.
    fail("E_TYPE_INVALID", `malformed array type: ${typeExpr}`);
  }
  if (ATOMIC.has(typeExpr)) {
    return { kind: "atomic", name: typeExpr };
  }
  if (!IDENT.test(typeExpr)) {
    fail("E_TYPE_INVALID", `invalid type name: ${typeExpr}`);
  }
  return { kind: "struct", name: typeExpr };
}

function structFields(typeName, types) {
  if (!hasOwn(types, typeName)) {
    fail("E_TYPE_UNKNOWN", `unknown type: ${typeName}`);
  }
  const fields = types[typeName];
  if (!Array.isArray(fields)) {
    fail("E_FIELD_DEF", `${typeName}: field list must be an array`);
  }
  return fields;
}

function checkFieldDefs(typeName, fields) {
  const names = new Set();
  for (const f of fields) {
    if (!f || typeof f !== "object" || typeof f.name !== "string" || typeof f.type !== "string") {
      fail("E_FIELD_DEF", `${typeName}: bad field definition`);
    }
    if (RESERVED_FIELD_NAMES.has(f.name)) {
      fail("E_FIELD_RESERVED", `${typeName}.${f.name}: reserved field name`);
    }
    if (names.has(f.name)) {
      fail("E_FIELD_DUP", `${typeName}: duplicate field ${f.name}`);
    }
    names.add(f.name);
  }
}

/**
 * Walk the struct dependency graph reachable from `typeExpr`, collecting
 * every struct type name (including the entry type) into `visited`.
 * `stack` tracks the types currently being expanded on this DFS path; a
 * repeat hit against `stack` is a cycle (spec 10, E_TYPE_CYCLE).
 */
function collectStructDeps(typeExpr, types, visited, stack) {
  const t = classifyType(typeExpr);
  if (t.kind === "array") {
    collectStructDeps(t.elem, types, visited, stack);
    return;
  }
  if (t.kind === "atomic") {
    return;
  }
  const name = t.name;
  if (stack.has(name)) {
    fail("E_TYPE_CYCLE", `type cycle involving ${name}`);
  }
  if (visited.has(name)) {
    return;
  }
  const fields = structFields(name, types);
  checkFieldDefs(name, fields);
  stack.add(name);
  for (const f of fields) {
    collectStructDeps(f.type, types, visited, stack);
  }
  stack.delete(name);
  visited.add(name);
}

function encodeTypeLocal(name, fields) {
  const inner = fields.map((f) => `${f.type} ${f.name}`).join(",");
  return `${name}(${inner})`;
}

/**
 * encodeType(S), spec 6.1: S's own local encoding first, then its
 * dependencies (deps(S) \ {S}) sorted ascending by UTF-8 bytes of the type
 * name.
 */
function encodeType(typeName, types) {
  const visited = new Set();
  collectStructDeps(typeName, types, visited, new Set());
  const deps = [];
  for (const name of visited) {
    if (name !== typeName) {
      deps.push(name);
    }
  }
  deps.sort(compareUtf8);
  const parts = [encodeTypeLocal(typeName, types[typeName])];
  for (const d of deps) {
    parts.push(encodeTypeLocal(d, types[d]));
  }
  return parts.join("");
}

function typeHash(typeName, types) {
  return sha256(utf8(encodeType(typeName, types)));
}

function structHash(typeName, values, types) {
  const th = typeHash(typeName, types);
  const fields = types[typeName];
  if (!isPlainObject(values)) {
    fail("E_VALUE_TYPE", `${typeName}: expected object value`);
  }
  const parts = [th];
  const seen = new Set();
  for (const f of fields) {
    if (!hasOwn(values, f.name)) {
      fail("E_FIELD_MISSING", `missing field ${typeName}.${f.name}`);
    }
    seen.add(f.name);
    parts.push(encodeValue(f.type, values[f.name], types));
  }
  for (const k of Object.keys(values)) {
    if (!seen.has(k)) {
      fail("E_FIELD_EXTRA", `unexpected field ${typeName}.${k}`);
    }
  }
  return sha256(concat(...parts));
}

function encodeValue(typeExpr, value, types) {
  const t = classifyType(typeExpr);
  if (t.kind === "array") {
    if (!Array.isArray(value)) {
      fail("E_VALUE_TYPE", `${typeExpr}: expected array`);
    }
    if (value.length !== t.n) {
      fail("E_ARRAY_LENGTH", `${typeExpr}: expected length ${t.n}, got ${value.length}`);
    }
    return concat(...value.map((v) => encodeValue(t.elem, v, types)));
  }
  if (t.kind === "atomic") {
    return encAtomic(t.name, value);
  }
  if (!isPlainObject(value)) {
    fail("E_VALUE_TYPE", `${t.name}: expected object`);
  }
  return structHash(t.name, value, types);
}

function encAtomic(typeName, value) {
  switch (typeName) {
    case "string": {
      if (typeof value !== "string") {
        fail("E_VALUE_TYPE", "string field requires JSON string");
      }
      return sha256(utf8(value));
    }
    case "bytes": {
      const raw = decodeHex(value, "bytes");
      return sha256(raw);
    }
    case "bytes32": {
      const raw = decodeHex(value, "bytes32");
      if (raw.length !== 32) {
        fail("E_BYTES32_LENGTH", "bytes32 requires exactly 32 bytes (no padding)");
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
        fail("E_VALUE_TYPE", "bool field requires JSON boolean");
      }
      return new Uint8Array([value ? 1 : 0]);
    }
    default:
      // classifyType() only returns ATOMIC names here, so this is unreachable.
      fail("E_TYPE_INVALID", `unsupported atomic ${typeName}`);
  }
}

function parseUint(value, bits) {
  let n;
  if (typeof value === "number") {
    if (!Number.isInteger(value) || !Number.isSafeInteger(value)) {
      fail("E_UINT_RANGE", "uint JSON number must be a safe integer");
    }
    n = BigInt(value);
  } else if (typeof value === "string") {
    if (!/^(0|[1-9][0-9]*)$/.test(value)) {
      fail("E_UINT_FORMAT", "uint string must be decimal with no leading zeros");
    }
    n = BigInt(value);
  } else {
    fail("E_VALUE_TYPE", "uint requires a number or a decimal string");
  }
  if (n < 0n) {
    fail("E_UINT_RANGE", "uint cannot be negative");
  }
  const max = (1n << BigInt(bits)) - 1n;
  if (n > max) {
    fail("E_UINT_RANGE", `uint${bits} overflow`);
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
    fail("E_VALUE_TYPE", `${label} requires 0x-hex string`);
  }
  let h = value;
  if (h.startsWith("0x") || h.startsWith("0X")) {
    h = h.slice(2);
  }
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) {
    fail("E_HEX_FORMAT", `${label}: invalid hex encoding`);
  }
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function utf8(s) {
  return new TextEncoder().encode(s);
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
