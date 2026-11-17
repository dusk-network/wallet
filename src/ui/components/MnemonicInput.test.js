import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import bip39Vectors from "../../shared/fixtures/bip39-vectors.json";
import { compose, fakeEvent, installFakeDom, isShown, press, typeInto, typeKeys } from "../testing/fakeDom.js";
import { createMnemonicInput } from "./MnemonicInput.js";

// Public BIP39 test phrases only.
const TWELVE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const OTHER = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const TWENTY_FOUR = `${"abandon ".repeat(23)}art`;
// Twelve words from the list whose checksum fails.
const NO_CHECKSUM = "abandon ".repeat(12).trim();

let dom;

beforeEach(() => {
  dom = installFakeDom();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function mount(opts = {}) {
  const onCheck = vi.fn();
  const input = createMnemonicInput({ onCheck, ...opts });
  dom.document.body.replaceChildren(input.el);
  const box = (n) => input.el.querySelectorAll("input").find((i) => i.getAttribute("aria-label") === `Word ${n}`);
  const cell = (n) => box(n).parentNode.parentNode;
  const words = () => input.el.querySelectorAll("input").filter(isShown).map((i) => i.value);
  return { input, onCheck, box, cell, words };
}

const paste = (field, text) => field.dispatchEvent(fakeEvent("paste", { clipboardData: { getData: () => text } }));
// The focus leaving `field` for `to` (null: for nothing on the page).
const leave = (field, to = null) => field.dispatchEvent(fakeEvent("focusout", { relatedTarget: to }));

describe("on a phone", () => {
  // The rule ui.css has for `selector`, its declarations.
  const cssRule = async (selector) => {
    const css = await readFile(path.resolve(process.cwd(), "public", "ui.css"), "utf8");
    return css.split("\n}").find((block) => `\n${block}`.includes(`\n${selector} {`)) ?? "";
  };

  // Marek's: Firefox for Android told the keyboard nothing of "don't learn" for these boxes;
  // then, typed in password boxes, Firefox offered to keep a word as a password.
  it("types each word unseen in a box that's no password box, a password's to the keyboard, shown read-only on asking", async () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Android 15; Mobile; rv:159.0) Gecko/159.0 Firefox/159.0" });
    const { input, box, words } = mount();
    const grid = input.el.querySelector(".srp-grid");
    const boxes = () => input.el.querySelectorAll("input").map((i) => [i.getAttribute("type"), Boolean(i.readOnly)]);
    const hidden = () => grid.classList.contains("srp-grid--masked") && grid.classList.contains("is-hidden");
    expect([new Set(boxes().map(String)), hidden()]).toEqual([new Set(["text,false"]), true]);
    // Hidden as a password's dots, and a password's to the keyboard (Firefox's ime-mode).
    expect(await cssRule(".srp-grid--masked.is-hidden .srp-word-input input")).toContain("-webkit-text-security: disc;");
    expect(await cssRule(".srp-grid--masked .srp-word-input input")).toContain("ime-mode: disabled;");
    expect(box(1).getAttribute("autocomplete")).toBe("off");
    paste(box(1), TWELVE);
    expect(words()).toEqual(TWELVE.split(" "));
    expect(input.getMnemonic()).toBe(TWELVE);

    // Marek's: Firefox's app switcher took its picture of words shown before the page heard it was leaving. Shown
    // read-only only while Hold to show words is held, a tap toggling nothing.
    const show = input.el.querySelectorAll("button").find((b) => b.textContent === "Hold to show words");
    show.click();
    expect(hidden()).toBe(true);
    show.dispatchEvent(fakeEvent("pointerdown", { button: 0, pointerId: 1 }));
    expect([new Set(boxes().map(String)), hidden(), show.getAttribute("aria-pressed")]).toEqual([new Set(["text,true"]), false, "true"]);
    show.dispatchEvent(fakeEvent("pointerup", { button: 0, pointerId: 1 }));
    expect([new Set(boxes().map(String)), hidden(), show.getAttribute("aria-pressed"), show.textContent]).toEqual([new Set(["text,false"]), true, "false", "Hold to show words"]);
    typeInto(box(3), "zoo");
    expect(words()[2]).toBe("zoo");
  });

  it("shows the words in Firefox for Android only while Hold to show words is held, by a finger or a key", () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Android 15; Mobile; rv:159.0) Gecko/159.0 Firefox/159.0" });
    const { input, box } = mount();
    paste(box(1), TWELVE);
    const grid = input.el.querySelector(".srp-grid");
    const show = input.el.querySelectorAll("button").find((b) => b.textContent === "Hold to show words");
    const seen = () => !grid.classList.contains("is-hidden");
    for (const [press, letGo] of [
      [{ type: "pointerdown", button: 0, pointerId: 1 }, { type: "pointerup" }],
      // A scroll or a call takes the press away.
      [{ type: "pointerdown", button: 0, pointerId: 2 }, { type: "pointercancel" }],
      [{ type: "keydown", key: " " }, { type: "keyup", key: " " }],
      [{ type: "keydown", key: "Enter" }, { type: "blur" }],
      [{ type: "pointerdown", button: 0, pointerId: 3 }, { page: () => dom.window.dispatchEvent(fakeEvent("blur")) }],
      [{ type: "pointerdown", button: 0, pointerId: 4 }, { page: () => {
        dom.document.visibilityState = "hidden";
        dom.document.dispatchEvent(fakeEvent("visibilitychange"));
      } }],
    ]) {
      dom.document.visibilityState = "visible";
      const { type, ...props } = press;
      show.dispatchEvent(fakeEvent(type, props));
      expect(seen()).toBe(true);
      if (letGo.page) letGo.page();
      else {
        const { type: up, ...rest } = letGo;
        show.dispatchEvent(fakeEvent(up, rest));
      }
      expect(seen()).toBe(false);
    }
    // Its long press is the hold, never the browser's menu.
    const menu = fakeEvent("contextmenu");
    show.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(true);
  });

  // Marek's: with Show words on, Firefox's tab list and Android's app switcher kept a picture of the twelve words in clear.
  it("hides shown words again the moment the page is hidden, left or loses the focus, till Show words again", () => {
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Linux; Android 15; sdk_gphone64_x86_64 Build/AE3A.240806.036; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.7390.122 Mobile Safari/537.36",
    });
    dom.window.__TAURI_INTERNALS__ = { invoke: vi.fn() };
    const { input, box } = mount();
    const grid = input.el.querySelector(".srp-grid");
    const show = input.el.querySelectorAll("button").find((b) => b.textContent === "Show words");
    const seen = () => [!grid.classList.contains("is-hidden"), show.textContent, show.getAttribute("aria-pressed")];
    paste(box(1), TWELVE);
    for (const away of [
      () => {
        dom.document.visibilityState = "hidden";
        dom.document.dispatchEvent(fakeEvent("visibilitychange"));
      },
      () => dom.window.dispatchEvent(fakeEvent("pagehide")),
      () => dom.window.dispatchEvent(fakeEvent("blur")),
    ]) {
      dom.document.visibilityState = "visible";
      show.click();
      expect(seen()).toEqual([true, "Hide words", "true"]);
      away();
      expect(seen()).toEqual([false, "Show words", "false"]);
      // Back in sight: still hidden, till Show words.
      dom.document.visibilityState = "visible";
      dom.document.dispatchEvent(fakeEvent("visibilitychange"));
      dom.window.dispatchEvent(fakeEvent("focus"));
      expect(seen()).toEqual([false, "Show words", "false"]);
    }
    expect(input.getMnemonic()).toBe(TWELVE);
  });

  // In the Android app the words went in text boxes its keyboard learns from: ime-mode is Firefox's alone.
  it("types each word in the Android app in a password box, which its keyboard learns nothing from, a one-time code's to autofill", () => {
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Linux; Android 15; sdk_gphone64_x86_64 Build/AE3A.240806.036; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.7390.122 Mobile Safari/537.36",
    });
    dom.window.__TAURI_INTERNALS__ = { invoke: vi.fn() };
    const { input, box, words } = mount();
    const boxes = () => new Set(input.el.querySelectorAll("input").map((i) => [i.getAttribute("type"), i.getAttribute("autocomplete"), Boolean(i.readOnly)].join()));
    expect(boxes()).toEqual(new Set(["password,one-time-code,false"]));
    // A space still moves on, sent as the keyboard sends it.
    box(1).focus();
    typeKeys("kiwi lemon ", { as: "text" });
    expect([words().slice(0, 3), dom.document.activeElement === box(3)]).toEqual([["kiwi", "lemon", ""], true]);
    // Shown read-only as text; a box pressed to type in hides them as passwords again.
    input.el.querySelectorAll("button").find((b) => b.textContent === "Show words").click();
    expect(boxes()).toEqual(new Set(["text,one-time-code,true"]));
    box(4).dispatchEvent(fakeEvent("pointerdown"));
    expect(boxes()).toEqual(new Set(["password,one-time-code,false"]));
  });

  it("keeps words in plain boxes elsewhere, the app on a computer too", () => {
    for (const app of [false, true]) {
      if (app) dom.window.__TAURI_INTERNALS__ = { invoke: vi.fn() };
      const { input } = mount();
      expect(new Set(input.el.querySelectorAll("input").map((i) => i.getAttribute("type"))), String(app)).toEqual(new Set(["text"]));
      expect(input.el.querySelector(".srp-grid").classList.contains("srp-grid--masked")).toBe(false);
      expect(input.el.querySelectorAll("button").find((b) => b.textContent === "Show words")).toBeUndefined();
    }
  });

  it("is a form of its own, which Enter never submits", () => {
    const { input, box } = mount();
    expect(input.el.localName).toBe("form");
    const submit = fakeEvent("submit");
    box(1).dispatchEvent(submit);
    expect(submit.defaultPrevented).toBe(true);
  });
});

