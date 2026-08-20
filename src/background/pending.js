import { ERROR_CODES, rpcError } from "../shared/errors.js";
import {
  getExtensionApi,
  runtimeGetURL,
  windowsCreate,
  windowsRemove,
} from "../platform/extensionApi.js";

export const APPROVAL_TTL_MS = 5 * 60 * 1000;
let approvalGeneration = 0;

/**
 * Pending approval requests.
 *
 * NOTE: The resolve value can carry user overrides (e.g. edited gas settings)
 * so the background can apply them before sending the transaction.
 *
 * @type {Map<string, { kind: string, origin: string, params: any, createdAt:number, expiryTimer?: ReturnType<typeof setTimeout>, windowId?: number, resolve: (v:any)=>void, reject:(e:any)=>void }>}
 */
export const pendingApprovals = new Map();

export function captureApprovalGeneration() {
  return approvalGeneration;
}

function takePending(rid) {
  const entry = pendingApprovals.get(rid);
  if (!entry) return null;
  pendingApprovals.delete(rid);
  if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
  return entry;
}

async function closePendingWindow(entry) {
  if (entry?.windowId === undefined) return;
  await windowsRemove(entry.windowId).catch(() => {});
}

async function rejectPending(rid, error) {
  const entry = takePending(rid);
  if (!entry) return false;
  entry.reject(error);
  await closePendingWindow(entry);
  return true;
}

function isExpired(entry) {
  return Date.now() - entry.createdAt >= APPROVAL_TTL_MS;
}

export async function rejectAllPendingApprovals() {
  approvalGeneration += 1;
  const error = rpcError(
    ERROR_CODES.UNAUTHORIZED,
    "Wallet locked; pending approval cancelled"
  );
  await Promise.all(
    [...pendingApprovals.keys()].map((rid) => rejectPending(rid, error))
  );
}

/**
 * Open a small notification window and wait for the user's decision.
 */
export function requestUserApproval(
  kind,
  origin,
  params,
  expectedGeneration = approvalGeneration
) {
  if (expectedGeneration !== approvalGeneration) {
    return Promise.reject(
      rpcError(
        ERROR_CODES.UNAUTHORIZED,
        "Wallet locked; approval request cancelled"
      )
    );
  }

  const rid = crypto.randomUUID();

  const promise = new Promise((resolve, reject) => {
    const entry = {
      kind,
      origin,
      params,
      createdAt: Date.now(),
      expiryTimer: undefined,
      resolve,
      reject,
    };
    entry.expiryTimer = setTimeout(() => {
      void rejectPending(
        rid,
        rpcError(ERROR_CODES.USER_REJECTED, "Approval request expired")
      );
    }, APPROVAL_TTL_MS);
    entry.expiryTimer?.unref?.();
    pendingApprovals.set(rid, entry);
  });

  const url = runtimeGetURL(
    `notification.html?rid=${encodeURIComponent(rid)}`
  );

  // Best effort: open a popup-style window.
  void windowsCreate({
    url,
    type: "popup",
    width: 380,
    height: 620,
  })
    .then(async (win) => {
      // If the user closes the approval window, reject the pending request.
      const entry = pendingApprovals.get(rid);
      if (entry && win?.id !== undefined) {
        entry.windowId = win.id;
      } else if (!entry && win?.id !== undefined) {
        await windowsRemove(win.id).catch(() => {});
      }
    })
    .catch((error) => rejectPending(rid, error));

  return promise;
}

const ext = getExtensionApi();

ext?.windows?.onRemoved?.addListener((windowId) => {
  for (const [rid, entry] of pendingApprovals.entries()) {
    if (entry.windowId === windowId) {
      takePending(rid)?.reject(
        rpcError(ERROR_CODES.USER_REJECTED, "User closed the approval window")
      );
    }
  }
});

export function getPending(rid) {
  const entry = pendingApprovals.get(rid);
  if (!entry) return null;
  if (isExpired(entry)) {
    void rejectPending(
      rid,
      rpcError(ERROR_CODES.USER_REJECTED, "Approval request expired")
    );
    return null;
  }
  return entry;
}

export function resolvePendingDecision(message) {
  const { rid, decision } = message || {};
  const current = pendingApprovals.get(rid);
  if (current && isExpired(current)) {
    void rejectPending(
      rid,
      rpcError(ERROR_CODES.USER_REJECTED, "Approval request expired")
    );
    return { ok: false, error: "Request expired" };
  }
  const entry = takePending(rid);
  if (!entry) {
    return { ok: false, error: "Unknown request" };
  }

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
