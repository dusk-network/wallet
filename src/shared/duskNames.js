// Dusk Domains (.dusk names) for the send flow and the wallet's own names.
//
// A name resolves to the public account in its `moonlight_address` record and
// the shielded address in its `phoenix_payment_endpoint` record, and a public
// account to its verified primary name, read through the SDK's lens reader and
// the wallet's own node. The SDK and the pinned release descriptors are loaded
// on the first lookup only, so they stay out of the popup bundle. The lens data
// driver ships with the extension in public/drivers/dusk-domains, and the SDK
// checks it against the sha256 pinned in dusk-domains-releases.json. Nothing
// else is fetched.

import { assetUrl } from "../platform/assets.js";
import { classifyDuskIdentifier } from "./duskIdentifiers.js";
import { detectPresetIdFromNodeUrl } from "./network.js";

const LOOKUP_REUSE_MS = 60_000;

// The records a name is sent to by: its public account, then its opt-in shielded address.
const RECORD_KEYS = Object.freeze(["moonlight_address", "phoenix_payment_endpoint"]);

/**
 * Whether recipient input is meant as a .dusk name. Base58 recipients never
 * contain a dot, so this never claims a raw address; `dusk:` request links
 * keep their own handling.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isDuskName(value) {
  const text = String(value ?? "").trim();
  return /\.dusk$/i.test(text) && !/^dusk:/i.test(text);
}

/**
 * The Dusk Domains network for a node URL, or null where names are off.
 * @param {string} nodeUrl
 * @returns {"mainnet"|"testnet"|null}
 */
export function duskNamesNetwork(nodeUrl) {
  const preset = detectPresetIdFromNodeUrl(String(nodeUrl ?? ""));
  return preset === "mainnet" || preset === "testnet" ? preset : null;
}

// Release roles whose data drivers ship with the extension, in
// public/drivers/dusk-domains. Name lookups load exactly these.
export const BUNDLED_DRIVER_ROLES = Object.freeze(["lens"]);

/**
 * The bundled data drivers of a release, from its pinned descriptors.
 * @param {object} release - one network of dusk-domains-releases.json
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

// The SDK and the pinned release descriptors, loaded on the first lookup.
const loadSdk = () => Promise.all([import("./duskNamesSdk.js"), import("./dusk-domains-releases.json")]);

// The SDK's own spelling of the node URL, which its reads start with.
const nodeHref = (nodeUrl) => new URL(String(nodeUrl)).href.replace(/\/$/, "");

// One reader per network, bound to the node it reads from.
const readers = new Map();

function readerFor(createLensReader, release, network, nodeUrl) {
  const cached = readers.get(network);
  if (cached?.nodeUrl === nodeUrl) return cached.promise;

  const promise = createLensReader(release, {
    nodeUrl,
    artifactBaseUrl: release.artifactBaseUrl,
    fetch: bundledFetch(release, nodeUrl),
  });
  const entry = { nodeUrl, promise };
  readers.set(network, entry);
  // A reader that failed to build is built again by the next lookup.
  promise.catch(() => {
    if (readers.get(network) === entry) readers.delete(network);
  });
  return promise;
}

// What an answer lets the wallet send to: the public account in the name's
// `moonlight_address` record and the shielded address its
// `phoenix_payment_endpoint` record holds as UTF-8 text. The wallet checks each
// as it checks any address, and a record that fails counts as absent.
function addressesFrom(sdk, { status, records }, name) {
  const fail = (reason) => ({ ok: false, name, reason });
  if (status === "Absent" || status === "Released") return fail("not_registered");
  if (status === "Grace" || status === "Expired") return fail("expired");
  if (status !== "Active") return fail("lookup_failed");
  const [moonlight, phoenix] = records;
  // The key check the reader's own resolveMoonlightAccount makes.
  const account =
    moonlight && sdk.hasClaimableReferrerShape({ kind: "Moonlight", bytes: moonlight.value })
      ? sdk.encodeBase58(moonlight.value)
      : "";
  // A shielded address and nothing else, not even a byte order mark.
  const text = phoenix ? new TextDecoder("utf-8", { ignoreBOM: true }).decode(Uint8Array.from(phoenix.value)) : "";
  const result = { ok: true, name };
  if (classifyDuskIdentifier(account) === "account") result.account = account;
  if (text === text.trim() && classifyDuskIdentifier(text) === "address") result.address = text;
  return result.account || result.address ? result : fail("no_account");
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
  let name = String(input ?? "").trim();
  const fail = (reason) => ({ ok: false, name, reason });

  const network = duskNamesNetwork(nodeUrl);
  if (!network) return fail("unsupported_network");
  const node = nodeHref(nodeUrl);

  let sdk;
  let releases;
  try {
    [sdk, { default: releases }] = await loadSdk();
  } catch {
    return fail("lookup_failed");
  }

  const checked = sdk.validateName(name);
  if (!checked.ok) return fail("invalid_name");
  name = checked.name.canonical;

  // The reader bounds its own build and reads; any LensReaderError is a failed lookup.
  try {
    const reader = await readerFor(sdk.createLensReader, releases[network], network, node);
    return addressesFrom(sdk, await reader.resolve(name, RECORD_KEYS), name);
  } catch {
    return fail("lookup_failed");
  }
}

/**
 * The verified primary .dusk name of a public account, read with the lens
 * reader's `verifyPrimary` through the wallet's node; `name` is null when the
 * account has none. Never throws.
 *
 * @param {string} account - Base58 public account
 * @param {{ nodeUrl?: string }} [opts] - the wallet's node for the active network
 * @returns {Promise<{ ok: true, name: string|null } | { ok: false, reason: "unsupported_network"|"lookup_failed" }>}
 */
export async function resolvePrimaryName(account, { nodeUrl } = {}) {
  const network = duskNamesNetwork(nodeUrl);
  if (!network) return { ok: false, reason: "unsupported_network" };
  // Only a public account, a Moonlight key, can have a primary name.
  if (classifyDuskIdentifier(account) !== "account") return { ok: true, name: null };
  try {
    const [sdk, { default: releases }] = await loadSdk();
    const reader = await readerFor(sdk.createLensReader, releases[network], network, nodeHref(nodeUrl));
    // The reader takes the 96-byte key as plain numbers.
    const verified = await reader.verifyPrimary(Array.from(sdk.decodeBase58(account)));
    const name = verified === null ? null : verified.primary.spelling;
    return name === null || typeof name === "string" ? { ok: true, name } : { ok: false, reason: "lookup_failed" };
  } catch {
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
      const result = await resolvePrimaryName(account, { nodeUrl });
      entry.running = null;
      if (!result.ok) return null;
      Object.assign(entry, { name: result.name, at: Date.now() });
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
