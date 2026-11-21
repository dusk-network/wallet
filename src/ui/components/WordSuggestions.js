// Words suggested under the recovery-word box being typed in, for Import,
// Add wallet and Check your recovery words (MnemonicInput.js, WordCheck.js):
// from two letters on, up to four words of the wallet's own BIP39 English
// list that start with them (app-core's wordSuggestions), as chips in a row of
// their own under the box's, the first one marked. A tap takes one, Enter and
// Tab the marked one; the arrow keys move the mark, and Escape puts them away
// till the next letter. A word that's the only one, typed whole, needs none.
// Letters that start no word are said to at once, in that row: Not in the
// word list. Only the box typed in has them, and they go as it's left, and the
// moment the page is hidden or loses the focus, as for a phone's app switcher,
// coming back only as the box is typed in again (Marek's: Firefox's switcher
// kept a card of the chips, the word being typed in clear beside its masked
// box). In Firefox for Android, none: its switcher takes the card before the
// page hears it's leaving, chips and all. What's said of letters that start
// no word stays.
//
// They come from the list in the app, never the phone's keyboard, which
// learns what's typed: nothing is sent, kept or logged. To a screen reader
// the chips are a listbox under the box, the marked one its active option.

import { wordSuggestions } from "@dusk-network/app-core/recovery-words";
import { wordlist } from "@scure/bip39/wordlists/english";
import { isFirefoxAndroid } from "../lib/device.js";
import { h } from "../lib/dom.js";

/** What's said under a box whose letters start no recovery word. */
export const NOT_A_WORD_TEXT = "Not in the word list";

// The boxes' columns (ui.css, .srp-grid): the chips' row goes under the box's.
const COLUMNS = 2;

let made = 0;

// The sets of suggestions showing now, put away together as the page is
// hidden or loses the focus.
const showing = new Set();
let watched = null;
function watchPage() {
  const win = globalThis.window;
  if (watched === win || typeof win?.addEventListener !== "function") return;
  watched = win;
  const putAway = () => {
    for (const each of [...showing]) each.hide();
  };
  const doc = globalThis.document;
  win.addEventListener("blur", putAway);
  win.addEventListener("pagehide", putAway);
  doc?.addEventListener?.("visibilitychange", () => {
    if (doc.visibilityState === "hidden") putAway();
  });
}

/**
 * Where the chips of the box at `i` go, of the `count` shown in a grid of
 * `cells`: after the cell that ends its row (`after`); what's said of it at
 * the row's end (`end`) where the box ends its row, so that's under it.
 * @param {HTMLElement[]} cells
 * @param {number} i
 * @param {number} count
 * @returns {{ after: HTMLElement, end: boolean }}
 */
export const underBox = (cells, i, count) => ({ after: cells[Math.min(i - (i % COLUMNS) + COLUMNS - 1, count - 1)], end: i % COLUMNS === COLUMNS - 1 });

/**
 * Suggestions for one set of word boxes: one row of chips and one line, under
 * whichever box is typed in. `take` puts the word a tap, Enter or Tab took in
 * its box, and moves on as it says (`by`): a tap and Enter to the next box,
 * Tab as the browser does.
 * @param {{ take: (input: HTMLInputElement, word: string, by: "tap" | "enter" | "tab") => void }} opts
 */
