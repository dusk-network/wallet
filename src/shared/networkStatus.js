/**
 * Network status and endpoint probing module.
 *
 * This is the single source of truth for all network endpoint probing logic.
 * It provides:
 * - Reusable probe functions for node, prover, and archiver endpoints
 * - Background status polling with storage persistence
 * - UI status display helpers
 *
 * Design (similar to MetaMask's approach):
 * - Accept any URL the user enters
 * - Poll endpoints in the background
 * - Show visual status (online/offline/checking)
 * - Don't block saving settings on validation failures
 */

import { RUSK_HEADERS, chainChangeWords, chainIdOfInfo, chainRefusal, listedChainId, pinnedChainOf } from "./nodeNetwork.js";
import { ERROR_CODES, rpcError } from "./errors.js";
import { getSettings, rememberNodeChain } from "./settings.js";
import { storage, STORAGE_KEYS } from "./storage.js";

// ============================================================================
// Types
// ============================================================================

/**
 * @typedef {"online"|"offline"|"checking"|"unknown"} EndpointStatus
 */

/**
 * @typedef {Object} NetworkStatusState
 * @property {EndpointStatus} nodeStatus
 * @property {EndpointStatus} proverStatus
 * @property {EndpointStatus} archiverStatus
 * @property {number|null} lastChecked - Timestamp of last check
 * @property {string|null} nodeError - Last error message for node
 * @property {string|null} proverError - Last error message for prover
 * @property {string|null} archiverError - Last error message for archiver
 * @property {string|null} nodeUrl - The node the last check asked
 * @property {number|null} nodeChainId - The chain ID it said then, if it said
 */

/**
 * @typedef {Object} ProbeResult
 * @property {boolean} ok - Whether the endpoint is reachable
 * @property {string} [error] - Error message if not reachable
 * @property {number|null} [chainId] - A node's chain ID, from its /on/node/info
 */

// ============================================================================
// Utilities
// ============================================================================

/**
 * Fetch with timeout helper.
 * Exported for reuse in other modules that need timeout-aware fetching.
 * @param {string} url
 * @param {RequestInit} options
 * @param {number} timeoutMs
 * @returns {Promise<Response>}
 */
export async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

// ============================================================================
// Endpoint Probes
// ============================================================================

/**
 * Probe a node endpoint for reachability, and read the chain ID that names
 * its network (nodeNetwork.js), from its /on/node/info.
 * @param {string} baseUrl - Base URL of the node
 * @param {number} [timeoutMs=6000] - Request timeout in milliseconds
 * @returns {Promise<ProbeResult>}
 */
export async function probeNode(baseUrl, timeoutMs = 6000) {
  try {
    const u = new URL(baseUrl);
    const infoUrl = new URL("/on/node/info", u.origin).toString();

    const resp = await fetchWithTimeout(
      infoUrl,
      { method: "POST", headers: RUSK_HEADERS, body: new Uint8Array(0) },
      timeoutMs
    );

    if (resp.ok) {
      const info = await resp.json().catch(() => null);
      return { ok: true, chainId: chainIdOfInfo(info) };
    }

    // Rusk can return 400/424 when its Rusk-Version/Rusk-Session-Id
    // checks fail. Still means the node is alive, though it gave no info.
    if (resp.status === 400 || resp.status === 424) {
      return { ok: true, chainId: null };
    }

    return { ok: false, error: `HTTP ${resp.status}` };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/**
 * The chain ID a node gives, read when the node is chosen (Settings, or a
 * site's switch): a network's own node's at once, else the node's own
 * answer, asked again once after a short wait; null when it can't be read,
 * and the next status check asks again.
 * @param {string} nodeUrl
 * @param {{ attempts?: number, waitMs?: number, timeoutMs?: number }} [opts]
 * @returns {Promise<number | null>}
 */
export async function readChainId(nodeUrl, { attempts = 2, waitMs = 500, timeoutMs = 4000 } = {}) {
  const listed = listedChainId(nodeUrl);
  if (listed !== null) return listed;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, waitMs));
    const { chainId } = await probeNode(nodeUrl, timeoutMs);
    if (Number.isInteger(chainId)) return chainId;
  }
  return null;
}

