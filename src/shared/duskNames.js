// Dusk Domains (.dusk names) for the send flow.
//
// A name resolves to the public account in its `moonlight_address` record,
// read through the SDK's lens reader and the wallet's own node. The SDK and the
// pinned release descriptors are loaded on the first lookup only, so they stay
// out of the popup bundle. The lens data driver ships with the extension in
// public/drivers/dusk-domains, and the SDK checks it against the sha256 pinned
// in dusk-domains-releases.json. Nothing else is fetched.

import { assetUrl } from "../platform/assets.js";
import { classifyDuskIdentifier } from "./duskIdentifiers.js";
import { detectPresetIdFromNodeUrl } from "./network.js";

const LOOKUP_REUSE_MS = 60_000;

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

function accountFrom({ status, account }, name) {
  const fail = (reason) => ({ ok: false, name, reason });
  if (status === "Absent" || status === "Released") return fail("not_registered");
  if (status === "Grace" || status === "Expired") return fail("expired");
  if (status !== "Active") return fail("lookup_failed");
  // The reader checks the record's shape only; the wallet checks the account as any address.
  if (typeof account !== "string" || classifyDuskIdentifier(account) !== "account") return fail("no_account");
  return { ok: true, name, account };
}

/**
 * Resolve a .dusk name to the public account in its `moonlight_address`
 * record. Only an active name with a valid 96-byte Moonlight account resolves;
 * everything else is a failure with a reason. Never throws.
 *
 * @param {string} input - recipient field text
 * @param {{ nodeUrl?: string }} [opts] - the wallet's node for the active network
 * @returns {Promise<
 *   | { ok: true, name: string, account: string }
 *   | { ok: false, name: string, reason: "invalid_name"|"unsupported_network"|"not_registered"|"expired"|"no_account"|"lookup_failed" }
 * >}
 */
export async function resolveDuskName(input, { nodeUrl } = {}) {
  let name = String(input ?? "").trim();
  const fail = (reason) => ({ ok: false, name, reason });

  const network = duskNamesNetwork(nodeUrl);
  if (!network) return fail("unsupported_network");
  // The SDK's own spelling of the node URL, which its reads start with.
  const node = new URL(String(nodeUrl)).href.replace(/\/$/, "");

  let sdk;
  let releases;
  try {
    [sdk, { default: releases }] = await Promise.all([
      import("./duskNamesSdk.js"),
      import("./dusk-domains-releases.json"),
    ]);
  } catch {
    return fail("lookup_failed");
  }

  const checked = sdk.validateName(name);
  if (!checked.ok) return fail("invalid_name");
  name = checked.name.canonical;

  // The reader bounds its own build and reads; any LensReaderError is a failed lookup.
  try {
    const reader = await readerFor(sdk.createLensReader, releases[network], network, node);
    return accountFrom(await reader.resolveMoonlightAccount(name), name);
  } catch {
    return fail("lookup_failed");
  }
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

/**
 * Inline copy for a lookup that did not give a usable account.
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
      return `${name} has no public account to send to.`;
    default:
      return `Couldn't look up ${name}.`;
  }
}
