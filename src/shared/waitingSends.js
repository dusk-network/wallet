// A payment made in Send that couldn't reach the network before it went out
// waits for the network, as the web wallet's does (web-wallet sendGate.js):
// asked again as the browser says it's back online, or every 5 seconds, and
// made again once the network answers. Until the node is asked to broadcast
// it, it can be called off, from its Sent screen or from Home; the engine,
// which hands it over, settles which comes first (walletEngine.js
// cancelSend), so one called off never goes out. Payments that waited go out
// one at a time, in the order they were made, and a new one waits behind them.
//
// What each pays is kept on this device from the moment it's confirmed, before
// anything else happens to it, never a password or a key
// (STORAGE_KEYS.WAITING_SENDS): one the wallet closed on, locked on or left
// for another wallet isn't forgotten without a word. Home says it wasn't sent,
// with Send it now and Don't send, and it never goes out by itself after that.
//
// Only what's known not to have gone out is said so. Before any try hands a
// payment to the node, its transaction's ID and nonce are kept with it (the
// engine waits for that: noteHandingOver). One handed over with no clear
// answer may or may not have reached the node: a public one is looked up on
// the node, by its ID in the chain and the node's mempool and by its
// account's nonce, once the network answers. Found, it went; nowhere, and its
// nonce unused, the node never had it: while the payment still waits here it
// goes out once, as the very transaction made for it, and once the wallet has
// stopped meanwhile it's said not sent, with Send it now and Don't send. A
// shielded one, which has no nonce to tell by, is followed by its ID as a
// send with no clear answer (`host.follow`), never said not sent.
//
// The wallet's background keeps the queue in the extension, the page in the
// app (wallet/localBus.js): `host` is how each reaches the engine, the node
// and its pages.

import { storage, STORAGE_KEYS } from "./storage.js";
import { SEND_CANCELLED_TEXT, unreachable, unreachableBeforeSent } from "./sendOutcome.js";

export { SEND_CANCELLED_TEXT };

/** How long a waiting payment waits before the network is asked again, where the browser doesn't say first that it's back. */
export const ASK_AGAIN_AFTER_MS = 5_000;

/**
 * How long a handed-over payment whose nonce was used by something else must
 * stay missing from the chain before it's said not sent: the chain's list of
 * transactions can be a moment behind the account's nonce.
 */
export const USED_FOR_MS = 10_000;

/** Why a waiting payment wasn't sent, as the wallet stopped waiting for it. */
export const NOT_SENT_TEXT = Object.freeze({
  closed: "The wallet closed before the network answered, so nothing was sent.",
  locked: "The wallet locked before the network answered, so nothing was sent.",
  switched: "Another wallet was opened before the network answered, so nothing was sent.",
});

// Why the wallet stopped waiting on a payment that may have gone out.
const STOPPED_TEXT = Object.freeze({
  closed: "The wallet closed before the network answered.",
  locked: "The wallet locked before the network answered.",
  switched: "Another wallet was opened before the network answered.",
});

/** Why a payment handed over never went: its account's nonce went to another transaction. */
export const REPLACED_TEXT = "Another transaction from this account took its place, so nothing was sent.";

/**
 * What's kept of a waiting payment: whose, on which network, profile and
 * account, and what it pays. `ended` once it no longer waits without having
 * gone out: "closed", "locked", "switched", or "failed" with the `error` it
 * ran into. `hash` and `nonce` once it's being handed to the node: its
 * transaction's ID and nonce; `stopped`, why the wallet stopped waiting on it
 * meanwhile.
 * @typedef {{
 *   sendId: string, walletId: string, nodeUrl: string, profileIndex: number, account?: string,
 *   privacy: "public" | "shielded", to: string, toName?: string, lux: string,
 *   feeLux: string, memo: string, at: number, hash?: string, nonce?: string,
 *   ended?: "closed" | "locked" | "switched" | "failed", error?: string,
 *   stopped?: "closed" | "locked" | "switched", usedSince?: number,
 * }} WaitingRecord
 */

/**
 * Where a payment handed over without a clear answer stands, as the node says
 * it (txLifecycle.js handedOverState): "in" the chain or the node's mempool;
 * "absent", nowhere and its nonce unused, so the node never had it; "used",
 * nowhere though its account's nonce went past it; "unknown" where the node
 * couldn't be asked.
 * @typedef {{ state: "in" | "absent" | "used" | "unknown" }} HandedOverState
 */

