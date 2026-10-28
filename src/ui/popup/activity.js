// Activity's data in the popup: the selected account's history, synced with
// the archive node by block height (activityHistory.js), its counterparties'
// verified .dusk names, and this wallet's own transactions, merged into the
// rows Recent activity and the History view show.
//
// The kept history paints at once. One sync run follows when the popup opens
// and one after a transaction of this wallet goes through; nothing polls.
//
// What an account's activity keeps is tied to the store's epoch when the
// popup first saw it: after a wallet reset since, nothing more is kept. A
// lock drops it.

import {
  fillActivityDetails,
  needsDetails,
  noteActivityUnavailable,
  readActivity,
  syncActivity,
} from "../../shared/activityHistory.js";
import { mergeActivity } from "../../shared/activityMerge.js";
import { arrivalOf } from "../../shared/bridgeArrival.js";
import {
  StaleActivityError,
  getActivityEpoch,
  getCounterpartyNames,
  putCounterpartyNames,
} from "../../shared/activityStore.js";
import { classifyDuskIdentifier } from "../../shared/duskIdentifiers.js";
import { lookupRecipientNames } from "../../shared/duskNames.js";
import { VERIFIED_NAME_TTL_MS, duskNamesNetwork } from "../../shared/verifiedNames.js";

/** Rows read for the History view at first, and how many more Show more adds. */
export const ACTIVITY_PAGE = 50;
// Routes that show Activity: a sync step redraws only these.
const ROUTES = new Set(["home", "activity", "tx"]);
// The wait after a transaction went through before the archive is asked for it.
const AFTER_TX_MS = 10_000;

function selected(ov) {
  const raw = Number(ov?.selectedAccountIndex ?? 0);
  const profileIndex = Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
  const account = String(ov?.accounts?.[profileIndex] ?? "").trim();
  return { account, profileIndex };
}

/** One activity per node, archiver and account: a change of any starts over. */
export const activityKey = (ov) => {
  const { account } = selected(ov);
  return ov?.isUnlocked && account && ov?.nodeUrl ? `${ov.nodeUrl}\n${ov.archiverUrl ?? ""}\n${account}` : "";
};

let redrawTimer = null;
function redraw(state, render) {
  if (!ROUTES.has(state.route) || redrawTimer) return;
  // Steps land close together: one redraw for those of the same moment.
  redrawTimer = setTimeout(() => {
    redrawTimer = null;
    if (ROUTES.has(state.route)) render?.().catch?.(() => {});
  }, 50);
}

async function reload(a) {
  const { entries, meta, coveredTo, complete } = await readActivity({
    nodeUrl: a.nodeUrl,
    account: a.account,
    limit: a.limit,
  });
  a.entries = entries;
  a.meta = meta;
  a.coveredTo = coveredTo;
  a.complete = complete;
  a.loaded = true;
}

// Names kept from a check in the last ten minutes, as sites get them.
async function keptNames(a) {
  const network = duskNamesNetwork(a.nodeUrl);
  const accounts = counterparties(a);
  if (!network || !accounts.length) return;
  const now = Date.now();
  for (const [account, { name, at }] of await getCounterpartyNames(network, accounts)) {
    if (now - at >= 0 && now - at < VERIFIED_NAME_TTL_MS && !a.names.has(account)) a.names.set(account, name);
  }
}

const counterparties = (a) => [
  ...new Set(
    a.entries
      .slice(0, a.limit)
      .map((e) => e.counterparty)
      .filter((c) => c && c !== a.account && classifyDuskIdentifier(c) === "account")
  ),
];

// The shown counterparties' names, checked again: one Multicall query for up to 32.
async function checkNames(a) {
  const network = duskNamesNetwork(a.nodeUrl);
  const due = counterparties(a).filter((c) => !a.checked.has(c));
  if (!network || !due.length) return false;
  for (const c of due) a.checked.add(c);
  const names = await lookupRecipientNames(due, { nodeUrl: a.nodeUrl });
  for (const c of due) {
    if (names.has(c)) a.names.set(c, names.get(c));
    else a.names.delete(c);
  }
  const epoch = await a.epoch;
  if (epoch !== undefined) await putCounterpartyNames(network, names, { epoch }).catch(() => {});
  return names.size > 0;
}

/** How long a view waits to ask again for a shielded history the wallet couldn't give yet. */
export const SHIELDED_RETRY_MS = 60_000;

