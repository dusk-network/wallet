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
// stopped meanwhile it's said not sent, with Send it now and Don't send. Its
// nonce used, it's said not sent only once the account's transaction at that
// nonce is seen to be another: a nonce gone past it alone is no proof, and it
// stays looked up (Marek's: one the browser died on before it left, its nonce
// taken by the next send, was "on its way" for good). A
// shielded one, which has no nonce to tell by, is followed by its ID as a
// send with no clear answer (`host.follow`), never said not sent.
//
// A public payment that waited goes out by itself only where its account sent
// nothing else meanwhile (Chen's: one waiting on her first phone went out once
// the Wi-Fi came back, after she'd paid the same from her second): before it's
// made, the account's nonce now, its chain's or its mempool's, is set against
// the one the wallet saw as the person confirmed it, the wallet's own sends
// since counting as seen. Past it, the payment is held (`held`), said so, with
// Send it too and Don't send, and goes only on Send it too. One made already,
// sent again as it is, goes only while nothing else waits at its nonce.
//
// The wallet's background keeps the queue in the extension, the page in the
// app (wallet/localBus.js): `host` is how each reaches the engine, the node
// and its pages.

import { storage, STORAGE_KEYS } from "./storage.js";
import { SEND_CANCELLED_TEXT, unreachable, unreachableBeforeSent } from "./sendOutcome.js";

export { SEND_CANCELLED_TEXT };

/** How long a waiting payment waits before the network is asked again, where the browser doesn't say first that it's back. */
export const ASK_AGAIN_AFTER_MS = 5_000;

/** Why a waiting payment wasn't sent, as the wallet stopped waiting for it before the network answered. */
export const NOT_SENT_TEXT = Object.freeze({
  closed: "The wallet closed first. Nothing left your wallet.",
  locked: "The wallet locked first. Nothing left your wallet.",
  switched: "Another wallet was opened first. Nothing left your wallet.",
});

// Why the wallet stopped waiting on a payment that may have gone out.
const STOPPED_TEXT = Object.freeze({
  closed: "The wallet closed before the network answered.",
  locked: "The wallet locked before the network answered.",
  switched: "Another wallet was opened before the network answered.",
});

/** Why a payment handed over never went: its account's nonce went to another transaction. */
export const REPLACED_TEXT = "Another transaction from this account took its place, so nothing was sent.";

/** Why a payment that waited didn't go out by itself: its account sent something else meanwhile. */
export const SENT_MEANWHILE_TEXT = "Your account sent something else while this waited.";

/**
 * What's kept of a waiting payment: whose, on which network, profile and
 * account, and what it pays; `seenNonce`, its account's nonce as the wallet
 * saw it as the person confirmed it. `ended` once it no longer waits without
 * having gone out: "closed", "locked", "switched", or "failed" with the
 * `error` it ran into. `hash` and `nonce` once it's being handed to the node:
 * its transaction's ID and nonce; `stopped`, why the wallet stopped waiting
 * on it meanwhile. `held` while it waits for Send it too, its account having
 * sent something else meanwhile, and once it ended so; `checking`, since when
 * what its account sent meanwhile is read, while it is.
 * @typedef {{
 *   sendId: string, walletId: string, nodeUrl: string, profileIndex: number, account?: string,
 *   privacy: "public" | "shielded", to: string, toName?: string, lux: string,
 *   feeLux: string, memo: string, at: number, seenNonce?: string, hash?: string, nonce?: string,
 *   ended?: "closed" | "locked" | "switched" | "failed", error?: string,
 *   stopped?: "closed" | "locked" | "switched", held?: boolean, checking?: number,
 *   meanwhile?: Array<{ hash: string, to: string, lux: string, memo: string, at: number | null }>,
 * }} WaitingRecord
 */

/**
 * Where a payment handed over without a clear answer stands, as the node says
 * it (txLifecycle.js handedOverState): "in" the chain or the node's mempool;
 * "absent", nowhere and its nonce unused, so the node never had it;
 * "replaced", nowhere, and the account's transaction at its nonce seen, another;
 * "used", nowhere though its account's nonce went past it, nothing seen at
 * its nonce yet; "unknown" where the node couldn't be asked.
 * @typedef {{ state: "in" | "absent" | "replaced" | "used" | "unknown" }} HandedOverState
 */

