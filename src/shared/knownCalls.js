// Plain words for the contract calls Activity knows, as the explorer names
// them: a call to Dusk Domains by what it did to a .dusk name, a
// registration by the name it registered, read from its arguments, and a
// name reservation by the name of the registration that follows it. Only on
// the network the contracts are on, and only for a node of that network: a
// custom node's contract at the same ID could be anything. It reads nothing
// from the node.

import { blake2b } from "@noble/hashes/blake2b";

import releases from "./dusk-domains-releases.json";
import { bytesToHex, toBytes } from "./bytes.js";
import { base58Decode } from "./duskIdentifiers.js";
import { labelForNode, networkForNode } from "./nodeNetwork.js";

// What a Dusk Domains call did, by its function.
const NAME_CALLS = Object.freeze({
  commit: "Name reservation (step 1 of 2)",
  register: "Registered a .dusk name",
  renew: "Renewed a .dusk name",
  issue_reserved: "Issued a reserved .dusk name",
  create_subname: "Created a .dusk subname",
  set_primary: "Set a primary .dusk name",
  clear_primary: "Cleared the primary .dusk name",
  mutate_records: "Changed a .dusk name's records",
});

const norm = (id) =>
  String(id ?? "")
    .trim()
    .toLowerCase()
    .replace(/^0x/, "");

// Dusk Domains' contracts on each network, its lens included.
const DUSK_DOMAINS = Object.fromEntries(
  Object.entries(releases).map(([network, release]) => [
    network,
    new Set([...(release.contracts ?? []).map((c) => norm(c.contractId)), norm(release.lens?.contractId)].filter(Boolean)),
  ])
);

/**
 * Whether `contractId` is one of Dusk Domains' contracts on the network of
 * `nodeUrl`, by the chain ID the node gave (nodeNetwork.js).
 * @param {string} contractId
 * @param {string} nodeUrl
 */
export function isDuskDomains(contractId, nodeUrl) {
  const net = networkForNode(String(nodeUrl ?? ""));
  return Boolean(net?.duskDomains && DUSK_DOMAINS[net.name]?.has(norm(contractId)));
}

/**
 * What a contract is called on the node's network, as the explorer names it:
 * by the network's file, or Dusk Domains for one of its contracts; null for
 * any other.
 * @param {string} contractId
 * @param {string} nodeUrl
 * @returns {string | null}
 */
export function contractLabel(contractId, nodeUrl) {
  return labelForNode(String(nodeUrl ?? ""), String(contractId ?? "")) ?? (isDuskDomains(contractId, nodeUrl) ? "Dusk Domains" : null);
}

/**
 * What a known contract call did, or null for a contract the wallet doesn't
 * name on this network.
 * @param {{ contractId?: string, fnName?: string, nodeUrl?: string, registeredName?: string|null, reservedName?: string|null }} call
 *   `registeredName`: the name a registration registered, once read
 *   (registeredNameOf); `reservedName`: the name a reservation was for, once
 *   its registration followed (activityMerge.js)
 * @returns {{ app: "Dusk Domains", label: string } | null} `label`: the call
 *   in words, or the app's name for a function without them
 */
export function knownCall({ contractId, fnName, nodeUrl, registeredName, reservedName } = {}) {
  if (!isDuskDomains(contractId, nodeUrl)) return null;
  const fn = String(fnName ?? "").trim();
  if (fn === "register" && registeredName) return { app: "Dusk Domains", label: `Registered ${registeredName}` };
  if (fn === "commit" && reservedName) return { app: "Dusk Domains", label: `Reserved ${reservedName}` };
  return { app: "Dusk Domains", label: Object.hasOwn(NAME_CALLS, fn) ? NAME_CALLS[fn] : "Dusk Domains" };
}