/**
 * How the queue reaches the wallet: `attempt` is each payment's own, told
 * `waited` for a payment that waited, `resend` to send the transaction made
 * for it again as it is, or `found`, its transaction's ID and nonce, where
 * the node has it. `follow` keeps a payment handed over as a sent one, looked
 * up by its ID (`unclear` while it isn't known to have gone); `check` asks
 * the node where one handed over stands; `release` tells the engine a payment
 * it handed over never went, so its nonce is free again; `underWay`, whether
 * the engine is handing one over still, as after the background started again.
 * @typedef {{
 *   answers: () => Promise<boolean>,
 *   cancelInEngine: (sendId: string) => Promise<{ cancelled: boolean }>,
 *   follow: (handedOver: { record: WaitingRecord, hash: string, unclear?: boolean }) => Promise<void>,
 *   check?: (record: WaitingRecord) => Promise<HandedOverState>,
 *   release?: (sendId: string) => Promise<unknown>,
 *   underWay?: (sendId: string) => Promise<boolean>,
 *   tell: (message: object) => void,
 * }} WaitingHost
 */

/**
 * What's kept of a payment from Send as it waits, from the message Send sent
 * (DUSK_UI_SEND_TX): whose, on which network, profile and account its Review
 * was for, what it pays, and the most its fee costs (`feeCapLux`).
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
    // The account that pays, whose nonce says whether the node ever had it.
    ...(typeof context.account === "string" && context.account ? { account: context.account } : {}),
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

/**
 * Whether a payment from Send handed over with no clear answer is looked up on
 * the node by the queue here, rather than kept as a send with no clear
 * answer: a public one, which its account's nonce tells of.
 * @param {{ privacy?: string } | null | undefined} payment
 */
export const checkedOnNode = (payment) => payment?.privacy !== "shielded";

/** An error for a payment that wasn't sent because it was called off, saying why. */
export function sendCancelled(text = SEND_CANCELLED_TEXT) {
  const error = new Error(text);
  error.data = { sent: false, cancelled: true };
  return error;
}

// The payments waiting here, the oldest first: { sendId, record, attempt,
// resolve, reject, state: "waiting" | "sending" | "unclear" | "settled",
// handedOver, stopping, refused }. "unclear": handed over without a clear
// answer, to be looked up on the node.
const queue = [];
// Payments being tried the first time, before any waited, by their ID: one
// called off meanwhile (`cancelled`) never waits after its try; one handed
// over (`handedOver`) isn't said to have nothing gone.
const firstTries = new Map();
let looping = false;
// Ends the pause between asks at once: a payment joined, or the browser's back online.
let wake = () => {};

// Whether a payment is under way here: waiting, being tried, or looked up.
const active = (sendId) => firstTries.has(sendId) || queue.some((item) => item.sendId === sendId && item.state !== "settled");

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
    const answer = change(kept);
    await storage.set({ [STORAGE_KEYS.WAITING_SENDS]: kept });
    return answer;
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

// Kept as not sent: whatever was being handed over for it never went.
const endKept = (sendId, ended, error = "") =>
  changeKept((kept) => {
    if (!kept[sendId]) return;
    const { hash: _hash, nonce: _nonce, stopped: _stopped, usedSince: _usedSince, ...record } = kept[sendId];
    kept[sendId] = { ...record, ended, ...(error ? { error } : {}) };
  });

// A change to what's kept of one payment, where it still is.
const patchKept = (sendId, patch) =>
  changeKept((kept) => {
    if (kept[sendId]) kept[sendId] = { ...kept[sendId], ...patch };
  });

// ----------------------------------------------------------------------------
// The queue
// ----------------------------------------------------------------------------