/**
 * The chain ID to keep with a node as Settings or the network menu choose it:
 * the one it was added with, or for a new node what it says now. A node that
 * says something else than it was added with is refused until it's saved again
 * knowingly (`accept`, the chain ID the user agreed to, and no other); one that
 * doesn't say keeps the one it has.
 * @param {string} nodeUrl
 * @param {{ accept?: number | null }} [opts]
 * @returns {Promise<number | null>}
 */
export async function chainIdForChoice(nodeUrl, { accept = null } = {}) {
  const listed = listedChainId(nodeUrl);
  if (listed !== null) return listed;
  const pinned = pinnedChainOf(await getSettings(), nodeUrl);
  const answered = await readChainId(nodeUrl);
  if (pinned === null || answered === null || answered === pinned) return pinned ?? answered;
  if (accept === answered) return answered;
  const { notice, question } = chainChangeWords(nodeUrl, pinned, answered);
  throw rpcError(ERROR_CODES.UNAUTHORIZED, notice, { chainChanged: { pinned, answered, question } });
}

/**
 * Probe a prover endpoint for reachability.
 * Sends a dummy payload to /on/prover/prove and checks for known error signatures.
 * @param {string} baseUrl - Base URL of the prover
 * @param {number} [timeoutMs=10000] - Request timeout in milliseconds
 * @returns {Promise<ProbeResult>}
 */
export async function probeProver(baseUrl, timeoutMs = 10000) {
  try {
    const u = new URL(baseUrl);
    const proveUrl = new URL("/on/prover/prove", u.origin).toString();

    const resp = await fetchWithTimeout(
      proveUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          Accept: "application/octet-stream",
        },
        body: new Uint8Array(8), // dummy 8-byte payload
      },
      timeoutMs
    );

    // 404 means endpoint doesn't exist
    if (resp.status === 404) {
      return { ok: false, error: "Prover endpoint not found" };
    }

    // Success or Rusk header mismatch codes mean it's alive
    if (resp.ok || resp.status === 400 || resp.status === 424) {
      return { ok: true };
    }

    // Check for known prover error signatures (HTTP 500 with recognizable errors).
    // These indicate the prover is alive but rejected our dummy payload.
    const text = await resp.text().catch(() => "");
    if (
      text.includes("Dusk-Core Error") ||
      text.includes("Execution-Core Error") ||
      text.includes("BadLength") ||
      text.includes("Bad length")
    ) {
      return { ok: true };
    }

    return { ok: false, error: `HTTP ${resp.status}` };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/**
 * Probe an archiver endpoint for reachability.
 * Tests the /on/graphql/query endpoint with a contractEvents query.
 * @param {string} baseUrl - Base URL of the archiver
 * @param {number} [timeoutMs=7000] - Request timeout in milliseconds
 * @returns {Promise<ProbeResult>}
 */
export async function probeArchiver(baseUrl, timeoutMs = 7000) {
  try {
    const u = new URL(baseUrl);
    const gqlUrl = new URL("/on/graphql/query", u.origin).toString();

    const resp = await fetchWithTimeout(
      gqlUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          Accept: "application/json",
        },
        // Intentionally omit selection set to probe for field existence
        body: "query { contractEvents(height: 0) }",
      },
      timeoutMs
    );

    if (resp.status === 404) {
      return { ok: false, error: "GraphQL endpoint not found" };
    }

    const text = await resp.text().catch(() => "");

    // Check if this node doesn't support archive queries (not an archive node)
    if (
      text.includes('Unknown field "contractEvents"') ||
      text.includes("Unknown field 'contractEvents'") ||
      text.includes("Unknown field contractEvents")
    ) {
      return { ok: false, error: "Not an archive node" };
    }

    // GraphQL validation errors about missing selection sets mean the field EXISTS
    // and the endpoint is working - our query just needs subfields.
    if (
      text.includes("must have a selection") ||
      text.includes("selection of subfields")
    ) {
      return { ok: true };
    }

    // Any valid response (2xx) means archiver is reachable
    if (resp.ok) {
      return { ok: true };
    }

    // HTTP 500 with a GraphQL error mentioning contractEvents is still "alive"
    if (resp.status === 500 && text.includes("contractEvents")) {
      return { ok: true };
    }

    // Rusk header mismatch codes are still "alive"
    if (resp.status === 400 || resp.status === 424) {
      return { ok: true };
    }

    return { ok: false, error: `HTTP ${resp.status}` };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

