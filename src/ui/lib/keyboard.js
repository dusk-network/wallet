// On a phone, the field being typed in stays in view above the on-screen
// keyboard, with the screen's next button when both fit.
//
// Where the browser says what the keyboard covers (the visual viewport gets
// shorter, as in the app's WebView, or the page itself does), the field goes
// just above it. Firefox's add-on page on Android says nothing and doesn't
// move the page, so the field goes into the top half of the page, which a
// phone's keyboard leaves free. Either way the page gets room under its end
// (#app's padding, ui.css) to scroll that far; the room stays until the next
// screen, so nothing moves under a finger as the keyboard closes.

import { isPhone } from "./device.js";

// Fields that bring up no keyboard.
const UNTYPED = new Set(["checkbox", "radio", "range", "file", "button", "submit", "reset", "color", "image", "hidden"]);
const MARGIN = 12;
// Less than this under the visual viewport is a toolbar, not a keyboard.
const KEYBOARD_MIN = 80;

const isTyped = (el) =>
  (el?.localName === "textarea" || (el?.localName === "input" && !UNTYPED.has(String(el.getAttribute?.("type") ?? "text").toLowerCase()))) &&
  !el.disabled &&
  !el.readOnly;

/**
 * Where the keyboard starts, from the top of the page's viewport, in CSS px.
 * @param {Window} win
 */
export function keyboardTop(win) {
  const layout = win.document?.documentElement?.clientHeight || win.innerHeight || 0;
  const vv = win.visualViewport;
  const seen = vv ? vv.offsetTop + vv.height : layout;
  // The browser says what it covers.
  if (layout - seen > KEYBOARD_MIN) return seen;
  // The page was made shorter for it.
  const screen = Number(win.screen?.height) || 0;
  if (screen && layout < screen * 0.7) return layout;
  // Nothing said: the top half, a little more than a third turned sideways.
  return Math.round(layout * ((win.innerWidth || 0) > layout ? 0.35 : 0.5));
}

// Whether `n` is a box that scrolls what's in it: one that may and has more
// than it shows. Where styles can't be read, the panel's content, which does
// in the popup.
function scrolls(n, win) {
  const style = win?.getComputedStyle?.(n);
  if (!style) return Boolean(n.classList?.contains("panel-content"));
  return /(auto|scroll)/.test(String(style.overflowY ?? "")) && n.scrollHeight > n.clientHeight;
}

// The box that scrolls `el`: the panel's content in the popup, else the page,
// as in a tab of Firefox for Android, where the panel grows with the screen
// and the page scrolls instead.
function scrollerOf(el, doc, win) {
  for (let n = el?.parentNode; n && n.nodeType === 1; n = n.parentNode) {
    if (scrolls(n, win)) return n;
  }
  return doc.scrollingElement ?? doc.documentElement;
}

// The first main button after `field` on its screen or in its dialog: a
// primary one, or the one its fields lead to (`data-next`), as Receive's
// Copy request link.
function nextButton(field, doc) {
  const scope = field.closest?.(".qrscan-overlay") ?? doc.getElementById?.("app") ?? doc.body;
  const all = Array.from(scope?.querySelectorAll?.("*") ?? []);
  return all.slice(all.indexOf(field) + 1).find((el) => el.matches?.("button.btn-primary, button[data-next]")) ?? null;
}

/**
 * Keeps a field typed in on a touch screen above the keyboard.
 * @param {{ win?: Window }} [opts]
 * @returns {{ reset: () => void, reveal: (field: Element) => void }} `reset`
 *   when a new screen is drawn: its room goes
 */
export function installKeyboardRoom({ win = globalThis.window } = {}) {
  const doc = win?.document;
  const touch = () => isPhone(win?.navigator);
  const root = doc?.documentElement;
  let room = 0;
  // Where the box the keyboard moved was before it did, to go back to.
  let before = null;

  const setRoom = (px) => {
    const next = Math.max(room, Math.ceil(px));
    if (next === room) return;
    room = next;
    root?.style?.setProperty?.("--keyboard-room", `${room}px`);
  };

  const dropRoom = () => {
    room = 0;
    root?.style?.removeProperty?.("--keyboard-room");
  };

  const reveal = (field) => {
    if (!field?.isConnected) return;
    const top = keyboardTop(win);
    const layout = doc.documentElement?.clientHeight || win.innerHeight || 0;
    // The room first: a screen that fits whole scrolls only once it's there,
    // as one opened again from its Review does, its first field tapped low.
    setRoom(layout - top + MARGIN);
    const scroller = scrollerOf(field, doc, win);
    if (!before) before = { scroller, top: scroller.scrollTop };
    const page = scroller === doc.scrollingElement || scroller === doc.documentElement;
    const from = Math.max(MARGIN, page ? 0 : scroller.getBoundingClientRect().top + MARGIN);
    const to = top - MARGIN;
    const f = field.getBoundingClientRect();
    const b = nextButton(field, doc)?.getBoundingClientRect();
    // The field, and its button with it when both fit.
    const bottom = b && b.bottom > f.bottom && b.bottom - f.top <= to - from ? b.bottom : f.bottom;
    let by = bottom > to ? bottom - to : 0;
    if (f.top - by < from) by = f.top - from;
    if (Math.abs(by) >= 1) scroller.scrollTop += by;
  };

  if (!doc?.addEventListener) return { reset() {}, reveal };

  let frame = 0;
  const soon = () => {
    if (frame) return;
    frame = (win.requestAnimationFrame ?? ((fn) => setTimeout(fn, 0)))(() => {
      frame = 0;
      const el = doc.activeElement;
      if (touch() && isTyped(el)) reveal(el);
    });
  };
  doc.addEventListener("focusin", (e) => {
    if (isTyped(e.target)) soon();
  });
  win.visualViewport?.addEventListener?.("resize", soon);
  // Turned sideways or back: the room made for the keyboard the other way
  // round goes, and the page goes back where it was before the keyboard came,
  // or makes room afresh for a field still typed in.
  let width = win.innerWidth;
  win.addEventListener?.("resize", () => {
    if (win.innerWidth !== width) {
      width = win.innerWidth;
      if (room) {
        dropRoom();
        const typing = touch() && isTyped(doc.activeElement);
        if (!typing && before?.scroller?.isConnected) before.scroller.scrollTop = before.top;
        if (!typing) before = null;
      }
    }
    soon();
  });

  return {
    reset() {
      before = null;
      if (!room) return;
      dropRoom();
    },
    reveal,
  };
}
