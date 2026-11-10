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
  noteSiteRequest(walletId, entry.origin, { kind: entry.kind, params: entry.params, answer, asked: entry.asked }).catch(() => {});
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
// (`key`: its tab, frame and ID), with what it was asked for (`context`: the
// wallet, profile, network and site). The site's content script asks again
// once the background is back (`resume`), and the request takes up the
// approval still open, the same one: its params and context unchanged, its
// time left. An answer, or any end, is kept as final (`ended`), and a site
// asking again hears it; an approval is kept so before anything is signed or
// sent, or nothing is.

const KEPT_KEY = "dusk_pending_approvals_v1";
let keptWrites = Promise.resolve();

/** What a site hears when the wallet stopped before it answered, and nothing can take it up. */
const LOST_TEXT = "The wallet stopped before it answered, as Firefox stops it in the background. Check its Activity before you try again.";

/** What an approval says, and its site hears, when the wallet couldn't keep it as answered: nothing goes. */
export const NOT_NOTED_TEXT = "The wallet couldn't note your approval, so nothing was signed or sent. Ask the site again.";

const REJECTED = { code: ERROR_CODES.USER_REJECTED, message: "User rejected the request" };
const CLOSED = { code: ERROR_CODES.USER_REJECTED, message: "User closed the approval window" };

async function readKept() {
  const all = (await storageSessionGet(KEPT_KEY))?.[KEPT_KEY];
  return all && typeof all === "object" ? all : {};
}

async function keptAll() {
  try {
    return await readKept();
  } catch {
    return {};
  }
}

// A kept request still in its time.
const fresh = (record) => Boolean(record) && Date.now() - Number(record.createdAt) < APPROVAL_TTL_MS;

// One change at a time, in the order asked, each whole: `change` sees what's
// kept and what waits here (pendingApprovals) at once. What it returns comes
// back once written; a failed read or write rejects, never writes a guess.
function changeKept(change) {
  const done = keptWrites.then(async () => {
    const all = await readKept();
    for (const [rid, record] of Object.entries(all)) {
      if (!(Date.now() - Number(record?.createdAt) < 2 * APPROVAL_TTL_MS)) delete all[rid];
    }
    const result = change(all);
    await storageSessionSet({ [KEPT_KEY]: all });
    return result;
  });
  keptWrites = done.catch(() => {});
  return done;
}

// What's kept of a request: never its answer.
function recordOf(rid, entry) {
  const { key, origin, kind, params, context, createdAt, windowId, tabId, backTo, asked } = entry;
  return { rid, key, origin, kind, params, context, walletId: entry.shown?.walletId ?? "", createdAt, windowId, tabId, backTo, asked };
}

// Only a site's request (`key`) is asked again.
function keep(rid, entry) {
  if (!entry.key) return;
  changeKept((all) => {
    if (!all[rid]?.ended) all[rid] = recordOf(rid, entry);
  }).catch(() => {});
}

const endKept = (rid, entry, ended) =>
  entry.key
    ? changeKept((all) => {
        all[rid] = { ...(all[rid] ?? recordOf(rid, entry)), ended };
      })
    : Promise.resolve();

// Being taken up after a stop, its write not done: what ends it meanwhile
// (closed, cancelled) is kept here, and ends it then instead.
const resuming = new Map();

// Ended while the background was stopped (closed, cancelled, the wallet
// changed): its approval goes, and its site hears why as it asks again.
function endKeptWhere(match, ended) {
  for (const taking of resuming.values()) if (!taking.ended && match(taking.record)) taking.ended = ended;
  return changeKept((all) => {
    for (const record of Object.values(all)) {
      if (record.ended || pendingApprovals.has(record.rid) || !match(record)) continue;
      record.ended = ended;
      closeShown(record);
    }
  }).catch(() => {});
}

/**
 * A request kept while it waits, still in its time: its approval's window
 * and what it asked. Null for none, or one over.
 * @param {string} rid
 */
export async function keptApproval(rid) {
  await keptWrites;
  const record = (await keptAll())[String(rid ?? "")];
  return fresh(record) && !record.ended ? record : null;
}

/**
 * Asked again after a stop, the site's request `key` goes on only when its
 * approval still waits, kept through it. Else this throws what its site
 * hears: how it ended, or, nothing kept, that it may have gone already.
 * @param {string} key
 */
export async function checkResume(key) {
  await keptWrites;
  const record = Object.values(await keptAll()).find((r) => r.key === key && fresh(r));
  if (!record) throw rpcError(4900, LOST_TEXT);
  if (record.ended) throw rpcError(record.ended.code, record.ended.message);
}

