// A payment made in Send that couldn't reach the network before it went out
// waits for the network, as the web wallet's does (web-wallet sendGate.js):
// asked again as the browser says it's back online, or every 5 seconds, and
// made again once the network answers. Until the node is asked to broadcast
// it, it can be called off, from its Sent screen or from Home; the engine,
// which hands it over, settles which comes first (walletEngine.js
// cancelSend), so one called off never goes out. Payments that waited go out
// one at a time, in the order they were made, and a new one waits behind them.
//
// What each waits to send is kept on this device, never a password or a key
// (STORAGE_KEYS.WAITING_SENDS): one left waiting as the wallet closed, locked
// or opened another wallet isn't forgotten without a word. Home says it wasn't
// sent, with Send it now and Drop, and it never goes out by itself after that.
//
// Only what's known not to have gone out is said so. Before a payment that
// waited is handed to the node, its transaction's ID is kept with it (the
// engine waits for that: noteHandingOver): one handed over, or maybe, is
// followed by that ID until the chain says what came of it, as a send with no
// clear answer is (`host.follow`), however the wallet stopped meanwhile, and
// is never offered to send again.
//
// The wallet's background keeps the queue in the extension, the page in the
// app (wallet/localBus.js): `host` is how each reaches the engine, the node
// and its pages.

import { storage, STORAGE_KEYS } from "./storage.js";
import { SEND_CANCELLED_TEXT, unreachableBeforeSent } from "./sendOutcome.js";

export { SEND_CANCELLED_TEXT };

/** How long a waiting payment waits before the network is asked again, where the browser doesn't say first that it's back. */
export const ASK_AGAIN_AFTER_MS = 5_000;

/** Why a waiting payment wasn't sent, as the wallet stopped waiting for it. */
export const NOT_SENT_TEXT = Object.freeze({
  closed: "The wallet closed before the network answered, so nothing was sent.",
  locked: "The wallet locked before the network answered, so nothing was sent.",
  switched: "Another wallet was opened before the network answered, so nothing was sent.",
});

/**
 * What's kept of a waiting payment: whose, on which network and profile, and
 * what it pays. `ended` once it no longer waits without having gone out:
 * "closed", "locked", "switched", or "failed" with the `error` it ran into.
 * `hash` once it's being handed to the node: its transaction's ID.
 * @typedef {{
 *   sendId: string, walletId: string, nodeUrl: string, profileIndex: number,
 *   privacy: "public" | "shielded", to: string, toName?: string, lux: string,
 *   feeLux: string, memo: string, at: number, hash?: string,
 *   ended?: "closed" | "locked" | "switched" | "failed", error?: string,
 * }} WaitingRecord
 */

/**
 * How the queue reaches the wallet: `attempt` is each payment's own, told
 * `waited` for a payment that waited (the engine tells of it before its
 * hand-over then). `follow` keeps a payment handed over, or maybe, as a send
 * with no clear answer, to be looked up by its ID.
 * @typedef {{
 *   answers: () => Promise<boolean>,
 *   cancelInEngine: (sendId: string) => Promise<{ cancelled: boolean }>,
 *   follow: (handedOver: { record: WaitingRecord, hash: string }) => Promise<void>,
 *   tell: (message: object) => void,
 * }} WaitingHost
 */

/**
 * What's kept of a payment from Send as it waits, from the message Send sent
 * (DUSK_UI_SEND_TX): whose, on which network and profile its Review was for,
 * what it pays, and the most its fee costs (`feeCapLux`).
 * @param {any} message
 * @param {{ nodeUrl?: string, profileIndex?: number }} [here] - the wallet's, where the message doesn't say
 * @returns {Omit<WaitingRecord, "sendId" | "at">}
 */