// ============================================================================
// Network Status Storage
// ============================================================================

const DEFAULT_STATUS = {
  nodeStatus: "unknown",
  proverStatus: "unknown",
  archiverStatus: "unknown",
  lastChecked: null,
  nodeError: null,
  proverError: null,
  archiverError: null,
  nodeUrl: null,
  nodeChainId: null,
};

/**
 * Get the current network status from storage.
 * @returns {Promise<NetworkStatusState>}
 */
export async function getNetworkStatus() {
  const items = await storage.get(STORAGE_KEYS.NETWORK_STATUS);
  const raw = items[STORAGE_KEYS.NETWORK_STATUS] ?? {};
  return { ...DEFAULT_STATUS, ...raw };
}

/**
 * Update the network status in storage.
 * @param {Partial<NetworkStatusState>} patch
 * @returns {Promise<NetworkStatusState>}
 */
export async function setNetworkStatus(patch) {
  const current = await getNetworkStatus();
  const next = { ...current, ...patch };
  await storage.set({ [STORAGE_KEYS.NETWORK_STATUS]: next });
  return next;
}

/**
 * Reset network status to unknown (e.g., when endpoints change).
 * @returns {Promise<NetworkStatusState>}
 */
export async function resetNetworkStatus() {
  await storage.set({ [STORAGE_KEYS.NETWORK_STATUS]: DEFAULT_STATUS });
  return DEFAULT_STATUS;
}

// ============================================================================
// Polling & Helpers
// ============================================================================

// The check under way for each set of endpoints: a caller while it runs, as
// each popup render that finds the status stale, gets its answer rather than
// probing every endpoint again.
const runningChecks = new Map();

/**
 * Check all endpoints and update status in storage.
 * This is designed to be called periodically from the background.
 * Each probe is wrapped in its own try/catch to ensure one failure
 * doesn't block the others. Callers while a check of the same endpoints
 * runs share it.
 * @param {{nodeUrl: string, proverUrl: string, archiverUrl: string}} endpoints
 * @returns {Promise<NetworkStatusState>}
 */
export function checkAllEndpoints(endpoints) {
  const key = JSON.stringify([endpoints?.nodeUrl ?? "", endpoints?.proverUrl ?? "", endpoints?.archiverUrl ?? ""]);
  let check = runningChecks.get(key);
  if (!check) {
    check = runEndpointChecks(endpoints).finally(() => runningChecks.delete(key));
    runningChecks.set(key, check);
  }
  return check;
}

async function runEndpointChecks({ nodeUrl, proverUrl, archiverUrl }) {
  // Mark as checking
  await setNetworkStatus({
    nodeStatus: "checking",
    proverStatus: "checking",
    archiverStatus: "checking",
  });

  // Wrap each probe with individual error handling
  const safeProbe = async (probeFn, url, label) => {
    if (!url) {
      return { ok: false, error: "No URL configured" };
    }
    try {
      return await probeFn(url);
    } catch (e) {
      return { ok: false, error: `${label} check failed: ${e?.message ?? String(e)}` };
    }
  };

  // Run all probes in parallel with individual safety wrappers
  const [nodeResult, proverResult, archiverResult] = await Promise.all([
    safeProbe(probeNode, nodeUrl, "Node"),
    safeProbe(probeProver, proverUrl, "Prover"),
    safeProbe(probeArchiver, archiverUrl, "Archiver"),
  ]);

  // A node whose chain ID wasn't read when it was chosen gets it here, once.
  if (Number.isInteger(nodeResult.chainId)) {
    await rememberNodeChain(nodeUrl, nodeResult.chainId).catch(() => {});
  }

  // Update status
  return setNetworkStatus({
    nodeStatus: nodeResult.ok ? "online" : "offline",
    proverStatus: proverResult.ok ? "online" : "offline",
    archiverStatus: archiverResult.ok ? "online" : "offline",
    nodeError: nodeResult.error ?? null,
    proverError: proverResult.error ?? null,
    archiverError: archiverResult.error ?? null,
    lastChecked: Date.now(),
    // What it said, which the screens compare with the chain it's fixed to.
    nodeUrl: nodeUrl ?? null,
    nodeChainId: Number.isInteger(nodeResult.chainId) ? nodeResult.chainId : null,
  });
}

