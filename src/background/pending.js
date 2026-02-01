import { ERROR_CODES, rpcError } from "../shared/errors.js";
import {
  getExtensionApi,
  runtimeGetURL,
  windowsCreate,
} from "../platform/extensionApi.js";

/**
 * Pending approval requests.
 *
 * NOTE: The resolve value can carry user overrides (e.g. edited gas settings)
 * so the background can apply them before sending the transaction.
 *
 * @type {Map<string, { kind: string, origin: string, params: any, createdAt:number, windowId?: number, resolve: (v:any)=>void, reject:(e:any)=>void }>}
 */
export const pendingApprovals = new Map();

/**
 * Open a small notification window and wait for the user's decision.
 */
export async function requestUserApproval(kind, origin, params) {
  const rid = crypto.randomUUID();

  const promise = new Promise((resolve, reject) => {
    pendingApprovals.set(rid, {
      kind,
      origin,
      params,
      createdAt: Date.now(),
      resolve,
      reject,
    });
  });

  const url = runtimeGetURL(
    `notification.html?rid=${encodeURIComponent(rid)}`
  );

  // Best effort: open a popup-style window.
  const win = await windowsCreate({
    url,
    type: "popup",
    width: 380,
    height: 620,
  });

  // If the user closes the approval window, reject the pending request.
  const entry = pendingApprovals.get(rid);
  if (entry && win?.id !== undefined) {
    entry.windowId = win.id;
  }

  return promise;
}

const ext = getExtensionApi();

ext?.windows?.onRemoved?.addListener((windowId) => {
  for (const [rid, entry] of pendingApprovals.entries()) {
    if (entry.windowId === windowId) {
      pendingApprovals.delete(rid);
      entry.reject(
        rpcError(ERROR_CODES.USER_REJECTED, "User closed the approval window")
      );
    }
  }
});

export function getPending(rid) {
  return pendingApprovals.get(rid) ?? null;
}

export function resolvePendingDecision(message) {
  const { rid, decision } = message || {};
  const entry = pendingApprovals.get(rid);
  if (!entry) {
    return { ok: false, error: "Unknown request" };
  }

  pendingApprovals.delete(rid);

  if (decision === "approve") {
    // Optionally accept user edited parameters (e.g. gas overrides).
    // If none were provided, resolve with null.
    entry.resolve(
      message && Object.prototype.hasOwnProperty.call(message, "approvedParams")
        ? message.approvedParams
        : null
    );
    return { ok: true };
  }

  entry.reject(rpcError(ERROR_CODES.USER_REJECTED, "User rejected the request"));
  return { ok: true };
}
