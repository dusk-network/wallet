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
