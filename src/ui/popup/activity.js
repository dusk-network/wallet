// Activity's data in the popup: the selected account's history, synced with
// the archive node by block height (activityHistory.js), its counterparties'
// verified .dusk names, and this wallet's own transactions, merged into the
// rows Recent activity and the History view show
// (@dusk-network/app-core/activity).
//
// The kept history paints at once. One sync run follows when the popup opens
// and one after a transaction of this wallet goes through; nothing polls.
//
// What an account's activity keeps is tied to the store's epoch when the
// popup first saw it: after a wallet reset since, nothing more is kept. A
// lock drops it.

import { activityRows as rowsOf, settleSends } from "@dusk-network/app-core/activity";
import { StaleHistoryError } from "@dusk-network/app-core/history";
import { sozuFacts, sozuGrowth } from "@dusk-network/app-core/sozu";

import { activityHistory, archiveAt, historyArchiverUrl, noteActivityUnavailable } from "../../shared/activityHistory.js";
import { keptArrivals } from "../../shared/bridgeArrival.js";
import {
  StaleActivityError,
  getActivityEpoch,
  getCounterpartyNames,
  putCounterpartyNames,
} from "../../shared/activityStore.js";
import { safeBigInt } from "../../shared/amount.js";
import { classifyDuskIdentifier } from "../../shared/duskIdentifiers.js";
import { nameFactsFor } from "../../shared/knownCalls.js";
import { chainIdForNode, networkForNode } from "../../shared/nodeNetwork.js";
import { lookupRecipientNames } from "../../shared/duskNames.js";
import { forgetTxs, getTxEpoch, listTxs, patchTxMeta } from "../../shared/txStore.js";
import { VERIFIED_NAME_TTL_MS, duskNamesScope } from "../../shared/verifiedNames.js";
import { noteTxStatus, sentStatus } from "./views/sent.js";

/** Rows read for the History view at first, and how many more Show more adds. */
export const ACTIVITY_PAGE = 50;
// Routes that show Activity, and Receive for what came in for its requests: a sync step redraws only these.
// The views that show activity; and the Sent screen, which says what a stake with Sozu got once its row comes.
const ROUTES = new Set(["home", "activity", "tx", "receive", "sent"]);
// The wait after a transaction went through before the archive is asked for it.
const AFTER_TX_MS = 10_000;

/** The overview's selected profile: its index, and its public account. */
export function selected(ov) {
  const raw = Number(ov?.selectedAccountIndex ?? 0);
  const profileIndex = Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
  const account = String(ov?.accounts?.[profileIndex] ?? "").trim();
  return { account, profileIndex };
}

/**
 * One activity per node, archiver, account and the node's network as known:
 * a change of any starts over, so a custom node's chain learned later counts.
 */
