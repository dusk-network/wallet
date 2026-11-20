import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import bip39Vectors from "../../shared/fixtures/bip39-vectors.json";
import { fakeEvent, installFakeDom, isShown, typeInto, typeKeys } from "../testing/fakeDom.js";
import { HOLD_LONGEST_MS } from "../lib/pageAway.js";
import { CLIPBOARD_KEPT_TEXT, createMnemonicInput } from "./MnemonicInput.js";

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
  // What `onCheck` is told of `act`, and only of it: what's wrong with the words then, "" for nothing.
  const said = (act) => {
    onCheck.mockClear();
    act();
    expect(onCheck).toHaveBeenCalled();
    return onCheck.mock.lastCall[0];
  };
  // The boxes marked as holding no recovery word, by number.
  const marked = () => input.el.querySelectorAll("input").filter(isShown).flatMap((i, n) => (i.getAttribute("aria-invalid") === "true" && cell(n + 1).classList.contains("is-invalid") ? [n + 1] : []));
  return { input, onCheck, box, cell, words, said, marked };
}

const paste = (field, text) => field.dispatchEvent(fakeEvent("paste", { clipboardData: { getData: () => text } }));
// The focus leaving `field` for `to` (null: for nothing on the page).
const leave = (field, to = null) => field.dispatchEvent(fakeEvent("focusout", { relatedTarget: to }));
// Show words, or Hold to show words, whatever it says.
const showButton = (input) => input.el.querySelector(".srp-show");
// The numbers a sentence names, in order: the words it means, or a count.
const numbersIn = (text) => text.match(/\d+/g) ?? [];
// A figure exactly as written: not inside a longer number, not signed or bounded unless written so, and not followed by
// more digits, letters or a decimal part (1.0025 ≠ 11.0025, 0.005 ≠ −0.005, 2,000,000 ≠ 2,000,000.5, BNB ≠ BNBX).
const exactly = (text) => new RegExp(`(?<![\\d.,+\\-−<>≤≥~])${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\dA-Za-z]|[.,]\\d)`);
// Says a phrase isn't valid, in its key words ("isn't a valid recovery phrase"), and never that it is one.
const notValid = (text, name) => {
  expect(text, name).toMatch(/\b(?:isn['’]t|is not) a valid\b|\binvalid\b/i);
  expect(text, name).not.toMatch(/\bis a valid\b/i);
};

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
    const show = showButton(input);
    show.click();
    expect(hidden()).toBe(true);
    show.dispatchEvent(fakeEvent("pointerdown", { button: 0, pointerId: 1 }));
    expect([new Set(boxes().map(String)), hidden(), show.getAttribute("aria-pressed")]).toEqual([new Set(["text,true"]), false, "true"]);
    show.dispatchEvent(fakeEvent("pointerup", { button: 0, pointerId: 1 }));
    expect([new Set(boxes().map(String)), hidden(), show.getAttribute("aria-pressed")]).toEqual([new Set(["text,false"]), true, "false"]);
    typeInto(box(3), "zoo");
    expect(words()[2]).toBe("zoo");
  });

  it("shows the words in Firefox for Android only while Hold to show words is held, by a finger or a key", () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Android 15; Mobile; rv:159.0) Gecko/159.0 Firefox/159.0" });
    const { input, box } = mount();
    paste(box(1), TWELVE);
    const grid = input.el.querySelector(".srp-grid");
    const show = showButton(input);
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
      [{ type: "pointerdown", button: 0, pointerId: 5 }, { page: () => dom.window.dispatchEvent(fakeEvent("pagehide")) }],
      // Marek's: a second touch while it's held, anywhere on the page.
      [{ type: "pointerdown", button: 0, pointerId: 6 }, { page: () => dom.document.body.dispatchEvent(fakeEvent("pointerdown", { button: 0, pointerId: 7 })) }],
      [{ type: "pointerdown", button: 0, pointerId: 8 }, { page: () => dom.document.body.dispatchEvent(fakeEvent("touchstart", { touches: [{}, {}] })) }],
      [{ type: "pointerdown", button: 0, pointerId: 9 }, { type: "pointerdown", button: 0, pointerId: 10 }],
      // Let go off the button, or a menu over the page.
      [{ type: "pointerdown", button: 0, pointerId: 11 }, { page: () => dom.document.body.dispatchEvent(fakeEvent("pointerup", { pointerId: 11 })) }],
      [{ type: "pointerdown", button: 0, pointerId: 12 }, { page: () => dom.document.body.dispatchEvent(fakeEvent("contextmenu")) }],
      [{ type: "pointerdown", button: 0, pointerId: 13 }, { type: "lostpointercapture", pointerId: 13 }],
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
    show.dispatchEvent(fakeEvent("pointerdown", { button: 0, pointerId: 14 }));
    const menu = fakeEvent("contextmenu");
    show.dispatchEvent(menu);
    expect([menu.defaultPrevented, seen()]).toEqual([true, true]);
    show.dispatchEvent(fakeEvent("pointerup", { pointerId: 14 }));
    expect(seen()).toBe(false);
  });

  // Amélie's: she'd write the words down holding still, a thumb Firefox hears nothing of till it moves about 0.8 mm.
  // Marek's: holding, then touching Firefox's toolbar with another finger, Firefox told the page nothing of the
  // hold's end, and all twelve words stayed on screen with no finger down: one hold shows them for a minute at most.
  it("keeps the words for a still hold, hides them a minute into one hold, and a press after a hold whose end it never heard shows nothing", () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Android 15; Mobile; rv:159.0) Gecko/159.0 Firefox/159.0" });
      const { input, box } = mount();
      paste(box(1), TWELVE);
      const grid = input.el.querySelector(".srp-grid");
      const show = showButton(input);
      const seen = () => !grid.classList.contains("is-hidden");
      const finger = (type, pointerId, more = {}) => show.dispatchEvent(fakeEvent(type, { button: 0, pointerId, pointerType: "touch", ...more }));

      // Held still for 5 seconds, the page hearing nothing of the finger: shown all along.
      finger("pointerdown", 1);
      vi.advanceTimersByTime(5_000);
      expect(seen()).toBe(true);
      vi.advanceTimersByTime(54_000);
      expect(seen()).toBe(true);
      // 61 seconds into the one hold: hidden. Its late end changes nothing; holding again shows them again.
      vi.advanceTimersByTime(2_000);
      expect([seen(), HOLD_LONGEST_MS]).toEqual([false, 60_000]);
      finger("pointerup", 1);
      finger("pointerdown", 2);
      expect(seen()).toBe(true);
      // Taken away, or a second touch anywhere: hidden at once, as ever.
      finger("pointercancel", 2);
      expect(seen()).toBe(false);
      finger("pointerdown", 3);
      expect(seen()).toBe(true);
      dom.document.body.dispatchEvent(fakeEvent("pointerdown", { button: 0, pointerId: 4, pointerType: "touch" }));
      expect(seen()).toBe(false);
      finger("pointerup", 3);

      // A hold whose end never came, and a new press that reuses its pointer: the hold is over, and that press
      // shows nothing; the one after it does.
      finger("pointerdown", 0);
      finger("pointerdown", 0);
      expect(seen()).toBe(false);
      finger("pointerup", 0);
      finger("pointerdown", 0);
      expect(seen()).toBe(true);
      finger("pointerup", 0);

      // A key held for a minute: hidden too.
      show.dispatchEvent(fakeEvent("keydown", { key: " " }));
      vi.advanceTimersByTime(HOLD_LONGEST_MS - 1);
      expect(seen()).toBe(true);
      vi.advanceTimersByTime(1);
      expect(seen()).toBe(false);
      show.dispatchEvent(fakeEvent("keyup", { key: " " }));
    } finally {
      vi.useRealTimers();
    }
  });

  // Marek's: with Show words on, Firefox's tab list and Android's app switcher kept a picture of the twelve words in clear.
  it("hides shown words again the moment the page is hidden, left or loses the focus, till Show words again", () => {
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Linux; Android 15; sdk_gphone64_x86_64 Build/AE3A.240806.036; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.7390.122 Mobile Safari/537.36",
    });
    dom.window.__TAURI_INTERNALS__ = { invoke: vi.fn() };
    const { input, box } = mount();
    const grid = input.el.querySelector(".srp-grid");
    const show = showButton(input);
    const seen = () => [!grid.classList.contains("is-hidden"), show.getAttribute("aria-pressed")];
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
      expect(seen()).toEqual([true, "true"]);
      away();
      expect(seen()).toEqual([false, "false"]);
      // Back in sight: still hidden, till Show words.
      dom.document.visibilityState = "visible";
      dom.document.dispatchEvent(fakeEvent("visibilitychange"));
      dom.window.dispatchEvent(fakeEvent("focus"));
      expect(seen()).toEqual([false, "false"]);
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
    showButton(input).click();
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
      expect(showButton(input)).toBeNull();
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
    await vi.waitFor(() => expect(said()).toMatch(/\bstill on the clipboard\b/i));
    expect(said()).toBe(CLIPBOARD_KEPT_TEXT);
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
    const { box, said, marked } = mount();
    // Marked, and named: the word that isn't one, not one that's missing.
    const one = said(() => paste(box(1), OTHER.replace("worth", "wurth")));
    expect(marked()).toEqual([7]);
    expect(numbersIn(one)).toEqual(["7"]);
    expect(one).not.toMatch(/missing/i);

    const two = said(() => paste(box(1), OTHER.replace("legal", "legl").replace("worth", "wurth")));
    expect(marked()).toEqual([1, 7]);
    expect(numbersIn(two)).toEqual(["1", "7"]);
    expect(two).not.toMatch(/missing/i);
  });

  it("says when a pasted phrase has the wrong count or its checksum fails, and nothing for a good one", () => {
    const { box, said } = mount();
    // Too many words: how many, and nothing of the phrase being valid.
    for (const [phrase, count] of [
      [`${OTHER} wave`, "13 words"],
      [`${TWENTY_FOUR} art`, "25 words"],
    ]) {
      const told = said(() => paste(box(1), phrase));
      expect(told, count).toMatch(exactly(count));
      expect(told, count).not.toMatch(/valid/i);
    }
    // Every word the list's, as many as a phrase has, its checksum wrong: not a valid phrase, naming no word or count.
    const checksum = said(() => paste(box(1), NO_CHECKSUM));
    notValid(checksum);
    expect(numbersIn(checksum)).toEqual([]);
    expect(said(() => paste(box(1), OTHER))).toBe("");
  });

  // bip39-vectors.json: test phrases and verdicts from bip39 3.1.0, the library before @scure/bip39.
  it("takes each 12- or 24-word phrase it took before, however it's spaced or capitalised, and refuses each checksum it refused", () => {
    const { box, said } = mount();
    const verdict = (name) => bip39Vectors.verdicts.find((v) => v.case === name).phrase;
    const took = [
      ...bip39Vectors.seeds.filter((v) => v.words === 12 || v.words === 24).map((v) => v.phrase),
      ...["spaces around", "two spaces between words", "a tab and a newline between words", "no-break spaces between words", "a capital first letter", "capitals"].map(verdict),
    ];
    for (const phrase of took) expect(said(() => paste(box(1), phrase))).toBe("");
    // Refused for its checksum: not a valid phrase, naming no word or count.
    for (const name of ["wrong checksum, 12 words", "wrong checksum, 24 words"]) {
      const told = said(() => paste(box(1), verdict(name)));
      notValid(told, name);
      expect(numbersIn(told), name).toEqual([]);
    }
  });

  it("says what's wrong once the focus leaves the words: a missing word, too few, or a checksum", () => {
    const { box, onCheck, said } = mount();
    const password = dom.document.createElement("input");
    dom.document.body.appendChild(password);

    // Nothing typed: nothing to say.
    leave(box(1), password);
    expect(onCheck).not.toHaveBeenCalledWith(expect.stringMatching(/\S/));

    const words = OTHER.split(" ");
    words.forEach((w, i) => typeInto(box(i + 1), w));
    typeInto(box(5), "");
    const missing = said(() => leave(box(12), password));
    expect(missing).toMatch(/missing/i);
    expect(numbersIn(missing)).toEqual(["5"]);

    typeInto(box(5), "wave");
    typeInto(box(12), "");
    const few = said(() => leave(box(11), password));
    expect(few).toMatch(exactly("11 words"));
    expect(few).not.toMatch(/missing|valid/i);

    typeInto(box(12), "abandon");
    const checksum = said(() => leave(box(12), null));
    notValid(checksum);
    expect(numbersIn(checksum)).toEqual([]);
    // Typing again takes back what was said.
    expect(said(() => typeInto(box(12), "yellow"))).toBe("");
  });

  it("checks a phrase typed into one box with spaces as it checks a paste", () => {
    const { box, words, said, marked } = mount();
    const told = said(() => typeInto(box(9), OTHER.replace("worth", "wurth")));
    expect(words()).toEqual(OTHER.replace("worth", "wurth").split(" "));
    expect(marked()).toEqual([7]);
    expect(numbersIn(told)).toEqual(["7"]);
    expect(told).not.toMatch(/missing/i);
  });

  it("says the same on asking (problem), for the form's submit", () => {
    const { input, box, said } = mount();
    expect(input.problem()).toBe("");
    const checksum = said(() => paste(box(1), NO_CHECKSUM));
    notValid(checksum);
    expect(input.problem()).toBe(checksum);
    paste(box(1), OTHER);
    expect([input.problem(), input.getMnemonic()]).toEqual(["", OTHER]);
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
  // What's said under a box whose letters start no word.
  const note = (input) => {
    const line = input.el.querySelector(".srp-word-note");
    return line && isShown(line) ? line.textContent : "";
  };
  const keydown = (field, key, props = {}) => {
    const e = fakeEvent("keydown", { key, ...props });
    field.dispatchEvent(e);
    return e;
  };

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
    const { input, box, words, said } = mount();
    box(1).focus();
    typeInto(box(1), "ap");
    expect(chips(input)).toEqual(["apart", "apology", "appear", "apple"]);
    const told = said(() => paste(box(1), OTHER));
    expect([words(), chips(input), told]).toEqual([OTHER.split(" "), [], ""]);
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

  // Marek's: Firefox for Android's app switcher took its card of the page before the page heard it was leaving,
  // chips and all, the word being typed in clear beside its masked box.
  it("shows none in Firefox for Android, and still says when letters start no word", () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Android 15; Mobile; rv:159.0) Gecko/159.0 Firefox/159.0" });
    const { input, box, words } = mount();
    box(1).focus();
    typeKeys("ca", { as: "text" });
    expect([words()[0], chips(input)]).toEqual(["ca", []]);
    typeInto(box(1), "xq");
    expect([note(input), chips(input), box(1).getAttribute("aria-invalid")]).toEqual([expect.stringMatching(/\S/), [], "true"]);
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
    expect([fetch.mock.calls.length, ...logged.map((spy) => spy.mock.calls.length), note(input), box(2).getAttribute("aria-invalid")]).toEqual([0, 0, 0, 0, 0, 0, expect.stringMatching(/\S/), "true"]);
    for (const spy of logged) spy.mockRestore();
  });

  it("hands on a word typed with an accent or in capitals as the list spells it", () => {
    const { input, box } = mount();
    paste(box(1), OTHER.replace("legal", "LÉGAL").replace("worth", "wörth"));
    expect([input.problem(), input.getMnemonic()]).toEqual(["", OTHER]);
  });
});
