// On a phone, the field being typed in stays in view above the on-screen
// keyboard, with the screen's next button when both fit.
//
// Where the browser says what the keyboard covers (the visual viewport gets
// shorter, as in the app's WebView and Firefox's tab, or the page itself
// does), the field goes just above it, and once the keyboard's gone, the field
// still typed in, the page goes back where it was before it came. Firefox's
// add-on page on Android says nothing and doesn't move the page, so the field
// goes into the top half of the page, which a phone's keyboard leaves free.
// Either way the page gets room under its end (#app's padding, ui.css) to
// scroll that far; where nothing's said, the room stays until the next screen,
// so nothing moves under a finger as the keyboard closes.
//
// Turned sideways, the keyboard leaves a strip at the top a box high: the
// field goes there, and the test network's band and the popup's top bar give
// it their room while it's typed in with the keyboard up
// (`data-typing-sideways` on the page, ui.css). Which way round the phone is
// held is the screen's to say: a keyboard makes the page shorter. Turned back,
// the page goes back where it was before the keyboard came, and the field
// typed in still goes above it from there. For a moment after a turn, what
// the browser says the keyboard covers is still the other way round's
// (Firefox's tab says the sideways keyboard leaves 62 px of an upright page):
// the field goes where a keyboard leaves room, as when nothing is said.

import { isPhone } from "./device.js";

// Fields that bring up no keyboard.
const UNTYPED = new Set(["checkbox", "radio", "range", "file", "button", "submit", "reset", "color", "image", "hidden"]);
const MARGIN = 12;
// Less than this under the visual viewport is a toolbar, not a keyboard.
const KEYBOARD_MIN = 80;
// How long after a turn what the browser says of the keyboard is the other way round's.
const TURN_SETTLE_MS = 600;

const isTyped = (el) =>
  (el?.localName === "textarea" || (el?.localName === "input" && !UNTYPED.has(String(el.getAttribute?.("type") ?? "text").toLowerCase()))) &&
  !el.disabled &&
  !el.readOnly;

/**
 * Where the keyboard starts, from the top of the page's viewport, in CSS px.
 * `told`: false where what the browser says isn't to be taken, as just after a turn.
 * @param {Window} win
 * @param {{ told?: boolean }} [opts]
 */
export function keyboardTop(win, { told = true } = {}) {
  const layout = win.document?.documentElement?.clientHeight || win.innerHeight || 0;
  const vv = win.visualViewport;
  const seen = vv ? vv.offsetTop + vv.height : layout;
  // The browser says what it covers.
  if (told && layout - seen > KEYBOARD_MIN) return seen;
  // The page was made shorter for it.
  if (told && madeShorter(win, layout)) return layout;
  // Nothing said: the top half; turned sideways, the fifth the keyboard
  // leaves above it, as on Amélie's phone in Firefox's tab and its menu's page.
  return Math.round(layout * (sideways(win) ? 0.2 : 0.5));
}

// Whether the page is shorter than the screen leaves it without a keyboard.
function madeShorter(win, layout) {
  const screen = Number(win.screen?.height) || 0;
  return Boolean(screen && layout < screen * 0.7);
}

// Whether the browser says the keyboard covers part of the page now.
function keyboardSaid(win) {
  const layout = win.document?.documentElement?.clientHeight || win.innerHeight || 0;
  const vv = win.visualViewport;
  const seen = vv ? vv.offsetTop + vv.height : layout;
  return layout - seen > KEYBOARD_MIN || madeShorter(win, layout);
}

