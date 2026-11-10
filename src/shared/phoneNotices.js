// Arrival notices on a phone, Firefox for Android's and the app's: asked for
// only when the person taps Tell me when it arrives on Sent, never by the
// wallet itself, and never again after a no.
//
// The question is the phone's: Android asks the app's leave to show notices.
// The app hears the answer at once ("on" or "off"). Firefox doesn't tell an
// add-on what was answered, so its question is the first notice itself, and
// whether that notice is still there when a payment arrives says whether
// notices may show ("asked", then "on" or "off"). Once off, Sent says so,
// once ("off-said"), and how to turn them on in the phone's settings.

import { getSettings, setSettings } from "./settings.js";

const STATES = new Set(["asked", "on", "off", "off-said"]);

/** Where arrival notices stand: null till the person asked for them. */
export async function noticesState() {
  const state = (await getSettings().catch(() => ({})))?.phoneNotices;
  return STATES.has(state) ? state : null;
}

/**
 * The person tapped Tell me when it arrives: the phone asked, once.
 * @param {() => Promise<"asked" | "on" | "off">} ask - the phone's question
 * @returns {Promise<string>} where notices stand after it
 */
export async function askForNotices(ask) {
  const state = await noticesState();
  if (state) return state;
  // Asked before the question shows: a second tap meanwhile asks nothing.
  await setSettings({ phoneNotices: "asked" });
  const answer = await ask().catch(() => "asked");
  if (answer !== "asked") await setSettings({ phoneNotices: answer });
  return answer;
}

/**
 * Whether a payment's arrival may show as a notice now. Asked, and not
 * answered in a way the wallet heard, `check` says whether notices show.
 * @param {() => Promise<boolean>} check
 */
export async function mayNotify(check) {
  const state = await noticesState();
  if (state === "on") return true;
  if (state !== "asked") return false;
  const on = await check().catch(() => false);
  await setSettings({ phoneNotices: on ? "on" : "off" });
  return on;
}

/** Sent said notices are off: it doesn't again. */
export async function saidNoticesOff() {
  if ((await noticesState()) === "off") await setSettings({ phoneNotices: "off-said" });
}
