import { afterEach, describe, expect, it, vi } from "vitest";

import { fakeEvent, installFakeDom, settle } from "../testing/fakeDom.js";
import { installKeyboardRoom } from "./keyboard.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

// A 1080×2400 phone (414×914 CSS px) showing the Import screen in the add-on's
// page: the panel's content scrolls from y=70, the page is 790 tall, and the
// password, its confirmation and Import wallet sit low on it, as Chen and
// Amélie measured them. `seen` is the visual viewport's height: 790 when the
// browser says nothing of the keyboard, as Firefox on Android does.
function importScreen({ seen = 790, touch = true } = {}) {
  const dom = installFakeDom({ pathname: "/popup.html" });
  const win = Object.assign(dom.window, {
    document: dom.document,
    innerWidth: 414,
    innerHeight: 790,
    screen: { width: 414, height: 914 },
    navigator: { userAgent: touch ? "Mozilla/5.0 (Android 15; Mobile; rv:144.0) Gecko/144.0 Firefox/159.0" : "Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/159.0" },
    visualViewport: { offsetTop: 0, height: seen, addEventListener: vi.fn() },
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
  });
  dom.document.documentElement.clientHeight = 790;
  const make = (tag, className = "") => Object.assign(dom.document.createElement(tag), { className });
  const scroller = make("main", "panel-content");
  scroller.scrollTop = 0;
  const app = make("div");
  app.id = "app";
  // Where each sits on the page, scrolled with the panel's content.
  const at = (el, top, height) => {
    el.getBoundingClientRect = () => ({ top: top - scroller.scrollTop, bottom: top + height - scroller.scrollTop });
    return el;
  };
  scroller.getBoundingClientRect = () => ({ top: 70, bottom: 790 });
  const word = at(make("input"), 300, 42);
  const password = at(make("input"), 683, 44);
  const confirm = at(make("input"), 745, 44);
  const button = at(make("button", "btn-primary"), 829, 46);
  password.type = "password";
  confirm.type = "password";
  app.append(word, password, confirm, button);
  scroller.append(app);
  dom.document.body.append(scroller);
  const keyboard = installKeyboardRoom({ win });
  const focus = async (field) => {
    field.focus();
    field.dispatchEvent(fakeEvent("focusin"));
    await settle();
  };
  return { dom, scroller, word, password, confirm, button, keyboard, focus, room: () => dom.document.documentElement.style.getPropertyValue("--keyboard-room") };
}

// The same screen in a tab of Firefox for Android (full.html): the panel grows
// with what's in it, and the page itself scrolls, as on Chen's Import and Send.
function importTab({ seen = 434 } = {}) {
  const page = importScreen({ seen });
  const { dom, scroller } = page;
  const doc = dom.document;
  const html = doc.documentElement;
  html.scrollTop = 0;
  doc.scrollingElement = html;
  // Nothing in the page scrolls but the page; the panel's content shows all it has.
  dom.window.getComputedStyle = (el) => ({ overflowY: el === scroller ? "auto" : "visible" });
  Object.assign(scroller, { scrollHeight: 900, clientHeight: 900 });
  for (const el of [page.word, page.password, page.confirm, page.button]) {
    const at = el.getBoundingClientRect();
    el.getBoundingClientRect = () => ({ top: at.top - html.scrollTop, bottom: at.bottom - html.scrollTop });
  }
  return page;
}

