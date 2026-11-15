// Boxes for "Check your recovery words": one for each word asked, named by
// its place (Word 4), as Import's boxes are made: no password manager, no
// keyboard learning, hidden on a phone till Show words, the words a box's
// letters start suggested under it (WordSuggestions.js), and letters that
// start none marked at once. Enter goes on to the next box, and on the last,
// to the check (`onDone`).

import { RECOVERY_WORDS_MISMATCH, RECOVERY_WORDS_SHOW, isRecoveryWord } from "@dusk-network/app-core/recovery-words";
import { wordlist } from "@scure/bip39/wordlists/english";
import { isTauriRuntime } from "../../platform/runtime.js";
import { h } from "../lib/dom.js";
import { isPhone } from "../lib/device.js";
import { createWordSuggestions, underBox } from "./WordSuggestions.js";

/**
 * A check that didn't match: it says so, with Try again, and apart from it
 * Show my recovery words, for rewriting the paper, which asks as showing them
 * always does; both in both wallets' words (app-core). A wrong answer shows
 * no word, whatever was typed.
 * @param {{ tryAgain: () => void, showWords: () => void }} opts
 */
export function wordsMismatch({ tryAgain, showWords }) {
  return [
    h("p", { class: "field-error", role: "alert", text: RECOVERY_WORDS_MISMATCH }),
    h("button", { class: "btn-primary btn-full", type: "button", text: "Try again", onclick: () => tryAgain() }),
    h("button", { class: "btn-outline btn-full", type: "button", text: RECOVERY_WORDS_SHOW, onclick: () => showWords() }),
  ];
}

/**
 * @param {{ places: number[], masked?: boolean, passwordBoxes?: boolean, onDone?: () => void }} opts
 */
export function createWordCheck({ places, masked = isPhone(), passwordBoxes = masked && isTauriRuntime(), onDone }) {
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
  // A word taken from the suggestions: a tap or Enter goes on to the next
  // box, Enter on the last to the check; Tab as the browser goes.
  const suggest = createWordSuggestions({
    take: (input, word, by) => {
      const i = inputs.indexOf(input);
      if (i < 0) return;
      input.value = word;
      mark(i, false);
      if (by === "enter" && i === last) onDone?.();
      else if (by === "enter" || (by === "tap" && i < last)) inputs[i + 1].focus?.();
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
      if (i < last) inputs[i + 1].focus?.();
      else onDone?.();
    });
    // Marked at once where its letters start no word; a word not finished, once it's left.
    input.addEventListener("input", () => mark(i, suggestFor(i, { typing: true }).none));
    input.addEventListener("focus", () => suggestFor(i));
    input.addEventListener("blur", () => {
      suggest.hide();
      const typed = input.value.trim();
      mark(i, Boolean(typed) && !isRecoveryWord(typed, wordlist));
    });
  });
  const grid = h("div", { class: ["srp-grid srp-grid--input", masked ? "srp-grid--masked is-hidden" : ""].filter(Boolean).join(" ") }, cells);
  let shown = false;
  const showBtn = masked
    ? h("button", {
        class: "text-btn srp-show",
        type: "button",
        text: "Show words",
        "aria-pressed": "false",
        onclick: () => {
          shown = !shown;
          grid.classList.toggle("is-hidden", !shown);
          if (passwordBoxes) for (const input of inputs) input.setAttribute("type", shown ? "text" : "password");
          showBtn.textContent = shown ? "Hide words" : "Show words";
          showBtn.setAttribute("aria-pressed", String(shown));
        },
      })
    : null;
  const el = h("form", { class: "mnemonic-input", novalidate: "" }, [h("div", { class: "box srp-box" }, [grid]), showBtn].filter(Boolean));
  el.addEventListener("submit", (e) => e.preventDefault?.());
  return {
    el,
    /** Each word typed, by its place. */
    typed: () => places.map((place, i) => [place, inputs[i].value]),
    filled: () => inputs.every((input) => input.value.trim() !== ""),
    clear: () => {
      suggest.hide();
      inputs.forEach((input, i) => {
        input.value = "";
        mark(i, false);
      });
    },
    focus: () => inputs[0]?.focus?.(),
    setDisabled: (on) => {
      if (on) suggest.hide();
      inputs.forEach((input) => (input.disabled = Boolean(on)));
    },
  };
}
