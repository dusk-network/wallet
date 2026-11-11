// Fingerprint unlock in the app on Android (apps/tauri, android/KeystorePlugin.kt):
// the password kept only encrypted under a Keystore key that a fresh
// fingerprint opens. Everywhere else there's none, and each answer says so.
//
// Android's prompt is a window over the app's, which stays in front: no leaving
// the app, so Lock: Immediately doesn't lock under it.
//
// Every answer is { ok, reason? }: reason "password" when the person chose
// their password instead, "invalidated" when the phone's fingerprints changed
// since it was turned on (it's off then), "off", "unavailable" or "error".

import { isTauriRuntime } from "./runtime.js";

async function ask(action, args = {}) {
  if (!isTauriRuntime()) return { ok: false, reason: "unavailable" };
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const answer = await invoke("fingerprint", { action, args });
    return answer && typeof answer === "object" ? answer : { ok: false, reason: "error" };
  } catch {
    return { ok: false, reason: "error" };
  }
}

/**
 * Whether this phone can guard the password with a fingerprint (`available`),
 * or could once it has one (`enroll`), whether it does, and whether it
 * stopped by itself (`lost`): the phone's fingerprints or screen lock changed,
 * so it's off until it's turned on or off again.
 * @returns {Promise<{ available: boolean, enroll: boolean, on: boolean, lost: boolean }>}
 */
export async function fingerprintStatus() {
  const answer = await ask("status");
  const said = (name) => answer.ok === true && answer[name] === true;
  return { available: said("available"), enroll: said("enroll"), on: said("on"), lost: said("lost") };
}

// One turning on at a time: each makes the Keystore key anew, so two at once
// could leave neither one working.
let turningOn = null;

/**
 * Turns fingerprint unlock on with `password`, after a fingerprint; "busy"
 * while another turning on is under way.
 * @param {string} password
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export function turnFingerprintOn(password) {
  if (turningOn) return Promise.resolve({ ok: false, reason: "busy" });
  const going = ask("enable", { secret: String(password ?? ""), title: "Unlock with fingerprint", cancel: "Cancel" }).finally(() => {
    if (turningOn === going) turningOn = null;
  });
  turningOn = going;
  return going;
}

/**
 * The password, after a fingerprint, for what the prompt's `title` says.
 * @param {{ title?: string }} [opts]
 * @returns {Promise<{ ok: boolean, secret?: string, reason?: string }>}
 */
export function fingerprintPassword({ title = "Unlock your wallet" } = {}) {
  return ask("unlock", { title, cancel: "Use password" });
}

/**
 * The phone's keyboard, for the password field just focused, as the person
 * chose their password over the fingerprint: a page's focus alone doesn't
 * bring it in the app.
 */
export async function showKeyboard() {
  await ask("keyboard");
}

/** Turns fingerprint unlock off, after a turning on under way, so off is what's left. */
export async function turnFingerprintOff() {
  await turningOn?.catch(() => {});
  return ask("disable");
}