export function waitingRecordOf(message, { nodeUrl = "", profileIndex = 0 } = {}) {
  const params = reviewedParams(message?.params);
  const context = params._approvalContext && typeof params._approvalContext === "object" ? params._approvalContext : {};
  const lux = (value) => (/^\d+$/.test(String(value ?? "")) ? String(value) : "0");
  const asked = Number(params.profileIndex);
  return {
    walletId: String(message?.walletId || context.walletId || ""),
    nodeUrl: String(context.nodeUrl || nodeUrl),
    profileIndex: Number.isInteger(asked) && asked >= 0 ? asked : profileIndex,
    privacy: params.privacy === "shielded" ? "shielded" : "public",
    to: String(params.to ?? ""),
    ...(message?.toName ? { toName: String(message.toName) } : {}),
    lux: lux(params.amount),
    feeLux: lux(message?.feeCapLux),
    memo: typeof params.memo === "string" ? params.memo : "",
  };
}

/**
 * A payment's transaction as sent, naming the profile its Review was for
 * (`_approvalContext`) where it names none: one that waits goes out from that
 * profile, whichever is picked meanwhile.
 * @param {any} params
 * @returns {object}
 */
export function reviewedParams(params) {
  const sent = params && typeof params === "object" ? params : {};
  const named = sent.profileIndex;
  if (named !== undefined && named !== null && named !== "" && Number.isInteger(Number(named)) && Number(named) >= 0) return sent;
  const reviewed = sent._approvalContext?.profileIndex;
  return Number.isInteger(reviewed) && reviewed >= 0 ? { ...sent, profileIndex: reviewed } : sent;
}

/** An error for a payment that wasn't sent because it was called off, saying why. */
export function sendCancelled(text = SEND_CANCELLED_TEXT) {
  const error = new Error(text);
  error.data = { sent: false, cancelled: true };
  return error;
}

// The payments waiting here, the oldest first: { sendId, record, attempt,
// resolve, reject, state: "waiting" | "sending" | "settled" }.
const queue = [];
// Payments being tried the first time, before any waited, by their ID: one
// called off meanwhile (`cancelled`) never waits after its try.
const firstTries = new Map();
let looping = false;
// Ends the pause between asks at once: a payment joined, or the browser's back online.
let wake = () => {};

// ----------------------------------------------------------------------------
// What's kept on the device
// ----------------------------------------------------------------------------

// Writes one after another: each reads what the one before wrote.
let writes = Promise.resolve();

async function readKept() {
  const kept = (await storage.get(STORAGE_KEYS.WAITING_SENDS))?.[STORAGE_KEYS.WAITING_SENDS];
  return kept && typeof kept === "object" && !Array.isArray(kept) ? kept : {};
}

function changeKept(change) {
  const next = writes.then(async () => {
    const kept = await readKept();
    change(kept);
    await storage.set({ [STORAGE_KEYS.WAITING_SENDS]: kept });
  });
  writes = next.catch(() => {});
  return next;
}

const keep = (record) =>
  changeKept((kept) => {
    kept[record.sendId] = record;
  });

const forget = (sendId) =>
  changeKept((kept) => {
    delete kept[sendId];
  });

// Kept as not sent: whatever was being handed over for it never was.
const endKept = (sendId, ended, error = "") =>
  changeKept((kept) => {
    if (!kept[sendId]) return;
    const record = { ...kept[sendId], ended, ...(error ? { error } : {}) };
    delete record.hash;
    kept[sendId] = record;
  });

// ----------------------------------------------------------------------------
// The queue
// ----------------------------------------------------------------------------

const tellWaits = (host, sendId, waits) => {
  try {
    host.tell({ type: "DUSK_UI_SEND_WAITING", sendId, waits });
  } catch {
    // No page to tell.
  }
};

// Out of the queue, its record kept as `how` says: forgotten once it went
// out, was called off with Cancel, or is followed by its transaction's ID;
// kept as not sent otherwise.
function settle(item, how, error) {
  item.state = "settled";
  const at = queue.indexOf(item);
  if (at >= 0) queue.splice(at, 1);
  if (how === "out" || how === "cancelled" || how === "followed") return forget(item.sendId).catch(() => {});
  return endKept(item.sendId, how, how === "failed" ? String(error?.message ?? error ?? "") : "").catch(() => {});
}