/**
 * How the queue reaches the wallet: `attempt` is each payment's own, told
 * `waited` for a payment that waited, `resend` to send the transaction made
 * for it again as it is, or `found`, its transaction's ID and nonce, where
 * the node has it. `follow` keeps a payment handed over as a sent one, looked
 * up by its ID (`unclear` while it isn't known to have gone); `check` asks
 * the node where one handed over stands; `release` tells the engine a payment
 * it handed over never went, so its nonce is free again; `underWay`, whether
 * the engine is handing one over still, as after the background started again;
 * `changed`, that a payment began its first try, which hasn't reached the node.
 * `nonceNow`, the account's nonce as the node has it now, its mempool's
 * included; `chainNonce`, as its chain has it alone, which the engine counts
 * a new transaction's from; `ownNonce`, the last one the wallet's own sends
 * took, or null; `meanwhile`, what the account sent at the nonces after
 * `after` up to `upTo`, as far as the node says it (txLifecycle.js
 * sentMeanwhileOf).
 * @typedef {{
 *   answers: () => Promise<boolean>,
 *   cancelInEngine: (sendId: string) => Promise<{ cancelled: boolean }>,
 *   follow: (handedOver: { record: WaitingRecord, hash: string, unclear?: boolean }) => Promise<void>,
 *   check?: (record: WaitingRecord) => Promise<HandedOverState>,
 *   release?: (sendId: string) => Promise<unknown>,
 *   underWay?: (sendId: string) => Promise<boolean>,
 *   nonceNow?: (record: WaitingRecord) => Promise<bigint | string>,
 *   chainNonce?: (record: WaitingRecord) => Promise<bigint | string>,
 *   ownNonce?: (record: WaitingRecord) => Promise<bigint | string | null>,
 *   meanwhile?: (record: WaitingRecord, range: { after: bigint, upTo: bigint }) => Promise<Array<object>>,
 *   tell: (message: object) => void,
 * }} WaitingHost
 */

/**
 * What's kept of a payment from Send as it waits, from the message Send sent
 * (DUSK_UI_SEND_TX): whose, on which network, profile and account its Review
 * was for, what it pays, the most its fee costs (`feeCapLux`), and its
 * account's nonce as the Review read it (`seenNonce`).
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
    ...(/^\d+$/.test(String(message?.seenNonce ?? "")) ? { seenNonce: String(message.seenNonce) } : {}),
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

// One called off as another is sent in its place: nothing's said of it.
function inPlaceOf(error) {
  error.data = { ...error.data, inPlace: true };
  return error;
}

// The payments waiting here, the oldest first: { sendId, record, attempt,
// resolve, reject, state: "waiting" | "sending" | "unclear" | "held" |
// "replacing" | "settled", handedOver, stopping, refused, heldAt, accepted,
// replacing }. "unclear": handed over without a clear answer, to be looked up
// on the node; "held": its account sent something else while it waited, the
// nonce then (`heldAt`), and it waits for Send it too, which takes that as
// seen (`accepted`); "replacing": held, and another being sent in its place
// from Send it too's Review (that one's `replacing`), till that one goes out.
const queue = [];
// Payments being tried the first time, before any waited, by their ID, with
// what's kept of them (`record`): one called off meanwhile (`cancelled`) never
// waits after its try; one handed over (`handedOver`) isn't said to have
// nothing gone.
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

// Forgotten, and the payment it took the place of (`prior`, sent again from
// Home's Send it now) back in its place: it never went out either.
const forgetFor = (sendId, prior) =>
  changeKept((kept) => {
    delete kept[sendId];
    if (prior?.sendId && !kept[prior.sendId]) kept[prior.sendId] = prior;
  });

/** What a payment sent again in another's place says where it isn't that payment, from where it was made. */
export const NOT_IN_PLACE_TEXT = "The wallet, profile or network changed. Check the send again.";

// The same payment from the same place: wallet, network, profile and account,
// to whom, how much, with what memo, public or shielded. The account where
// the one kept names one: an earlier version's kept none, and its wallet and
// profile say whose it is (issue #214: Send it now refused such a payment as
// "changed").
const SAME_PAYMENT = ["walletId", "nodeUrl", "profileIndex", "account", "privacy", "to", "lux", "memo"];
const samePayment = (kept, again) => SAME_PAYMENT.every((key) => (key === "account" && !kept?.account) || String(kept?.[key] ?? "") === String(again?.[key] ?? ""));

