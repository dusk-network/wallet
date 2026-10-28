// Plain words for the contract calls Activity knows, as the explorer names
// them: a call to Dusk Domains by what it did to a .dusk name, and a
// registration by the name it registered, read from its arguments. Only on
// the network the contracts are on, and only for a node of that network: a
// custom node's contract at the same ID could be anything. It reads nothing
// from the node.

import { blake2b } from "@noble/hashes/blake2b";

import releases from "./dusk-domains-releases.json";
import { toBytes } from "./bytes.js";
import { networkForNode } from "./nodeNetwork.js";

// What a Dusk Domains call did, by its function.
const NAME_CALLS = Object.freeze({
  commit: "Reserved a .dusk name",
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
 * What a known contract call did, or null for a contract the wallet doesn't
 * name on this network.
 * @param {{ contractId?: string, fnName?: string, nodeUrl?: string, registeredName?: string|null }} call
 *   `registeredName`: the name a registration registered, once read (registeredNameOf)
 * @returns {{ app: "Dusk Domains", label: string } | null} `label`: the call
 *   in words, or the app's name for a function without them
 */
export function knownCall({ contractId, fnName, nodeUrl, registeredName } = {}) {
  if (!isDuskDomains(contractId, nodeUrl)) return null;
  const fn = String(fnName ?? "").trim();
  if (fn === "register" && registeredName) return { app: "Dusk Domains", label: `Registered ${registeredName}` };
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
  const root = bytes.length - ROOT_BYTES;
  const label = root >= 0 && root % 8 === 0 ? labelBytes(bytes, root + LABEL_AT, root) : null;
  const text = label ? String.fromCharCode(...label) : "";
  if (!LABEL.test(text)) return null;
  const node = blake(DUSK_NODE, blake(label));
  return node.every((b, i) => b === bytes[root + i]) ? `${text}.dusk` : null;
}