// The ID of the transaction a payment's try handed to the node, or was
// handing over as it ended: as its error says, or as it was kept before.
async function handedOverHash(sendId, failure) {
  const said = String(failure?.data?.hash ?? "");
  if (said) return said;
  await writes;
  const kept = await readKept().catch(() => ({}));
  return String(kept[sendId]?.hash ?? "");
}

// Out of the queue, handed over or maybe, its record kept with its
// transaction's ID: where it couldn't be followed by that ID yet, it is the
// next time the wallet starts (followHandedOver), and isn't said not sent.
async function keepHandedOver(item, hash) {
  item.state = "settled";
  const at = queue.indexOf(item);
  if (at >= 0) queue.splice(at, 1);
  await changeKept((kept) => {
    if (kept[item.sendId]) kept[item.sendId] = { ...kept[item.sendId], hash };
  }).catch(() => {});
}

// An error that says its payment may have gone out, with its ID.
function maybeSent(failure, hash) {
  const error = failure instanceof Error ? failure : new Error(String(failure?.message ?? failure));
  try {
    error.data = { ...(error.data && typeof error.data === "object" ? error.data : {}), sent: "unknown", ...(hash ? { hash } : {}) };
  } catch {
    // A frozen error says what it says.
  }
  return error;
}

// A pause before the network is asked again: over after a while, as the
// browser says it's back online, or as a payment joins or is called off.
function pause() {
  return new Promise((resolve) => {
    const end = () => {
      clearTimeout(timer);
      try {
        globalThis.removeEventListener?.("online", end);
      } catch {
        // No such event here.
      }
      wake = () => {};
      resolve();
    };
    const timer = setTimeout(end, ASK_AGAIN_AFTER_MS);
    try {
      globalThis.addEventListener?.("online", end);
    } catch {
      // No such event here.
    }
    wake = end;
  });
}

// Waits for the network while payments wait for it, and sends them once it
// answers, one at a time, in their order. One that can't reach it again holds
// the ones after it: the network's gone again.
async function follow(host) {
  if (looping) return;
  looping = true;
  try {
    while (queue.some((item) => item.state === "waiting")) {
      await pause();
      if (!queue.some((item) => item.state === "waiting")) break;
      if (!(await host.answers().catch(() => false))) continue;
      for (const item of [...queue]) {
        if (item.state !== "waiting") continue;
        item.state = "sending";
        tellWaits(host, item.sendId, false);
        let result;
        let failure;
        try {
          result = await item.attempt({ waited: true });
        } catch (error) {
          failure = error;
        }
        // Called off, or ended by a lock, while it was tried: said already.
        if (item.state === "settled") continue;
        if (!failure) {
          settle(item, "out");
          item.resolve(result);
          continue;
        }
        // Stopped as it was tried, as the wallet locked or its engine closed:
        // nothing went out, and it never waits again.
        if (item.stopping && (unreachableBeforeSent(failure) || failure?.data?.sent === false)) {
          settle(item, item.stopping);
          item.reject(sendCancelled(NOT_SENT_TEXT[item.stopping]));
          continue;
        }
        if (unreachableBeforeSent(failure)) {
          item.state = "waiting";
          tellWaits(host, item.sendId, true);
          break;
        }
        // Handed to the node, or maybe, with no clear answer: followed by its
        // ID until the chain says, never kept as not sent. Only a try that
        // never handed it over (no ID kept for it) or that the node turned
        // down is.
        const hash = await handedOverHash(item.sendId, failure);
        if (failure?.data?.sent !== false && (hash || failure?.data?.sent === "unknown")) {
          // Its record goes once it's followed by its ID, never before.
          const followed = !hash || (typeof host.follow === "function" && (await host.follow({ record: item.record, hash }).then(() => true, () => false)));
          if (followed) await settle(item, "followed");
          else await keepHandedOver(item, hash);
          item.reject(maybeSent(failure, hash));
          continue;
        }
        settle(item, item.stopping ?? "failed", failure);
        item.reject(item.stopping ? sendCancelled(NOT_SENT_TEXT[item.stopping]) : failure);
      }
    }
  } finally {
    looping = false;
  }
}

