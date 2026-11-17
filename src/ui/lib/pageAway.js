// The moment the page goes out of sight or loses the focus: hidden, as a tab
// switch, the phone's app switcher or Firefox's tab list hides it; left
// (pagehide); or its window's focus gone (blur), which comes first where the
// browser says it at all. Screens that show recovery words in clear mask them
// then, before a switcher or a tab list takes its picture of the page
// (Marek's: Firefox's tab list and Android's app switcher kept the twelve
// words of Import's Show words in clear). Firefox for Android tells the page
// too late: Android's app switcher has its picture by then, or the page hears
// nothing at all. There the words show only while their button is held down
// (holdToShow), so no picture taken as the phone leaves the page has them.

const watchers = new Set();
let watched = null;

function watch() {
  const win = globalThis.window;
  if (watched === win || typeof win?.addEventListener !== "function") return;
  watched = win;
  const away = () => {
    for (const each of [...watchers]) each();
  };
  const doc = win.document ?? globalThis.document;
  win.addEventListener("blur", away);
  win.addEventListener("pagehide", away);
  doc?.addEventListener?.("visibilitychange", () => {
    if (doc.visibilityState === "hidden") away();
  });
}

/**
 * Calls `away` each time the page is hidden, left or loses the focus, while
 * `el` is on the page: once it's gone, never again.
 * @param {() => void} away
 * @param {Element} el - what `away` is for, on the page as it's called
 * @returns {() => void} stops it
 */
export function onPageAway(away, el) {
  watch();
  const each = () => {
    if (el?.isConnected === false) {
      watchers.delete(each);
      return;
    }
    try {
      away();
    } catch {
      // The next one is still told.
    }
  };
  watchers.add(each);
  return () => watchers.delete(each);
}

/** What a button that shows the words only while it's held says (holdToShow). */
export const HOLD_TO_SHOW_TEXT = "Hold to show words";

/**
 * A button that shows recovery words only while it's held down, for Firefox
 * for Android: `show(true)` as it's pressed, by a finger or a key, and
 * `show(false)` as it's let go, the press taken away (a scroll, a call), the
 * button left, or the page out of sight. A tap shows them for as long as the
 * finger stays; nothing toggles.
 * @param {HTMLButtonElement} button
 * @param {(on: boolean) => void} show
 */
export function holdToShow(button, show) {
  let held = false;
  const set = (on) => {
    if (held === on) return;
    held = on;
    show(on);
  };
  button.classList.add("hold-to-show");
  button.addEventListener("pointerdown", (e) => {
    if (e?.button > 0) return;
    e?.preventDefault?.();
    try {
      button.setPointerCapture?.(e.pointerId);
    } catch {
      // Let go off the button: its pointerup still comes as the page's.
    }
    set(true);
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture", "blur"]) button.addEventListener(type, () => set(false));
  const holdKey = (e) => e?.key === " " || e?.key === "Enter";
  button.addEventListener("keydown", (e) => {
    if (!holdKey(e)) return;
    e.preventDefault?.();
    set(true);
  });
  button.addEventListener("keyup", (e) => {
    if (holdKey(e)) set(false);
  });
  // A long press is the hold, not the browser's menu; a click toggles nothing.
  button.addEventListener("contextmenu", (e) => e?.preventDefault?.());
  button.addEventListener("click", (e) => e?.preventDefault?.());
  onPageAway(() => set(false), button);
}
