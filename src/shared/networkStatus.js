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
 */

/**
 * @typedef {Object} ProbeResult
 * @property {boolean} ok - Whether the endpoint is reachable
 * @property {string} [error] - Error message if not reachable
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
 * Probe a node endpoint for reachability.
 * Tests the /on/node/info endpoint.
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
      {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          Accept: "application/json",
        },
        body: new Uint8Array(0),
      },
      timeoutMs
    );

    // Rusk can return 400/424 when Rusk-Version/Rusk-Session-Id headers are
    // missing or mismatched. Still means the node is alive.
    if (resp.ok || resp.status === 400 || resp.status === 424) {
      return { ok: true };
    }

    return { ok: false, error: `HTTP ${resp.status}` };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
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
 * Uses node status as the primary indicator.
 * @param {NetworkStatusState} status
 * @returns {EndpointStatus}
 */
export function getCombinedStatus(status) {
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