/**
 * An answer to an approval whose request is kept through a stop and not
 * asked again yet: a refusal (or `abandon`, the window giving up on it) is
 * final at once, and its site hears it as it asks again; an approval waits
 * for that ("waking"). Null when none is kept so.
 * @param {string} rid
 * @param {string} decision
 */
export async function decideKept(rid, decision) {
  let found = null;
  await changeKept((all) => {
    const record = all[String(rid ?? "")];
    if (!fresh(record) || record.ended || pendingApprovals.has(record.rid)) return;
    found = record;
    if (decision !== "approve") record.ended = decision === "abandon" ? { code: 4900, message: LOST_TEXT } : REJECTED;
  }).catch(() => {});
  if (!found) return null;
  if (decision === "approve") {
    askKeptAgain(rid).catch(() => {});
    return { ok: false, error: { code: "waking", message: "The wallet is picking this request up again." } };
  }
  // Given up on, its window stays to say so.
  if (decision !== "abandon") closeShown(found);
  keepAnswer({ origin: found.origin, kind: found.kind, params: found.params, asked: found.asked, shown: { walletId: found.walletId } }, decision === "abandon" ? "cancelled" : "rejected");
  return { ok: true };
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
    if ((rid && record.rid !== rid) || !fresh(record) || record.ended || pendingApprovals.has(record.rid)) continue;
    const [, tabId, frameId, id] = /^(\d+):(\d+):(.+)$/s.exec(String(record.key ?? "")) ?? [];
    if (tabId) tabsSendMessage(Number(tabId), { type: "DUSK_ASK_AGAIN", id }, { frameId: Number(frameId) }).catch(() => {});
  }
}

// The same request, asked again: what its approval shows is what it asks now.
const sameAsked = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// `code`: the person's refusal, or a wallet that couldn't ask at all (INTERNAL).
function rejectPending(rid, entry, message, answer = "cancelled", code = ERROR_CODES.USER_REJECTED) {
  if (!entry) return;
  pendingApprovals.delete(rid);
  endKept(rid, entry, { code, message }).catch(() => {});
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
 * @param {{ beforeApprove?: (answer: object) => Promise<unknown>, key?: string, resume?: boolean, context?: object }} [opts]
 *   - `beforeApprove`: what an approval must pass first: thrown, the request
 *   goes on waiting, and its window says why; `key`, `resume`, `context`: the
 *   site's request, asked again after a stop, and what it's asked for (above)
 */
export async function requestUserApproval(kind, origin, params, shown = { walletId: "" }, { beforeApprove, key = "", resume = false, context = null } = {}) {
  if (
    pendingApprovals.size >= MAX_PENDING ||
    [...pendingApprovals.values()].some((entry) => entry.origin === origin)
  ) {
    throw rpcError(ERROR_CODES.USER_REJECTED, "Another approval is already pending");
  }

  // Waiting, with its time left.
  const wait = (rid, entry) =>
    new Promise((resolve, reject) => {
      Object.assign(entry, { resolve, reject });
      entry.timer = setTimeout(
        () => rejectPending(rid, entry, "Approval request expired", "expired"),
        Math.max(0, entry.createdAt + APPROVAL_TTL_MS - Date.now())
      );
      pendingApprovals.set(rid, entry);
    });

  // Asked again after a stop: the approval still open takes it up, when it
  // shows what's asked now, for the same wallet, profile, network and site.
  // Changed params ask anew; anything else changed ends it.
  if (resume && key) {
    let taken = null;
    let ended = null;
    let stale = null;
    let taking = null;
    try {
      await changeKept((all) => {
        const kept = Object.values(all).find((r) => r.key === key && fresh(r));
        if (!kept) ended = { code: 4900, message: LOST_TEXT };
        else if (kept.ended) ended = kept.ended;
        else if (pendingApprovals.has(kept.rid)) ended = { code: ERROR_CODES.USER_REJECTED, message: "Another approval is already pending" };
        else if (kept.origin !== origin || kept.kind !== kind || !sameAsked(kept.context, context)) {
          ended = kept.ended = { code: ERROR_CODES.UNAUTHORIZED, message: "Wallet changed while awaiting approval" };
          closeShown(kept);
        } else if (!sameAsked(kept.params, params)) {
          delete all[kept.rid];
          stale = kept;
        } else {
          taken = kept;
          resuming.set(kept.rid, (taking = { record: kept, ended: null }));
        }
      });
    } finally {
      if (taking) resuming.delete(taken.rid);
    }
    if (taking?.ended) ended = taking.ended;
    if (ended) throw rpcError(ended.code, ended.message);
    // Waiting here only once that's written: a failed write leaves nothing to answer.
    if (taken && !pendingApprovals.has(taken.rid)) {
      const { rid, createdAt, windowId, tabId, backTo, asked } = taken;
      return wait(rid, { kind, origin, params, shown, beforeApprove, key, context, createdAt, windowId, tabId, backTo, asked });
    }
    if (taken) throw rpcError(ERROR_CODES.USER_REJECTED, "Another approval is already pending");
    if (stale) closeShown(stale);
  }

  const rid = crypto.randomUUID();
  const promise = wait(rid, { kind, origin, params, shown, beforeApprove, key, context, createdAt: Date.now() });
  keep(rid, pendingApprovals.get(rid));

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
  endKeptWhere((record) => record.windowId === windowId, CLOSED);
});

