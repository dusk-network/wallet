// Boxes for "Check your recovery words": one for each word asked, named by
// its place (Word 4), as Import's boxes are made: no password manager, no
// keyboard learning, hidden on a phone till Show words (and again the moment
// the page is out of sight: pageAway.js; in Firefox for Android shown only
// while Hold to show words is held), the words a box's
// letters start suggested under it (WordSuggestions.js), and letters that
// start none marked at once. Enter, or a phone keyboard's Next, goes on to
// the next box, suggestions shown or not, and never checks (Lena's: a whole
// word and Enter in the first box said "That doesn't match" with two boxes
// empty). Check waits till every box holds a recovery word (`onReady`), and
// Enter in the last box checks (`onDone`) only then; a word taken there with
// Enter is only taken (Amélie's: it checked before she'd looked).

import { RECOVERY_WORDS_MISMATCH, RECOVERY_WORDS_SHOW, isRecoveryWord } from "@dusk-network/app-core/recovery-words";
import { wordlist } from "@scure/bip39/wordlists/english";
import { isTauriRuntime } from "../../platform/runtime.js";
import { h } from "../lib/dom.js";
import { isFirefoxAndroid, isPhone } from "../lib/device.js";
import { HOLD_TO_SHOW_TEXT, holdToShow, onPageAway } from "../lib/pageAway.js";
import { createWordSuggestions, underBox } from "./WordSuggestions.js";

/**
 * A check that didn't match: it says so, with Try again, the one button, and
 * below it, apart and small, Show my recovery words, for rewriting the paper,
 * which asks as showing them always does (Amélie's: beside Try again and its
 * size, a caller on the phone need only say "press the grey one"); both in
 * both wallets' words (app-core). A wrong answer shows no word, whatever was
 * typed.
 * @param {{ tryAgain: () => void, showWords: () => void }} opts
 */
export function wordsMismatch({ tryAgain, showWords }) {
  return [
    h("p", { class: "field-error", role: "alert", text: RECOVERY_WORDS_MISMATCH }),
    h("button", { class: "btn-primary btn-full", type: "button", text: "Try again", onclick: () => tryAgain() }),
    h("button", { class: "text-btn words-show", type: "button", text: RECOVERY_WORDS_SHOW, onclick: () => showWords() }),
  ];
}

/**
 * @param {{ places: number[], masked?: boolean, passwordBoxes?: boolean, onDone?: () => void, onReady?: (ready: boolean) => void }} opts
 *   `onReady`: told as the words change whether every box holds a recovery word, for Check
 */
export function createWordCheck({ places, masked = isPhone(), passwordBoxes = masked && isTauriRuntime(), onDone, onReady }) {
  const inputs = places.map((place, i) =>
    h("input", {
      type: passwordBoxes ? "password" : "text",
      inputmode: "text",
      autocomplete: passwordBoxes ? "one-time-code" : "off",
      autocorrect: "off",
      autocapitalize: "none",
      spellcheck: "false",
      enterkeyhint: i === places.length - 1 ? "done" : "next",
      "aria-label": `Word ${place}`,
    })
  );
  const cells = places.map((place, i) => h("div", { class: "srp-word" }, [h("div", { class: "srp-word-index", text: String(place) }), h("div", { class: "srp-word-input" }, [inputs[i]])]));
  const last = inputs.length - 1;
  // Box `i` marked as holding no recovery word (`on`), for screen readers too.
  const mark = (i, on) => {
    cells[i].classList.toggle("is-invalid", on);
    if (on) inputs[i].setAttribute("aria-invalid", "true");
    else inputs[i].removeAttribute("aria-invalid");
  };
  // Whether box `i` holds a recovery word, and the first that doesn't (-1 for none).
  const holds = (i) => isRecoveryWord(inputs[i].value.trim(), wordlist);
  const firstEmpty = () => inputs.findIndex((_, i) => !holds(i));
  const told = () => onReady?.(firstEmpty() < 0);
  // A word taken from the suggestions: a tap or Enter goes on to the next
  // box, and on the last stays, checked only with its own press; Tab as the
  // browser goes.
  const suggest = createWordSuggestions({
    take: (input, word, by) => {
      const i = inputs.indexOf(input);
      if (i < 0) return;
      input.value = word;
      mark(i, false);
      told();
      if ((by === "enter" || by === "tap") && i < last) inputs[i + 1].focus?.();
    },
  });
  const suggestFor = (i, opts) => suggest.show(inputs[i], { ...underBox(cells, i, inputs.length), ...opts });
  inputs.forEach((input, i) => {
    suggest.attach(input);
    input.addEventListener("keydown", (e) => {
      // A key the keyboard keeps for itself (229), or one it composes with, isn't the page's.
      if (!e || e.isComposing || e.keyCode === 229) return;
      if (suggest.key(e, input)) return;
      if (e.key !== "Enter") return;
      e.preventDefault?.();
      // On to the next box; on the last, the check once every box holds a word, else the first that doesn't.
      if (i < last) inputs[i + 1].focus?.();
      else if (firstEmpty() < 0) onDone?.();
      else inputs[firstEmpty()].focus?.();
    });
    // Marked at once where its letters start no word; a word not finished, once it's left.
    input.addEventListener("input", () => {
      mark(i, suggestFor(i, { typing: true }).none);
      told();
    });
    input.addEventListener("focus", () => suggestFor(i));
    input.addEventListener("blur", () => {
      suggest.hide();
      const typed = input.value.trim();
      mark(i, Boolean(typed) && !isRecoveryWord(typed, wordlist));
    });
  });
  const grid = h("div", { class: ["srp-grid srp-grid--input", masked ? "srp-grid--masked is-hidden" : ""].filter(Boolean).join(" ") }, cells);
  let shown = false;
  const hold = masked && isFirefoxAndroid();
  const setShown = (next) => {
    shown = next;
    grid.classList.toggle("is-hidden", !shown);
    if (passwordBoxes) for (const input of inputs) input.setAttribute("type", shown ? "text" : "password");
    if (!hold) showBtn.textContent = shown ? "Hide words" : "Show words";
    showBtn.setAttribute("aria-pressed", String(shown));
  };
  const showBtn = masked ? h("button", { class: "text-btn srp-show", type: "button", text: hold ? HOLD_TO_SHOW_TEXT : "Show words", "aria-pressed": "false" }) : null;
  if (showBtn && hold) holdToShow(showBtn, setShown);
  else if (showBtn) showBtn.onclick = () => setShown(!shown);
  const el = h("form", { class: "mnemonic-input", novalidate: "" }, [h("div", { class: "box srp-box" }, [grid]), showBtn].filter(Boolean));
  el.addEventListener("submit", (e) => e.preventDefault?.());
  // Shown words hide again the moment the page is out of sight, till Show words again.
  if (masked) {
    onPageAway(() => {
      if (shown) setShown(false);
    }, el);
  }
  return {
    el,
    /** Each word typed, by its place. */
    typed: () => places.map((place, i) => [place, inputs[i].value]),
    /** Whether every box holds a recovery word: Check waits till then. */
    ready: () => firstEmpty() < 0,
    clear: () => {
      suggest.hide();
      inputs.forEach((input, i) => {
        input.value = "";
        mark(i, false);
      });
      told();
    },
    focus: () => inputs[0]?.focus?.(),
    setDisabled: (on) => {
      if (on) suggest.hide();
      inputs.forEach((input) => (input.disabled = Boolean(on)));
    },
  };
}
