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
// so nothing moves under a finger as the keyboard closes. What a field shows
// under it as it's typed in, as a recovery-word box's suggestions and Not in
// the word list, goes above the keyboard with it.
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

// How long after a field is tapped its keyboard can make the page shorter.
const KEYBOARD_COMES_MS = 1500;

// Each page's own height at its width with no keyboard over it, whether a
// keyboard that made the page shorter is up, the height last measured, and
// when a field was last tapped (`pages`).
const pages = new WeakMap();

function pageOf(win) {
  let page = pages.get(win);
  if (!page) pages.set(win, (page = { width: -1, height: 0, up: false, last: 0, tapped: -Infinity }));
  return page;
}

// A field tapped or given the focus, or the page shown again with one still
// typed in: its keyboard may make the page shorter now.
function noteTapped(win) {
  pageOf(win).tapped = Date.now();
}

// Whether a keyboard made the page itself shorter (not the visual viewport):
// shorter than its own height at this width by a keyboard's height, just after
// a field was tapped, or the page shown again with one typed in. Made shorter
// otherwise, as a window resized in a split screen, the page has a new height
// of its own; never measured against the screen's height, which a window in
// part of the screen is shorter than with no keyboard. A turn starts it over,
// but not while such a keyboard is up: the first height then is the
// keyboard's, and the page's own is the one it has once the keyboard's gone,
// a keyboard's height taller.
function madeShorter(win, layout) {
  const page = pageOf(win);
  const width = win.innerWidth || 0;
  const now = Date.now();
  if (page.width !== width) {
    page.width = width;
    page.height = page.up ? 0 : layout;
  } else if (page.up) {
    if (layout - page.last > KEYBOARD_MIN || (page.height && layout >= page.height - KEYBOARD_MIN)) {
      page.up = false;
      page.height = Math.max(page.height, layout);
    }
  } else if (!page.height || layout >= page.height || page.height - layout <= KEYBOARD_MIN) {
    page.height = Math.max(page.height, layout);
  } else if (now - page.tapped < KEYBOARD_COMES_MS) {
    page.up = true;
  } else {
    page.height = layout;
  }
  page.last = layout;
  return page.up;
}

// Whether the browser says the keyboard covers part of the page now.
function keyboardSaid(win) {
  const layout = win.document?.documentElement?.clientHeight || win.innerHeight || 0;
  const vv = win.visualViewport;
  const seen = vv ? vv.offsetTop + vv.height : layout;
  const shorter = madeShorter(win, layout);
  return layout - seen > KEYBOARD_MIN || shorter;
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
// Copy request.
function nextButton(field, doc) {
  const scope = field.closest?.(".qrscan-overlay") ?? doc.getElementById?.("app") ?? doc.body;
  const all = Array.from(scope?.querySelectorAll?.("*") ?? []);
  return all.slice(all.indexOf(field) + 1).find((el) => el.matches?.("button.btn-primary, button[data-next]")) ?? null;
}

// Shown: neither it nor what's around it hidden.
const isShown = (el) => Boolean(el) && !el.hidden && !el.closest?.("[hidden]");

// What a field shows under it as it's typed in, its own: the words it
// suggests (`aria-controls`, a recovery-word box's chips) and what's said
// of it (`aria-errormessage`, "Not in the word list"; `aria-describedby`,
// an amount's error or its two-readings question), where shown. It goes
// above the keyboard with the field, which stays in view, rather than
// taking the page on to the button as a warning does.
function ownedBy(field, doc, names = ["aria-controls", "aria-errormessage", "aria-describedby"]) {
  const ids = names.flatMap((name) => String(field.getAttribute?.(name) ?? "").split(/\s+/).filter(Boolean));
  return ids.map((id) => doc.getElementById?.(id)).filter(isShown);
}

// What's said of a field that asks for an answer, as an amount that reads two
// ways asks which, with a button for each: the buttons' box, else null.
function askedOf(field, doc) {
  const buttons = ownedBy(field, doc, ["aria-errormessage", "aria-describedby"])
    .flatMap((el) => Array.from(el.querySelectorAll?.("button") ?? []))
    .filter(isShown);
  if (!buttons.length) return null;
  return buttons.reduce(
    (box, button) => {
      const r = button.getBoundingClientRect();
      return { top: Math.min(box.top, r.top), bottom: Math.max(box.bottom, r.bottom) };
    },
    { top: Infinity, bottom: -Infinity }
  );
}

// What the screen says between a field and its button as it's typed in: a
// warning ("The same payment is waiting to go out…") or a note ("Your
// recovery phrase is still on the clipboard…"), shown; not what the field
// shows under it itself, which goes with it.
function saidBetween(field, button, doc) {
  const scope = field.closest?.(".qrscan-overlay") ?? doc.getElementById?.("app") ?? doc.body;
  const all = Array.from(scope?.querySelectorAll?.("*") ?? []);
  const from = all.indexOf(field);
  const to = all.indexOf(button);
  if (from < 0 || to < 0) return null;
  const own = ownedBy(field, doc);
  return (
    all
      .slice(from + 1, to)
      .find((el) => el.matches?.('[role="alert"], [role="status"], .callout') && isShown(el) && !own.includes(el) && String(el.textContent ?? "").trim()) ?? null
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
  // The page's height as it opens, a keyboard down: what one makes it shorter than.
  if (win) madeShorter(win, doc?.documentElement?.clientHeight || win.innerHeight || 0);
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
    // The field, with what it shows under it as it's typed in.
    const f = ownedBy(field, doc).reduce(
      (box, el) => {
        const r = el.getBoundingClientRect();
        return { top: Math.min(box.top, r.top), bottom: Math.max(box.bottom, r.bottom) };
      },
      field.getBoundingClientRect()
    );
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
    let bottom = b && b.bottom > f.bottom && (both || w) ? b.bottom : f.bottom;
    let first = !both && w && bottom === b.bottom ? Math.max(w.top, b.bottom - room) : f.top;
    // Asked something as it's typed in, with a button for each answer, where
    // the field and what it shows don't all fit (a phone on its side): the
    // buttons above the keyboard, as what must be answered, and as much as
    // fits above them, the question first.
    const asked = !both && !w && f.bottom - f.top > room ? askedOf(field, doc) : null;
    if (asked) {
      bottom = asked.bottom;
      first = Math.max(f.top, asked.bottom - room);
    }
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
  // A field tapped, focused already or not: its keyboard may come now.
  doc.addEventListener(
    "pointerdown",
    (e) => {
      if (isTyped(e.target)) noteTapped(win);
    },
    true
  );
  doc.addEventListener("focusin", (e) => {
    if (isTyped(e.target)) noteTapped(win);
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
  // Back from the phone's app switcher, the keyboard up again over the field
  // still typed in, which says nothing of it (Marek's: a recovery-word box
  // half behind it): above it again. The page shown again, a field still
  // typed in, is as that field tapped: the keyboard brought back may make the
  // page shorter, its own height kept as it was.
  const shownAgain = () => {
    if (isTyped(doc.activeElement)) noteTapped(win);
    soon();
  };
  doc.addEventListener("visibilitychange", () => {
    if (doc.visibilityState !== "hidden") shownAgain();
  });
  win.addEventListener?.("focus", soon);
  win.addEventListener?.("pageshow", shownAgain);
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