describe("the recovery phrase's word boxes", () => {
  it("fills every box in order from a whole phrase pasted into any box, and takes its length from it", () => {
    const { box, words } = mount();
    paste(box(5), OTHER);
    expect(words()).toEqual(OTHER.split(" "));

    // 24 words switch to 24 boxes, and 12 back to 12.
    paste(box(3), TWENTY_FOUR);
    expect(words()).toEqual(TWENTY_FOUR.split(" "));
    paste(box(20), TWELVE);
    expect(words()).toEqual(TWELVE.split(" "));
  });

  // Marek's: "Paste the whole phrase into any box", and the pasted phrase stayed on the phone's clipboard, where his
  // own page read it back in full.
  it("takes pasted words off the clipboard, in the paste's own tap, and says so once where the browser won't", async () => {
    const { box, input, words } = mount();
    const said = () => {
      const note = input.el.querySelector(".srp-clipboard");
      return note && isShown(note) ? note.textContent : "";
    };
    paste(box(1), OTHER);
    expect(words()).toEqual(OTHER.split(" "));
    expect(dom.clipboard.writeText).toHaveBeenCalledWith("");
    await Promise.resolve();
    expect(said()).toBe("");

    // A browser that won't let the page write to the clipboard, nothing or a space: the phrase is still there, and
    // that's said.
    const blocked = new DOMException("Clipboard write was blocked", "NotAllowedError");
    dom.clipboard.writeText.mockRejectedValueOnce(blocked).mockRejectedValueOnce(blocked);
    paste(box(1), TWELVE);
    await vi.waitFor(() => expect(said()).toBe("Your recovery phrase is still on the clipboard. Copy something else over it."));
    expect(words()).toEqual(TWELVE.split(" "));

    // No clipboard to write to at all, as in an old WebView: said too.
    const bare = mount();
    vi.stubGlobal("navigator", { language: "en-GB" });
    paste(bare.box(1), OTHER);
    await vi.waitFor(() => expect(bare.input.el.querySelector(".srp-clipboard").hidden).toBe(false));
  });

  // Marek's, in Firefox for Android with the clipboardWrite permission: the phrase stayed on the clipboard all the
  // same, and his page read it back. Firefox there writes no empty text ("Clipboard write is not allowed"), but
  // writes a space; and Gboard's clipboard chip puts the phrase in as typing, with no paste.
  it("writes a space over the phrase where the browser writes no empty text, and takes it off when a keyboard puts it in whole", async () => {
    const { box, input, words } = mount();
    const said = () => {
      const note = input.el.querySelector(".srp-clipboard");
      return note && isShown(note) ? note.textContent : "";
    };
    // Firefox for Android: "" refused, " " written.
    dom.clipboard.writeText.mockImplementation(async (text) => {
      if (text === "") throw new DOMException("Clipboard write is not allowed.", "NotAllowedError");
    });
    paste(box(1), TWELVE);
    await vi.waitFor(() => expect(dom.clipboard.writeText.mock.calls).toEqual([[""], [" "]]));
    await Promise.resolve();
    expect([words(), said()]).toEqual([TWELVE.split(" "), ""]);

    // The whole phrase from Gboard's clipboard chip: one input, no paste.
    dom.clipboard.writeText.mockClear();
    const fresh = mount();
    fresh.box(1).value = TWELVE;
    fresh.box(1).dispatchEvent(fakeEvent("input", { inputType: "insertText" }));
    expect(fresh.words()).toEqual(TWELVE.split(" "));
    await vi.waitFor(() => expect(dom.clipboard.writeText.mock.calls).toEqual([[""], [" "]]));
    // Typed a word at a time, nothing's written.
    dom.clipboard.writeText.mockClear();
    const typed = mount();
    typed.box(1).value = "legal ";
    typed.box(1).dispatchEvent(fakeEvent("input", { inputType: "insertText" }));
    await Promise.resolve();
    expect(dom.clipboard.writeText).not.toHaveBeenCalled();
  });

  it("puts a few words where they're pasted, as before", () => {
    const { box, words } = mount();
    paste(box(4), "legal winner thank");
    expect(words()).toEqual(["", "", "", "legal", "winner", "thank", "", "", "", "", "", ""]);
  });

  it("marks a word that isn't a recovery word after a paste, and says which", () => {
    const { box, cell, onCheck } = mount();
    paste(box(1), OTHER.replace("worth", "wurth"));
    expect([cell(7).classList.contains("is-invalid"), box(7).getAttribute("aria-invalid")]).toEqual([true, "true"]);
    expect(cell(6).classList.contains("is-invalid")).toBe(false);
    expect(onCheck).toHaveBeenLastCalledWith("Word 7 isn't a recovery word. Check its spelling.");

    paste(box(1), OTHER.replace("legal", "legl").replace("worth", "wurth"));
    expect(onCheck).toHaveBeenLastCalledWith("Words 1 and 7 aren't recovery words. Check their spelling.");
  });

  it("says plainly when a pasted phrase has the wrong count or its checksum fails, and nothing for a good one", () => {
    const { box, onCheck } = mount();
    paste(box(1), `${OTHER} wave`);
    expect(onCheck).toHaveBeenLastCalledWith("That's 13 words. A recovery phrase has 12 or 24.");
    paste(box(1), `${TWENTY_FOUR} art`);
    expect(onCheck).toHaveBeenLastCalledWith("That's 25 words. A recovery phrase has 12 or 24.");
    paste(box(1), NO_CHECKSUM);
    expect(onCheck).toHaveBeenLastCalledWith("That isn't a valid recovery phrase. Check each word.");
    paste(box(1), OTHER);
    expect(onCheck).toHaveBeenLastCalledWith("");
  });

  // bip39-vectors.json: test phrases and verdicts from bip39 3.1.0, the library before @scure/bip39.
  it("takes each 12- or 24-word phrase it took before, however it's spaced or capitalised, and refuses each checksum it refused", () => {
    const { box, onCheck } = mount();
    const verdict = (name) => bip39Vectors.verdicts.find((v) => v.case === name).phrase;
    const took = [
      ...bip39Vectors.seeds.filter((v) => v.words === 12 || v.words === 24).map((v) => v.phrase),
      ...["spaces around", "two spaces between words", "a tab and a newline between words", "no-break spaces between words", "a capital first letter", "capitals"].map(verdict),
    ];
    for (const phrase of took) {
      paste(box(1), phrase);
      expect(onCheck).toHaveBeenLastCalledWith("");
    }
    for (const name of ["wrong checksum, 12 words", "wrong checksum, 24 words"]) {
      paste(box(1), verdict(name));
      expect(onCheck, name).toHaveBeenLastCalledWith("That isn't a valid recovery phrase. Check each word.");
    }
  });

  it("marks a word not finished as its box is left, not while it's typed, and clears the mark once it's a word", () => {
    const { box, cell, onCheck } = mount();
    typeInto(box(1), "aban");
    expect(cell(1).classList.contains("is-invalid")).toBe(false);
    leave(box(1), box(2));
    expect([cell(1).classList.contains("is-invalid"), box(1).getAttribute("aria-invalid")]).toEqual([true, "true"]);
    // Still among the words: nothing said yet.
    expect(onCheck).not.toHaveBeenCalledWith(expect.stringMatching(/\S/));

    typeInto(box(1), "abandon");
    expect([cell(1).classList.contains("is-invalid"), box(1).getAttribute("aria-invalid")]).toEqual([false, null]);
  });

  it("says what's wrong once the focus leaves the words: a missing word, too few, or a checksum", () => {
    const { box, onCheck } = mount();
    const password = dom.document.createElement("input");
    dom.document.body.appendChild(password);

    // Nothing typed: nothing to say.
    leave(box(1), password);
    expect(onCheck).not.toHaveBeenCalledWith(expect.stringMatching(/\S/));

    const words = OTHER.split(" ");
    words.forEach((w, i) => typeInto(box(i + 1), w));
    typeInto(box(5), "");
    leave(box(12), password);
    expect(onCheck).toHaveBeenLastCalledWith("Word 5 is missing.");

    typeInto(box(5), "wave");
    typeInto(box(12), "");
    leave(box(11), password);
    expect(onCheck).toHaveBeenLastCalledWith("That's 11 words. A recovery phrase has 12 or 24.");

    typeInto(box(12), "abandon");
    leave(box(12), null);
    expect(onCheck).toHaveBeenLastCalledWith("That isn't a valid recovery phrase. Check each word.");
    // Typing again takes back what was said.
    typeInto(box(12), "yellow");
    expect(onCheck).toHaveBeenLastCalledWith("");
  });

  it("checks a phrase typed into one box with spaces as it checks a paste", () => {
    const { box, words, onCheck } = mount();
    typeInto(box(9), OTHER.replace("worth", "wurth"));
    expect(words()).toEqual(OTHER.replace("worth", "wurth").split(" "));
    expect(onCheck).toHaveBeenLastCalledWith("Word 7 isn't a recovery word. Check its spelling.");
  });

  // Chen's: in the Android app a phone's keyboard sends a space as text, never as a key, and every word went in box 1.
  it("moves on to the next box at a space after a word, sent as a key or as a phone's keyboard sends it, as text", () => {
    for (const as of ["keys", "text"]) {
      const onComplete = vi.fn();
      const { box, words } = mount({ onComplete });
      box(1).focus();
      typeKeys("kiwi lemon apple ", { as });
      expect([words(), dom.document.activeElement === box(4)], as).toEqual([["kiwi", "lemon", "apple", "", "", "", "", "", "", "", "", ""], true]);
      // A space in an empty box goes nowhere, and puts nothing in it.
      typeKeys(" ", { as });
      expect([words()[3], dom.document.activeElement === box(4)], as).toEqual(["", true]);
      // After the last box, on to what comes after the words, as Enter goes.
      box(12).focus();
      typeKeys("zoo ", { as });
      expect([words()[11], onComplete.mock.calls.length], as).toEqual(["zoo", 1]);
    }
  });

  it("takes any whitespace a keyboard commits for a space", () => {
    const { box, words } = mount();
    box(1).focus();
    typeKeys("kiwi lemon\tapple　", { as: "text" });
    expect(words().slice(0, 4)).toEqual(["kiwi", "lemon", "apple", ""]);
    expect(dom.document.activeElement).toBe(box(4));
  });

  it("puts words a keyboard commits at once in the boxes from there, and with a space after them moves on past the last", () => {
    const { box, words } = mount();
    box(3).focus();
    typeInto(box(3), "kiwi lemon apple ");
    expect(words()).toEqual(["", "", "kiwi", "lemon", "apple", "", "", "", "", "", "", ""]);
    expect(dom.document.activeElement).toBe(box(6));
  });

  // A phone's keyboard composes the word it suggests for, then commits it, a space with it or after it.
  it("takes a word the keyboard composed once it's done, in Chrome's order of events and Firefox's", () => {
    for (const order of ["chrome", "firefox"]) {
      const { box, words, onCheck } = mount();
      box(1).focus();
      compose("kiwi", { commit: "kiwi ", order });
      expect([words()[0], dom.document.activeElement === box(2)], order).toEqual(["kiwi", true]);
      compose("lemon", { order });
      expect(dom.document.activeElement, order).toBe(box(2));
      typeKeys(" ", { as: "text" });
      expect(dom.document.activeElement, order).toBe(box(3));
      // Several words at once, as voice typing composes them, put in the boxes from there, and said of after it's done.
      compose("apple kiwo pear", { order });
      expect(words().slice(0, 6), order).toEqual(["kiwi", "lemon", "apple", "kiwo", "pear", ""]);
      expect(onCheck, order).toHaveBeenLastCalledWith("Word 4 isn't a recovery word. Check its spelling.");
    }
  });

  it("keeps the words before an emptied box however often Backspace is pressed in it", () => {
    const { box, words } = mount();
    paste(box(1), OTHER);
    // Backspace as the browser does it: what the box doesn't stop deletes
    // the focused box's last letter, or the whole word when it's selected.
    const backspace = () => {
      const field = dom.document.activeElement;
      if (!press(field, "Backspace")) return;
      const whole = field.selectionStart === 0 && field.selectionEnd === field.value.length;
      typeInto(field, whole ? "" : field.value.slice(0, -1));
    };
    box(6).focus();
    for (let i = 0; i < 40; i++) backspace();
    const left = OTHER.split(" ");
    left[5] = "";
    expect(words()).toEqual(left);
    expect(dom.document.activeElement).toBe(box(6));
  });

  it("says the same on asking (problem), for the form's submit", () => {
    const { input, box } = mount();
    expect(input.problem()).toBe("");
    paste(box(1), NO_CHECKSUM);
    expect(input.problem()).toBe("That isn't a valid recovery phrase. Check each word.");
    paste(box(1), OTHER);
    expect([input.problem(), input.getMnemonic()]).toEqual(["", OTHER]);
  });

  it("can show a line above the words that describes them", () => {
    const { input } = mount({ hint: "Paste the whole phrase into any box." });
    const hint = input.el.querySelector(".srp-hint");
    expect(hint.textContent).toBe("Paste the whole phrase into any box.");
    // Above the boxes, under the 12 or 24 choice; under them, what's said of the clipboard after a paste.
    expect(input.el.children.map((el) => el.className)).toEqual(["tabs tabs--mini srp-toggle", "srp-hint", "box srp-box", "srp-clipboard"]);
    expect(input.el.getAttribute("aria-describedby")).toBe(hint.id);
    expect(mount().input.el.querySelector(".srp-hint")).toBeNull();
  });

  it("gives each box an edge of 3:1 or more against the page and the fields where words are typed (WCAG 1.4.11)", async () => {
    const css = await readFile(path.resolve(process.cwd(), "public", "ui.css"), "utf8");
    const rule = (selector) => css.split("\n}").find((block) => `\n${block}`.includes(`\n${selector} {`)) ?? "";
    const token = (name) => rule(":root").match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1];
    const edge = rule(".srp-grid--input .srp-word").match(/border-color:\s*var\((--[\w-]+)\)/)?.[1];
    expect(edge).toBeTruthy();

    const luminance = (hex) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (a, b) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    for (const surface of ["--surface-0", "--surface-1"]) {
      expect(contrast(token(edge), token(surface))).toBeGreaterThanOrEqual(3);
    }
    // The words shown to write down keep no edge.
    expect(rule(".srp-word")).toContain("border: 1px solid transparent;");
  });
});

