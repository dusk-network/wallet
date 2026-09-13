/**
 * Wallet-owned typed-data disclosure, never signing input. A bounded leaf
 * preview accompanies a lossless escaped JSON view, checked against the pending
 * digest by @dusk/typed-data. Approval must fail closed if preparation throws.
 * The flattener remains tolerant of missing/wrong-typed values; its dotted paths
 * are unambiguous only for schema names accepted by the shared validator.
 */
import { hashTypedDataHex } from "@dusk/typed-data";
import { isUnsafeC0ControlCodePoint } from "./signMessagePreview.js";
import { hexToBytes, sha256Hex } from "./bytes.js";

export const TYPED_DATA_DISPLAY_MAX_DEPTH = 8;
export const TYPED_DATA_DISPLAY_MAX_ROWS = 200;
export const TYPED_DATA_DISPLAY_MAX_STRING_CHARS = 2048;

const ATOMIC_TYPES = new Set(["string", "bytes", "bytes32", "uint64", "uint32", "uint8", "bool"]);
const ARRAY_FIXED = /^(.+)\[([1-9][0-9]*)\]$/;
// Same shadowing hazard as the protocol: a field literally named
// "__proto__" must not be treated as a live object-property lookup.
const RESERVED_FIELD_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const REPLACEMENT_CHAR = "�";

const BIDI_CONTROL = /\p{Bidi_Control}/u;
const FORMAT_CONTROL = /\p{Cf}/u;
const LINE_SEPARATOR = /[\n\r\u2028\u2029]/u;
// ponytail: one 2 MiB text view; use pagination if legitimate requests exceed it.
const MAX_DISCLOSURE_CHARS = 2 * 1024 * 1024;

function escapeCodeUnit(char) {
  return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
}

/**
 * Prepare a JSON snapshot and its full ASCII-only disclosure. JSON escapes
 * preserve original Unicode, including combining sequences and literal escapes.
 * Throws on size/serialization/validation failure or a mismatch with the digest
 * already computed by the signer. Callers must not enable signing on failure.
 */
export function prepareTypedDataDisclosure(input, digestHex) {
  let budget = MAX_DISCLOSURE_CHARS;
  const parents = [];
  const json = JSON.stringify(input, function (key, value) {
    // Bound construction work, including indentation of unused schema metadata
    // (which protocol validation deliberately does not traverse).
    while (parents.length && parents.at(-1) !== this) parents.pop();
    budget -= key.length + (typeof value === "string" ? value.length : 1) + 2 * parents.length;
    if (budget < 0) throw new Error("Signing request is too large to disclose in full");
    if (value && typeof value === "object") parents.push(value);
    return value;
  }, 2).replace(/[\u007f-\uffff]/g, escapeCodeUnit);
  if (json.length > MAX_DISCLOSURE_CHARS) throw new Error("Signing request is too large to disclose in full");
  const snapshot = JSON.parse(json);
  if (hashTypedDataHex(snapshot) !== digestHex) throw new Error("Signing request does not match its digest");
  return { json, input: snapshot };
}

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
 * Bound a readable preview by source code points without splitting pairs.
 * Replace unsafe controls and visibly escape formatting/line separators.
 * Non-NFC sequences are flagged, never normalized. Originals remain available
 * in the full JSON view; these display substitutions must never be signed.
 */
export function sanitizeStringForDisplay(raw, maxChars = TYPED_DATA_DISPLAY_MAX_STRING_CHARS) {
  const flags = new Set();
  const out = [];
  for (const char of raw) {
    const code = char.codePointAt(0);
    if (code >= 0xd800 && code <= 0xdfff) {
      flags.add("invalid_surrogate");
      out.push(REPLACEMENT_CHAR);
    } else if (BIDI_CONTROL.test(char)) {
      flags.add("bidi_control");
      out.push(REPLACEMENT_CHAR);
    } else if (FORMAT_CONTROL.test(char) || LINE_SEPARATOR.test(char)) {
      flags.add(LINE_SEPARATOR.test(char) ? "line_separator" : "invisible_format");
      out.push(char.replace(/[\s\S]/g, escapeCodeUnit));
    } else if (code === 0x09 || isUnsafeC0ControlCodePoint(code) || isC1ControlCodePoint(code)) {
      flags.add("control_chars");
      out.push(REPLACEMENT_CHAR);
    } else {
      out.push(char);
    }
  }
  if (raw.normalize("NFC") !== raw) flags.add("non_nfc");
  if (out.length > maxChars) flags.add("truncated");
  return { display: out.slice(0, maxChars).join(""), flags: [...flags] };
}

function describeStringLeaf(value, type, path, limits) {
  if (typeof value !== "string") return makeRow(path, type, "(unexpected type)", []);
  const { display, flags } = sanitizeStringForDisplay(value, limits.maxStringChars);
  return makeRow(path, type, display, flags);
}

async function describeBytesLeaf(value, type, path) {
  if (typeof value !== "string") {
    return makeRow(path, type, "(unexpected type)", []);
  }
  let bytes;
  try {
    bytes = hexToBytes(value);
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
  // Empty structs are leaves too: their named presence can carry meaning.
  if (fields.length === 0) {
    if (state.rows.length >= limits.maxRows) {
      state.omitted += 1;
    } else {
      state.rows.push(makeRow(path || "(root)", type, obj ? "{}" : "(unexpected type)", []));
    }
    return;
  }
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