// Kept, in place of the payment Home said wasn't sent that it sends again
// (`replaces`): that one, as it was, or null where it isn't one to replace.
// Another payment, or one from another wallet, profile or network, is refused,
// and the one Home said wasn't sent stays as it was.
const replacingNow = (sendId) => queue.some((item) => item.sendId === sendId && item.state === "replacing");
const keepInPlace = (record, replaces) =>
  changeKept((kept) => {
    const prior = replaces && replaces !== record.sendId && kept[replaces] && !kept[replaces].hash && (!active(replaces) || replacingNow(replaces)) ? kept[replaces] : null;
    if (prior && !samePayment(prior, record)) throw new Error(NOT_IN_PLACE_TEXT);
    if (prior) delete kept[replaces];
    kept[record.sendId] = record;
    return prior;
  });

// Gone out after it waited: kept, with its transaction's ID, as went, for
// Home to say Sent till its block is in and the balance read since
// (forgetWent), so it never drops out of both Home and Activity as it goes
// (Lena's: no card, no payment and the old balance for 20 s). One with no ID
// kept is forgotten.
const keepWent = (sendId) =>
  changeKept((kept) => {
    const record = kept[sendId];
    if (!record?.hash) {
      delete kept[sendId];
      return;
    }
    const { ended: _ended, error: _error, stopped: _stopped, held: _held, ...went } = record;
    kept[sendId] = { ...went, went: Date.now() };
    wentAfter.set(sendId, ++steps);
  });

// Reads of the wallet's sends begun, and payments kept as went, in order, in
// this life of the queue: a read knows nothing of a payment that went out
// after it began (forgetWent). One that went in an earlier life went before
// any read now.
let steps = 0;
const wentAfter = new Map();

/**
 * Marks a read of the wallet's sends as it begins, for forgetWent.
 * @returns {number}
 */
export const sendsReadBegins = () => ++steps;

// Kept as not sent: whatever was being handed over for it never went.
const endKept = (sendId, ended, error = "") =>
  changeKept((kept) => {
    if (!kept[sendId]) return;
    // (`usedSince`: kept by an earlier version.)
    const { hash: _hash, nonce: _nonce, stopped: _stopped, usedSince: _usedSince, ...record } = kept[sendId];
    kept[sendId] = { ...record, ended, ...(error ? { error } : {}) };
  });

// ----------------------------------------------------------------------------
// The queue
// ----------------------------------------------------------------------------

// The page told whether a payment waits for the network (`waits`), once it
// was handed over (`handedOver`): from then on it may have gone out; and
// while it's held for Send it too (`held`).
const tellWaits = (host, sendId, waits, handedOver = false, held = false) => {
  try {
    host.tell({ type: "DUSK_UI_SEND_WAITING", sendId, waits, ...(handedOver ? { handedOver: true } : {}), ...(held ? { held: true } : {}) });
  } catch {
    // No page to tell.
  }
};

// A nonce as a bigint, or null.
const nonceOf = (value) => (/^\d+$/.test(String(value ?? "")) ? BigInt(String(value)) : null);

/**
 * Whether a public payment's account sent something else since the person
 * confirmed it, before it goes out by itself: its nonce now (the node's
 * chain's, or its mempool's) past the one seen then. Seen: the nonce the
 * Review read, what Send it too took as seen since, and the wallet's own
 * sends; for one made already (`signed`, its `record` as kept with its
 * transaction's nonce), the nonce before its own. The nonce it's past, or
 * null where nothing else was sent or there's nothing to tell by (a shielded
 * payment, or no nonce seen); "unknown" where the node couldn't say.
 * @returns {Promise<bigint | null | "unknown">}
 */
async function sentMeanwhile(item, host, { record = item.record, signed = false } = {}) {
  if (!checkedOnNode(record) || !record.account || typeof host.nonceNow !== "function") return null;
  const own = signed ? null : nonceOf(await Promise.resolve().then(() => host.ownNonce?.(record)).catch(() => null));
  const made = signed ? nonceOf(record.nonce) : null;
  const seen = [signed ? (made === null ? null : made - 1n) : nonceOf(record.seenNonce), own, item.accepted ?? null].filter((nonce) => typeof nonce === "bigint");
  if (!seen.length) return null;
  const now = nonceOf(await Promise.resolve().then(() => host.nonceNow(record)).catch(() => null));
  if (now === null) return "unknown";
  if (!seen.every((nonce) => now > nonce)) return null;
  // What it's past: the account's nonce the wallet knew of last, whatever sent
  // after it being what the account sent meanwhile (hold).
  item.seenUpTo = seen.reduce((a, b) => (b > a ? b : a));
  return now;
}

