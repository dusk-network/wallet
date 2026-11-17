// A screen's password box, focused as the screen opens (Chen's, Lena's,
// Sofía's: on Unlock, Check your recovery words and Reset wallet the box
// wasn't, and the phone's keyboard stayed down till it was tapped): once it's
// on the page, unless the person is in another field already; in the app on a
// phone with its keyboard brought up, as a page's focus alone doesn't there.

import { showKeyboard } from "../../platform/fingerprint.js";
import { isTauriRuntime } from "../../platform/runtime.js";
import { isPhone } from "./device.js";

const FIELD = /^(input|textarea|select)$/;

/**
 * @param {HTMLInputElement} input
 * @param {{ tries?: number }} [opts] - how many turns to wait for it to be on the page
 */
export function focusOnOpen(input, { tries = 3 } = {}) {
  const go = (left) => {
    if (!input?.isConnected) {
      if (left > 0) setTimeout(() => go(left - 1), 0);
      return;
    }
    const active = globalThis.document?.activeElement;
    if (input.disabled || (active && active !== input && active.isConnected !== false && FIELD.test(String(active.localName ?? "")))) return;
    input.focus?.();
    if (isTauriRuntime() && isPhone()) showKeyboard().catch(() => {});
  };
  setTimeout(() => go(tries), 0);
}
