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
 * The longest one hold shows the words (holdToShow): held on past it, they're
 * hidden, and holding again shows them again. Long enough to write them down
 * with a thumb held still, which the browser may hear nothing of for as long
 * (Firefox tells no move under about 0.8 mm).
 */
export const HOLD_LONGEST_MS = 60_000;

/**
 * A button that shows recovery words only while it's held down, for Firefox
 * for Android: `show(true)` as it's pressed, by a finger or a key, and
 * `show(false)` the moment the hold ends or is cut into: let go, the press
 * taken away (a scroll, a call), a second touch anywhere on the page, a menu
 * opening over it, the button left, the page out of sight, or one hold past
 * HOLD_LONGEST_MS. Firefox for Android can drop a hold's end without a word
 * to the page (Marek's: holding, then touching Firefox's toolbar with another
 * finger left all twelve words shown once both fingers were off): the next
 * touch on the page ends such a hold, or that limit. A tap shows them for as
 * long as the finger stays; nothing toggles. A press that ends a hold starts
 * none.
 * @param {HTMLButtonElement} button
 * @param {(on: boolean) => void} show
 */
export function holdToShow(button, show) {
  let held = false;
  // The pointer holding it (null for a key), the hold's time limit, the press
  // that began the hold and the one that last ended one.
  let pointer = null;
  let longest;
  let began = null;
  let cut = null;
  const page = () => button.ownerDocument ?? globalThis.document;
  const end = () => set(false);
  // What the page hears while it's held, wherever on it: another press, the
  // held pointer's end, two fingers down, or a menu nothing stopped (the
  // button's own long press opens none).
  const listeners = [
    ["pointerdown", (e) => {
      if (e === began) return;
      cut = e;
      end();
    }],
    ["pointerup", (e) => e?.pointerId === pointer && end()],
    ["pointercancel", (e) => e?.pointerId === pointer && end()],
    ["touchstart", (e) => (e?.touches?.length ?? 0) > 1 && end()],
    ["contextmenu", (e) => !e?.defaultPrevented && end(), false],
  ];
  const listen = (on) => {
    const doc = page();
    for (const [type, fn, capture = true] of listeners) {
      if (on) doc?.addEventListener?.(type, fn, { capture, passive: type === "touchstart" });
      else doc?.removeEventListener?.(type, fn, { capture });
    }
  };
  function set(on) {
    if (held === on) return;
    held = on;
    listen(on);
    clearTimeout(longest);
    if (on) longest = setTimeout(end, HOLD_LONGEST_MS);
    else {
      pointer = null;
      began = null;
    }
    show(on);
  }
  button.classList.add("hold-to-show");
  button.addEventListener("pointerdown", (e) => {
    if (e?.button > 0) return;
    e?.preventDefault?.();
    // A second touch, or the first after a hold whose end the page never
    // heard: that hold is over, and this press shows nothing.
    if (held || e === cut) {
      cut = e;
      end();
      return;
    }
    try {
      button.setPointerCapture?.(e.pointerId);
    } catch {
      // Let go off the button: its pointerup still comes as the page's.
    }
    pointer = e?.pointerId ?? null;
    began = e;
    set(true);
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture", "blur"]) button.addEventListener(type, end);
  const holdKey = (e) => e?.key === " " || e?.key === "Enter";
  button.addEventListener("keydown", (e) => {
    if (!holdKey(e)) return;
    e.preventDefault?.();
    if (held) return;
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