export function createWordSuggestions({ take }) {
  watchPage();
  const id = `srp-suggest-${++made}`;
  // Pressed, the row keeps the focus in the box, and a phone its keyboard.
  const list = h("div", { class: "srp-suggest", id, role: "listbox", "aria-label": "Suggested words", hidden: true, onmousedown: (e) => e.preventDefault?.() });
  const note = h("p", { class: "field-error srp-word-note", id: `${id}-note`, role: "alert", hidden: true });
  // The box they're for, its words shown, and the one marked.
  let box = null;
  let words = [];
  let active = 0;

  const combobox = (input) => input?.getAttribute("role") === "combobox";

  function mark(next) {
    active = next;
    [...list.children].forEach((chip, n) => chip.setAttribute("aria-selected", String(n === active)));
    box?.setAttribute("aria-activedescendant", `${id}-${active}`);
  }

  // The chips' row, then the line, right after `after`; the line at the
  // row's end where the box is (`end`).
  function place(after, end) {
    note.classList.toggle("is-end", Boolean(end));
    const parent = after?.parentNode;
    if (!parent) return;
    if (after.nextSibling !== list) parent.insertBefore(list, after.nextSibling);
    if (list.nextSibling !== note) parent.insertBefore(note, list.nextSibling);
  }

  function hide() {
    showing.delete(api);
    if (!box && list.hidden && note.hidden) return;
    list.hidden = true;
    note.hidden = true;
    list.replaceChildren();
    note.textContent = "";
    if (box) {
      box.removeAttribute("aria-activedescendant");
      box.removeAttribute("aria-errormessage");
      if (combobox(box)) box.setAttribute("aria-expanded", "false");
    }
    box = null;
    words = [];
  }

  function pick(n, by) {
    const input = box;
    const word = words[n];
    hide();
    if (input && word) take(input, word, by);
  }

  const api = {
    /**
     * A box of the set, told of its suggestions; a password box's role stays
     * its own, as ARIA has none other for it.
     * @param {HTMLInputElement} input
     */
    attach(input) {
      input.setAttribute("aria-autocomplete", "list");
      input.setAttribute("aria-controls", id);
      if (input.getAttribute("type") !== "password") {
        input.setAttribute("role", "combobox");
        input.setAttribute("aria-expanded", "false");
      }
    },

    /**
     * What `input`, the box typed in, has under it, in a row after `after`
     * (underBox): chips for what's typed in it, only as it's typed in
     * (`typing`), never as it's focused again; and that its letters start no
     * word. Whether they don't.
     * @param {HTMLInputElement} input
     * @param {{ after: HTMLElement, end?: boolean, typing?: boolean }} opts
     * @returns {{ none: boolean }}
     */
    show(input, { after, end = false, typing = false }) {
      const typed = String(input.value ?? "").trim();
      const found = wordSuggestions(typed, wordlist);
      const none = [...typed].length >= 2 && found.length === 0;
      const whole = found.length === 1 && found[0] === typed.toLowerCase();
      const next = typing && !none && !whole && !isFirefoxAndroid() ? found : [];
      if (!next.length && !none) {
        hide();
        return { none };
      }
      // As they were, for the same box: left be, the mark where it was, the line not said again.
      if (box === input && note.hidden === !none && words.join(" ") === next.join(" ")) {
        place(after, end);
        return { none };
      }
      hide();
      box = input;
      words = next;
      showing.add(api);
      place(after, end);
      if (none) {
        note.textContent = NOT_A_WORD_TEXT;
        note.hidden = false;
        input.setAttribute("aria-errormessage", note.id);
        return { none };
      }
      list.replaceChildren(
        ...words.map((word, n) =>
          h("div", {
            class: "srp-suggest__word",
            id: `${id}-${n}`,
            role: "option",
            "aria-selected": "false",
            text: word,
            onclick: () => pick(n, "tap"),
          })
        )
      );
      list.hidden = false;
      if (combobox(input)) input.setAttribute("aria-expanded", "true");
      mark(0);
      return { none };
    },

    hide,

    /**
     * A key pressed in `input`: taken where its chips show, and whether it was.
     * @param {KeyboardEvent} e
     * @param {HTMLInputElement} input
     */
    key(e, input) {
      if (input !== box || !words.length) return false;
      const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
      if (step) {
        e.preventDefault?.();
        mark((active + step + words.length) % words.length);
        return true;
      }
      if (e.key === "Enter") {
        e.preventDefault?.();
        pick(active, "enter");
        return true;
      }
      // Taken, and on as Tab goes; back with Shift isn't a choice.
      if (e.key === "Tab" && !e.shiftKey) {
        pick(active, "tab");
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault?.();
        hide();
        return true;
      }
      return false;
    },
  };
  return api;
}
