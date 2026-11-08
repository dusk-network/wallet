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

describe("a field typed in on a phone", () => {
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

  it("gives the room back on the next screen", async () => {
    const page = importScreen();
    await page.focus(page.confirm);
    page.keyboard.reset();
    expect(page.room()).toBe("");
  });
});
