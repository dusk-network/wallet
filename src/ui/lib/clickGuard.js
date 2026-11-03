// A button that sends, stakes, signs or approves ignores a click, and the
// Enter that clicks it, for a moment after its screen appears: a double-click
// on Review or Next, or on the site that opened an approval, mustn't land on
// it. It looks as it always does meanwhile, neither disabled nor greyed.

export const CLICK_GUARD_MS = 500;

// When the screen on show in a window appeared, by its document. The popup
// marks each new screen, not a redraw of the same one; an approval window
// marks each screen it shows.
const shownAt = new WeakMap();

/** A new screen is up: its confirm waits CLICK_GUARD_MS for a click. */
export function screenShown() {
  if (globalThis.document) shownAt.set(globalThis.document, Date.now());
}

/**
 * `onClick` for a confirm button: a click within CLICK_GUARD_MS of its screen
 * appearing does nothing.
 * @param {(event: Event) => unknown} onClick
 */
export function guarded(onClick) {
  return function guardedClick(event) {
    if (Date.now() - (shownAt.get(globalThis.document) ?? Number.NEGATIVE_INFINITY) < CLICK_GUARD_MS) {
      event?.preventDefault?.();
      return undefined;
    }
    return onClick.call(this, event);
  };
}