// Sent it too past another transaction of its account (`accepted`), which
// the node's mempool may hold still: built once the chain has it, or the
// mempool no longer does. Built before, it would take that transaction's
// nonce, as the engine counts a new one's from the chain's (Astra's). Where
// the node can't say, not yet.
async function pastAccepted(item, host) {
  if (item.accepted == null || typeof host.chainNonce !== "function") return true;
  const chain = nonceOf(await Promise.resolve().then(() => host.chainNonce(item.record)).catch(() => null));
  if (chain === null) return false;
  if (chain >= item.accepted) return true;
  const now = nonceOf(await Promise.resolve().then(() => host.nonceNow?.(item.record)).catch(() => null));
  return now !== null && now <= chain;
}

// Held, its account having sent something else meanwhile (`now`, its nonce
// then): it goes out only on Send it too, and the page is told. What the
// account sent meanwhile is read from the node, as far as it says it, and
// kept with it (`meanwhile`), for Home and Sent to name: what, to whom, with
// what memo and when (Marek's, Lena's, Chen's: "something else" was the
// very same payment, made on another device). While it's read (`checking`,
// since when), the hold says so, its answers off (Chen's and Marek's: "something
// else", Send it too live, for the 8 to 10 seconds before it named this same
// payment); with the answer, or what's known once the node's had its time, they're on.
async function hold(item, host, now) {
  item.state = "held";
  item.heldAt = now;
  await changeKept((kept) => {
    if (kept[item.sendId]) kept[item.sendId] = { ...kept[item.sendId], held: true, checking: Date.now() };
  }).catch(() => {});
  tellWaits(host, item.sendId, false, false, true);
  const named = await sentWhileHeld(item, host, now);
  await changeKept((kept) => {
    if (!kept[item.sendId]) return;
    const { checking: _checking, ...record } = kept[item.sendId];
    kept[item.sendId] = named.length && item.state === "held" ? { ...record, meanwhile: named } : record;
  }).catch(() => {});
  if (item.state === "held") tellWaits(host, item.sendId, false, false, true);
}

/** How long the node is given to say what an account sent while a payment waited: its hold says it checks meanwhile. */
export const MEANWHILE_READ_MS = 10_000;

// What the account sent after the nonce the wallet knew of last, up to `now`,
// as the node says it within MEANWHILE_READ_MS; none where it doesn't.
async function sentWhileHeld(item, host, now) {
  if (item.seenUpTo == null || typeof host.meanwhile !== "function") return [];
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve([]), MEANWHILE_READ_MS);
  });
  const read = Promise.resolve().then(() => host.meanwhile(item.record, { after: item.seenUpTo, upTo: now })).catch(() => []);
  const said = await Promise.race([read, late]).finally(() => clearTimeout(timer));
  return (Array.isArray(said) ? said : [])
    .filter((sent) => sent && typeof sent === "object" && /^\d+$/.test(String(sent.lux ?? "")))
    .map(({ hash, to, lux, memo, at }) => ({ hash: String(hash ?? ""), to: String(to ?? ""), lux: String(lux), memo: String(memo ?? ""), at: Number(at) || null }));
}

// Out of the queue, its record kept as `how` says: kept as went once it went
// out; forgotten once it was called off with Don't send, or is followed by
// its transaction's ID; kept as not sent otherwise. One called off that took the place of a
// payment Home said wasn't sent gives that payment its place back; one sent
// in the place of a held one (`replacing`) that never went out, called off or
// turned down, gives it back held; one that went, that one goes.
function settle(item, how, error) {
  item.state = "settled";
  const at = queue.indexOf(item);
  if (at >= 0) queue.splice(at, 1);
  const held = item.replacing;
  if (how === "cancelled" || (how === "failed" && held?.state === "replacing")) {
    return forgetFor(item.sendId, item.prior)
      .then(() => heldAgain(held, item.host))
      .catch(() => {});
  }
  if (how === "out") {
    replacedBy(held);
    return keepWent(item.sendId).catch(() => {});
  }
  if (how === "followed") {
    replacedBy(held);
    return forget(item.sendId).catch(() => {});
  }
  return endKept(item.sendId, how, how === "failed" ? String(error?.message ?? error ?? "") : "").catch(() => {});
}

