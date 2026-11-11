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
// a no. An arrival then is kept for the answer (`later`), shown with a yes.
// Firefox wakes the wallet for that word, so it's lost only with Firefox
// itself, and the question with it (questionGone).

import { getSettings, setSettings } from "./settings.js";
import { networkTextOf } from "./nodeNetwork.js";
import { TX_KIND } from "./constants.js";

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

/**
 * Where notices stand, for Sent.
 * @param {() => Promise<boolean>} [allowedNow] - the app's: whether Android lets it show one now
 * @returns {Promise<"asked" | "on" | "off" | "off-said" | null>}
 */
export async function noticesState(allowedNow) {
  return forSent(await kept(), allowedNow);
}

/**
 * A send's notice on a phone, as its lock screen shows it: what came of it,
 * never its amount or whom it was for, and its network.
 * @param {{ kind?: string, ok: boolean, nodeUrl?: string }} sent
 * @returns {{ title: string, network: string }}
 */
export function arrivalNotice({ kind, ok, nodeUrl }) {
  const what = String(kind ?? "") === TX_KIND.TRANSFER ? "payment" : "transaction";
  const title = ok ? (what === "payment" ? "Your payment arrived" : "Your transaction went through") : `Your ${what} didn't go through`;
  return { title, network: nodeUrl ? networkTextOf(String(nodeUrl)) : "" };
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
 * Firefox, notices off: the person tapped Ask again, so Firefox asks once
 * more. Never by itself.
 * @param {() => Promise<unknown>} ask - Firefox's question: its notice that asks
 */
export async function askForNoticesAgain(ask) {
  const again = await inTurn(async () => {
    if (!["off", "off-said"].includes(await kept())) return false;
    await keep("asked");
    return true;
  });
  if (again) await ask().catch(() => {});
  return noticesState();
}

/**
 * Firefox's word on its notice that asked, the first it gives: shown ("on"),
 * or taken away without showing ("off"). Taken away once shown is a swipe.
 * @param {"on" | "off"} answer
 * @param {() => Promise<object[]>} [takeLater] - the arrivals kept for the answer, taken as it's kept
 * @returns {Promise<object[]>} those arrivals, to show with a yes
 */
export function noticeAnswered(answer, takeLater) {
  return inTurn(async () => {
    if ((await kept()) !== "asked") return [];
    await keep(answer);
    return (await takeLater?.()) ?? [];
  });
}

/**
 * Firefox started: a question still asked went with the Firefox before,
 * unanswered, so it's not asked, and Sent offers the tap again.
 */
export function questionGone() {
  return inTurn(async () => {
    if ((await kept()) === "asked") await keep(null);
  });
}

/**
 * Whether a payment's arrival may show as a notice now.
 * @param {() => Promise<boolean>} [allowedNow] - the app's
 * @param {() => Promise<void>} [later] - Firefox's: keeps the arrival for the answer to the question on screen
 */
export function mayNotify(allowedNow, later) {
  return inTurn(async () => {
    const state = await kept();
    if (!state) return false;
    if (allowedNow) return allowedNow().catch(() => false);
    if (state === "asked") await later?.();
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