/**
 * Sends a payment from Send: at once, unless payments before it wait for the
 * network; and where it couldn't reach the network before it went out, once
 * the network answers, kept meanwhile (`record`). Resolves with what
 * `attempt` gives once it's handed over, and rejects with why it wasn't sent:
 * called off (sendCancelled), the wallet locked or switched, or what a try
 * ran into.
 * @template T
 * @param {{ sendId: string, record: Omit<WaitingRecord, "sendId" | "at">, attempt: () => Promise<T>, host: WaitingHost }} send
 * @returns {Promise<T>}
 */
export async function sendWhenReachable({ sendId, record, attempt, host }) {
  if (!queue.length) {
    const first = { cancelled: false };
    firstTries.set(sendId, first);
    try {
      return await attempt({ waited: false });
    } catch (error) {
      // Called off as it was tried: nothing went out, and it never waits after.
      if (first.cancelled && error?.data?.sent !== "unknown") throw sendCancelled();
      if (!unreachableBeforeSent(error)) throw error;
    } finally {
      firstTries.delete(sendId);
    }
  }
  return new Promise((resolve, reject) => {
    const kept = { ...record, sendId, at: Date.now() };
    queue.push({ sendId, record: kept, attempt, resolve, reject, state: "waiting" });
    keep(kept).catch(() => {});
    tellWaits(host, sendId, true);
    wake();
    follow(host).catch(() => {});
  });
}

/**
 * Cancel on a payment from Send: called off unless it was handed to the node
 * already, which the engine settles. One waiting here says so to whoever
 * waits on it; one not waiting here any more (not sent, from before) is
 * forgotten. Whether it was called off.
 * @param {string} sendId
 * @param {WaitingHost} host
 * @returns {Promise<boolean>}
 */
export async function cancelWaitingSend(sendId, host) {
  const id = String(sendId ?? "");
  if (!id) return false;
  // Its first try under way: the engine settles it, and its try won't wait after.
  const first = firstTries.get(id);
  if (first) {
    const { cancelled } = await host.cancelInEngine(id).catch(() => ({ cancelled: false }));
    if (cancelled) first.cancelled = true;
    return cancelled;
  }
  const item = queue.find((each) => each.sendId === id);
  // Between tries: nothing of it is under way, and nothing will be.
  if (item?.state === "waiting") {
    settle(item, "cancelled");
    item.reject(sendCancelled());
    wake();
    host.cancelInEngine(id).catch(() => {});
    return true;
  }
  const { cancelled } = await host.cancelInEngine(id).catch(() => ({ cancelled: false }));
  if (!cancelled) return false;
  if (item && item.state !== "settled") {
    settle(item, "cancelled");
    item.reject(sendCancelled());
  } else if (!item) {
    forget(id).catch(() => {});
  }
  return true;
}

/**
 * Stops every payment waiting here, as the wallet locks, another wallet
 * opens, or the engine it runs in closes (Firefox's tab, which ends the
 * wallet open): a payment goes out only while the wallet it was made on is
 * open. Each is kept as not sent, for Home to say so once the wallet's open
 * again, with Send it now and Drop. One being tried as its engine closed
 * ends as its try does, kept as not sent unless it may have gone.
 * @param {"locked" | "switched" | "closed"} why
 * @param {WaitingHost} host
 * @param {{ engineGone?: boolean }} [opts] - the engine's gone: nothing's asked of it
 */
export async function stopWaitingSends(why, host, { engineGone = false } = {}) {
  const items = queue.filter((item) => item.state !== "settled");
  await Promise.all(
    items.map(async (item) => {
      // One being tried is called off where it's handed over; one handed
      // over goes on, said not sent where its try ends without going out.
      if (item.state === "sending") {
        const { cancelled } = engineGone ? { cancelled: false } : await host.cancelInEngine(item.sendId).catch(() => ({ cancelled: false }));
        if (!cancelled) {
          item.stopping = why;
          return;
        }
      }
      // Over meanwhile, as its try ended.
      if (item.state === "settled") return;
      settle(item, why);
      item.reject(sendCancelled(NOT_SENT_TEXT[why]));
    })
  );
  wake();
}

