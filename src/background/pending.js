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

const MAX_PENDING = 20;
const APPROVAL_TTL_MS = 5 * 60_000;

function rejectPending(rid, entry, message) {
  if (!entry) return;
  pendingApprovals.delete(rid);
  clearTimeout(entry.timer);
  entry.reject(rpcError(ERROR_CODES.USER_REJECTED, message));
}

/**
 * Open a small notification window and wait for the user's decision.
 */
export async function requestUserApproval(kind, origin, params) {
  if (
    pendingApprovals.size >= MAX_PENDING ||
    [...pendingApprovals.values()].some((entry) => entry.origin === origin)
  ) {
    throw rpcError(ERROR_CODES.USER_REJECTED, "Another approval is already pending");
  }

  const rid = crypto.randomUUID();
  const promise = new Promise((resolve, reject) => {
    const entry = { kind, origin, params, createdAt: Date.now(), resolve, reject };
    entry.timer = setTimeout(
      () => rejectPending(rid, entry, "Approval request expired"),
      APPROVAL_TTL_MS
    );
    pendingApprovals.set(rid, entry);
  });

  const url = runtimeGetURL(
    `notification.html?rid=${encodeURIComponent(rid)}`
  );

  // Best effort: open a popup-style window.
  let win;
  try {
    win = await windowsCreate({
      url,
      type: "popup",
      width: 380,
      height: 620,
    });
  } catch {
    rejectPending(rid, pendingApprovals.get(rid), "Could not open approval window");
  }

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
      rejectPending(rid, entry, "User closed the approval window");
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
  clearTimeout(entry.timer);

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

export function cancelPendingApprovals(origin, reason = "Wallet state changed") {
  for (const [rid, entry] of pendingApprovals) {
    if (!origin || entry.origin === origin) rejectPending(rid, entry, reason);
  }
}