// The profile's shielded history, from the engine, once Moonlight's is shown:
// worked out once from the notes the shielded sync keeps, then kept. One the
// wallet couldn't give yet, or gave no usable answer for, is asked for again:
// by the next popup, or by a long-lived view once its notes are synced, or a
// minute later, by a timer that goes with this activity.
async function loadShielded(a, state, render) {
  if (a.shieldedAsked || !a.send) return;
  a.shieldedAsked = true;
  clearTimeout(a.shieldedTimer);
  const again = () => {
    a.shieldedAsked = false;
    a.shieldedRetryAt = Date.now() + SHIELDED_RETRY_MS;
    clearTimeout(a.shieldedTimer);
    a.shieldedTimer = setTimeout(() => {
      if (state.activity === a) loadShielded(a, state, render).catch(() => {});
    }, SHIELDED_RETRY_MS);
  };
  try {
    const res = await a.send({ type: "DUSK_UI_GET_SHIELDED_HISTORY" });
    // Another account's activity now: nothing more for this one.
    if (state.activity !== a) return;
    const result = res?.result;
    // An error, or an answer that isn't this profile's history: asked again later.
    if (res?.error || !Array.isArray(result?.entries) || result.profileIndex !== a.profileIndex) {
      again();
      return;
    }
    a.shielded = result.entries;
    if (result.pending) again();
    if (result.entries.length) redraw(state, render);
  } catch {
    if (state.activity === a) again();
  }
}

// Drops the popup's activity, and the shielded retry that goes with it.
function dropActivity(state) {
  clearTimeout(state.activity?.shieldedTimer);
  state.activity = null;
}

// A render of the same account: its shielded history asked for again once
// the notes finished syncing, or a minute after the wallet couldn't give it.
function retryShielded(a, ov, state, render) {
  const synced = ov?.shieldedSync?.state === "done";
  const justSynced = synced && a.shieldedSync !== "done";
  a.shieldedSync = ov?.shieldedSync?.state;
  if (a.shieldedAsked || !a.loaded || a.syncing || !synced) return;
  if (justSynced || Date.now() >= (a.shieldedRetryAt ?? 0)) loadShielded(a, state, render).catch(() => {});
}

async function run(a, state, render) {
  // The wallet was reset since this popup first saw the account.
  if (a.stale) return;
  if (a.syncing) {
    a.again = true;
    return;
  }
  a.syncing = true;
  try {
    const epoch = await a.epoch;
    if (epoch === undefined) throw new Error("The activity store is out of reach");
    await syncActivity({
      nodeUrl: a.nodeUrl,
      archiverUrl: a.archiverUrl,
      account: a.account,
      epoch,
      onStep: () => {
        if (state.activity !== a) return;
        reload(a)
          .then(() => redraw(state, render))
          .catch(() => {});
      },
    });
    a.error = null;
  } catch (error) {
    if (error instanceof StaleActivityError) a.stale = true;
    else {
      a.error = error?.message ?? String(error);
      noteActivityUnavailable(error);
    }
  } finally {
    a.syncing = false;
  }
  // Another wallet's now: nothing more for this one.
  if (state.activity !== a || a.stale) return;
  await reload(a).catch(() => {});
  redraw(state, render);
  if (await checkNames(a).catch(() => false)) redraw(state, render);
  loadShielded(a, state, render).catch(() => {});
  if (a.again) {
    a.again = false;
    return run(a, state, render);
  }
}

/**
 * Activity for the overview's account: kept history from this device, then
 * one sync run per popup and account. Call on every render; it starts work
 * only for an account it hasn't seen.
 *
 * @param {object} ov - the overview
 * @param {{ state: object, render: () => Promise<void>, send?: (message: object) => Promise<any> }} ctx
 *   `send` reaches the wallet, for the shielded history
 */
export function ensureActivity(ov, { state, render, send }) {
  const key = activityKey(ov);
  // Locked: what the last account's work brings back is dropped.
  if (ov?.isUnlocked === false) dropActivity(state);
  if (!key) return;
  if (state.activity?.key === key) {
    retryShielded(state.activity, ov, state, render);
    return;
  }
  dropActivity(state);
  const { account, profileIndex } = selected(ov);
  const a = {
    key,
    account,
    profileIndex,
    nodeUrl: String(ov.nodeUrl),
    archiverUrl: String(ov.archiverUrl ?? ""),
    entries: [],
    meta: null,
    loaded: false,
    complete: false,
    limit: ACTIVITY_PAGE,
    names: new Map(),
    checked: new Set(),
    shielded: [],
    shieldedSync: ov?.shieldedSync?.state,
    send,
    syncing: false,
    error: null,
    // The store's epoch now; undefined when it can't be read.
    epoch: getActivityEpoch().catch(() => undefined),
  };
  state.activity = a;
  (async () => {
    try {
      await reload(a);
      await keptNames(a);
    } catch {
      // No store here: the archive's answer comes after the sync.
    }
    if (state.activity !== a) return;
    redraw(state, render);
    await run(a, state, render);
  })().catch(() => {});
}

