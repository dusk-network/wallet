// Dusk Domains (.dusk names) for the send flow, the wallet's own names and the
// recipients of sites' requests to send.
//
// A name resolves to the public account in its `moonlight_address` record and
// the shielded address in its `phoenix_payment_endpoint` record, and a public
// account to its verified primary name, read through the SDK's lens reader and
// the wallet's own node. The reader and its account check are loaded on the
// first lookup only, so they stay out of the popup bundle. The lens data
// driver ships with the extension in public/drivers/dusk-domains, and the SDK
// checks it against the sha256 of its pinned release. Nothing else is fetched.

import { nameToShow, toDuskName } from "@duskdomains/sdk/names";
import { PINNED_RELEASES } from "@duskdomains/sdk/releases";
import { createMulticallFetch } from "@hdauven/dusk-multicall";

import { assetUrl } from "../platform/assets.js";
import { storageSessionGet, storageSessionRemove, storageSessionSet } from "../platform/extensionApi.js";
import { bytesToHex, hexToBytes } from "./bytes.js";
import { classifyDuskIdentifier } from "./duskIdentifiers.js";
import { networkForNode } from "./nodeNetwork.js";
import { duskNamesNetwork, rememberVerifiedName } from "./verifiedNames.js";

export { duskNamesNetwork };

const LOOKUP_REUSE_MS = 60_000;

// Release roles whose data drivers ship with the extension, in
// public/drivers/dusk-domains. Name lookups load exactly these.
export const BUNDLED_DRIVER_ROLES = Object.freeze(["lens"]);

/**
 * The bundled data drivers of a release, from its pinned descriptors.
 * @param {object} release - one network's of PINNED_RELEASES (@duskdomains/sdk/releases)
 * @returns {{ url: string, file: string, sha256: string }[]} pinned driver URL, file name, sha256
 */
export function bundledDrivers(release) {
  return [...release.contracts, release.lens]
    .filter(({ role }) => BUNDLED_DRIVER_ROLES.includes(role))
    .map(({ dataDriver: { path, sha256 } }) => ({
      url: new URL(path, release.artifactBaseUrl).href,
      file: path.split("/").pop(),
      sha256,
    }));
}

// The SDK fetches through this: bundled drivers load from the extension, reads
// go to the wallet's node, and every other request is refused.
function bundledFetch(release, nodeUrl) {
  const files = new Map(
    bundledDrivers(release).map(({ url, file }) => [url, assetUrl(`drivers/dusk-domains/${file}`)])
  );
  return (input, init) => {
    const url = String(input?.href ?? input?.url ?? input);
    if (files.has(url)) return fetch(files.get(url), init);
    if (url.startsWith(`${nodeUrl}/`)) return fetch(input, init);
    return Promise.reject(new Error(`Refused request to ${url}`));
  };
}

// The lens's binding and interface, asked once a session. A reader checks
// them before it answers its first lookup; once a lookup through it answered,
// the replies it checked are kept in the browser's session storage (in this
// page's memory where there is none, as in the engine), and every reader
// built since, in another popup or the background, checks those. A reply no
// lookup took, or one over the SDK's 32,768-byte limit, isn't kept; a lookup
// that finds the deployment wrong, or a reply that doesn't decode, forgets
// them, and the next reader asks the node again.
const ONCE_A_SESSION = new Set(["binding", "lens_interface"]);
const REPLY_MAX = 32_768;
const sessionReplies = new Map();
const replyKey = (release, method) => `dusk_names_lens_v1:${release.lens.contractId}:${method}`;

async function keptReply(key) {
  if (sessionReplies.has(key)) return sessionReplies.get(key);
  try {
    const hex = (await storageSessionGet(key))?.[key];
    if (typeof hex === "string") {
      sessionReplies.set(key, hex);
      return hex;
    }
  } catch {
    // No session storage here: this page's memory alone.
  }
  return null;
}

async function keepReply(key, hex) {
  sessionReplies.set(key, hex);
  await storageSessionSet({ [key]: hex }).catch(() => {});
}

async function forgetReplies(release) {
  const keys = [...ONCE_A_SESSION].map((method) => replyKey(release, method));
  for (const key of keys) sessionReplies.delete(key);
  await storageSessionRemove(keys).catch(() => {});
}