describe("a field typed in on a phone", () => {
  // Chen's: the box half under the keyboard, Import wallet and Review all under it.
  it("scrolls the page where the page scrolls, the box and its button just above the keyboard", async () => {
    const page = importTab();
    await page.focus(page.confirm);
    const html = page.dom.document.documentElement;
    expect(html.scrollTop).toBeGreaterThan(0);
    expect(page.scroller.scrollTop).toBe(0);
    expect(page.confirm.getBoundingClientRect().top).toBeGreaterThanOrEqual(12);
    expect(page.button.getBoundingClientRect().bottom).toBeLessThanOrEqual(434);
  });

  it("goes into the top half with the button after it, where Firefox says nothing of the keyboard", async () => {
    const page = importScreen();
    await page.focus(page.confirm);
    // The top half (395 of 790) stays clear of a phone's keyboard.
    expect(page.confirm.getBoundingClientRect().top).toBeGreaterThanOrEqual(82);
    expect(page.button.getBoundingClientRect().bottom).toBeLessThanOrEqual(395);
    // Room under the screen's end to scroll that far.
    expect(page.room()).not.toBe("");
  });

  it("goes just above the keyboard where the browser says what it covers, the button with it", async () => {
    const page = importScreen({ seen: 480 });
    await page.focus(page.password);
    expect(page.password.getBoundingClientRect().top).toBeGreaterThanOrEqual(82);
    expect(page.button.getBoundingClientRect().bottom).toBeLessThanOrEqual(480);
    expect(page.button.getBoundingClientRect().bottom).toBeGreaterThan(395);
  });

  it("stays put where it shows already, and nothing moves with a mouse", async () => {
    const page = importScreen();
    await page.focus(page.word);
    expect(page.scroller.scrollTop).toBe(0);
    const desk = importScreen({ touch: false });
    await desk.focus(desk.confirm);
    expect([desk.scroller.scrollTop, desk.room()]).toEqual([0, ""]);
  });

  // Chen's, in landscape and back: the page stayed scrolled, To and Back off its top, its lower half empty.
  it("gives the room back as the phone turns, and puts the page back where it was once the keyboard's gone", async () => {
    const page = importScreen({ seen: 480 });
    await page.focus(page.confirm);
    expect(page.scroller.scrollTop).toBeGreaterThan(0);
    expect(page.room()).not.toBe("");
    // Turned, and the keyboard closed: nothing typed in any more.
    page.confirm.blur?.();
    page.dom.document.activeElement = page.dom.document.body;
    Object.assign(page.dom.window, { innerWidth: 914, innerHeight: 414 });
    page.dom.window.dispatchEvent(fakeEvent("resize"));
    await settle();
    expect(page.room()).toBe("");
    expect(page.scroller.scrollTop).toBe(0);
  });

  // Amélie's: Send opened again from its Review, all of it on screen, its Memo the first box tapped.
  it("scrolls a screen that fits whole until the keyboard comes, its low box tapped first", async () => {
    const page = importScreen();
    const { scroller, dom } = page;
    // The panel scrolls only what's more than it shows: nothing, but the room under it.
    dom.window.getComputedStyle = (el) => ({ overflowY: el === scroller ? "auto" : "visible" });
    const room = () => Number.parseInt(page.room() || "0", 10);
    Object.defineProperty(scroller, "clientHeight", { value: 720, configurable: true });
    Object.defineProperty(scroller, "scrollHeight", { get: () => 720 + room(), configurable: true });
    await page.focus(page.confirm);
    expect(page.scroller.scrollTop).toBeGreaterThan(0);
    expect(page.confirm.getBoundingClientRect().top).toBeGreaterThanOrEqual(82);
    expect(page.button.getBoundingClientRect().bottom).toBeLessThanOrEqual(395);
  });

  it("gives the room back on the next screen", async () => {
    const page = importScreen();
    await page.focus(page.confirm);
    page.keyboard.reset();
    expect(page.room()).toBe("");
  });
});

// Send in a tab of Firefox for Android on Amélie's phone, which says nothing of
// the keyboard: upright the page is 414×790; on its side 914×324, and the
// keyboard leaves its top 63 px. The page scrolls; To, Amount, Memo and Review
// sit where each way round puts them.
function sendTab({ touch = true, says = false } = {}) {
  const dom = installFakeDom({ pathname: "/full.html" });
  const doc = dom.document;
  const html = doc.documentElement;
  const win = Object.assign(dom.window, {
    document: doc,
    navigator: { userAgent: touch ? "Mozilla/5.0 (Android 15; Mobile; rv:144.0) Gecko/144.0 Firefox/159.0" : "Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/159.0" },
    visualViewport: { offsetTop: 0, height: 790, addEventListener: vi.fn() },
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
  });
  // `says`: the browser says what the keyboard covers, as Firefox's tab does: 468 px show upright, 62 sideways.
  const vvListeners = [];
  win.visualViewport.addEventListener = (type, fn) => vvListeners.push(fn);
  // `pageHeight`: the page as tall as the keyboard left it the other way round, as Firefox's tab keeps it a moment.
  const turn = (onSide, { seen, pageHeight } = {}) => {
    const [width, height] = onSide ? [914, 324] : [414, 790];
    const orientation = { type: onSide ? "landscape-primary" : "portrait-primary" };
    Object.assign(win, { innerWidth: width, innerHeight: height, screen: onSide ? { width: 914, height: 411, orientation } : { width: 414, height: 914, orientation } });
    win.visualViewport.height = seen ?? (says ? (onSide ? 62 : 468) : height);
    html.clientHeight = pageHeight ?? height;
  };
  turn(false);
  html.scrollTop = 0;
  doc.scrollingElement = html;
  win.getComputedStyle = () => ({ overflowY: "visible" });
  // Each one's top upright, its height, and its top on its side.
  const places = { to: [180, 46, 120], amount: [250, 84, 190], memo: [420, 46, 300], review: [478, 46, 358] };
  const make = (tag, name, className = "") => {
    const el = Object.assign(doc.createElement(tag), { className });
    el.getBoundingClientRect = () => {
      const [upright, height, onSide] = places[name];
      const top = (win.innerWidth > html.clientHeight ? onSide : upright) - html.scrollTop;
      return { top, bottom: top + height };
    };
    return el;
  };
  const app = doc.createElement("div");
  app.id = "app";
  const [to, amount, memo, review] = [make("input", "to"), make("input", "amount"), make("input", "memo"), make("button", "review", "btn-primary")];
  app.append(to, amount, memo, review);
  doc.body.append(app);
  installKeyboardRoom({ win });
  const settleTurn = async (onSide, opts) => {
    turn(onSide, opts);
    win.dispatchEvent(fakeEvent("resize"));
    await settle();
  };
  const keyboardSays = async (seen) => {
    win.visualViewport.height = seen;
    for (const fn of vvListeners) fn(fakeEvent("resize"));
    await settle();
  };
  const focus = async (field) => {
    field.focus();
    field.dispatchEvent(fakeEvent("focusin"));
    await settle();
  };
  const leave = async (field, next = null) => {
    field.blur?.();
    if (next) next.focus();
    field.dispatchEvent(fakeEvent("focusout", { relatedTarget: next }));
    await settle();
  };
  const marked = () => html.hasAttribute("data-typing-sideways");
  return { to, amount, memo, review, turn: settleTurn, keyboardSays, focus, leave, marked, html };
}

