import { ERROR_CODES, rpcError } from "../shared/errors.js";
import { noteSiteRequest } from "../shared/siteRecords.js";
import { activeWalletId } from "../shared/wallets.js";
import {
  getExtensionApi,
  runtimeGetURL,
  storageSessionGet,
  storageSessionSet,
  tabsCreate,
  tabsGet,
  tabsSendMessage,
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

// Its window or its tab goes; a tab's site comes back to the front, only
// when that tab is the one in front: not over the page or the other
// approval the person went to meanwhile.
function closeShown(entry) {
  if (entry.windowId !== undefined) windowsRemove(entry.windowId).catch(() => {});
  if (entry.tabId === undefined) return;
  const { tabId, backTo } = entry;
  tabsGet(tabId)
    .catch(() => null)
    .then((tab) => {
      tabsRemove(tabId).catch(() => {});
      if (backTo !== undefined && tab?.active) tabsUpdate(backTo, { active: true }).catch(() => {});
    });
}

// --- Kept through a stop --------------------------------------------------
// Firefox for Android stops the background a while after Firefox leaves the
// screen (a call, another app), and with it what it held of a request waiting
// for its approval: the site's answer and the approval's Approve. So each
// waiting request is kept in session storage too, by the site's own request
// (`key`: its tab, frame and ID). The site's content script asks again once
// the background is back (`resume`), and the request takes up the approval
// still open, the same one: its params unchanged, its time left. A request
// that can't be taken up says so, to the site and on its approval.

const KEPT_KEY = "dusk_pending_approvals_v1";
let keptWrites = Promise.resolve();

/** What a site hears when the wallet stopped before it answered, and nothing can take it up. */
const LOST_TEXT = "The wallet stopped before it answered, as Firefox stops it in the background. Check its Activity before you try again.";

async function keptAll() {
  try {
    const all = (await storageSessionGet(KEPT_KEY))?.[KEPT_KEY];
    return all && typeof all === "object" ? all : {};
  } catch {
    return {};
  }
}

// One change at a time, in the order asked.
function changeKept(change) {
  keptWrites = keptWrites
    .then(async () => {
      const all = await keptAll();
      change(all);
      await storageSessionSet({ [KEPT_KEY]: all });
    })
    .catch(() => {});
  return keptWrites;
}

const keep = (rid, entry) =>
  changeKept((all) => {
    const { key, origin, kind, params, createdAt, windowId, tabId, backTo } = entry;
    all[rid] = { rid, key, origin, kind, params, createdAt, windowId, tabId, backTo };
  });
const forget = (rid) =>
  changeKept((all) => {
    delete all[rid];
  });

// A kept request still in its time, by its approval's ID, or by the site's request.
const fresh = (record) => record && Date.now() - Number(record.createdAt) < APPROVAL_TTL_MS;

/**
 * A request kept while it waits, still in its time: its approval's window
 * and what it asked. Null for none.
 * @param {string} rid
 */
export async function keptApproval(rid) {
  await keptWrites;
  const record = (await keptAll())[String(rid ?? "")];
  return fresh(record) ? record : null;
}

/**
 * Asked again after a stop, the site's request `key` goes on only when its
 * approval still waits, kept through it. Else this throws what its site
 * hears: closed meanwhile, or nothing kept, as it may have gone already.
 * @param {string} key
 */
export async function checkResume(key) {
  await keptWrites;
  const record = Object.values(await keptAll()).find((r) => r.key === key && fresh(r));
  if (!record) throw rpcError(4900, LOST_TEXT);
  if (record.closed) {
    forget(record.rid);
    throw rpcError(ERROR_CODES.USER_REJECTED, "User closed the approval window");
  }
}

/** The site's request, by its tab, frame and ID: what a request asked again is matched by. */
export const requestKey = (tabId, frameId, id) => `${tabId ?? ""}:${frameId ?? 0}:${id}`;

/**
 * Back after a stop, tells each site whose request still waits for its
 * approval (or the one of `rid`) to ask again: its tab, behind the approval,
 * runs no timer on Firefox for Android, so it wouldn't by itself.
 * @param {string} [rid]
 */
export async function askKeptAgain(rid) {
  await keptWrites;
  for (const record of Object.values(await keptAll())) {
    if ((rid && record.rid !== rid) || !fresh(record) || record.closed || pendingApprovals.has(record.rid)) continue;
    const [, tabId, frameId, id] = /^(\d+):(\d+):(.+)$/s.exec(String(record.key ?? "")) ?? [];
    if (tabId) tabsSendMessage(Number(tabId), { type: "DUSK_ASK_AGAIN", id }, { frameId: Number(frameId) }).catch(() => {});
  }
}

// Its approval closed while the background was stopped: nothing answers it.
const closedKept = (match) =>
  changeKept((all) => {
    for (const record of Object.values(all)) if (match(record) && !pendingApprovals.has(record.rid)) record.closed = true;
  });

// The same request, asked again: what its approval shows is what it asks now.
const sameAsked = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// `code`: the person's refusal, or a wallet that couldn't ask at all (INTERNAL).
function rejectPending(rid, entry, message, answer = "cancelled", code = ERROR_CODES.USER_REJECTED) {
  if (!entry) return;
  pendingApprovals.delete(rid);
  forget(rid);
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
export async function requestUserApproval(kind, origin, params, shown = { walletId: "" }, { beforeApprove, key = "", resume = false } = {}) {
  if (
    pendingApprovals.size >= MAX_PENDING ||
    [...pendingApprovals.values()].some((entry) => entry.origin === origin)
  ) {
    throw rpcError(ERROR_CODES.USER_REJECTED, "Another approval is already pending");
  }

  // Waiting, with its time left; kept for a stop of the background.
  const wait = (rid, entry) =>
    new Promise((resolve, reject) => {
      Object.assign(entry, { resolve, reject });
      entry.timer = setTimeout(
        () => rejectPending(rid, entry, "Approval request expired", "expired"),
        Math.max(0, entry.createdAt + APPROVAL_TTL_MS - Date.now())
      );
      pendingApprovals.set(rid, entry);
      keep(rid, entry);
    });

  // Asked again after a stop: the approval still open takes it up, when it
  // shows what's asked now. Else that one goes, and a new one asks.
  if (resume && key) {
    await keptWrites;
    const kept = Object.values(await keptAll()).find((r) => r.key === key && r.origin === origin && r.kind === kind && fresh(r) && !r.closed);
    if (kept && !pendingApprovals.has(kept.rid)) {
      if (sameAsked(kept.params, params)) {
        const { rid, createdAt, windowId, tabId, backTo } = kept;
        return wait(rid, { kind, origin, params, shown, beforeApprove, key, createdAt, windowId, tabId, backTo });
      }
      forget(kept.rid);
      closeShown(kept);
    }
  }

  const rid = crypto.randomUUID();
  const promise = wait(rid, { kind, origin, params, shown, beforeApprove, key, createdAt: Date.now() });

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
    keep(rid, entry);
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
  closedKept((record) => record.windowId === windowId);
});

ext?.tabs?.onRemoved?.addListener?.((tabId) => {
  for (const [rid, entry] of pendingApprovals.entries()) {
    if (entry.tabId === tabId) {
      // Gone already: only the site's tab comes back.
      entry.tabId = undefined;
      rejectPending(rid, entry, "User closed the approval window", "closed");
    }
  }
  closedKept((record) => record.tabId === tabId);
});

// Back on an approval before any press goes to Firefox for Android's home,
// not back a page; then at its site's tab again, the request is cancelled,
// as the approval's own Back does (notification/app.js). Approvals in a tab
// only: a window's site tab may come to the front with the window open.
ext?.tabs?.onActivated?.addListener?.(({ tabId } = {}) => {
  for (const [rid, entry] of pendingApprovals.entries()) {
    if (entry.tabId !== undefined && entry.backTo === tabId) rejectPending(rid, entry, "User rejected the request");
  }
  changeKept((all) => {
    for (const record of Object.values(all)) {
      if (record.tabId === undefined || record.backTo !== tabId || record.closed || pendingApprovals.has(record.rid)) continue;
      record.closed = true;
      closeShown(record);
    }
  });
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
  // Answered: a stop after this takes nothing up again, whatever came of it.
  forget(rid);
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