// Hein's: the boxes suggest words as they're typed in, as the web wallet's did, from the wallet's own list,
// never the phone's keyboard. Made-up words only: list words in no wallet's order.
describe("words suggested as a box is typed in", () => {
  const listOf = (input) => input.el.querySelector("[role=listbox]");
  const chips = (input) => {
    const list = listOf(input);
    return list && isShown(list) ? list.querySelectorAll("[role=option]").map((o) => o.textContent) : [];
  };
  const marked = (input) => (chips(input).length ? listOf(input).querySelector('[role=option][aria-selected="true"]')?.textContent : "");
  const note = (input) => {
    const line = input.el.querySelector(".srp-word-note");
    return line && isShown(line) ? line.textContent : "";
  };
  const keydown = (field, key, props = {}) => {
    const e = fakeEvent("keydown", { key, ...props });
    field.dispatchEvent(e);
    return e;
  };

  it("shows, from two letters, up to four words of the list they start, under the box's row, the first marked, a listbox to screen readers", () => {
    const { input, box, cell } = mount();
    const grid = input.el.querySelector(".srp-grid");
    box(3).focus();
    typeInto(box(3), "a");
    expect(chips(input)).toEqual([]);
    typeInto(box(3), "ab");
    expect([chips(input), marked(input)]).toEqual([["abandon", "ability", "able", "about"], "abandon"]);
    // A row of its own under boxes 3 and 4, across both.
    const list = listOf(input);
    expect(grid.children.indexOf(list)).toBe(grid.children.indexOf(cell(4)) + 1);
    // The box names the list and its marked word, as a combobox's are named.
    const first = list.querySelector("[role=option]");
    expect(list.getAttribute("aria-label")).toBe("Suggested words");
    expect(["role", "aria-autocomplete", "aria-expanded", "aria-controls", "aria-activedescendant"].map((name) => box(3).getAttribute(name))).toEqual(["combobox", "list", "true", list.id, first.id]);
    // The box on the right of a row: under the same row; the next row's: under that one.
    typeInto(box(4), "zo");
    expect([chips(input), grid.children.indexOf(listOf(input))]).toEqual([["zone", "zoo"], grid.children.indexOf(cell(4)) + 1]);
    typeInto(box(5), "ki");
    expect([chips(input), grid.children.indexOf(listOf(input))]).toEqual([["kick", "kid", "kidney", "kind"], grid.children.indexOf(cell(6)) + 1]);
    // The box before it shows none now: only the box typed in has them.
    expect([box(3), box(4)].map((b) => [b.getAttribute("aria-expanded"), b.getAttribute("aria-activedescendant")])).toEqual([["false", null], ["false", null]]);
  });

  it("takes the marked word with Enter, the arrows moving the mark, a tapped one, or the marked one with Tab, and moves on", () => {
    const { input, box, words } = mount();
    box(1).focus();
    typeInto(box(1), "ab");
    keydown(box(1), "ArrowDown");
    keydown(box(1), "ArrowRight");
    expect(marked(input)).toBe("able");
    keydown(box(1), "ArrowUp");
    expect(marked(input)).toBe("ability");
    // Round from the first to the last.
    keydown(box(1), "ArrowLeft");
    expect(marked(input)).toBe("abandon");
    keydown(box(1), "ArrowLeft");
    expect([marked(input), box(1).getAttribute("aria-activedescendant")]).toEqual(["about", listOf(input).querySelectorAll("[role=option]")[3].id]);
    const enter = keydown(box(1), "Enter");
    expect([words()[0], dom.document.activeElement === box(2), chips(input), enter.defaultPrevented]).toEqual(["about", true, [], true]);

    // A tap: pressed, the row keeps the focus in the box (and a phone its keyboard); the word goes in, on to the next.
    typeInto(box(2), "zo");
    const zoo = listOf(input).querySelectorAll("[role=option]")[1];
    const press = fakeEvent("mousedown");
    zoo.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
    zoo.click();
    expect([words()[1], dom.document.activeElement === box(3), chips(input)]).toEqual(["zoo", true, []]);

    // Tab takes the marked one, and goes on as Tab goes; Shift+Tab takes nothing.
    typeInto(box(3), "wor");
    expect(keydown(box(3), "Tab", { shiftKey: true }).defaultPrevented).toBe(false);
    expect([words()[2], chips(input)]).toEqual(["wor", ["word", "work", "world", "worry"]]);
    const tab = keydown(box(3), "Tab");
    expect([words()[2], tab.defaultPrevented, chips(input)]).toEqual(["word", false, []]);

    // Escape puts them away till the next letter; Enter then goes on with what's typed, as before.
    box(4).focus();
    typeInto(box(4), "sa");
    expect(keydown(box(4), "Escape").defaultPrevented).toBe(true);
    expect(chips(input)).toEqual([]);
    typeInto(box(4), "sad");
    expect(chips(input)).toEqual(["sad", "saddle", "sadness"]);
    keydown(box(4), "Escape");
    keydown(box(4), "Enter");
    expect([words()[3], dom.document.activeElement === box(5)]).toEqual(["sad", true]);
  });

  it("needs no chip for the one word typed whole, but offers the words a whole word starts, and the list's spelling", () => {
    const { input, box, words } = mount();
    box(1).focus();
    typeInto(box(1), "zoo");
    expect(chips(input)).toEqual([]);
    typeInto(box(1), "act");
    expect([chips(input), marked(input)]).toEqual([["act", "action", "actor", "actress"], "act"]);
    keydown(box(1), "Enter");
    expect(words()[0]).toBe("act");
    // Typed with an accent, or with capitals: the list's word, taken as it spells it.
    typeInto(box(2), "Zóo");
    expect(chips(input)).toEqual(["zoo"]);
    keydown(box(2), "Enter");
    expect(words()[1]).toBe("zoo");
  });

  it("marks letters that start no word at once, Not a recovery word under the box, and a word not finished once it's left", () => {
    const { input, box, cell } = mount();
    const grid = input.el.querySelector(".srp-grid");
    const markOf = (n) => [cell(n).classList.contains("is-invalid"), box(n).getAttribute("aria-invalid")];
    box(5).focus();
    typeInto(box(5), "x");
    expect([note(input), markOf(5)]).toEqual(["", [false, null]]);
    typeInto(box(5), "xq");
    expect([note(input), chips(input), markOf(5)]).toEqual(["Not a recovery word", [], [true, "true"]]);
    // Said to screen readers as it shows, as the box's own error, under the row of boxes 5 and 6 (after its
    // chips' row, hidden).
    const line = input.el.querySelector(".srp-word-note");
    const at = grid.children.indexOf(cell(6));
    expect([line.getAttribute("role"), box(5).getAttribute("aria-errormessage"), grid.children[at + 1] === listOf(input), grid.children[at + 2] === line]).toEqual(["alert", line.id, true, true]);
    // Of a box on the right, at the row's end, under it.
    expect(line.classList.contains("is-end")).toBe(false);
    typeInto(box(6), "qx");
    expect([note(input), line.classList.contains("is-end"), markOf(6)]).toEqual(["Not a recovery word", true, [true, "true"]]);
    typeInto(box(6), "");
    box(5).focus();
    // Letters that start a word again: the mark goes as they're typed.
    typeInto(box(5), "ab");
    expect([note(input), markOf(5), box(5).getAttribute("aria-errormessage")]).toEqual(["", [false, null], null]);
    // A word not finished: marked once its box is left, as before; back in it, its words come again only as it's
    // typed in (Marek's: chips shown again with no key pressed).
    typeInto(box(5), "aban");
    expect(markOf(5)).toEqual([false, null]);
    leave(box(5), box(9));
    expect([markOf(5), chips(input)]).toEqual([[true, "true"], []]);
    box(5).focus();
    box(5).dispatchEvent(fakeEvent("focus"));
    expect([chips(input), markOf(5)]).toEqual([[], [true, "true"]]);
    typeInto(box(5), "aband");
    expect(chips(input)).toEqual(["abandon"]);
    listOf(input).querySelector("[role=option]").click();
    expect([box(5).value, markOf(5), dom.document.activeElement === box(6)]).toEqual(["abandon", [false, null], true]);
  });

  it("shows them for the box with the focus only, and they go as it's left; a word typed whole shows none as it's back", () => {
    const { input, box } = mount();
    box(2).focus();
    typeInto(box(2), "le");
    expect(chips(input)).toEqual(["leader", "leaf", "learn", "leave"]);
    leave(box(2), box(7));
    expect(chips(input)).toEqual([]);
    box(7).dispatchEvent(fakeEvent("focus"));
    expect(chips(input)).toEqual([]);
    typeInto(box(2), "act");
    leave(box(2), box(7));
    box(2).dispatchEvent(fakeEvent("focus"));
    expect(chips(input)).toEqual([]);
  });

  // Marek's, Sofía's, Chen's and Lena's: the chips print the word being typed in clear beside a masked box, and
  // Firefox's app switcher kept a card of them.
  it("puts the chips away the moment the page is hidden or loses the focus, back only as the box is typed in again", () => {
    const { input, box } = mount();
    for (const away of [
      () => {
        dom.document.visibilityState = "hidden";
        dom.document.dispatchEvent(fakeEvent("visibilitychange"));
      },
      () => dom.window.dispatchEvent(fakeEvent("pagehide")),
      () => dom.window.dispatchEvent(fakeEvent("blur")),
    ]) {
      dom.document.visibilityState = "visible";
      box(4).focus();
      typeInto(box(4), "ca");
      expect(chips(input)).toEqual(["cabbage", "cabin", "cable", "cactus"]);
      away();
      expect([chips(input), listOf(input).hidden]).toEqual([[], true]);
      // Back, the box still focused: nothing till a key.
      dom.document.visibilityState = "visible";
      dom.document.dispatchEvent(fakeEvent("visibilitychange"));
      box(4).dispatchEvent(fakeEvent("focus"));
      expect(chips(input)).toEqual([]);
      typeInto(box(4), "cab");
      expect(chips(input)).toEqual(["cabbage", "cabin", "cable"]);
      typeInto(box(4), "");
    }
  });

  it("still spreads a pasted phrase over the boxes and moves on at a space, with nothing left suggested", () => {
    const { input, box, words, onCheck } = mount();
    box(1).focus();
    typeInto(box(1), "ap");
    expect(chips(input)).toEqual(["apart", "apology", "appear", "apple"]);
    paste(box(1), OTHER);
    expect([words(), chips(input), onCheck.mock.lastCall]).toEqual([OTHER.split(" "), [], [""]]);
    box(3).focus();
    typeInto(box(3), "");
    typeKeys("ca", { as: "text" });
    expect(chips(input)).toEqual(["cabbage", "cabin", "cable", "cactus"]);
    typeKeys(" ", { as: "text" });
    expect([words()[2], dom.document.activeElement === box(4), chips(input)]).toEqual(["ca", true, []]);
    // A word pasted over letters suggested for, no box left empty: what was suggested for them goes with them.
    box(12).focus();
    typeInto(box(12), "ab");
    expect(chips(input)).toEqual(["abandon", "ability", "able", "about"]);
    paste(box(12), "zebra");
    expect([words()[11], chips(input)]).toEqual(["zebra", []]);
    keydown(box(12), "Enter");
    expect(words()[11]).toBe("zebra");
  });

  // The Android app's boxes are password boxes, its keyboard's one way to learn nothing: they stay so.
  it("suggests in the Android app's password boxes too, which keep their own role", () => {
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Linux; Android 15; sdk_gphone64_x86_64 Build/AE3A.240806.036; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.7390.122 Mobile Safari/537.36",
    });
    dom.window.__TAURI_INTERNALS__ = { invoke: vi.fn() };
    const { input, box, words } = mount();
    box(1).focus();
    typeKeys("ve", { as: "text" });
    expect(chips(input)).toEqual(["vehicle", "velvet", "vendor", "venture"]);
    expect(["type", "autocomplete", "role", "aria-activedescendant"].map((name) => box(1).getAttribute(name))).toEqual([
      "password",
      "one-time-code",
      null,
      listOf(input).querySelector("[role=option]").id,
    ]);
    listOf(input).querySelectorAll("[role=option]")[2].click();
    expect([words()[0], dom.document.activeElement === box(2)]).toEqual(["vendor", true]);
  });

  // Marek's: Firefox for Android's app switcher took its card of the page before the page heard it was leaving,
  // chips and all, the word being typed in clear beside its masked box.
  it("shows none in Firefox for Android, and still says when letters start no word", () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Android 15; Mobile; rv:159.0) Gecko/159.0 Firefox/159.0" });
    const { input, box, words } = mount();
    box(1).focus();
    typeKeys("ca", { as: "text" });
    expect([words()[0], chips(input)]).toEqual(["ca", []]);
    typeInto(box(1), "xq");
    expect([note(input), chips(input)]).toEqual(["Not a recovery word", []]);
  });

  it("asks nothing of the network and logs nothing as words are typed", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const logged = ["log", "info", "warn", "error", "debug"].map((name) => vi.spyOn(console, name));
    const { input, box } = mount();
    box(1).focus();
    for (const typed of ["w", "wa", "wal", "walk"]) typeInto(box(1), typed);
    keydown(box(1), "Enter");
    typeInto(box(2), "xq");
    expect([fetch.mock.calls.length, ...logged.map((spy) => spy.mock.calls.length), note(input)]).toEqual([0, 0, 0, 0, 0, 0, "Not a recovery word"]);
    for (const spy of logged) spy.mockRestore();
  });

  it("hands on a word typed with an accent or in capitals as the list spells it", () => {
    const { input, box } = mount();
    paste(box(1), OTHER.replace("legal", "LÉGAL").replace("worth", "wörth"));
    expect([input.problem(), input.getMnemonic()]).toEqual(["", OTHER]);
  });
});

