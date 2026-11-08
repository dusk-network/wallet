import { ERROR_CODES, rpcError } from "../shared/errors.js";
import { noteSiteRequest } from "../shared/siteRecords.js";
import { activeWalletId } from "../shared/wallets.js";
import {
  getExtensionApi,
  runtimeGetURL,
  tabsCreate,
  tabsQuery,
  tabsRemove,
  tabsUpdate,
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
 * Its window (`windowId`), or where windows can't be made its tab (`tabId`),
 * with the tab the person was on (`backTo`), which comes back once it's done.
 *
 * @type {Map<string, { kind: string, origin: string, params: any, shown: { walletId: string }, createdAt:number, windowId?: number, tabId?: number, backTo?: number, resolve: (v:any)=>void, reject:(e:any)=>void }>}
 */
export const pendingApprovals = new Map();

const MAX_PENDING = 20;
const APPROVAL_TTL_MS = 5 * 60_000;

// How a request ended, for its site's record: for the wallet it was for, or, asked
// while locked and never shown, the one the next unlock opens. Never in the way
// of the answer.
function keepAnswer(entry, answer) {
  const walletId = entry.shown?.walletId || activeWalletId().catch(() => "");
  noteSiteRequest(walletId, entry.origin, { kind: entry.kind, params: entry.params, answer }).catch(() => {});
}

// Its window or its tab goes; a tab's site comes back to the front.
function closeShown(entry) {
  if (entry.windowId !== undefined) windowsRemove(entry.windowId).catch(() => {});
  if (entry.tabId !== undefined) {
    tabsRemove(entry.tabId).catch(() => {});
    if (entry.backTo !== undefined) tabsUpdate(entry.backTo, { active: true }).catch(() => {});
  }
}

// `code`: the person's refusal, or a wallet that couldn't ask at all (INTERNAL).
function rejectPending(rid, entry, message, answer = "cancelled", code = ERROR_CODES.USER_REJECTED) {
  if (!entry) return;
  pendingApprovals.delete(rid);
  clearTimeout(entry.timer);
  closeShown(entry);
  keepAnswer(entry, answer);
  entry.reject(rpcError(code, message));
}

/** What a site hears when the wallet couldn't show its request: not a refusal. */
export const NOT_SHOWN_TEXT = "The wallet couldn't show this request. Nothing was approved.";

// A window of its own, the size of the popup; where windows can't be made
// (Firefox for Android has no windows), a tab, in front of the one the person
// was on. Null when neither opens.
async function showApproval(url) {
  if (getExtensionApi()?.windows) {
    try {
      const win = await windowsCreate({ url, type: "popup", width: 380, height: 620 });
      return { windowId: win?.id };
    } catch {
      // A tab, then.
    }
  }
  try {
    const [front] = (await tabsQuery({ active: true, currentWindow: true }).catch(() => [])) ?? [];
    const tab = await tabsCreate({ url, active: true });
    return { tabId: tab?.id, backTo: front?.id };
  } catch {
    return null;
  }
}

/**
 * Open a small notification window and wait for the user's decision.
 * @param {string} kind
 * @param {string} origin
 * @param {any} params
 * @param {{ walletId: string }} [shown] - the wallet the request is for, ""
 *   until its window shows one; kept by reference, so the caller sees it bound
 * @param {{ beforeApprove?: (answer: object) => Promise<unknown> }} [opts] - what
 *   an approval must pass first: thrown, the request goes on waiting, and its
 *   window says why
 */
export async function requestUserApproval(kind, origin, params, shown = { walletId: "" }, { beforeApprove } = {}) {
  if (
    pendingApprovals.size >= MAX_PENDING ||
    [...pendingApprovals.values()].some((entry) => entry.origin === origin)
  ) {
    throw rpcError(ERROR_CODES.USER_REJECTED, "Another approval is already pending");
  }

  const rid = crypto.randomUUID();
  const promise = new Promise((resolve, reject) => {
    const entry = { kind, origin, params, shown, beforeApprove, createdAt: Date.now(), resolve, reject };
    entry.timer = setTimeout(
      () => rejectPending(rid, entry, "Approval request expired", "expired"),
      APPROVAL_TTL_MS
    );
    pendingApprovals.set(rid, entry);
  });

  const url = runtimeGetURL(
    `notification.html?rid=${encodeURIComponent(rid)}`
  );

  const where = await showApproval(url);
  const entry = pendingApprovals.get(rid);
  if (!where) {
    // Never shown, so never refused: the site hears the wallet couldn't ask.
    rejectPending(rid, entry, NOT_SHOWN_TEXT, "not_shown", ERROR_CODES.INTERNAL);
  } else if (entry) {
    // Closed by the person, the request is rejected (onRemoved below).
    Object.assign(entry, Object.fromEntries(Object.entries(where).filter(([, id]) => id !== undefined)));
  } else {
    // Over while it opened: it goes.
    closeShown(where);
  }

  return promise;
}

const ext = getExtensionApi();

ext?.windows?.onRemoved?.addListener((windowId) => {
  for (const [rid, entry] of pendingApprovals.entries()) {
    if (entry.windowId === windowId) {
      rejectPending(rid, entry, "User closed the approval window", "closed");
    }
  }
});

ext?.tabs?.onRemoved?.addListener?.((tabId) => {
  for (const [rid, entry] of pendingApprovals.entries()) {
    if (entry.tabId === tabId) {
      // Gone already: only the site's tab comes back.
      entry.tabId = undefined;
      rejectPending(rid, entry, "User closed the approval window", "closed");
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

// An approval that must pass `beforeApprove` first: one at a time, and it stands
// only while the request is still waiting.
async function approveChecked(rid, entry, message) {
  if (entry.checking) return { ok: false, error: "Unknown request" };
  entry.checking = true;
  try {
    await entry.beforeApprove(message);
  } catch (error) {
    return { ok: false, error: { code: error?.code, message: error?.message ?? String(error), data: error?.data } };
  } finally {
    entry.checking = false;
  }
  if (pendingApprovals.get(rid) !== entry) return { ok: false, error: "Unknown request" };
  return decided(rid, entry, message);
}

export function resolvePendingDecision(message) {
  const { rid, decision } = message || {};
  const entry = pendingApprovals.get(rid);
  if (!entry) {
    return { ok: false, error: "Unknown request" };
  }
  if (decision === "approve" && entry.beforeApprove) return approveChecked(rid, entry, message);
  return decided(rid, entry, message);
}

function decided(rid, entry, message) {
  const { decision } = message;
  pendingApprovals.delete(rid);
  clearTimeout(entry.timer);
  // A tab doesn't close itself as a window does.
  if (entry.tabId !== undefined) closeShown(entry);
  keepAnswer(entry, decision === "approve" ? "approved" : "rejected");

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
