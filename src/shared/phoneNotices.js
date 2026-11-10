// Arrival notices on a phone, Firefox for Android's and the app's: asked for
// only when the person taps Tell me when it arrives on Sent, and only once,
// whatever they answer.
//
// Where they stand is kept (settings.phoneNotices):
// - null: not asked;
// - "asked": asked; in Firefox, its question is on screen till Firefox says
//   what its notice that asked did;
// - "on" / "off": that notice showed, or was taken away without showing, as
//   after a no (noticeAnswered);
// - "off-said": Sent said they're off, once.
// Whether an arrival shows is read as it comes: the app reads Android's leave
// as it is then (`allowedNow`, which never asks), so allowing notices in the
// phone's settings later is enough. Firefox can't be asked whether it may
// without asking Android, so it goes by what its notice that asked did, and
// makes no other notice while its question is on screen: Firefox keeps one
// notice's answer, the last made, and the notice that asked would never hear
// a no. Firefox wakes the wallet for that word, so it's lost only with
// Firefox itself, and the question with it (questionGone).

import { getSettings, setSettings } from "./settings.js";

const STATES = new Set(["asked", "on", "off", "off-said"]);

// One read, check and write at a time, in the order they come: a tap,
// Firefox's word on its notice and arrivals each see what the one before kept.
let queue = Promise.resolve();
function inTurn(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

async function kept() {
  const state = (await getSettings().catch(() => ({})))?.phoneNotices;
  return STATES.has(state) ? state : null;
}

const keep = (state) => setSettings({ phoneNotices: state });

// What Sent says of what's kept: in the app, by Android's leave now.
async function forSent(state, allowedNow) {
  if (!state || !allowedNow) return state;
  if (await allowedNow().catch(() => false)) return "on";
  return state === "off-said" ? state : "off";
}

// Who waits for Firefox's word on the question on screen (questionAnswered).
const waiting = new Set();
function wake() {
  for (const resolve of waiting) resolve();
  waiting.clear();
}

// While Firefox's question is on screen, its answer first.
async function questionAnswered() {
  for (;;) {
    let heard;
    const word = new Promise((resolve) => waiting.add((heard = resolve)));
    if ((await kept()) !== "asked") {
      waiting.delete(heard);
      return;
    }
    await word;
  }
}

/**
 * Where notices stand, for Sent.
 * @param {() => Promise<boolean>} [allowedNow] - the app's: whether Android lets it show one now
 * @returns {Promise<"asked" | "on" | "off" | "off-said" | null>}
 */
export async function noticesState(allowedNow) {
  return forSent(await kept(), allowedNow);
}

/**
 * The person tapped Tell me when it arrives: the phone asks, the first time.
 * @param {() => Promise<unknown>} ask - the phone's question
 * @param {() => Promise<boolean>} [allowedNow] - the app's
 */
export async function askForNotices(ask, allowedNow) {
  const first = await inTurn(async () => {
    if (await kept()) return false;
    await keep("asked");
    return true;
  });
  if (first) await ask().catch(() => {});
  return noticesState(allowedNow);
}

/**
 * Firefox's word on its notice that asked, the first it gives: shown ("on"),
 * or taken away without showing ("off"). Taken away once shown is a swipe.
 * @param {"on" | "off"} answer
 */
export function noticeAnswered(answer) {
  return inTurn(async () => {
    if ((await kept()) === "asked") await keep(answer);
  }).finally(wake);
}

/**
 * Firefox started: a question still asked went with the Firefox before,
 * unanswered, so it's not asked, and Sent offers the tap again.
 */
export function questionGone() {
  return inTurn(async () => {
    if ((await kept()) === "asked") await keep(null);
  }).finally(wake);
}

/**
 * Whether a payment's arrival may show as a notice now.
 * @param {() => Promise<boolean>} [allowedNow] - the app's
 */
export async function mayNotify(allowedNow) {
  if (!allowedNow) await questionAnswered();
  return inTurn(async () => {
    const state = await kept();
    if (!state) return false;
    if (allowedNow) return allowedNow().catch(() => false);
    return state === "on";
  });
}

/**
 * Sent said notices are off: it doesn't again.
 * @param {() => Promise<boolean>} [allowedNow] - the app's
 */
export function saidNoticesOff(allowedNow) {
  return inTurn(async () => {
    if ((await forSent(await kept(), allowedNow)) === "off") await keep("off-said");
  });
}
