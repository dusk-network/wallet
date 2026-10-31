import { ERROR_CODES, rpcError } from "../shared/errors.js";
import {
  getExtensionApi,
  runtimeGetURL,
  windowsCreate,
  windowsRemove,
} from "../platform/extensionApi.js";

/**
 * Pending approval requests.
 *
 * NOTE: The resolve value can carry user overrides (e.g. edited gas settings)
 * so the background can apply them before sending the transaction.
 *
 * Each is for one wallet, by its wallet ID (its first public account), in
 * `shown`: the one unlocked as the site asked, or, asked while locked, the
 * one its window shows first (bindPendingWallet). Its window shows no other,
 * and what it approves acts for no other (rpc.js checks `shown` again).
 *
 * @type {Map<string, { kind: string, origin: string, params: any, shown: { walletId: string }, createdAt:number, windowId?: number, resolve: (v:any)=>void, reject:(e:any)=>void }>}
 */
export const pendingApprovals = new Map();

const MAX_PENDING = 20;
const APPROVAL_TTL_MS = 5 * 60_000;

function rejectPending(rid, entry, message) {
  if (!entry) return;
  pendingApprovals.delete(rid);
  clearTimeout(entry.timer);
  if (entry.windowId !== undefined) windowsRemove(entry.windowId).catch(() => {});
  entry.reject(rpcError(ERROR_CODES.USER_REJECTED, message));
}

/**
 * Open a small notification window and wait for the user's decision.
 * @param {string} kind
 * @param {string} origin
 * @param {any} params
 * @param {{ walletId: string }} [shown] - the wallet the request is for, ""
 *   until its window shows one; kept by reference, so the caller sees it bound
 */
export async function requestUserApproval(kind, origin, params, shown = { walletId: "" }) {
  if (
    pendingApprovals.size >= MAX_PENDING ||
    [...pendingApprovals.values()].some((entry) => entry.origin === origin)
  ) {
    throw rpcError(ERROR_CODES.USER_REJECTED, "Another approval is already pending");
  }

  const rid = crypto.randomUUID();
  const promise = new Promise((resolve, reject) => {
    const entry = { kind, origin, params, shown, createdAt: Date.now(), resolve, reject };
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
  } else if (!entry && win?.id !== undefined) {
    windowsRemove(win.id).catch(() => {});
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

/**
 * The wallet a request's window is about to show, by its wallet ID: the
 * request's own wallet, or the first one shown for a request made while
 * locked. Another wallet ends the request instead. False when it's over.
 * @param {string} rid
 * @param {string} walletId
 */
export function bindPendingWallet(rid, walletId) {
  const entry = pendingApprovals.get(rid);
  if (!entry) return false;
  const id = String(walletId ?? "");
  if (!id) return true;
  if (!entry.shown.walletId) entry.shown.walletId = id;
  if (entry.shown.walletId === id) return true;
  rejectPending(rid, entry, "Wallet changed while awaiting approval");
  return false;
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

/**
 * Ends the requests waiting for approval: every one, or `origin`'s. With
 * `wallets` (wallet IDs), only those for one of them: a request is for the
 * wallet its window shows (`shown`), and one not shown yet for `open`, the
 * wallet open now, which its window would show. Another wallet's stay.
 * @param {string|null} origin
 * @param {string} [reason]
 * @param {{ wallets?: string[], open?: string }} [opts]
 */
export function cancelPendingApprovals(origin, reason = "Wallet state changed", { wallets, open = "" } = {}) {
  for (const [rid, entry] of pendingApprovals) {
    if (origin && entry.origin !== origin) continue;
    if (Array.isArray(wallets) && !wallets.includes(String(entry.shown?.walletId || open || ""))) continue;
    rejectPending(rid, entry, reason);
  }
}
