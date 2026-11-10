// Offline, as the browser says it at once, and a button that sends held
// while it is: a Review's Confirm, an approval's Approve.

import { h } from "./dom.js";

/** Whether the browser says it's offline. */
export const isOffline = (nav = globalThis.navigator) => nav?.onLine === false;

// The `disabled` accessor the button's prototypes give it.
function disabledAccessor(el) {
  for (let proto = Object.getPrototypeOf(el); proto; proto = Object.getPrototypeOf(proto)) {
    const own = Object.getOwnPropertyDescriptor(proto, "disabled");
    if (own?.get && own?.set) return own;
  }
  return null;
}

/**
 * Holds `button` off while the browser is offline, the line it gives saying
 * so, and lets it be as the page has it once back online: whatever the page
 * sets its `disabled` to meanwhile is kept, and applies from then on.
 * @param {HTMLButtonElement} button
 * @param {{ text: string, className?: string, win?: Window }} opts - what the line says, and its look
 * @returns {HTMLElement} the line, shown while offline
 */
export function holdWhileOffline(button, { text, className = "", win = globalThis.window } = {}) {
  const line = h("div", { class: ["field-error offline-note", className].filter(Boolean).join(" "), role: "status", text, hidden: true });
  const own = button ? disabledAccessor(button) : null;
  if (!own || !win?.addEventListener) return line;
  let wanted = own.get.call(button);
  let shown = false;
  const apply = () => {
    const off = isOffline();
    line.hidden = !off;
    own.set.call(button, wanted || off);
  };
  Object.defineProperty(button, "disabled", {
    configurable: true,
    get() {
      return own.get.call(this);
    },
    set(next) {
      wanted = Boolean(next);
      apply();
    },
  });
  const onChange = () => {
    // A screen drawn again in its place: its listeners go with it.
    shown ||= Boolean(button.isConnected);
    if (shown && !button.isConnected) {
      win.removeEventListener("online", onChange);
      win.removeEventListener("offline", onChange);
      return;
    }
    apply();
  };
  win.addEventListener("online", onChange);
  win.addEventListener("offline", onChange);
  apply();
  // A screen's button is on the page once it's drawn, in the same turn.
  queueMicrotask(() => {
    shown ||= Boolean(button.isConnected);
  });
  return line;
}