// A payment held for Send it too that another was sent in the place of, from
// its Review: out of the queue once that one went out, or may have, said not
// sent, in its place. Its record went as that one was kept in its place.
function replacedBy(held) {
  if (held?.state !== "replacing") return;
  held.state = "settled";
  const at = queue.indexOf(held);
  if (at >= 0) queue.splice(at, 1);
  held.reject(inPlaceOf(sendCancelled()));
}

// ... and held again, as it was, where that one never went out, called off or
// turned down (its balance, its gas): its record back in its place first
// (forgetFor), then Send it too and Don't send again (Astra's: it was gone
// with the one turned down).
function heldAgain(held, host) {
  if (held?.state !== "replacing") return;
  held.state = "held";
  if (host) tellWaits(host, held.sendId, false, false, true);
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
// made for it goes out again, once, as it is; the account's transaction at
// its nonce seen to be another, it never will; its nonce gone past it alone,
// it's looked up again. Whether the ones after it may go now: not while this
// one's still unclear.
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
  if (state === "replaced") {
    await endUnsent(item, host, "failed", item.refused ?? new Error(REPLACED_TEXT));
    return true;
  }
  if (state !== "absent") return false;
  // Made already, it goes again only while nothing else of its account waits
  // at its nonce: another there takes its place once it's in a block.
  const meanwhile = await sentMeanwhile(item, host, { record, signed: true });
  if (item.state !== "unclear") return true;
  if (meanwhile !== null) return false;
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
// whose hand-over isn't clear yet, holds the ones after it; one held for Send
// it too doesn't. `now`: the network's asked at once, without the pause.
async function follow(host, { now = false } = {}) {
  if (looping) return;
  looping = true;
  const pending = () => queue.some((item) => item.state === "waiting" || item.state === "unclear");
  let paused = !now;
  try {
    while (pending()) {
      if (paused) await pause();
      paused = true;
      if (!pending()) break;
      if (!(await host.answers().catch(() => false))) continue;
      for (const item of [...queue]) {
        if (item.state === "unclear") {
          if (!(await settleUnclear(item, host))) break;
          continue;
        }
        if (item.state !== "waiting") continue;
        // Its account sent something else since it was confirmed: held for
        // Send it too, never sent by itself. Where the node can't say, asked
        // again on the next round.
        const meanwhile = await sentMeanwhile(item, host);
        if (item.state !== "waiting") continue;
        if (meanwhile === "unknown") break;
        if (meanwhile !== null) {
          await hold(item, host, meanwhile);
          continue;
        }
        // Sent it too: after the other transaction, never at its nonce. It
        // and the ones after it wait for the next round.
        if (!(await pastAccepted(item, host))) break;
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
 * for one that may have gone, with its ID. One sent again from Home's Send
 * it now (`replaces`, the one Home said wasn't sent) takes its place there,
 * and gives it back where it never went out.
 * @template T
 * @param {{ sendId: string, record: Omit<WaitingRecord, "sendId" | "at">, attempt: (opts?: { waited?: boolean, resend?: boolean, found?: { hash: string, nonce: string } }) => Promise<T>, host: WaitingHost, replaces?: string }} send
 * @returns {Promise<T>}
 */
export async function sendWhenReachable({ sendId, record, attempt, host, replaces = "" }) {
  const kept = { ...record, sendId, at: Date.now() };
  // Send it too, from its Review: sent in the place of the one held for it.
  // That one stays held, out of reach, till this one goes out, and goes then,
  // said not sent in its place; where this one never goes out, it's held
  // again, as it was (Astra's: one turned down for its balance or gas took
  // the held payment with it).
  const held = replaces ? queue.find((item) => item.sendId === String(replaces) && item.state === "held") : null;
  if (held) held.state = "replacing";
  // Kept before anything else happens to it: a wallet that closes from here
  // on finds it, and says what came of it. Not kept, it isn't sent.
  let prior;
  try {
    prior = await keepInPlace(kept, String(replaces ?? ""));
  } catch (error) {
    heldAgain(held, host);
    throw notSent(error);
  }
  let unclear = false;
  if (!queue.some((item) => item !== held)) {
    const first = { cancelled: false, handedOver: false, record: kept, replacing: held };
    firstTries.set(sendId, first);
    host.changed?.();
    try {
      const result = await attempt({ waited: false });
      await forget(sendId).catch(() => {});
      replacedBy(held);
      return result;
    } catch (error) {
      // Called off as it was tried: nothing went out, and it never waits after.
      if (first.cancelled && error?.data?.sent !== "unknown") {
        await forgetFor(sendId, prior).catch(() => {});
        heldAgain(held, host);
        throw sendCancelled();
      }
      // Handed over with no clear answer: a public one is looked up on the
      // node once it answers; a shielded one is followed by its ID (the
      // host keeps it so), and its record goes. What it was sent in the
      // place of goes: it may have gone out.
      if (error?.data?.sent === "unknown") {
        replacedBy(held);
        if (!checkedOnNode(kept) || !(await handedOverHash(sendId, error))) {
          await forget(sendId).catch(() => {});
          throw error;
        }
        unclear = true;
      } else if (!unreachableBeforeSent(error)) {
        // Turned down: Send said why, and one sent again from Home is said
        // not sent there again, as it was, as is one held.
        await forgetFor(sendId, first.handedOver ? null : prior).catch(() => {});
        if (first.handedOver) replacedBy(held);
        else heldAgain(held, host);
        throw error;
      }
    } finally {
      firstTries.delete(sendId);
    }
  }
  return new Promise((resolve, reject) => {
    queue.push({ sendId, record: kept, attempt, resolve, reject, state: unclear ? "unclear" : "waiting", handedOver: unclear, prior: unclear ? null : prior, ...(held && !unclear ? { replacing: held, host } : {}) });
    tellWaits(host, sendId, true, unclear);
    wake();
    follow(host).catch(() => {});
  });
}

/**
 * Don't send on a waiting payment from Send: called off unless it was handed
 * to the node already, which the engine settles. One waiting here says so to
 * whoever waits on it; one not waiting here any more (not sent, from before)
 * is forgotten. Whether it was called off.
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
  // Between tries, or held for Send it too (its Don't send): nothing of it is
  // under way, and nothing will be.
  if (item?.state === "waiting" || item?.state === "held") {
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
 * Send it too, on a payment held as its account sent something else while it
 * waited: what was sent till then counts as seen, and it goes out as the
 * network answers, as one that waited does. Whether one was held here.
 * @param {string} sendId
 * @param {WaitingHost} host
 * @returns {Promise<boolean>}
 */
export async function sendHeld(sendId, host) {
  const item = queue.find((each) => each.sendId === String(sendId ?? "") && each.state === "held");
  if (!item) return false;
  item.accepted = item.heldAt;
  item.state = "waiting";
  await changeKept((kept) => {
    if (!kept[item.sendId]) return;
    const { held: _held, ...record } = kept[item.sendId];
    kept[item.sendId] = record;
  }).catch(() => {});
  tellWaits(host, item.sendId, true);
  wake();
  follow(host, { now: true }).catch(() => {});
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
 * The payments here that haven't been handed to the node: on their first
 * try, waiting for the network, or being made to go out again. Each one's
 * ID, wallet and node, the first tries first. In the app, which sends only
 * while it's open, Android's notice says so while the app's away
 * (wallet/localBus.js).
 * @returns {{ sendId: string, walletId: string, nodeUrl: string }[]}
 */
export function waitingForNetwork() {
  const of = (sendId, record) => ({
    sendId,
    walletId: String(record?.walletId ?? ""),
    nodeUrl: String(record?.nodeUrl ?? ""),
    // What it pays and to whom, for its notice where the phone shows one whole.
    to: String(record?.to ?? ""),
    toName: String(record?.toName ?? ""),
    lux: String(record?.lux ?? ""),
    memo: String(record?.memo ?? ""),
  });
  return [
    ...[...firstTries].filter(([, first]) => !first.handedOver && !first.cancelled).map(([sendId, first]) => of(sendId, first.record)),
    ...queue.filter((item) => (item.state === "waiting" || item.state === "sending") && !item.handedOver).map((item) => of(item.sendId, item.record)),
  ];
}

/**
 * The payments from Send kept for one wallet on one node, the oldest first,
 * for Home, Send and Review: those still waiting here (`waiting`; `waits`
 * while they wait for the network, not while one is being tried), those
 * handed over without a clear answer yet (`unclear`, waiting too: they may
 * still go out; `checks` once nothing here waits on one, and the node is
 * asked of it), those held for Send it too as their account sent something
 * else meanwhile (`held`, waiting too), and those that stopped waiting
 * without going out (`ended`, the wallet closed meanwhile where nothing says
 * otherwise; `held` where it was held as it stopped), and those gone out after
 * they waited (`went`, when), said Sent till their block's in (forgetWent).
 * @param {{ walletId: string, nodeUrl: string }} of
 * @returns {Promise<Array<WaitingRecord & { waiting: boolean, waits: boolean, unclear?: boolean, checks?: boolean, held?: boolean, went?: number }>>}
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
      if (item?.state === "held") return { ...record, ended: undefined, waiting: true, waits: false, held: true };
      if (item) {
        const { held: _held, ...waiting } = record;
        return { ...waiting, ended: undefined, waiting: true, waits: item.state === "waiting" || item.state === "unclear", ...(item.handedOver ? { unclear: true } : {}) };
      }
      // Gone out after it waited: said Sent till its block's in and the balance read.
      if (record.went) return { ...record, ended: undefined, waiting: false, waits: false };
      // Handed over as the wallet stopped: asked of the node once it answers (`checks`).
      if (record.hash) return { ...record, ended: undefined, waiting: true, waits: false, unclear: true, checks: true };
      return { ...record, ended: record.ended ?? "closed", waiting: false, waits: false };
    })
    .sort((a, b) => Number(a.at) - Number(b.at));
}

/** How long a payment gone out after it waited is said Sent, at most. */
export const WENT_FOR_MS = 15 * 60_000;

/**
 * Forgets the payments said Sent on Home after they waited, of one wallet on
 * one node, whose transaction's done and the balance read since: its record
 * among the wallet's sends final, or gone from them as the chain's history
 * has it now; and any said Sent longer than WENT_FOR_MS. Nothing where the
 * sends couldn't be read (`txs` null), or the balance wasn't; nor of one gone
 * out after the sends began to be read (`read`, sendsReadBegins), which they
 * can't have (Lena's: gone out as Home read the wallet, it went from Home by
 * the sends read before, and was in neither for 20 s).
 * @param {{ walletId: string, nodeUrl: string }} of
 * @param {Array<{ hash?: string, status?: string }> | null} txs - the wallet's sends, read before the balance
 * @param {{ balanceRead?: boolean, read?: number }} [opts] - whether the balance was read after them, and
 *   when their read began, as sendsReadBegins said: now where it's not said
 */
export async function forgetWent({ walletId, nodeUrl }, txs, { balanceRead = true, read = steps } = {}) {
  await writes;
  const kept = await readKept().catch(() => ({}));
  const status = new Map((Array.isArray(txs) ? txs : []).map((tx) => [String(tx?.hash ?? ""), String(tx?.status ?? "")]));
  const now = Date.now();
  const done = (record) => {
    if (now - Number(record.went) > WENT_FOR_MS) return true;
    if (!Array.isArray(txs) || !balanceRead || (wentAfter.get(record.sendId) ?? 0) > read) return false;
    const said = status.get(String(record.hash));
    return said === undefined || ["executed", "failed", "removed"].includes(said);
  };
  const gone = Object.values(kept)
    .filter((record) => record?.went && record.walletId === walletId && record.nodeUrl === nodeUrl && done(record))
    .map((record) => record.sendId);
  if (!gone.length) return;
  await changeKept((all) => {
    for (const sendId of gone) if (all[sendId]?.went) delete all[sendId];
  });
  for (const sendId of gone) wentAfter.delete(sendId);
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
  // Handed over: what it took the place of never comes back.
  if (item) Object.assign(item, { handedOver: true, prior: null });
  replacedBy(first?.replacing ?? item?.replacing);
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
 * the node never had, its nonce unused, is kept as not sent, with why the
 * wallet stopped; one whose nonce the account's transaction seen at it took,
 * as not sent, with that. One whose nonce is gone past it with nothing seen
 * at it yet, or the node can't be asked of, waits for the next look, as does one the engine is still handing over
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
      if (!record?.hash || record.went || active(record.sendId)) continue;
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
        } else if (state === "replaced") {
          await host.release?.(record.sendId).catch(() => {});
          await endKept(record.sendId, "failed", REPLACED_TEXT);
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
 * forgotten. One still waiting here isn't: its own Don't send calls that
 * off; nor one handed over that may have gone, which the node is asked of.
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