// Whether the phone's on its side, as its screen says; else the page wider
// than it's tall.
function sideways(win) {
  const held = String(win.screen?.orientation?.type ?? "");
  if (held) return held.startsWith("landscape");
  const layout = win.document?.documentElement?.clientHeight || win.innerHeight || 0;
  return (win.innerWidth || 0) > layout;
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

// What the screen says between a field and its button as it's typed in: a
// warning ("The same payment is waiting to go out…") or a note ("Your
// recovery phrase is still on the clipboard…"), shown.
function saidBetween(field, button, doc) {
  const scope = field.closest?.(".qrscan-overlay") ?? doc.getElementById?.("app") ?? doc.body;
  const all = Array.from(scope?.querySelectorAll?.("*") ?? []);
  const from = all.indexOf(field);
  const to = all.indexOf(button);
  if (from < 0 || to < 0) return null;
  return (
    all
      .slice(from + 1, to)
      .find((el) => el.matches?.('[role="alert"], [role="status"], .callout') && !el.hidden && !el.closest?.("[hidden]") && String(el.textContent ?? "").trim()) ?? null
  );
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
  // Until when what the browser says of the keyboard is from before a turn.
  let settled = 0;
  // Whether this page's browser has said what the keyboard covers, and
  // whether the keyboard was up when it last did.
  let tells = false;
  let covered = false;

  // While a field is typed in on a phone on its side, with the keyboard up
  // where that's said: the page's top lines give it their room.
  const markSideways = (typing) => {
    const up = !tells || keyboardSaid(win);
    if (touch() && sideways(win) && isTyped(typing) && up) root?.setAttribute?.("data-typing-sideways", "");
    else root?.removeAttribute?.("data-typing-sideways");
  };

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
    const told = Date.now() >= settled;
    if (told) {
      const said = keyboardSaid(win);
      tells ||= said;
      // A browser that says what the keyboard covers says it's down: once it
      // goes, the page goes back where it was before it came.
      if (tells && !said) {
        if (covered) {
          covered = false;
          dropRoom();
          if (before?.scroller?.isConnected) before.scroller.scrollTop = before.top;
        }
        return;
      }
      covered = said;
    }
    const top = keyboardTop(win, { told });
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
    const next = nextButton(field, doc);
    const b = next?.getBoundingClientRect();
    // A warning or a note said between them as it's typed in: it and the
    // button above the keyboard, the field with them where all fit (Chen's
    // and Marek's: Review, and what was said of the payment, under it).
    const w = next ? saidBetween(field, next, doc)?.getBoundingClientRect() : null;
    const room = to - from;
    // The field, and its button with it when both fit; said between them,
    // the button and as much of what's said as fits above it.
    const both = Boolean(b && b.bottom > f.bottom && b.bottom - f.top <= room);
    const bottom = b && b.bottom > f.bottom && (both || w) ? b.bottom : f.bottom;
    const first = !both && w && bottom === b.bottom ? Math.max(w.top, b.bottom - room) : f.top;
    let by = bottom > to ? bottom - to : 0;
    if (first - by < from) by = first - from;
    if (Math.abs(by) >= 1) scroller.scrollTop += by;
  };

  if (!doc?.addEventListener) return { reset() {}, reveal };

  let frame = 0;
  const soon = () => {
    if (frame) return;
    frame = (win.requestAnimationFrame ?? ((fn) => setTimeout(fn, 0)))(() => {
      frame = 0;
      const el = doc.activeElement;
      // The top lines go or come back first: the field goes where they leave it.
      markSideways(el);
      if (touch() && isTyped(el)) reveal(el);
      markSideways(el);
    });
  };
  doc.addEventListener("focusin", (e) => {
    markSideways(e.target);
    if (isTyped(e.target)) soon();
  });
  // Something said or shown as a field is typed in, a warning under it: it,
  // and the button, go above the keyboard too.
  try {
    if (win.MutationObserver && doc.body) {
      new win.MutationObserver(() => {
        if (touch() && isTyped(doc.activeElement)) soon();
      }).observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });
    }
  } catch {
    // Nothing watched: it goes above the keyboard as it's tapped.
  }
  // Where the focus goes next, if anywhere: another field keeps it so.
  doc.addEventListener("focusout", (e) => markSideways(e.relatedTarget ?? null));
  win.visualViewport?.addEventListener?.("resize", soon);
  // Turned sideways or back: the room made for the keyboard the other way
  // round goes, and the page goes back where it was before the keyboard came;
  // a field still typed in goes above the keyboard again from there.
  let width = win.innerWidth;
  win.addEventListener?.("resize", () => {
    if (win.innerWidth !== width) {
      width = win.innerWidth;
      const typing = touch() && isTyped(doc.activeElement);
      markSideways(doc.activeElement);
      settled = Date.now() + TURN_SETTLE_MS;
      if (room || before) {
        dropRoom();
        if (before?.scroller?.isConnected) before.scroller.scrollTop = before.top;
        if (!typing) before = null;
      }
    }
    soon();
  });

  return {
    reset() {
      before = null;
      // The field typed in goes with its screen, which tells nothing as it does.
      markSideways(null);
      if (!room) return;
      dropRoom();
    },
    reveal,
  };
}
