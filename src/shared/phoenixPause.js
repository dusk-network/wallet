// Whether a network has shielded (Phoenix) transactions paused.
//
// Nodes list feature activations under `vm_config.features` in
// /on/node/info. DISABLE_PHOENIX is either an activation height or a list of
// [start, end] height ranges, both ends included. u64::MAX means never, and
// feature names match case-insensitively. A new transaction lands in the next
// block, so the check is made at tip + 1.

import { bytesToHex } from "./bytes.js";
import { TX_KIND } from "./constants.js";
import { ERROR_CODES, rpcError } from "./errors.js";
import { fetchWithTimeout } from "./networkStatus.js";
import { storage, STORAGE_KEYS } from "./storage.js";
import { withStorageLock } from "./storageLock.js";
import { postGraphql } from "./txLifecycle.js";

export const PHOENIX_FEATURE = "DISABLE_PHOENIX";
export const U64_MAX = 18446744073709551615n;
/** Refresh a network's answer at most this often (driven by overview polling). */
export const PHOENIX_PAUSE_MAX_AGE_MS = 60_000;

const FETCH_TIMEOUT_MS = 5_000;
const TRANSFER_CONTRACT_ID = "0100000000000000000000000000000000000000000000000000000000000000";

// JSON numbers past Number's safe range lose precision (u64::MAX arrives as
// 2^64), so they are read as u64::MAX: no block height gets that far.
function toHeight(value) {
  if (typeof value === "bigint") {
    if (value < 0n) return null;
    return value > U64_MAX ? U64_MAX : value;
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) return null;
    return Number.isSafeInteger(value) ? BigInt(value) : U64_MAX;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const n = BigInt(value.trim());
    return n > U64_MAX ? U64_MAX : n;
  }
  return null;
}

/**
 * Parse a feature activation as a node reports it.
 * @param {unknown} raw - A height, or a list of [start, end] ranges.
 * @returns {{ height: bigint } | { ranges: Array<[bigint, bigint]> } | null}
 *   null when the feature is missing or unreadable, which counts as inactive.
 */
export function parseFeatureActivation(raw) {
  const height = toHeight(raw);
  if (height !== null) return { height };
  if (!Array.isArray(raw)) return null;

  const ranges = [];
  for (const range of raw) {
    if (!Array.isArray(range) || range.length !== 2) continue;
    const start = toHeight(range[0]);
    const end = toHeight(range[1]);
    if (start !== null && end !== null) ranges.push([start, end]);
  }
  return { ranges };
}

/**
 * Whether a parsed activation is active at a block height.
 * @param {ReturnType<typeof parseFeatureActivation>} activation
 * @param {bigint|number|string} height
 */
export function isFeatureActiveAt(activation, height) {
  const at = toHeight(height);
  if (!activation || at === null) return false;
  if ("height" in activation) return activation.height !== U64_MAX && at >= activation.height;
  return activation.ranges.some(([start, end]) => at >= start && at <= end);
}

/**
 * A feature's raw activation from a node info response, matched by name
 * regardless of case.
 * @param {any} info - The /on/node/info response.
 * @param {string} name
 */
export function nodeFeature(info, name) {
  const features = info?.vm_config?.features ?? info?.vmConfig?.features;
  if (!features || typeof features !== "object") return undefined;
  const want = String(name).toLowerCase();
  const key = Object.keys(features).find((k) => k.toLowerCase() === want);
  return key === undefined ? undefined : features[key];
}

/**
 * Whether node info says Phoenix is off for the block after `tipHeight`.
 * @param {any} info - The /on/node/info response.
 * @param {bigint|number|string} tipHeight
 */
export function isPhoenixPausedAt(info, tipHeight) {
  const tip = toHeight(tipHeight);
  if (tip === null || tip >= U64_MAX) return false;
  return isFeatureActiveAt(parseFeatureActivation(nodeFeature(info, PHOENIX_FEATURE)), tip + 1n);
}

function canEverActivate(activation) {
  if (!activation) return false;
  if ("height" in activation) return activation.height !== U64_MAX;
  return activation.ranges.length > 0;
}

// Resolved against the node URL as the transaction lookups do (txLifecycle.js).
function nodeEndpoint(nodeUrl, pathname) {
  const base = String(nodeUrl || "").trim();
  if (!base) throw new Error("nodeUrl is required");
  return new URL(pathname, base).toString();
}

async function fetchNodeInfo(nodeUrl, timeoutMs) {
  const resp = await fetchWithTimeout(
    nodeEndpoint(nodeUrl, "/on/node/info"),
    {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", Accept: "application/json" },
      body: new Uint8Array(0),
    },
    timeoutMs
  );
  if (!resp.ok) throw new Error(`Node info request failed (HTTP ${resp.status})`);
  return await resp.json();
}

// The node's own GraphQL protocol, as the transaction lookups use it.
async function fetchTipHeight(nodeUrl) {
  const body = await postGraphql(nodeUrl, "query { block(height: -1) { header { height } } }");
  const height = toHeight(body?.block?.header?.height);
  if (height === null) throw new Error("Block height missing from node response");
  return height;
}

