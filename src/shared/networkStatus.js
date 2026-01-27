/**
 * Network status polling module.
 *
 * This provides a lightweight mechanism to check endpoint reachability in the
 * background without blocking settings changes. The UI can display online/offline
 * status based on the last poll result.
 *
 * Design (similar to MetaMask's approach):
 * - Accept any URL the user enters
 * - Poll endpoints in the background
 * - Show visual status (online/offline/checking)
 * - Don't block saving settings on validation failures
 */

import { storage, STORAGE_KEYS } from "./storage.js";

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
 */

const DEFAULT_STATUS = {
  nodeStatus: "unknown",
  proverStatus: "unknown",
  archiverStatus: "unknown",
  lastChecked: null,
  nodeError: null,
  proverError: null,
  archiverError: null,
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

/**
 * Fetch with timeout helper.
 * @param {string} url
 * @param {RequestInit} options
 * @param {number} timeoutMs
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * Light probe for node reachability.
 * Returns { ok: true } if reachable, { ok: false, error: string } otherwise.
 * @param {string} baseUrl
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function probeNode(baseUrl) {
  try {
    const u = new URL(baseUrl);
    const infoUrl = new URL("/on/node/info", u.origin).toString();

    const resp = await fetchWithTimeout(
      infoUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          Accept: "application/json",
        },
        body: new Uint8Array(0),
      },
      5000
    );

    // Rusk can return 400/424 when headers are missing; still means it's alive.
    if (resp.ok || resp.status === 400 || resp.status === 424) {
      return { ok: true };
    }

    return { ok: false, error: `HTTP ${resp.status}` };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/**
 * Light probe for prover reachability.
 * @param {string} baseUrl
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function probeProver(baseUrl) {
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
        body: new Uint8Array(8), // dummy payload
      },
      5000
    );

    // 404 means endpoint doesn't exist
    if (resp.status === 404) {
      return { ok: false, error: "Prover endpoint not found" };
    }

    // Any response (including errors for bad payload) means prover is reachable
    if (resp.ok || resp.status === 400 || resp.status === 424) {
      return { ok: true };
    }

    // Check for known prover error signatures (HTTP 500 with recognizable errors)
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
 * Light probe for archiver reachability.
 * @param {string} baseUrl
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function probeArchiver(baseUrl) {
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
        body: "query { contractEvents(height: 0) }",
      },
      5000
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
    // Example: 'Field "contractEvents" of type "ContractEvents" must have a selection'
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

    // HTTP 500 with a GraphQL error about selection sets is still "alive"
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

/**
 * Check all endpoints and update status in storage.
 * This is designed to be called periodically from the background.
 * Each probe is wrapped in its own try/catch to ensure one failure
 * doesn't block the others.
 * @param {{nodeUrl: string, proverUrl: string, archiverUrl: string}} endpoints
 * @returns {Promise<NetworkStatusState>}
 */
export async function checkAllEndpoints({ nodeUrl, proverUrl, archiverUrl }) {
  // Mark as checking
  await setNetworkStatus({
    nodeStatus: "checking",
    proverStatus: "checking",
    archiverStatus: "checking",
  });

  // Wrap each probe with individual error handling and timeout
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

  // Update status
  return setNetworkStatus({
    nodeStatus: nodeResult.ok ? "online" : "offline",
    proverStatus: proverResult.ok ? "online" : "offline",
    archiverStatus: archiverResult.ok ? "online" : "offline",
    nodeError: nodeResult.error ?? null,
    proverError: proverResult.error ?? null,
    archiverError: archiverResult.error ?? null,
    lastChecked: Date.now(),
  });
}

/**
 * Get a combined status for display purposes.
 * "online" if node is online (prover/archiver issues shown separately).
 * "offline" if node is offline.
 * "checking" if currently checking.
 * "unknown" if never checked.
 * @param {NetworkStatusState} status
 * @returns {EndpointStatus}
 */
export function getCombinedStatus(status) {
  // Node status is the primary indicator
  return status?.nodeStatus ?? "unknown";
}

/**
 * Check if the status is stale and should be refreshed.
 * @param {NetworkStatusState} status
 * @param {number} maxAgeMs - Maximum age before considered stale (default: 30s)
 * @returns {boolean}
 */
export function isStatusStale(status, maxAgeMs = 30000) {
  if (!status?.lastChecked) return true;
  return Date.now() - status.lastChecked > maxAgeMs;
}