/** How long a page's ask of the node gets before it's said not to answer: less than a page asks again. */
export const NODE_ANSWER_MS = 10_000;

// The node's ask under way, by its address: one at a time, as a node that holds
// them open would otherwise use up the browser's connections to it.
const runningNodeAsks = new Map();

/**
 * Asks the node alone whether it answers, as a page that shows asks it: a node
 * can stop answering without an error, and between reads, minutes apart,
 * nothing else would find it silent. Its status, error and chain ID go in the
 * status kept, the prover's and the archiver's stay, and it's never "checking"
 * meanwhile. Nothing is kept once the wallet is on another node.
 * @param {string} nodeUrl
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<NetworkStatusState>}
 */
export function checkNode(nodeUrl, { timeoutMs = NODE_ANSWER_MS } = {}) {
  const key = String(nodeUrl ?? "");
  let ask = runningNodeAsks.get(key);
  if (!ask) {
    ask = (async () => {
      const result = key ? await probeNode(key, timeoutMs) : { ok: false, error: "No URL configured" };
      if ((await getSettings()).nodeUrl !== key) return getNetworkStatus();
      if (Number.isInteger(result.chainId)) await rememberNodeChain(key, result.chainId).catch(() => {});
      return setNetworkStatus({
        nodeStatus: result.ok ? "online" : "offline",
        nodeError: result.error ?? null,
        nodeUrl: key,
        nodeChainId: Number.isInteger(result.chainId) ? result.chainId : null,
      });
    })().finally(() => runningNodeAsks.delete(key));
    runningNodeAsks.set(key, ask);
  }
  return ask;
}

/**
 * What the last check heard from a node, when it contradicts the chain it's
 * fixed to: why nothing is signed on it, in plain words, else "".
 * @param {NetworkStatusState | null | undefined} status
 * @param {string} nodeUrl
 * @param {number | null} pinned
 * @returns {string}
 */
export function statusChainRefusal(status, nodeUrl, pinned) {
  if (status?.nodeUrl !== nodeUrl || !Number.isInteger(status?.nodeChainId)) return "";
  return chainRefusal(nodeUrl, pinned, status.nodeChainId, { required: false, ahead: true });
}

/**
 * Check if the status is stale and should be refreshed.
 * @param {NetworkStatusState} status
 * @param {number} maxAgeMs - Maximum age before considered stale (default: 30s)
 * @returns {boolean}
 */
/**
 * How old a check may be before the next overview checks again: 5 minutes,
 * 30 seconds while something fails (`failing`), and 5 seconds once the node
 * answers a read (`read`) while the last check said it was offline: back, it
 * says so at once rather than a red dot that stays.
 * @param {NetworkStatusState | null | undefined} status
 * @param {{ failing?: boolean, read?: boolean }} [now]
 */
export function checkEveryMs(status, { failing = false, read = false } = {}) {
  if (status?.nodeStatus === "offline") return read ? 5_000 : 30_000;
  return failing ? 30_000 : 5 * 60_000;
}

/** What a check said, to tell whether another said otherwise. */
export const statusWords = (status) => [status?.nodeStatus, status?.proverStatus, status?.archiverStatus, status?.nodeChainId].join("|");

export function isStatusStale(status, maxAgeMs = 30000) {
  if (!status?.lastChecked) return true;
  return Date.now() - status.lastChecked > maxAgeMs;
}