// A copy of a reply's body, read as a stream no further than `max` bytes:
// null past it, and the copy given up. The reply itself is left whole for
// the SDK, which reads it to the same limit. A copy's cancel settles only
// once the reply is given up too, so it isn't waited for.
async function bodyUpTo(res, max) {
  const copy = res.clone();
  if (Number(copy.headers.get("content-length") ?? undefined) > max) {
    copy.body?.cancel().catch(() => {});
    return null;
  }
  if (!copy.body) return new Uint8Array();
  const reader = copy.body.getReader();
  const chunks = [];
  let length = 0;
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    length += chunk.value.length;
    if (length > max) {
      reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

// One reader's `fetch`, with the lens's binding and interface answered from
// the session once a reader's lookup took them; and `keep`, which keeps the
// replies this reader read itself, once a lookup through it answered.
function lensSession(release, nodeUrl, fetch) {
  const prefix = `${nodeUrl}/on/contracts:${release.lens.contractId}/`;
  const read = new Map();
  return {
    async fetch(input, init) {
      const url = String(input?.href ?? input?.url ?? input);
      const method = url.startsWith(prefix) ? url.slice(prefix.length) : "";
      if (!ONCE_A_SESSION.has(method)) return fetch(input, init);
      const key = replyKey(release, method);
      const kept = await keptReply(key);
      if (kept !== null) return new Response(hexToBytes(kept), { status: 200, headers: { "Content-Type": "application/octet-stream" } });
      const res = await fetch(input, init);
      const bytes = res.ok ? await bodyUpTo(res, REPLY_MAX).catch(() => null) : null;
      if (bytes) read.set(key, bytesToHex(bytes));
      return res;
    },
    async keep() {
      const replies = [...read];
      read.clear();
      for (const [key, hex] of replies) await keepReply(key, hex);
    },
  };
}

// Each reader's `keep` (lensSession), and what calls it: a lookup through
// the reader that answered, so the SDK took the replies it checked.
const keeps = new WeakMap();
const took = (reader) => {
  keeps.get(reader)?.().catch(() => {});
};

// A lookup's failure: one that found the lens's deployment wrong, or a reply
// that didn't decode, forgets the replies kept, so they are asked again.
function failed(release, error) {
  if (error?.reason === "deployment" || error?.reason === "decode") forgetReplies(release).catch(() => {});
}

// The SDK's reader and account check, loaded on the first lookup.
const loadSdk = () => import("./duskNamesSdk.js");

// The SDK's own spelling of the node URL, which its reads start with.
const nodeHref = (nodeUrl) => new URL(String(nodeUrl)).href.replace(/\/$/, "");

// One reader per network, bound to the node it reads from, and one whose
// reads go through Multicall for Dusk (lookupRecipientNames).
const readers = new Map();
const batchedReaders = new Map();

// The gas a lens read takes inside a multicall, as the SDK's client gives it
// (client.ts, LENS_READS and lensGas): the lens shares its gas among every
// read it may make and refuses (GasBudget) when a share is short.
const LENS_READS = { resolve: 90, reverse: 203 };
const lensGas = (release) => (contractId, fnName) =>
  contractId === release.lens.contractId && LENS_READS[fnName]
    ? BigInt(LENS_READS[fnName]) * 4_000_000n + 30_000_000n
    : 0n;

function readerFor(createLensReader, network, nodeUrl, { batched = false } = {}) {
  const cache = batched ? batchedReaders : readers;
  const cached = cache.get(network);
  if (cached?.nodeUrl === nodeUrl) return cached.promise;

  const release = PINNED_RELEASES[network];
  const direct = bundledFetch(release, nodeUrl);
  // The multicall on the node's network, as its file has it.
  const multicallId = networkForNode(nodeUrl)?.contracts.multicall ?? null;
  const session = lensSession(
    release,
    nodeUrl,
    batched ? createMulticallFetch({ nodeUrl, multicallId, fetch: direct, gasFor: lensGas(release) }) : direct
  );
  const promise = createLensReader(release, {
    nodeUrl,
    artifactBaseUrl: release.artifactBaseUrl,
    fetch: (input, init) => session.fetch(input, init),
  }).then((reader) => {
    if (reader && typeof reader === "object") keeps.set(reader, session.keep);
    return reader;
  });
  const entry = { nodeUrl, promise };
  cache.set(network, entry);
  // A reader that failed to build is built again by the next lookup.
  promise.catch(() => {
    if (cache.get(network) === entry) cache.delete(network);
  });
  return promise;
}

/**
 * Resolve a .dusk name to what it can be sent to: the public account in its
 * `moonlight_address` record and the shielded address in its
 * `phoenix_payment_endpoint` record, read in one lens query. Only an active
 * name with at least one valid address resolves; everything else is a failure
 * with a reason. Never throws.
 *
 * @param {string} input - recipient field text
 * @param {{ nodeUrl?: string }} [opts] - the wallet's node for the active network
 * @returns {Promise<
 *   | { ok: true, name: string, account?: string, address?: string }
 *   | { ok: false, name: string, reason: "invalid_name"|"unsupported_network"|"not_registered"|"expired"|"no_account"|"lookup_failed" }
 * >}
 */
export async function resolveDuskName(input, { nodeUrl } = {}) {
  const typed = String(input ?? "").trim();
  const network = duskNamesNetwork(nodeUrl);
  if (!network) return { ok: false, name: typed, reason: "unsupported_network" };
  const name = toDuskName(typed);
  if (!name) return { ok: false, name: typed, reason: "invalid_name" };
  const fail = (reason) => ({ ok: false, name, reason });

  // The reader bounds its own build and reads; any LensReaderError is a failed lookup.
  try {
    const sdk = await loadSdk();
    const reader = await readerFor(sdk.createLensReader, network, nodeHref(nodeUrl));
    // The public account only when it's a valid key, the shielded address only when it's exactly one.
    const { status, account, address } = await sdk.resolveAccounts(reader, name);
    took(reader);
    if (status === "Absent" || status === "Released") return fail("not_registered");
    if (status === "Grace" || status === "Expired") return fail("expired");
    if (status !== "Active") return fail("lookup_failed");
    if (!account && !address) return fail("no_account");
    return { ok: true, name, ...(account ? { account } : {}), ...(address ? { address } : {}) };
  } catch (error) {
    failed(PINNED_RELEASES[network], error);
    return fail("lookup_failed");
  }
}

/**
 * The verified primary .dusk name of a public account, read with the lens
 * reader's `verifyPrimary` through the wallet's node; `name` is null when the
 * account has none. Never throws.
 *
 * With `batched`, the reads of the lookup go through Multicall for Dusk as one
 * query, and a lookup the lens refused for want of gas in it is made again on
 * its own.
 *
 * @param {string} account - Base58 public account
 * @param {{ nodeUrl?: string, batched?: boolean }} [opts] - the wallet's node for the active network
 * @returns {Promise<{ ok: true, name: string|null } | { ok: false, reason: "unsupported_network"|"lookup_failed" }>}
 */
export async function resolvePrimaryName(account, { nodeUrl, batched = false } = {}) {
  const network = duskNamesNetwork(nodeUrl);
  if (!network) return { ok: false, reason: "unsupported_network" };
  // Only a public account, a Moonlight key, can have a primary name.
  if (classifyDuskIdentifier(account) !== "account") return { ok: true, name: null };
  try {
    const sdk = await loadSdk();
    const reader = await readerFor(sdk.createLensReader, network, nodeHref(nodeUrl), { batched });
    // The reader takes the 96-byte key as plain numbers.
    const verified = await reader.verifyPrimary(Array.from(sdk.decodeBase58(account)));
    took(reader);
    const name = verified === null ? null : verified.primary.spelling;
    return name === null || typeof name === "string" ? { ok: true, name } : { ok: false, reason: "lookup_failed" };
  } catch (error) {
    if (batched && shortOfGas(error)) return resolvePrimaryName(account, { nodeUrl });
    failed(PINNED_RELEASES[network], error);
    return { ok: false, reason: "lookup_failed" };
  }
}

/**
 * The address a resolved name is sent to: its public account, unless it has
 * only a shielded address or `shielded` picks that one.
 * @param {{ account?: string, address?: string }} result - a resolved name
 * @param {{ shielded?: boolean }} [opts]
 * @returns {string|undefined}
 */
export function duskNameRecipient({ account, address }, { shielded = false } = {}) {
  return address && (shielded || !account) ? address : account;
}

let lastLookup = null;

/**
 * `resolveDuskName` for the send form, which rebuilds on every render: the
 * latest lookup is shared while it runs and reused for a minute after an
 * answer. A failed lookup is tried again on the next call.
 *
 * @param {string} input
 * @param {{ nodeUrl?: string }} [opts]
 * @returns {{ result: object|null, promise: Promise<object> }} `result` is set once settled
 */
export function lookupDuskName(input, { nodeUrl } = {}) {
  const key = `${nodeUrl ?? ""}\n${String(input ?? "").trim()}`;
  const hit = lastLookup;
  if (
    hit?.key === key &&
    (!hit.result || (hit.result.reason !== "lookup_failed" && Date.now() - hit.at < LOOKUP_REUSE_MS))
  ) {
    return hit;
  }

  const entry = { key, result: null, at: 0, promise: null };
  entry.promise = resolveDuskName(input, { nodeUrl }).then((result) => {
    entry.result = result;
    entry.at = Date.now();
    return result;
  });
  lastLookup = entry;
  return entry;
}

// Primary names by node and account: the last answer, when it came, and the
// lookup while one runs.
const primaryNames = new Map();

// Where each answer is kept for sites and approvals: in storage, or, from
// the engine, by the background (keepPrimaryNamesWith).
let keepPrimaryName = rememberVerifiedName;

/**
 * Keep each primary-name answer with `keep` from now on rather than in this
 * context's storage. The engine sends its answers to the background: Chrome's
 * offscreen document has no storage.
 *
 * @param {(nodeUrl: string, account: string, name: string|null) => unknown} keep - never throws
 */
export function keepPrimaryNamesWith(keep) {
  keepPrimaryName = keep;
}

/**
 * `resolvePrimaryName` for display, by node and account. A lookup starts after
 * the render that asks for it and is shared while it runs. Its answer is reused
 * for a minute; after that a call gets the answer of a new lookup, so a name
 * that changed or went away doesn't stay on show. A failed lookup gives no name
 * and is tried again on the next call.
 *
 * With `stale`, a call gets the last answer at once while a new lookup runs,
 * for display that copies and sends nothing, as the header's account chip.
 *
 * Each answer is also kept for sites and approvals (verifiedNames.js,
 * keepPrimaryNamesWith).
 *
 * @param {string} account
 * @param {{ nodeUrl?: string, stale?: boolean }} [opts]
 * @returns {Promise<string|null>} the name, or null when there is none to show
 */
export function lookupPrimaryName(account, { nodeUrl, stale = false } = {}) {
  if (!duskNamesNetwork(nodeUrl) || classifyDuskIdentifier(account) !== "account") return Promise.resolve(null);
  const key = `${nodeUrl}\n${account}`;
  const entry = primaryNames.get(key) ?? { name: null, at: 0, running: null };
  primaryNames.set(key, entry);
  const fresh = Date.now() - entry.at < LOOKUP_REUSE_MS;
  if (!fresh && !entry.running) {
    entry.running = new Promise((start) => setTimeout(start)).then(async () => {
      const result = await resolvePrimaryName(account, { nodeUrl, batched: true });
      entry.running = null;
      if (!result.ok) return null;
      Object.assign(entry, { name: result.name, at: Date.now() });
      keepPrimaryName(nodeUrl, account, result.name);
      return result.name;
    });
  }
  return fresh || (stale && entry.at) ? Promise.resolve(entry.name) : entry.running;
}

/**
 * The verified primary name of a public account, for display beside the same
 * profile's shielded address: the name only when it pays there too, its
 * `phoenix_payment_endpoint` record being exactly `address`, and null
 * otherwise. Lookups are shared and reused as in `lookupPrimaryName` and
 * `lookupDuskName`.
 *
 * @param {string} account - the public account
 * @param {string} address - the profile's shielded address
 * @param {{ nodeUrl?: string }} [opts]
 * @returns {Promise<string|null>}
 */
export async function lookupShieldedName(account, address, { nodeUrl } = {}) {
  const name = await lookupPrimaryName(account, { nodeUrl });
  if (!name || !address) return null;
  const result = await lookupDuskName(name, { nodeUrl }).promise;
  return result.ok && result.address === address ? name : null;
}

// The longest name an approval shows for a recipient, ".dusk" included, so it
// fits on its line beside "name set by the recipient". A longer name is left
// out rather than cut short (nameToShow): the part cut off could give it away.
const RECIPIENT_NAME_MAX = 24;

/**
 * The primary .dusk name of the recipient of a site's request to send, for
 * its approval: that of a public account, once the lens reader's
 * `verifyPrimary` checked that the name's `moonlight_address` record is that
 * account. It is given only as a canonical name of at most RECIPIENT_NAME_MAX
 * characters, none of whose labels reads like an account, an address or a
 * contract ID; null otherwise. Unlike a profile's name it isn't kept: the
 * names kept are the wallet's own. Never throws.
 *
 * @param {string} recipient
 * @param {{ nodeUrl?: string }} [opts] - the approval's node
 * @returns {Promise<string|null>}
 */
export async function lookupRecipientName(recipient, { nodeUrl } = {}) {
  const result = await resolvePrimaryName(String(recipient ?? "").trim(), { nodeUrl });
  return result.ok ? nameToShow(result.name, RECIPIENT_NAME_MAX) : null;
}

// A lens refusal for want of gas, which a multicall's share of gas can cause
// and a query of its own does not (the SDK's client reads those again alone).
const shortOfGas = (error) =>
  error?.reason === "refused" &&
  (error.refusal?.code === "GasBudget" || error.refusal?.code === "ReadFailed" || error.refusal?.cause === "GasBudget");

/**
 * `lookupRecipientName` for many accounts at once, as Activity names its
 * counterparties: the lookups go out together, so Multicall for Dusk carries
 * up to 32 of them in one query (@hdauven/dusk-multicall), and the lens reader
 * checks each answer as it checks one read alone. A lookup the lens refused
 * for want of gas in the batch is made again on its own. Accounts whose
 * lookup failed are left out. Never throws.
 *
 * @param {string[]} accounts
 * @param {{ nodeUrl?: string }} [opts]
 * @returns {Promise<Map<string, string|null>>} the name of each account looked up, null for none
 */
export async function lookupRecipientNames(accounts, { nodeUrl } = {}) {
  const out = new Map();
  const network = duskNamesNetwork(nodeUrl);
  const list = [...new Set((accounts ?? []).map((a) => String(a ?? "").trim()))].filter(
    (a) => classifyDuskIdentifier(a) === "account"
  );
  if (!network || !list.length) return out;
  let sdk;
  let reader;
  try {
    sdk = await loadSdk();
    reader = await readerFor(sdk.createLensReader, network, nodeHref(nodeUrl), { batched: true });
  } catch (error) {
    failed(PINNED_RELEASES[network], error);
    return out;
  }
  // Started in one task, so one aggregate takes them.
  const results = await Promise.allSettled(list.map((a) => reader.verifyPrimary(Array.from(sdk.decodeBase58(a)))));
  const again = [];
  if (results.some((result) => result.status === "fulfilled")) took(reader);
  results.forEach((result, i) => {
    if (result.status === "fulfilled") {
      const name = result.value === null ? null : result.value?.primary?.spelling;
      if (name === null || typeof name === "string") out.set(list[i], name);
    } else if (shortOfGas(result.reason)) {
      again.push(list[i]);
    } else {
      failed(PINNED_RELEASES[network], result.reason);
    }
  });
  for (const account of again) {
    const result = await resolvePrimaryName(account, { nodeUrl });
    if (result.ok) out.set(account, result.name);
  }
  for (const [account, name] of out) out.set(account, nameToShow(name, RECIPIENT_NAME_MAX));
  return out;
}

/**
 * Inline copy for a lookup that did not give a usable address.
 * @param {{ name?: string, reason?: string }} result
 * @returns {string}
 */
export function duskNameErrorText({ name, reason } = {}) {
  switch (reason) {
    case "invalid_name":
      return "This isn't a valid .dusk name.";
    case "unsupported_network":
      return "Sending to .dusk names works on Mainnet and Testnet only.";
    case "not_registered":
      return `${name} isn't registered.`;
    case "expired":
      return `${name} has expired.`;
    case "no_account":
      return `${name} has no address to send to.`;
    default:
      return `Couldn't look up ${name}.`;
  }
}
