/**
 * Display-only flattening of a `dusk_signTypedData` message for the approval
 * popup. This module never validates signing-hash correctness (that lives in
 * typedDataHash.js) and never throws on malformed input - the whole `types`
 * table and `message` value come straight from the requesting dApp, and a
 * thrown error here would blank the approval screen instead of showing it.
 *
 * Design note: nested typed-data values are not rendered with
 * JSON.stringify. Pretty-printed JSON blows up vertical space in a small
 * popup and encourages scrolling past content without reading it - the exact
 * failure this screen exists to prevent. Instead every leaf value is
 * flattened to one row keyed by a dotted/bracketed path, mirroring how
 * signMessagePreview.js presents untrusted bytes safely rather than raw.
 */
import { isUnsafeC0ControlCodePoint } from "./signMessagePreview.js";
import { sha256Hex, toBytes } from "./bytes.js";

export const TYPED_DATA_DISPLAY_MAX_DEPTH = 8;
export const TYPED_DATA_DISPLAY_MAX_ROWS = 200;
export const TYPED_DATA_DISPLAY_MAX_STRING_CHARS = 2048;

const ATOMIC_TYPES = new Set(["string", "bytes", "bytes32", "uint64", "uint32", "uint8", "bool"]);
const ARRAY_FIXED = /^(.+)\[([1-9][0-9]*)\]$/;
// Same shadowing hazard as typedDataHash.js: a field literally named
// "__proto__" must not be treated as a live object-property lookup.
const RESERVED_FIELD_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const REPLACEMENT_CHAR = "�";

// U+202A-U+202E (LRE/RLE/PDF/LRO/RLO), U+2066-U+2069 (LRI/RLI/FSI/PDI),
// U+200E/U+200F (LRM/RLM). A right-to-left override can make "send 1 DUSK"
// paint as something else entirely on a signing screen, so these are always
// neutralised, never passed through raw.
const BIDI_CONTROL_CODEPOINTS = new Set([
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f,
]);

function isC1ControlCodePoint(code) {
  return code === 0x7f || (code >= 0x80 && code <= 0x9f);
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function parseArrayType(typeStr) {
  const m = ARRAY_FIXED.exec(typeStr);
  if (!m) return null;
  const length = Number(m[2]);
  if (!Number.isInteger(length) || length < 1) return null;
  return { itemType: m[1], length };
}

function makeRow(path, type, display, flags) {
  return { path, type: typeof type === "string" ? type : "", display, flags: flags || [] };
}

/**
 * Neutralise and flag anything in a string leaf that a signing screen must
 * not render raw: control characters, bidi overrides, and lone (unpaired)
 * UTF-16 surrogates. Unsafe code units are replaced with U+FFFD rather than
 * dropped, so the displayed length still roughly tracks the source and the
 * substitution itself is visible to the user.
 */
function sanitizeStringForDisplay(raw, maxChars) {
  const flags = [];
  let hasControl = false;
  let hasBidi = false;
  let hasInvalidSurrogate = false;

  const out = [];
  let i = 0;
  while (i < raw.length) {
    const code = raw.charCodeAt(i);

    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < raw.length ? raw.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        out.push(raw.slice(i, i + 2));
        i += 2;
        continue;
      }
      hasInvalidSurrogate = true;
      out.push(REPLACEMENT_CHAR);
      i += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      hasInvalidSurrogate = true;
      out.push(REPLACEMENT_CHAR);
      i += 1;
      continue;
    }

    if (BIDI_CONTROL_CODEPOINTS.has(code)) {
      hasBidi = true;
      out.push(REPLACEMENT_CHAR);
      i += 1;
      continue;
    }

    if (isUnsafeC0ControlCodePoint(code) || isC1ControlCodePoint(code)) {
      hasControl = true;
      out.push(REPLACEMENT_CHAR);
      i += 1;
      continue;
    }

    out.push(raw[i]);
    i += 1;
  }

  if (hasControl) flags.push("control_chars");
  if (hasBidi) flags.push("bidi_control");
  if (hasInvalidSurrogate) flags.push("invalid_surrogate");

  let chars = out;
  if (chars.length > maxChars) {
    chars = chars.slice(0, maxChars);
    flags.push("truncated");
  }

  return { display: chars.join(""), flags };
}

function describeStringLeaf(value, type, path, limits) {
  if (typeof value !== "string") return makeRow(path, type, "(unexpected type)", []);
  const { display, flags } = sanitizeStringForDisplay(value, limits.maxStringChars);
  return makeRow(path, type, display, flags);
}

async function describeBytesLeaf(value, type, path) {
  if (typeof value !== "string" || !/^0x/i.test(value.trim())) {
    return makeRow(path, type, "(unexpected type)", []);
  }
  let bytes;
  try {
    bytes = toBytes(value.trim());
  } catch {
    return makeRow(path, type, "(unexpected type)", []);
  }
  const hash = await sha256Hex(bytes);
  const display = `${bytes.length} bytes · sha256=${hash.slice(0, 12)}…${hash.slice(-8)}`;
  return makeRow(path, type, display, []);
}

function describeUintLeaf(value, type, path) {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
      return makeRow(path, type, "(unexpected type)", []);
    }
    return makeRow(path, type, String(value), []);
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (!/^\d+$/.test(s)) return makeRow(path, type, "(unexpected type)", []);
    return makeRow(path, type, s, []);
  }
  return makeRow(path, type, "(unexpected type)", []);
}

function describeBoolLeaf(value, type, path) {
  if (typeof value !== "boolean") return makeRow(path, type, "(unexpected type)", []);
  return makeRow(path, type, value ? "true" : "false", []);
}