export const activityKey = (ov) => {
  const { account } = selected(ov);
  return ov?.isUnlocked && account && ov?.nodeUrl
    ? `${ov.nodeUrl}\n${ov.archiverUrl ?? ""}\n${account}\n${chainIdForNode(String(ov.nodeUrl)) ?? ""}`
    : "";
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

/** What a whole read says when what's open in the wallet is no longer what it was read for. */
export class ActivityChangedError extends Error {
  constructor() {
    super("The wallet changed while this was read, so nothing was saved. Export again.");
    this.name = "ActivityChangedError";
  }
}

// Whether the wallet's answer is this activity's shielded history: the wallet answers
// for what's open in it now, whichever wallet, node and profile that is by then.
const shieldedOwn = (a, result) =>
  Array.isArray(result?.entries) && result.walletId === a.walletId && result.nodeUrl === a.nodeUrl && result.profileIndex === a.profileIndex;

async function reload(a) {
  const { entries, state, coveredTo, complete } = await a.history.read({ limit: a.limit });
  a.entries = entries;
  a.meta = state;
  a.coveredTo = coveredTo;
  a.complete = complete;
  a.loaded = true;
}

// What the wallet's own record of a send adds to the chain's row of it: the
// name typed for its recipient, a token's details, the site that asked for
// it, a shielded send's memo or recipient.
const keeps = (tx) =>
  Boolean(tx.toName || tx.asset || (tx.origin && tx.origin !== "Wallet") || (tx.privacy === "shielded" && (tx.memo || tx.to)));
// A send the wallet's watcher still writes to: settled once it's done.
const watched = (tx) => tx.status === "submitted" || tx.status === "mempool";

// Settles the profile's own sends the chain's histories have the outcome of
// (settleSends): those the chain's rows say all of are forgotten, the others
// kept for what they add. The Sent screen reads its send's result from the
// record where no watcher's event brought it (the desktop app's): it keeps
// that first.
async function settle(a, state) {
  const own = (await listTxs({ nodeUrl: a.nodeUrl, walletId: a.walletId })).filter(
    (tx) => !watched(tx) && (tx.profileIndex == null || Number(tx.profileIndex) === a.profileIndex)
  );
  const { drop, keep } = settleSends({ public: a.entries, shielded: a.shielded, pending: own, keeps });
  const epoch = await a.txEpoch;
  if (epoch === undefined) return;
  const shown = state?.sent?.hash && drop.includes(state.sent.hash) ? own.find((tx) => tx.hash === state.sent.hash) : null;
  if (shown) noteTxStatus(state.sent, shown);
  await forgetTxs(drop, { epoch });
  for (const { hash } of keep) await patchTxMeta(hash, { settled: true }, { epoch });
}

// Names kept from a check in the last ten minutes, as sites get them.
async function keptNames(a) {
  const scope = duskNamesScope(a.nodeUrl);
  const accounts = counterparties(a);
  if (!scope || !accounts.length) return;
  const now = Date.now();
  for (const [account, { name, at }] of await getCounterpartyNames(scope, accounts)) {
    if (now - at >= 0 && now - at < VERIFIED_NAME_TTL_MS && !a.names.has(account)) a.names.set(account, name);
  }
}

const counterparties = (a) => [
  ...new Set(a.entries.map((e) => e.counterparty).filter((c) => c && c !== a.account && classifyDuskIdentifier(c) === "account")),
];

// The shown counterparties' names, checked again: one Multicall query for up to 32.
async function checkNames(a) {
  const scope = duskNamesScope(a.nodeUrl);
  const due = counterparties(a).filter((c) => !a.checked.has(c));
  if (!scope || !due.length) return false;
  for (const c of due) a.checked.add(c);
  const names = await lookupRecipientNames(due, { nodeUrl: a.nodeUrl });
  for (const c of due) {
    if (names.has(c)) a.names.set(c, names.get(c));
    else a.names.delete(c);
  }
  const epoch = await a.epoch;
  if (epoch !== undefined) await putCounterpartyNames(scope, names, { epoch }).catch(() => {});
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
  a.shieldedReadAt = Date.now();
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
    // An error, or an answer that isn't this activity's history: asked again later.
    if (res?.error || !shieldedOwn(a, result)) {
      again();
      return;
    }
    a.shielded = result.entries;
    if (result.pending) again();
    await settle(a, state).catch(() => {});
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
    await a.history.sync({
      onStep: () => {
        if (state.activity !== a) return;
        reload(a)
          .then(() => redraw(state, render))
          .catch(() => {});
      },
    });
    a.error = null;
  } catch (error) {
    // Reset since, or overtaken by another page's run: nothing more for this one.
    if (error instanceof StaleActivityError || error instanceof StaleHistoryError) a.stale = true;
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
  await settle(a, state).catch(() => {});
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
    // The wallet the account is of: its own sends only.
    walletId: String(ov.accounts?.[0] ?? ""),
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
    // The stores' epochs now; undefined when they can't be read.
    epoch: getActivityEpoch().catch(() => undefined),
    txEpoch: getTxEpoch().catch(() => undefined),
  };
  state.activity = a;
  (async () => {
    try {
      a.history = activityHistory({ nodeUrl: a.nodeUrl, archiverUrl: a.archiverUrl, account, epoch: a.epoch });
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
 * Receive's look for what came in while a request waits: the account's
 * history synced again now, and its shielded history read again once its
 * notes synced since it was last read (the overview starts such a sync).
 * @param {object} ov - the overview
 * @param {{ state: object, render: () => Promise<void> }} ctx
 */
export function lookForPayments(ov, { state, render }) {
  const a = state?.activity;
  if (!a || a.key !== activityKey(ov)) return;
  refreshActivitySoon({ state, render }, 0);
  const sync = ov?.shieldedSync;
  if (sync?.state === "done" && Number(sync.updatedAt) > (a.shieldedReadAt ?? 0)) {
    a.shieldedAsked = false;
    loadShielded(a, state, render).catch(() => {});
  }
}

/** Rows read at most for Receive's requests, past the page Activity shows. */
const REQUEST_ROWS = 2_000;
/** Details read at most at once for them: one archive request's worth. */
const REQUEST_DETAILS = 50;

/**
 * The account's kept history back to `since` (milliseconds), past the page
 * Activity shows, for what must see every payment since then however many
 * came after (Receive's requests), with the details of what came in: what
 * `activityRows` takes as `whole`. Null while it isn't open or loaded.
 * @param {{ state: object }} ctx
 * @param {number} since
 */
export async function activitySince({ state }, since) {
  const a = state?.activity;
  if (!a?.history || !a.loaded) return null;
  // An entry's time, or where its details aren't read yet, about when its block was made.
  const timeOf = (entry, meta) =>
    Number(entry?.timestamp) || (meta?.headAt && Number.isFinite(entry?.blockHeight) ? meta.headAt - Math.max(0, Number(meta.finalized) - entry.blockHeight) * 10_000 : NaN);
  const readBack = async () => {
    for (let limit = Math.max(a.limit, ACTIVITY_PAGE); ; limit = Math.min(REQUEST_ROWS, limit * 2)) {
      const read = await a.history.read({ limit });
      if (read.entries.length < limit || limit >= REQUEST_ROWS || timeOf(read.entries.at(-1), read.state) < since) return read;
    }
  };
  let read = await readBack();
  // What came in has its time once its details are read.
  const missing = read.entries.filter((entry) => entry.direction === "in" && a.history.needsDetails(entry)).slice(0, REQUEST_DETAILS);
  if (missing.length && (await a.epoch) !== undefined) {
    await a.history.fillDetails(missing).catch(() => {});
    read = await readBack();
  }
  return state.activity === a ? { entries: read.entries, meta: read.state, shielded: a.shielded } : null;
}

/**
 * Show more: the next page of kept history, and a sync run for older history
 * when the kept history runs out.
 * @param {{ state: object, render: () => Promise<void> }} ctx
 */
export async function showMoreActivity({ state, render }) {
  const a = state.activity;
  if (!a) return;
  // From the rows shown: a read gives a block the page cuts through whole.
  a.limit = Math.max(a.limit, a.entries.length) + ACTIVITY_PAGE;
  await reload(a).catch(() => {});
  redraw(state, render);
  const missing = a.entries.filter((e) => a.history.needsDetails(e));
  const epoch = await a.epoch;
  if (missing.length && epoch !== undefined) {
    await a.history.fillDetails(missing).catch(() => {});
    await reload(a).catch(() => {});
    redraw(state, render);
  }
  if (await checkNames(a).catch(() => false)) redraw(state, render);
  if (!a.complete && a.entries.length < a.limit) await run(a, state, render);
}

// A whole read: runs of this many history requests, at most this many runs.
const WHOLE_RUN_REQUESTS = 64;
const WHOLE_RUNS = 64;

/**
 * All of the account's history, for what needs every row (an export, a Sozu
 * position), read from the archive as far as it isn't kept yet, with each
 * entry's details. Throws when it can't be had whole, and ActivityChangedError when
 * the wallet answers for another wallet, node or profile by then. `activityRows`
 * makes the rows of it.
 * @param {object} ov - the overview
 * @param {{ state: object, publicOnly?: boolean }} ctx - `publicOnly`: its shielded history isn't asked for
 * @returns {Promise<{ entries: object[], meta: object | null, shielded: object[], shieldedWaiting: boolean }>}
 *   `shieldedWaiting`: its shielded history isn't all there yet
 */
export async function wholeActivity(ov, { state, publicOnly = false }) {
  const a = state?.activity;
  if (!a?.history || a.key !== activityKey(ov)) throw new Error("The activity of this profile isn't open");
  if ((await a.epoch) === undefined) throw new Error("The activity store is out of reach");
  let whole = false;
  // At least one run: newer blocks than the last one read may hold more.
  for (let run = 0; run < WHOLE_RUNS && !whole; run += 1) {
    await a.history.sync({ maxRequests: WHOLE_RUN_REQUESTS, maxDetailRequests: 0 });
    ({ complete: whole } = await a.history.read({ limit: 1 }));
  }
  if (!whole) throw new Error("The history is too long to read at once");
  const all = { limit: Number.MAX_SAFE_INTEGER - 1 };
  let read = await a.history.read(all);
  const missing = read.entries.filter((entry) => a.history.needsDetails(entry));
  if (missing.length) {
    await a.history.fillDetails(missing);
    read = await a.history.read(all);
  }
  const answer = a.send && !publicOnly ? await a.send({ type: "DUSK_UI_GET_SHIELDED_HISTORY" }).catch(() => null) : null;
  const shielded = answer?.error ? null : answer?.result;
  // Another wallet's, node's or profile's: what's open changed while this was read.
  if (shielded && !shieldedOwn(a, shielded)) throw new ActivityChangedError();
  return {
    entries: read.entries,
    meta: read.state,
    shielded: shielded ? shielded.entries : a.shielded,
    shieldedWaiting: !shielded || Boolean(shielded.pending),
  };
}

/**
 * Refuses what was read for `ov` when that isn't what's open in the wallet any
 * more: another wallet, profile or node, or none, unlocked.
 * @param {object} ov - the overview it was read for
 * @param {{ state: object }} ctx
 */
export async function assertActivityOpen(ov, { state }) {
  const now = await state?.activity?.send?.({ type: "DUSK_UI_OVERVIEW" }).catch(() => null);
  // An overview says what was open before its balance reads: what's open by now is asked last.
  const status = await state?.activity?.send?.({ type: "DUSK_UI_STATUS" }).catch(() => null);
  const open = activityKey(now) && activityKey(now) === activityKey(ov) && status?.isUnlocked && status.accounts?.includes(selected(ov).account);
  if (!open) throw new ActivityChangedError();
}

// Each stake with Sozu's own stDUSK and deposit fee, read once a page.
const sozuFactsKept = new Map();

/**
 * What each stake and unstake with Sozu in `rows` did, as the pool's event says
 * it: none for what can't be read yet.
 * @param {object} ov - the overview
 * @param {object[]} rows - the account's rows
 * @returns {Promise<Map<string, import("@dusk-network/app-core/sozu").SozuFact> | undefined>}
 */
export function sozuFactsOf(ov, rows, { inBlock = false } = {}) {
  const archive = archiveAt(historyArchiverUrl({ nodeUrl: ov?.nodeUrl, archiverUrl: ov?.archiverUrl }));
  // What an accepted block says may yet change with it: never kept with the final.
  if (inBlock) return sozuFacts({ archive: blockEventsOf(archive), account: selected(ov).account, rows }).catch(() => undefined);
  return sozuFacts({ archive, account: selected(ov).account, rows, cache: sozuFactsKept }).catch(() => undefined);
}

// The account's history lists a transaction once its block is final; its
// block's events (contractEvents) have it as the block is accepted. Asked for
// the history of one block, this answers with that block's events, each
// transaction's (`origin`) together, as the history gives them.
function blockEventsOf(archive) {
  return {
    async query(text) {
      const asked = [...String(text).matchAll(/(h\d+): moonlightHistory\([^)]*?fromBlock: (\d+)/g)];
      if (!asked.length) return archive.query(text);
      const data = await archive.query(`query { ${asked.map(([, alias, height]) => `${alias}: contractEvents(height: ${height}) { json }`).join(" ")} }`);
      return Object.fromEntries(
        asked.map(([, alias]) => {
          const txs = new Map();
          for (const event of Array.isArray(data?.[alias]?.json) ? data[alias].json : []) {
            const origin = String(event?.origin ?? "").toLowerCase();
            if (!txs.has(origin)) txs.set(origin, { origin, events: [] });
            txs.get(origin).events.push({ ...event, target: event.target ?? event.source });
          }
          return [alias, { json: [...txs.values()] }];
        })
      );
    },
  };
}

/** How long a stake's or an unstake's Sozu facts not read yet wait before they're asked again: the archive can lag the block. */
export const SOZU_FACT_AGAIN_MS = 60_000;
/** On its Completed screen, as it just went through: asked again this soon, this many times, then a minute on. */
export const SOZU_FACT_SOON_MS = 3_000;
const SOZU_FACT_SOON_TRIES = 20;
// By activity and hash: what the pool's event said, or when a read that found none ended.
const sozuFactReads = new Map();

/**
 * What a stake or an unstake with Sozu did, for its details and its Completed
 * screen: undefined until the pool's event is read, and for a row that isn't
 * one that went through as the chain's history has it. Asked at most once a
 * minute while it isn't found, `render` drawing again a minute on, as nothing
 * else may; and once it's found.
 * @param {object} ov - the overview
 * @param {object | undefined} row - an activity row
 * @param {{ render?: () => Promise<unknown> }} [options]
 * @returns {import("@dusk-network/app-core/sozu").SozuFact | undefined}
 */
export function sozuFactOf(ov, row, { render, soon = false, inBlock = false } = {}) {
  if (!row?.sozu || row.status !== "executed" || row.source !== "public") return undefined;
  // Read from its block as accepted (`inBlock`), apart from the final history's.
  const key = `${inBlock ? "block" : "final"}\n${activityKey(ov)}\n${row.hash}`;
  const last = sozuFactReads.get(key);
  const again = (tries) => (soon && tries < SOZU_FACT_SOON_TRIES ? SOZU_FACT_SOON_MS : SOZU_FACT_AGAIN_MS);
  if (last?.fact || last?.reading || (last && Date.now() - last.at < again(last.tries))) return last.fact;
  const read = { at: Date.now(), fact: undefined, reading: true, tries: (last?.tries ?? 0) + 1 };
  sozuFactReads.set(key, read);
  sozuFactsOf(ov, [row], { inBlock })
    .then((facts) => {
      read.fact = facts?.get(row.hash);
    })
    .catch(() => {})
    .finally(() => {
      Object.assign(read, { at: Date.now(), reading: false });
      if (sozuFactReads.get(key) !== read) return;
      if (read.fact) render?.()?.catch?.(() => {});
      else setTimeout(() => render?.()?.catch?.(() => {}), again(read.tries));
    });
  return undefined;
}

/** While Completed's stake isn't in the final history yet: the history is read again this often, this many times (3 minutes). */
export const SOZU_FINAL_AGAIN_MS = 10_000;
export const SOZU_FINAL_TRIES = 18;
// By activity and hash: how often the history was read again for it, and whether a read waits.
const finalLooks = new Map();

/**
 * What a stake or an unstake with Sozu the wallet sent did, for its Completed
 * screen: as the chain's final history lists it; till then, from its block's
 * events as it went through (the block the wallet's watcher heard it in,
 * `sent.blockHeight`), marked not final (`final: false`), and the history
 * read again (`refresh`) every 10 seconds for a few minutes, as its block may
 * yet drop out.
 * @param {object} ov
 * @param {object} state
 * @param {object} sent - the Sent screen's transaction (state.sent)
 * @param {{ render?: () => Promise<unknown>, refresh?: () => void }} [options]
 */
export function sozuFactOfSent(ov, state, sent, options) {
  const listed = sent?.hash ? activityRows(ov, state).find((each) => each.hash === sent.hash && each.source === "public") : undefined;
  if (!listed && sent?.hash) lookForFinal(ov, sent, options?.refresh);
  // Final as failed, as a block that dropped out can leave it: the screen
  // says so, and nothing of what its block said.
  if (listed?.status === "failed") {
    noteTxStatus(sent, { hash: sent.hash, status: "failed", error: listed.error || "It didn't go through in the end." });
    return undefined;
  }
  // Listed: the final history's, once read, in place of its block's.
  const final = listed ? sozuFactOf(ov, listed, { ...options, soon: true }) : undefined;
  if (final) return final;
  const { status, blockHeight } = sentStatus(sent, ov);
  const height = Number(blockHeight);
  const pool = String(sent?.pool ?? "");
  if (status !== "executed" || !Number.isSafeInteger(height) || height <= 0 || !pool) return undefined;
  const row = { hash: sent.hash, sozu: sent.sozu, status, source: "public", blockHeight: height, contractId: pool, value: safeBigInt(sent.amountLux, 0n) };
  const early = sozuFactOf(ov, row, { ...options, soon: true, inBlock: true });
  return early && { ...early, final: false };
}

// The history read again a while on, once at a time, a few minutes at most.
function lookForFinal(ov, sent, refresh) {
  if (!refresh) return;
  const key = `${activityKey(ov)}\n${sent.hash}`;
  const look = finalLooks.get(key) ?? { tries: 0, waiting: false };
  finalLooks.set(key, look);
  if (look.waiting || look.tries >= SOZU_FINAL_TRIES) return;
  look.waiting = true;
  setTimeout(() => {
    look.waiting = false;
    look.tries++;
    refresh();
  }, SOZU_FINAL_AGAIN_MS);
}

// How Sozu's stDUSK grew lately, by pool, as app-core reads it from the chain:
// read once an hour in this popup, for every screen that shows Sozu's rate.
const sozuGrowthKept = new Map();

/**
 * How Sozu's stDUSK grew over the last 30 days, from the pool its status names
 * (app-core's sozuGrowth): null where it can't be read, or before the status is.
 * @param {object} ov - the overview
 * @param {object | null | undefined} status - Sozu's status, as the engine reads it
 * @param {number | null} [tipHeight] - the node's height, where it's known
 */
export function sozuGrowthOf(ov, status, tipHeight = null) {
  if (!status?.contracts?.pool) return Promise.resolve(null);
  const archive = archiveAt(historyArchiverUrl({ nodeUrl: ov?.nodeUrl, archiverUrl: ov?.archiverUrl }));
  return sozuGrowth({ archive, cache: sozuGrowthKept, pool: status.contracts.pool, status, tipHeight }).catch(() => null);
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
  if (!entry || !a.history.needsDetails(entry) || last === "loading" || (typeof last === "number" && Date.now() - last < DETAIL_RETRY_MS)) return;
  detailLoads.set(key, "loading");
  a.epoch
    .then((epoch) => {
      if (epoch === undefined) throw new Error("The activity store is out of reach");
      return a.history.fillDetails([entry]);
    })
    .then(() => reload(a))
    .then(() => redraw(state, render))
    .catch(() => {})
    .finally(() => {
      const now = a.entries.find((e) => e.hash === hash);
      if (now && !a.history.needsDetails(now)) detailLoads.delete(key);
      else detailLoads.set(key, Date.now());
    });
}

/** Whether Show more has more to show: kept rows beyond the page, or older history to sync. */
export function hasMoreActivity(state) {
  const a = state?.activity;
  return Boolean(a?.loaded && (!a.complete || a.entries.length >= a.limit));
}

// A send as the package reads it: a deposit's DuskEVM address, which the
// wallet keeps as `bridgeTo`, as the bridge facts it is.
const sentOf = (tx) => (tx?.bridgeTo ? { ...tx, bridge: { amount: String(tx.deposit ?? tx.amount ?? "0"), kind: "deposit", to: tx.bridgeTo } } : tx);

/**
 * The rows Recent activity and the History view show: this wallet's own
 * transactions on the overview's network with the account's history,
 * newest first, as @dusk-network/app-core/activity merges them.
 * @param {object} ov
 * @param {object} state
 * @param {{ entries?: object[], meta?: object | null, shielded?: object[] }} [whole] - the
 *   account's whole history (wholeActivity), in place of the page read so far
 * @returns {object[]}
 */
export function activityRows(ov, state, whole = null) {
  const key = activityKey(ov);
  const a = state?.activity;
  const ours = a && key && a.key === key ? a : null;
  const { account, profileIndex } = selected(ov);
  const nodeUrl = String(ov?.nodeUrl ?? "");
  return rowsOf({
    account,
    address: ov?.addresses?.[profileIndex],
    arrivals: keptArrivals(),
    nameCall: nameFactsFor(nodeUrl),
    names: ours?.names,
    network: networkForNode(nodeUrl),
    pending: (Array.isArray(ov?.txs) ? ov.txs : []).map(sentOf),
    // The selected profile's activity; every profile's while locked.
    profileIndex: key ? profileIndex : null,
    public: whole?.entries ?? ours?.entries,
    shielded: whole?.shielded ?? ours?.shielded,
    state: whole?.meta ?? ours?.meta,
  });
}