/**
 * One more sync run, after a transaction of this wallet went through: the
 * archive has it once its block is final.
 * @param {{ state: object, render: () => Promise<void> }} ctx
 */
export function refreshActivitySoon({ state, render }, delayMs = AFTER_TX_MS) {
  const a = state.activity;
  if (!a) return;
  clearTimeout(a.refreshTimer);
  a.refreshTimer = setTimeout(() => {
    if (state.activity === a) run(a, state, render).catch(() => {});
  }, delayMs);
}

/**
 * Show more: the next page of kept history, and a sync run for older history
 * when the kept history runs out.
 * @param {{ state: object, render: () => Promise<void> }} ctx
 */
export async function showMoreActivity({ state, render }) {
  const a = state.activity;
  if (!a) return;
  a.limit += ACTIVITY_PAGE;
  await reload(a).catch(() => {});
  redraw(state, render);
  const missing = a.entries.filter((e) => needsDetails(e, a.nodeUrl));
  const epoch = await a.epoch;
  if (missing.length && epoch !== undefined) {
    await fillActivityDetails({ nodeUrl: a.nodeUrl, archiverUrl: a.archiverUrl, account: a.account, entries: missing, epoch }).catch(
      () => {}
    );
    await reload(a).catch(() => {});
    redraw(state, render);
  }
  if (await checkNames(a).catch(() => false)) redraw(state, render);
  if (!a.complete && a.entries.length < a.limit) await run(a, state, render);
}

/** How long a detail lookup that brought nothing waits before it is asked again. */
export const DETAIL_RETRY_MS = 60_000;
// By activity and hash: "loading", or when a lookup that brought nothing
// ended (the archive's index can lag the block, or the request fail).
const detailLoads = new Map();

/**
 * The time, outcome and fee of one synced entry, for its details view, when
 * no sync looked them up yet, and a deposit to DuskEVM's address there: one
 * request at a time, again a minute after one that brought nothing.
 * @param {{ state: object, render: () => Promise<void> }} ctx
 * @param {string} hash
 */
export function loadActivityDetail({ state, render }, hash) {
  const a = state?.activity;
  const entry = a?.entries.find((e) => e.hash === hash);
  const key = `${a?.key}\n${hash}`;
  const last = detailLoads.get(key);
  if (!entry || !needsDetails(entry, a.nodeUrl) || last === "loading" || (typeof last === "number" && Date.now() - last < DETAIL_RETRY_MS)) return;
  detailLoads.set(key, "loading");
  a.epoch
    .then((epoch) => {
      if (epoch === undefined) throw new Error("The activity store is out of reach");
      return fillActivityDetails({ nodeUrl: a.nodeUrl, archiverUrl: a.archiverUrl, account: a.account, entries: [entry], epoch });
    })
    .then(() => reload(a))
    .then(() => redraw(state, render))
    .catch(() => {})
    .finally(() => {
      const now = a.entries.find((e) => e.hash === hash);
      if (now && !needsDetails(now, a.nodeUrl)) detailLoads.delete(key);
      else detailLoads.set(key, Date.now());
    });
}

/** Whether Show more has more to show: kept rows beyond the page, or older history to sync. */
export function hasMoreActivity(state) {
  const a = state?.activity;
  return Boolean(a?.loaded && (!a.complete || a.entries.length >= a.limit));
}

/**
 * The rows Recent activity and the History view show: this wallet's own
 * transactions on the overview's network with the account's history.
 * @param {object} ov
 * @param {object} state
 * @returns {object[]}
 */
export function activityRows(ov, state) {
  const local = Array.isArray(ov?.txs) ? ov.txs : [];
  const key = activityKey(ov);
  const a = state?.activity;
  const ours = a && key && a.key === key ? a : null;
  const { profileIndex } = selected(ov);
  const meta = ours?.meta;
  const rows = mergeActivity({
    local,
    history: ours?.entries ?? [],
    shielded: ours?.shielded ?? [],
    // The selected profile's activity; every profile's while locked.
    profileIndex: key ? profileIndex : undefined,
    nodeUrl: ov?.nodeUrl,
    names: ours?.names,
    // Blocks come about every 10 seconds.
    estimateTime: meta?.headAt
      ? (height) => meta.headAt - Math.max(0, Number(meta.finalized) - height) * 10_000
      : undefined,
  });
  // A deposit to DuskEVM that arrived there, with its transaction there (bridgeArrival.js).
  return rows.map((row) => {
    const arrival = arrivalOf(row?.hash);
    return arrival ? { ...row, arrival } : row;
  });
}