// A registration's arguments are rkyv, as the web wallet reads them: their
// root is their last 304 bytes. It starts with the name's node, and the
// label sits 32 bytes in: in place when it has up to 7 bytes, its length in
// their last, else before the root, as its length and an offset from there.
const ROOT_BYTES = 304;
const LABEL_AT = 32;
const INLINE = 7;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const utf8 = new TextEncoder();
const blake = (...parts) => {
  const bytes = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  parts.reduce((at, part) => (bytes.set(part, at), at + part.length), 0);
  return blake2b(bytes, { dkLen: 32 });
};
// The node of "dusk", which every .dusk name's node is made from, as Dusk
// Domains makes it: BLAKE2b-256 down from 32 zero bytes.
const DUSK_NODE = blake(new Uint8Array(32), blake(utf8.encode("dusk")));

function labelBytes(args, at, root) {
  const last = args[at + INLINE];
  if ((last & 0x80) === 0) return last <= INLINE ? args.subarray(at, at + last) : null;
  const view = new DataView(args.buffer, args.byteOffset, args.byteLength);
  const length = view.getUint32(at, true);
  const start = at + view.getInt32(at + 4, true);
  return length > INLINE && start >= 0 && start + length <= root ? args.subarray(start, start + length) : null;
}

// A registration's arguments as read: where their root starts, and the
// label, when it is the name of the node they name.
function readRegistration(bytes) {
  const root = bytes.length - ROOT_BYTES;
  const label = root >= 0 && root % 8 === 0 ? labelBytes(bytes, root + LABEL_AT, root) : null;
  const text = label ? String.fromCharCode(...label) : "";
  if (!LABEL.test(text)) return null;
  const node = blake(DUSK_NODE, blake(label));
  return node.every((b, i) => b === bytes[root + i]) ? { root, label, text } : null;
}

/**
 * The .dusk name a registration registered, read from its arguments, in any
 * encoding bytes.js reads: undefined for any other call, and null for
 * arguments that don't read exactly, or whose label isn't the name of the
 * node they name, as Dusk Domains checks.
 * @param {{ contractId?: string, fnName?: string, nodeUrl?: string, args?: unknown }} call
 * @returns {string|null|undefined} "alice.dusk"
 */
export function registeredNameOf({ contractId, fnName, nodeUrl, args } = {}) {
  if (String(fnName ?? "").trim() !== "register" || !isDuskDomains(contractId, nodeUrl)) return undefined;
  let bytes;
  try {
    bytes = toBytes(args);
  } catch {
    return null;
  }
  const registration = readRegistration(bytes);
  return registration ? `${registration.text}.dusk` : null;
}

// Matches a reservation to the registration that reveals it.
const RESERVATION_BYTES = 32;
const REVEALED_AT = 41;
const SECRET_AT = 73;
const REGISTRATION_TAG = utf8.encode("dusk-domains:registration:v1");
const AUTHORITY_TAG = utf8.encode("dusk-domains:runtime-authority:v1");

/**
 * A name reservation as a reservation makes it, or as a registration reveals
 * it once it checks out for the account that sent it, in hex: the two match
 * when they're for the same name. Undefined for any other call, null for
 * arguments that don't read, or a registration that doesn't check out.
 * @param {{ contractId?: string, fnName?: string, nodeUrl?: string, args?: unknown, account?: string }} call
 *   `account`: the public account that sent it
 * @returns {string|null|undefined}
 */
export function nameReservationOf({ contractId, fnName, nodeUrl, args, account } = {}) {
  const fn = String(fnName ?? "").trim();
  if ((fn !== "commit" && fn !== "register") || !isDuskDomains(contractId, nodeUrl)) return undefined;
  let bytes;
  try {
    bytes = toBytes(args);
  } catch {
    return null;
  }
  if (fn === "commit") return bytes.length === RESERVATION_BYTES ? bytesToHex(bytes) : null;
  const registration = readRegistration(bytes);
  const key = base58Decode(account);
  if (!registration || key?.length !== 96) return null;
  const { root, label } = registration;
  const revealed = bytes.subarray(root + REVEALED_AT, root + REVEALED_AT + 32);
  const secret = bytes.subarray(root + SECRET_AT, root + SECRET_AT + 32);
  const expected = blake(REGISTRATION_TAG, blake(AUTHORITY_TAG, key), bytes.subarray(root, root + 32), label, secret);
  return expected.every((b, i) => b === revealed[i]) ? bytesToHex(revealed) : null;
}