ext?.tabs?.onRemoved?.addListener?.((tabId) => {
  for (const [rid, entry] of pendingApprovals.entries()) {
    if (entry.tabId === tabId) {
      // Gone already: only the site's tab comes back.
      entry.tabId = undefined;
      rejectPending(rid, entry, "User closed the approval window", "closed");
    }
  }
  endKeptWhere((record) => record.tabId === tabId, CLOSED);
});

// The words an approval leads with that its site's record keeps: those of a
// bridge's own calls, which a site names otherwise. Nothing that's in a request.
const ASKED_WORDS = /^(Bridge to [A-Za-z][\w .()-]{0,40}|Prove a DuskEVM withdrawal|Claim a DuskEVM withdrawal)$/;

/**
 * An approval drawn, by its window: the words it leads with, for its site's
 * record (`asked`), and for one in a tab (Firefox for Android), an entry in
 * the tab's history under it, put there by the wallet, which the phone's first
 * Back takes away (notification/app.js): Firefox skips one the page puts up
 * before it's pressed. Switching tabs leaves it waiting.
 * @param {{ rid?: string, asked?: string }} message
 * @param {{ tab?: { id?: number, url?: string }, url?: string }} sender
 * @returns {Promise<boolean>} whether it's waiting
 */
export async function approvalShown({ rid, asked } = {}, sender) {
  const id = String(rid ?? "");
  const entry = pendingApprovals.get(id);
  if (!entry) return false;
  if (typeof asked === "string" && ASKED_WORDS.test(asked) && entry.asked !== asked) {
    entry.asked = asked;
    keep(id, entry);
  }
  const tabId = sender?.tab?.id;
  if (tabId === undefined || entry.tabId !== tabId || entry.backEntry) return true;
  entry.backEntry = true;
  const url = String(sender?.url ?? sender?.tab?.url ?? "").split("#")[0];
  if (url) await tabsUpdate(tabId, { url: `${url}#back` }).catch(() => {});
  return true;
}

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
  if (!entry.shown.walletId) {
    entry.shown.walletId = id;
    // Asked while locked: the wallet it's for from now on, kept through a stop too.
    if (entry.context && !entry.context.walletId) entry.context = { ...entry.context, walletId: id };
    keep(rid, entry);
  }
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

async function decided(rid, entry, message) {
  const { decision } = message;
  const approve = decision === "approve";
  pendingApprovals.delete(rid);
  clearTimeout(entry.timer);
  // Answered for good before anything is signed or sent: a stop after this
  // takes nothing up again, whatever came of it. Not kept so, nothing goes.
  const noted = endKept(rid, entry, approve ? { code: 4900, message: LOST_TEXT } : REJECTED);
  if (approve) {
    try {
      await noted;
    } catch {
      // Its window stays, to say nothing went.
      keepAnswer(entry, "cancelled");
      entry.reject(rpcError(ERROR_CODES.INTERNAL, NOT_NOTED_TEXT));
      return { ok: false, error: { code: "ended", message: NOT_NOTED_TEXT } };
    }
  } else noted.catch(() => {});
  // A tab doesn't close itself as a window does.
  if (entry.tabId !== undefined) closeShown(entry);
  keepAnswer(entry, approve ? "approved" : "rejected");

  if (approve) {
    // Optionally accept user edited parameters (e.g. gas overrides).
    // If none were provided, resolve with null.
    entry.resolve(
      message && Object.prototype.hasOwnProperty.call(message, "approvedParams")
        ? message.approvedParams
        : null
    );
    return { ok: true };
  }

  entry.reject(rpcError(REJECTED.code, REJECTED.message));
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
  // And those kept through a stop, not asked again yet: never taken up after it.
  endKeptWhere(
    (record) => (!origin || record.origin === origin) && (!Array.isArray(wallets) || wallets.includes(String(record.walletId || open || ""))),
    { code: ERROR_CODES.USER_REJECTED, message: reason }
  );
}