async function describeAtomicLeaf(type, value, path, limits) {
  if (value === undefined || value === null) return makeRow(path, type, "(missing)", []);

  switch (type) {
    case "string":
      return describeStringLeaf(value, type, path, limits);
    case "bytes":
    case "bytes32":
      return describeBytesLeaf(value, type, path);
    case "uint64":
    case "uint32":
    case "uint8":
      return describeUintLeaf(value, type, path);
    case "bool":
      return describeBoolLeaf(value, type, path);
    default:
      return makeRow(path, type, "(unexpected type)", []);
  }
}

/**
 * Recursively flatten one typed value into `state.rows`, honoring the depth
 * and row caps in `limits`. Never throws: every defensive branch below
 * exists because `types`/`value` are attacker-controlled and may be missing,
 * mis-shaped, or adversarially deep/wide.
 */
async function walk(typeStr, value, path, depth, types, state, limits) {
  if (depth > limits.maxDepth) {
    // Emit a row rather than silently counting one omission. A hostile payload
    // can nest past the cap at the very top, and a bare "1 more field" notice
    // would render an approval screen with no visible fields at all while
    // understating how much is hidden. Showing the path keeps the screen honest
    // about where the message was cut.
    if (state.rows.length < limits.maxRows) {
      state.rows.push(
        makeRow(path, typeof typeStr === "string" ? typeStr : "", "(nested too deep to display)", [
          "depth_limited",
        ])
      );
    } else {
      state.omitted += 1;
    }
    state.depthLimited = true;
    return;
  }

  const type = typeof typeStr === "string" ? typeStr : "";

  const arrayInfo = parseArrayType(type);
  if (arrayInfo) {
    const { itemType, length } = arrayInfo;
    if (!Array.isArray(value)) {
      state.rows.push(makeRow(path, type, "(unexpected type)", []));
      return;
    }
    for (let i = 0; i < length; i++) {
      if (state.rows.length >= limits.maxRows) {
        state.omitted += length - i;
        return;
      }
      await walk(itemType, value[i], `${path}[${i}]`, depth + 1, types, state, limits);
    }
    return;
  }

  if (ATOMIC_TYPES.has(type)) {
    if (state.rows.length >= limits.maxRows) {
      state.omitted += 1;
      return;
    }
    state.rows.push(await describeAtomicLeaf(type, value, path, limits));
    return;
  }

  const fields = isPlainObject(types) ? types[type] : null;
  if (!Array.isArray(fields)) {
    if (state.rows.length >= limits.maxRows) {
      state.omitted += 1;
      return;
    }
    state.rows.push(makeRow(path || "(root)", type || "(unknown)", "(unknown type)", []));
    return;
  }

  const obj = isPlainObject(value) ? value : null;
  for (let idx = 0; idx < fields.length; idx++) {
    if (state.rows.length >= limits.maxRows) {
      state.omitted += fields.length - idx;
      return;
    }
    const field = fields[idx];
    const fname = field && typeof field.name === "string" ? field.name : "";
    const ftype = field && typeof field.type === "string" ? field.type : "";
    if (!fname || !ftype || RESERVED_FIELD_NAMES.has(fname)) continue;

    const fpath = path ? `${path}.${fname}` : fname;
    const fvalue = obj && Object.prototype.hasOwnProperty.call(obj, fname) ? obj[fname] : undefined;
    await walk(ftype, fvalue, fpath, depth + 1, types, state, limits);
  }
}

/**
 * Flatten a typed-data message into one display row per leaf value.
 *
 * @param {{types: object, primaryType: string, message: object}} params
 * @param {{maxDepth?: number, maxRows?: number, maxStringChars?: number}} [options]
 *   Overrides for the default caps below; only intended for tests exercising
 *   the caps without building huge fixtures.
 * @returns {Promise<{rows: Array<{path: string, type: string, display: string, flags: string[]}>, truncated: {omittedCount: number, depthLimited: boolean} | null}>}
 *
 * Row `type` is always the *declared* schema type, not something inferred
 * from the JSON value - `amount: "42"` alone can't tell a caller whether the
 * field is a `uint64` or a `string`, and those sign different bytes.
 *
 * `truncated` is null when nothing was cut. Otherwise `omittedCount` counts
 * rows dropped at the row cap, and `depthLimited` records that at least one
 * subtree was cut for depth. The two are reported separately because
 * `omittedCount` alone would be misleading: a subtree cut for depth appears
 * as a `depth_limited` row at the cut point rather than as a count, since
 * counting its true leaf total would require the same unbounded recursion
 * the cap exists to avoid.
 */
export async function flattenTypedMessage({ types, primaryType, message } = {}, options = {}) {
  const limits = {
    maxDepth: Number.isInteger(options.maxDepth) ? options.maxDepth : TYPED_DATA_DISPLAY_MAX_DEPTH,
    maxRows: Number.isInteger(options.maxRows) ? options.maxRows : TYPED_DATA_DISPLAY_MAX_ROWS,
    maxStringChars: Number.isInteger(options.maxStringChars)
      ? options.maxStringChars
      : TYPED_DATA_DISPLAY_MAX_STRING_CHARS,
  };

  const state = { rows: [], omitted: 0, depthLimited: false };
  const typesObj = isPlainObject(types) ? types : {};
  const primary = typeof primaryType === "string" ? primaryType : "";

  await walk(primary, message, "", 0, typesObj, state, limits);

  return {
    rows: state.rows,
    truncated:
      state.omitted > 0 || state.depthLimited
        ? { omittedCount: state.omitted, depthLimited: state.depthLimited }
        : null,
  };
}