/**
 * The payments from Send kept for one wallet on one node, the oldest first,
 * for Home, Send and Review: those still waiting here (`waits` while they
 * wait for the network, not while one is being tried), and those that
 * stopped waiting without going out (`ended`, the wallet closed meanwhile
 * where nothing says otherwise). One being handed to the node as the wallet
 * stopped isn't one: it's followed by its ID (followHandedOver).
 * @param {{ walletId: string, nodeUrl: string }} of
 * @returns {Promise<Array<WaitingRecord & { waiting: boolean, waits: boolean }>>}
 */
export async function waitingSendsOf({ walletId, nodeUrl }) {
  await writes;
  const kept = await readKept().catch(() => ({}));
  return Object.values(kept)
    .filter((record) => record?.walletId === walletId && record?.nodeUrl === nodeUrl)
    .map((record) => {
      const item = queue.find((each) => each.sendId === record.sendId && each.state !== "settled");
      if (item) return { ...record, ended: undefined, waiting: true, waits: item.state === "waiting" };
      return record.hash ? null : { ...record, ended: record.ended ?? "closed", waiting: false, waits: false };
    })
    .filter(Boolean)
    .sort((a, b) => Number(a.at) - Number(b.at));
}

/**
 * Keeps a payment that waited with the ID of the transaction about to be
 * handed to the node for it: the engine hands it over once this is done
 * (setHandOverHook). One nothing here waits on any more, as the wallet's
 * background or page started again meanwhile, is followed by that ID at once.
 * @param {string} sendId
 * @param {string} hash
 * @param {WaitingHost} host
 */
export async function noteHandingOver(sendId, hash, host) {
  const id = String(sendId ?? "");
  const txHash = String(hash ?? "");
  if (!id || !txHash) return;
  let kept = false;
  await changeKept((all) => {
    if (!all[id]) return;
    all[id] = { ...all[id], hash: txHash };
    kept = true;
  });
  if (kept && !queue.some((item) => item.sendId === id && item.state !== "settled")) await followHandedOver(host);
}

/**
 * Follows each payment kept as being handed to the node that nothing here
 * waits on any more, as after the wallet's background or page stopped
 * during its try: by its transaction's ID, as a send with no clear answer,
 * until the chain says what came of it; its waiting record goes.
 * @param {WaitingHost} host
 */
export async function followHandedOver(host) {
  await writes;
  const kept = await readKept().catch(() => ({}));
  for (const record of Object.values(kept)) {
    if (!record?.hash || queue.some((item) => item.sendId === record.sendId && item.state !== "settled")) continue;
    try {
      await host.follow({ record, hash: record.hash });
      await forget(record.sendId);
    } catch {
      // Followed next time.
    }
  }
}

/**
 * Drop on Home, or Send it now, for a payment that wasn't sent: forgotten.
 * One still waiting here isn't: Cancel calls that off.
 * @param {string} sendId
 */
export async function dropUnsent(sendId) {
  const id = String(sendId ?? "");
  if (!id || queue.some((item) => item.sendId === id && item.state !== "settled")) return false;
  await forget(id);
  return true;
}

/**
 * Forgets what's kept of one wallet's payments that weren't sent, as the
 * wallet is removed: none still waiting goes on.
 * @param {string} walletId
 */
export async function forgetWalletUnsent(walletId) {
  await changeKept((kept) => {
    for (const [sendId, record] of Object.entries(kept)) {
      if (record?.walletId === walletId && !queue.some((item) => item.sendId === sendId && item.state !== "settled")) delete kept[sendId];
    }
  });
}

/** Forgets every payment kept, as the wallet is reset. */
export async function clearWaitingSends() {
  await writes;
  await storage.remove(STORAGE_KEYS.WAITING_SENDS);
}