describe("a field typed in on a phone turned sideways", () => {
  // Amélie's: sideways, she typed her memo into a box she couldn't see, under the keyboard and the Testnet band.
  it("goes into the strip the keyboard leaves at the top, the band and the top bar giving it their room", async () => {
    const page = sendTab();
    await page.focus(page.memo);
    await page.turn(true);
    expect(page.marked()).toBe(true);
    expect(page.memo.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
    expect(page.memo.getBoundingClientRect().bottom).toBeLessThanOrEqual(63);

    // Another field next keeps it so; none, and the band and the top bar come back.
    await page.leave(page.memo, page.to);
    expect(page.marked()).toBe(true);
    await page.leave(page.to);
    expect(page.marked()).toBe(false);
  });

  // Amélie's, back upright: Memo and Review alone at the top of a black page until she swiped.
  it("goes back where the page was before the keyboard as the phone turns upright, the field still above it", async () => {
    const page = sendTab();
    await page.focus(page.memo);
    await page.turn(true);
    await page.turn(false);
    expect(page.marked()).toBe(false);
    // The form from its top again, To on screen, Memo and Review in the half the keyboard leaves.
    expect(page.to.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
    expect(page.memo.getBoundingClientRect().top).toBeGreaterThanOrEqual(12);
    expect(page.review.getBoundingClientRect().bottom).toBeLessThanOrEqual(395);
  });

  // Amélie's, in Firefox's tab, which says what the keyboard covers: just turned upright, it still said the
  // sideways keyboard's 62 px were all that showed, and Memo went to the top of a black page.
  it("takes what the browser says of the keyboard only once it's said afresh after a turn", async () => {
    const page = sendTab({ says: true });
    await page.focus(page.memo);
    await page.turn(true);
    expect(page.memo.getBoundingClientRect().bottom).toBeLessThanOrEqual(62);
    // Upright, and the browser still says 62 px show, then the upright keyboard's 468.
    await page.turn(false, { seen: 62 });
    await page.keyboardSays(468);
    expect(page.to.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
    expect(page.review.getBoundingClientRect().bottom).toBeLessThanOrEqual(468);
  });

  // Amélie's: back upright, the keyboard closed, Memo and Review alone at the top of a black page.
  it("goes back where the page was before the keyboard came once it's gone, the field still typed in", async () => {
    const page = sendTab({ says: true });
    await page.focus(page.memo);
    await page.keyboardSays(468);
    expect(page.html.scrollTop).toBeGreaterThan(0);
    await page.keyboardSays(790);
    expect([page.html.scrollTop, page.to.getBoundingClientRect().top]).toEqual([0, 180]);
    expect(page.html.style.getPropertyValue("--keyboard-room")).toBe("");
  });

  // Firefox's tab kept the page as short as the sideways keyboard left it (62 px) a moment after she turned upright.
  it("goes by how the screen says the phone's held, not by the page's height, which a keyboard changes", async () => {
    const page = sendTab({ says: true });
    await page.focus(page.memo);
    await page.turn(true);
    expect(page.marked()).toBe(true);
    await page.turn(false, { seen: 62, pageHeight: 62 });
    expect(page.marked()).toBe(false);
  });

  it("leaves the page whole on a computer, whose window is wider than tall", async () => {
    const desk = sendTab({ touch: false });
    await desk.turn(true);
    await desk.focus(desk.memo);
    expect([desk.marked(), desk.html.scrollTop]).toEqual([false, 0]);
  });
});