// The page told whether a payment waits for the network (`waits`), and once
// it was handed over (`handedOver`): from then on it may have gone out.
const tellWaits = (host, sendId, waits, handedOver = false) => {
  try {
    host.tell({ type: "DUSK_UI_SEND_WAITING", sendId, waits, ...(handedOver ? { handedOver: true } : {}) });
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

// What's kept of a payment now: its record as written last.
async function keptRecord(sendId) {
  await writes;
  return (await readKept().catch(() => ({})))[sendId] ?? null;
}

// Out of the queue, handed over or maybe, its record kept with its
// transaction's ID: it's looked up on the node, or followed by that ID, the
// next time the wallet asks (followHandedOver), and isn't said not sent.
async function keepHandedOver(item, hash, stopped) {
  item.state = "settled";
  const at = queue.indexOf(item);
  if (at >= 0) queue.splice(at, 1);
  await changeKept((kept) => {
    if (kept[item.sendId]) kept[item.sendId] = { ...kept[item.sendId], hash, ...(stopped ? { stopped } : {}) };
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

// An error that says nothing went out, with its own words.
function notSent(failure) {
  const error = failure instanceof Error ? failure : new Error(String(failure?.message ?? failure));
  try {
    error.data = { ...(error.data && typeof error.data === "object" ? error.data : {}), sent: false };
  } catch {
    // A frozen error says what it says.
  }
  return error;
}

// A pause before the network is asked again: over after a while, as the
// browser says it's back online, as the wallet's page shows again (a phone
// that put the app away can hold back a timer set meanwhile well past its
// time), or as a payment joins or is called off.
function pause() {
  return new Promise((resolve) => {
    const page = globalThis.document;
    const shown = () => {
      if (page?.visibilityState === "visible") end();
    };
    const end = () => {
      clearTimeout(timer);
      try {
        globalThis.removeEventListener?.("online", end);
        page?.removeEventListener?.("visibilitychange", shown);
      } catch {
        // No such event here.
      }
      wake = () => {};
      resolve();
    };
    const timer = setTimeout(end, ASK_AGAIN_AFTER_MS);
    try {
      globalThis.addEventListener?.("online", end);
      page?.addEventListener?.("visibilitychange", shown);
    } catch {
      // No such event here.
    }
    wake = end;
  });
}

// One handed over without a clear answer, which a wallet stopping meanwhile
// left: kept with its ID for the node to be asked once it's open again, never
// said not sent, and whoever waits on it told it may have gone.
async function leaveHandedOver(item, failure) {
  const hash = await handedOverHash(item.sendId, failure);
  await keepHandedOver(item, hash, item.stopping);
  item.reject(maybeSent(failure ?? new Error(STOPPED_TEXT[item.stopping] ?? "The wallet stopped before the network answered."), hash));
}

// Not sent, after all: the node never had it, and it won't go out from here.
async function endUnsent(item, host, ended, error) {
  await host.release?.(item.sendId).catch(() => {});
  await settle(item, ended, error);
  item.reject(notSent(error ?? new Error(NOT_SENT_TEXT[ended] ?? REPLACED_TEXT)));
}

// A payment handed over without a clear answer, looked up on the node once
// it answers: found, it went; nowhere, and its nonce unused, the transaction
// made for it goes out again, once, as it is; its nonce used by another, it
// never will, which the chain is given a moment to say otherwise. Whether
// the ones after it may go now: not while this one's still unclear.
async function settleUnclear(item, host) {
  // As it's kept: with the ID and nonce its hand-over noted.
  const record = (await keptRecord(item.sendId)) ?? item.record;
  const { hash = "", nonce = "" } = record;
  const { state } = (await host.check?.(record).catch(() => null)) ?? { state: "unknown" };
  if (item.state !== "unclear") return true;
  if (state === "in") {
    item.state = "sending";
    let result;
    try {
      result = await item.attempt({ found: { hash, nonce } });
    } catch (error) {
      if (item.stopping) {
        await leaveHandedOver(item, error);
        return true;
      }
      item.state = "unclear";
      return false;
    }
    settle(item, "out");
    item.resolve(result);
    return true;
  }
  if (state === "used") {
    item.usedSince ??= Date.now();
    if (Date.now() - item.usedSince < USED_FOR_MS) return false;
    await endUnsent(item, host, "failed", item.refused ?? new Error(REPLACED_TEXT));
    return true;
  }
  if (state !== "absent") return false;
  delete item.usedSince;
  // The node never had it: the transaction made for it, as it is, once more.
  item.state = "sending";
  let result;
  let failure;
  try {
    result = await item.attempt({ resend: true });
  } catch (error) {
    failure = error;
  }
  if (item.state === "settled") return true;
  if (!failure) {
    settle(item, "out");
    item.resolve(result);
    return true;
  }
  // Nothing of it here to send again (the engine started again meanwhile): it won't go out from here.
  if (failure?.data?.gone === true) {
    await endUnsent(item, host, item.stopping ?? "closed");
    return true;
  }
  if (item.stopping) {
    await leaveHandedOver(item, failure);
    return true;
  }
  // Turned down as it is: looked up again, and said not sent with why once the node still hasn't it.
  if (failure?.data?.sent === false && !unreachable(failure)) {
    if (item.refused) {
      await endUnsent(item, host, "failed", failure);
      return true;
    }
    item.refused = failure;
  }
  item.state = "unclear";
  return false;
}

// Waits for the network while payments wait for it, and sends them once it
// answers, one at a time, in their order. One that can't reach it again, or
// whose hand-over isn't clear yet, holds the ones after it.
async function follow(host) {
  if (looping) return;
  looping = true;
  const pending = () => queue.some((item) => item.state === "waiting" || item.state === "unclear");
  try {
    while (pending()) {
      await pause();
      if (!pending()) break;
      if (!(await host.answers().catch(() => false))) continue;
      for (const item of [...queue]) {
        if (item.state === "unclear") {
          if (!(await settleUnclear(item, host))) break;
          continue;
        }
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
        // Handed to the node, or maybe, with no clear answer: never kept as
        // not sent before the node's been asked. Only a try that never
        // handed it over (no ID kept for it) or that the node turned down is.
        const hash = await handedOverHash(item.sendId, failure);
        if (failure?.data?.sent !== false && (hash || failure?.data?.sent === "unknown")) {
          if (item.stopping) {
            await leaveHandedOver(item, failure);
            continue;
          }
          if (hash && checkedOnNode(item.record)) {
            // Looked up on the node once it answers, the ones after it held till then.
            item.state = "unclear";
            tellWaits(host, item.sendId, true, true);
            break;
          }
          // Its record goes once it's followed by its ID, never before.
          const followed = !hash || (typeof host.follow === "function" && (await host.follow({ record: item.record, hash, unclear: true }).then(() => true, () => false)));
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
 * Sends a payment from Send: kept first, then at once, unless payments
 * before it wait for the network; and where it couldn't reach the network
 * before it went out, or a public one was handed over without a clear
 * answer, once the network answers. Resolves with what `attempt` gives once
 * it's handed over, and rejects with why it wasn't sent: called off
 * (sendCancelled), the wallet locked or switched, what a try ran into, or,
 * for one that may have gone, with its ID.
 * @template T
 * @param {{ sendId: string, record: Omit<WaitingRecord, "sendId" | "at">, attempt: (opts?: { waited?: boolean, resend?: boolean, found?: { hash: string, nonce: string } }) => Promise<T>, host: WaitingHost }} send
 * @returns {Promise<T>}
 */
export async function sendWhenReachable({ sendId, record, attempt, host }) {
  const kept = { ...record, sendId, at: Date.now() };
  // Kept before anything else happens to it: a wallet that closes from here
  // on finds it, and says what came of it. Not kept, it isn't sent.
  try {
    await keep(kept);
  } catch (error) {
    throw notSent(error);
  }
  let unclear = false;
  if (!queue.length) {
    const first = { cancelled: false, handedOver: false };
    firstTries.set(sendId, first);
    try {
      const result = await attempt({ waited: false });
      await forget(sendId).catch(() => {});
      return result;
    } catch (error) {
      // Called off as it was tried: nothing went out, and it never waits after.
      if (first.cancelled && error?.data?.sent !== "unknown") {
        await forget(sendId).catch(() => {});
        throw sendCancelled();
      }
      // Handed over with no clear answer: a public one is looked up on the
      // node once it answers; a shielded one is followed by its ID (the
      // host keeps it so), and its record goes.
      if (error?.data?.sent === "unknown") {
        if (!checkedOnNode(kept) || !(await handedOverHash(sendId, error))) {
          await forget(sendId).catch(() => {});
          throw error;
        }
        unclear = true;
      } else if (!unreachableBeforeSent(error)) {
        await forget(sendId).catch(() => {});
        throw error;
      }
    } finally {
      firstTries.delete(sendId);
    }
  }
  return new Promise((resolve, reject) => {
    queue.push({ sendId, record: kept, attempt, resolve, reject, state: unclear ? "unclear" : "waiting", handedOver: unclear });
    tellWaits(host, sendId, true, unclear);
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
  // Handed over already: it may have gone out, and is looked up, not called off.
  if (item?.handedOver && item.state !== "settled") return false;
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
    if ((await keptRecord(id))?.hash) return false;
    forget(id).catch(() => {});
  }
  return true;
}

/**
 * Stops every payment waiting here, as the wallet locks, another wallet
 * opens, or the engine it runs in closes (Firefox's tab, which ends the
 * wallet open in it): a payment goes out only while the wallet it was made on is
 * open. Each that never went is kept as not sent, for Home to say so once the
 * wallet's open again, with Send it now and Don't send. One being tried as its
 * engine closed ends as its try does, kept as not sent unless it may have
 * gone; one handed over without a clear answer is kept with its ID, for the
 * node to be asked once the wallet's open again.
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
        const { cancelled } = engineGone || item.handedOver ? { cancelled: false } : await host.cancelInEngine(item.sendId).catch(() => ({ cancelled: false }));
        if (!cancelled) {
          item.stopping = why;
          return;
        }
      }
      // Over meanwhile, as its try ended.
      if (item.state === "settled") return;
      if (item.state === "unclear") {
        item.stopping = why;
        await leaveHandedOver(item);
        return;
      }
      settle(item, why);
      item.reject(sendCancelled(NOT_SENT_TEXT[why]));
    })
  );
  wake();
}

/**
 * The payments from Send kept for one wallet on one node, the oldest first,
 * for Home, Send and Review: those still waiting here (`waiting`; `waits`
 * while they wait for the network, not while one is being tried), those
 * handed over without a clear answer yet (`unclear`, waiting too: they may
 * still go out; `checks` once nothing here waits on one, and the node is
 * asked of it), and those that stopped waiting without going out (`ended`,
 * the wallet closed meanwhile where nothing says otherwise).
 * @param {{ walletId: string, nodeUrl: string }} of
 * @returns {Promise<Array<WaitingRecord & { waiting: boolean, waits: boolean, unclear?: boolean, checks?: boolean }>>}
 */
export async function waitingSendsOf({ walletId, nodeUrl }) {
  await writes;
  const kept = await readKept().catch(() => ({}));
  return Object.values(kept)
    .filter((record) => record?.walletId === walletId && record?.nodeUrl === nodeUrl)
    .map((record) => {
      const first = firstTries.get(record.sendId);
      if (first) return { ...record, ended: undefined, waiting: true, waits: false, ...(first.handedOver ? { unclear: true } : {}) };
      const item = queue.find((each) => each.sendId === record.sendId && each.state !== "settled");
      if (item) return { ...record, ended: undefined, waiting: true, waits: item.state === "waiting" || item.state === "unclear", ...(item.handedOver ? { unclear: true } : {}) };
      // Handed over as the wallet stopped: asked of the node once it answers (`checks`).
      if (record.hash) return { ...record, ended: undefined, waiting: true, waits: false, unclear: true, checks: true };
      return { ...record, ended: record.ended ?? "closed", waiting: false, waits: false };
    })
    .sort((a, b) => Number(a.at) - Number(b.at));
}

/**
 * Keeps a payment with the ID and nonce of the transaction about to be
 * handed to the node for it: the engine hands it over only once this is done
 * (setHandOverHook), and never one this can't keep. One nothing here waits on
 * any more, as the wallet's background started again meanwhile, is looked up
 * on the node once the engine's hand-over is over (followHandedOver).
 * @param {string} sendId
 * @param {{ hash: string, nonce?: string | bigint } | string} sent
 * @param {WaitingHost} host
 * @returns {Promise<boolean>} whether it's kept
 */
export async function noteHandingOver(sendId, sent, host) {
  const id = String(sendId ?? "");
  const { hash, nonce } = sent && typeof sent === "object" ? sent : { hash: sent };
  const txHash = String(hash ?? "");
  if (!id || !txHash) return false;
  const txNonce = /^\d+$/.test(String(nonce ?? "")) ? String(nonce) : "";
  const kept = await changeKept((all) => {
    if (!all[id]) return false;
    all[id] = { ...all[id], hash: txHash, ...(txNonce ? { nonce: txNonce } : {}) };
    return true;
  });
  if (!kept) return false;
  const first = firstTries.get(id);
  const item = queue.find((each) => each.sendId === id && each.state !== "settled");
  if (first) first.handedOver = true;
  if (item) item.handedOver = true;
  if (first || item) tellWaits(host, id, false, true);
  else await followHandedOver(host);
  return true;
}

// Each kept payment's look-up on the node now under way, and when the last began.
let lookingUp = null;
let lookedUpAt = -Infinity;

/**
 * Looks up on the node each payment kept as handed over that nothing here
 * waits on any more, as after the wallet's background or page stopped, or
 * the wallet locked, during its try. A public one found in the chain or the
 * node's mempool went: it's followed as a sent one, and its record goes. One
 * the node never had, its nonce unused (or used by another a while now), is
 * kept as not sent, with why the wallet stopped. One the node can't be asked
 * of waits for the next look, as does one the engine is still handing over
 * (`host.underWay`: it went on as the background started again), which may
 * reach the node yet. A shielded one, or one kept before nonces were, is
 * followed by its ID as a send with no clear answer. The page is told of each
 * one that changed.
 * @param {WaitingHost} host
 * @param {{ every?: number }} [opts] - not again within this many milliseconds of the last
 */
export async function followHandedOver(host, { every = 0 } = {}) {
  if (lookingUp) return lookingUp;
  if (every > 0 && Date.now() - lookedUpAt < every) return;
  lookedUpAt = Date.now();
  lookingUp = (async () => {
    await writes;
    const kept = await readKept().catch(() => ({}));
    for (const record of Object.values(kept)) {
      if (!record?.hash || active(record.sendId)) continue;
      try {
        // Still being handed over: neither said not sent nor followed, till it's done.
        if (typeof host.underWay === "function" && (await Promise.resolve().then(() => host.underWay(record.sendId)).catch(() => false))) continue;
        if (!checkedOnNode(record) || !record.account || !record.nonce || typeof host.check !== "function") {
          await host.follow({ record, hash: record.hash, unclear: true });
          await forget(record.sendId);
          continue;
        }
        const { state } = (await host.check(record).catch(() => null)) ?? { state: "unknown" };
        if (active(record.sendId)) continue;
        if (state === "in") {
          await host.follow({ record, hash: record.hash });
          await forget(record.sendId);
        } else if (state === "absent") {
          await host.release?.(record.sendId).catch(() => {});
          await endKept(record.sendId, record.stopped ?? "closed");
        } else if (state === "used" && Number(record.usedSince) > 0 && Date.now() - Number(record.usedSince) >= USED_FOR_MS) {
          await endKept(record.sendId, "failed", REPLACED_TEXT);
        } else if (state === "used") {
          if (!(Number(record.usedSince) > 0)) await patchKept(record.sendId, { usedSince: Date.now() });
          continue;
        } else {
          continue;
        }
        tellWaits(host, record.sendId, false);
      } catch {
        // Looked up next time.
      }
    }
  })().finally(() => {
    lookingUp = null;
  });
  return lookingUp;
}

/**
 * Don't send on Home, or Send it now, for a payment that wasn't sent:
 * forgotten. One still waiting here isn't: Cancel calls that off; nor one
 * handed over that may have gone, which the node is asked of.
 * @param {string} sendId
 */
export async function dropUnsent(sendId) {
  const id = String(sendId ?? "");
  if (!id || active(id)) return false;
  return changeKept((kept) => {
    if (kept[id]?.hash) return false;
    delete kept[id];
    return true;
  });
}

/**
 * Forgets what's kept of one wallet's payments that weren't sent, as the
 * wallet is removed: none still waiting goes on.
 * @param {string} walletId
 */
export async function forgetWalletUnsent(walletId) {
  await changeKept((kept) => {
    for (const [sendId, record] of Object.entries(kept)) {
      if (record?.walletId === walletId && !active(sendId)) delete kept[sendId];
    }
  });
}

/** Forgets every payment kept, as the wallet is reset. */
export async function clearWaitingSends() {
  await writes;
  await storage.remove(STORAGE_KEYS.WAITING_SENDS);
}