/**
 * Ask a node whether Phoenix is paused for the next block. Throws when the
 * node can't answer.
 * @param {string} nodeUrl
 * @param {{ timeoutMs?: number }} [opts] - for the node info request
 * @returns {Promise<boolean>}
 */
export async function fetchPhoenixPaused(nodeUrl, { timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const tip = fetchTipHeight(nodeUrl);
  // The info alone settles a missing feature, so the height may go unused.
  tip.catch(() => {});
  const info = await fetchNodeInfo(nodeUrl, timeoutMs);
  if (!canEverActivate(parseFeatureActivation(nodeFeature(info, PHOENIX_FEATURE)))) return false;
  return isPhoenixPausedAt(info, await tip);
}

// --- Per-network cache ---------------------------------------------------------

const inflight = new Map();

function networkKey(nodeUrl) {
  try {
    return new URL(String(nodeUrl ?? "").trim()).origin;
  } catch {
    return "";
  }
}

async function readEntries() {
  try {
    const items = await storage.get(STORAGE_KEYS.PHOENIX_PAUSE);
    const all = items?.[STORAGE_KEYS.PHOENIX_PAUSE];
    return all && typeof all === "object" ? all : {};
  } catch {
    return {};
  }
}

async function writeEntry(key, entry) {
  try {
    await withStorageLock(STORAGE_KEYS.PHOENIX_PAUSE, async () => {
      const all = await readEntries();
      await storage.set({ [STORAGE_KEYS.PHOENIX_PAUSE]: { ...all, [key]: entry } });
    });
  } catch {
    // The answer still applies to this call; it just isn't remembered.
  }
}

async function refresh(key, nodeUrl, known, timeoutMs) {
  const attemptedAt = Date.now();
  try {
    const entry = { paused: await fetchPhoenixPaused(nodeUrl, { timeoutMs }), checkedAt: Date.now() };
    await writeEntry(key, entry);
    return entry;
  } catch {
    // Keep the last known answer, and wait a full period before asking again.
    await writeEntry(key, { ...known, attemptedAt });
    return known;
  }
}

/**
 * Whether Phoenix is paused on the network behind `nodeUrl`, cached per
 * network. Asks the node again once the answer is older than `maxAgeMs`. If
 * the node can't answer, the last known value stands; with nothing known yet,
 * the network counts as not paused. Never throws.
 * @param {string} nodeUrl
 * @param {{ maxAgeMs?: number, timeoutMs?: number }} [opts]
 * @returns {Promise<{ paused: boolean, checkedAt: number }>}
 */
export async function getPhoenixPause(
  nodeUrl,
  { maxAgeMs = PHOENIX_PAUSE_MAX_AGE_MS, timeoutMs = FETCH_TIMEOUT_MS } = {}
) {
  const key = networkKey(nodeUrl);
  if (!key) return { paused: false, checkedAt: 0 };

  const entry = (await readEntries())[key];
  const known = { paused: entry?.paused === true, checkedAt: Number(entry?.checkedAt) || 0 };
  const askedAt = Math.max(known.checkedAt, Number(entry?.attemptedAt) || 0);
  if (askedAt && Date.now() - askedAt < maxAgeMs) return known;

  let pending = inflight.get(key);
  if (!pending) {
    pending = refresh(key, nodeUrl, known, timeoutMs).finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return await pending;
}

// --- Requests that need Phoenix ------------------------------------------------

function isTransferContract(contractId) {
  let hex = "";
  if (typeof contractId === "string") {
    hex = contractId.trim().toLowerCase().replace(/^0x/, "");
  } else if (contractId && typeof contractId === "object") {
    try {
      hex = bytesToHex(contractId);
    } catch {
      hex = "";
    }
  }
  return hex === TRANSFER_CONTRACT_ID;
}

/**
 * Whether a transaction request needs Phoenix: shielded transfers and
 * contract calls, shield and unshield, staking paid to or from the shielded
 * balance, and calls to the transfer contract's `convert`.
 * @param {any} params - dusk_sendTransaction params.
 */
export function txNeedsPhoenix(params) {
  const lower = (v) => String(v ?? "").trim().toLowerCase();
  const kind = lower(params?.kind);
  if (kind === TX_KIND.SHIELD || kind === TX_KIND.UNSHIELD) return true;
  if (lower(params?.privacy) === "shielded") return true;
  const payment = lower(params?.payment);
  if (payment === "address" || payment === "shielded") return true;
  return (
    kind === TX_KIND.CONTRACT_CALL &&
    String(params?.fnName ?? "").trim() === "convert" &&
    isTransferContract(params?.contractId)
  );
}

/**
 * The paused notice, also used as the error message.
 * @param {string} networkName - The network's display name, e.g. "Mainnet".
 */
export function phoenixPausedMessage(networkName) {
  const name = String(networkName ?? "").trim() || "this network";
  return `Shielded transactions are paused on ${name}.`;
}

/** The error returned for a request that needs Phoenix while it's paused. */
export function phoenixPausedError(networkName) {
  return rpcError(ERROR_CODES.UNSUPPORTED, phoenixPausedMessage(networkName));
}
