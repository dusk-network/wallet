import { wordlists } from "bip39";
import { h } from "../lib/dom.js";
import { normalizeMnemonic } from "../lib/strings.js";

// We generate + validate mnemonics against the BIP39 English wordlist.
const WORDSET = new Set(wordlists.english);

function isValidWord(word) {
  if (!word) return true;
  return WORDSET.has(String(word).toLowerCase());
}

function firstEmptyIndex(inputs, count) {
  for (let i = 0; i < count; i++) {
    if (!String(inputs[i]?.value ?? "").trim()) return i;
  }
  return -1;
}

/**
 * A mnemonic input UI that uses numbered word slots (12/24) instead of a free-form textarea.
 *
 * Features:
 * - 12/24 toggle (optional)
 * - paste a full phrase into any field (auto-fills)
 * - typing a space-separated sequence into one field also distributes to next fields
 * - highlights invalid words (not in BIP39 English wordlist)
 */
export function createMnemonicInput({
  initialMnemonic = "",
  wordCount = 12,
  allowWordCountToggle = true,
  label12 = "12 words",
  label24 = "24 words",
} = {}) {
  const MAX = 24;
  let count = wordCount === 24 ? 24 : 12;

  /** @type {HTMLInputElement[]} */
  const inputs = [];
  /** @type {HTMLDivElement[]} */
  const cells = [];

  // Toggle buttons (optional)
  const btn12 = allowWordCountToggle
    ? h("button", { class: "btn-outline", type: "button", text: label12 })
    : null;
  const btn24 = allowWordCountToggle
    ? h("button", { class: "btn-outline", type: "button", text: label24 })
    : null;

  const toggleRow = allowWordCountToggle
    ? h("div", { class: "srp-toggle" }, [btn12, btn24])
    : null;

  function updateToggle() {
    if (!btn12 || !btn24) return;
    btn12.classList.toggle("is-active", count === 12);
    btn24.classList.toggle("is-active", count === 24);
  }

  function setCount(next) {
    count = next === 24 ? 24 : 12;
    for (let i = 0; i < MAX; i++) {
      cells[i].style.display = i < count ? "" : "none";
    }
    updateToggle();
  }

  function validateIndex(i) {
    const v = String(inputs[i]?.value ?? "").trim().toLowerCase();
    if (!v) {
      cells[i].classList.remove("is-invalid");
      return;
    }
    cells[i].classList.toggle("is-invalid", !isValidWord(v));
  }

  function validateAll() {
    for (let i = 0; i < count; i++) validateIndex(i);
  }

  function focusIndex(i) {
    if (i < 0 || i >= count) return;
    inputs[i].focus();
    inputs[i].select?.();
  }

  function applyWords(startIdx, words) {
    if (!words?.length) return;
    const needed = startIdx + words.length;
    if (count === 12 && needed > 12) setCount(24);

    for (let j = 0; j < words.length && startIdx + j < MAX; j++) {
      const idx = startIdx + j;
      inputs[idx].value = String(words[j] ?? "").trim().toLowerCase();
      validateIndex(idx);
    }

    // Focus the next empty field (or the last visible field)
    const empty = firstEmptyIndex(inputs, count);
    if (empty !== -1) focusIndex(empty);
  }

  function parseWords(text) {
    const words = normalizeMnemonic(text)
      .split(" ")
      .map((w) => w.trim())
      .filter(Boolean);
    return words;
  }

  function onPaste(i, e) {
    const clip = e?.clipboardData?.getData?.("text");
    if (!clip) return;
    e.preventDefault();
    const words = parseWords(clip);
    if (!words.length) return;
    applyWords(i, words);
  }

  function onInput(i) {
    const raw = String(inputs[i].value ?? "");
    // If user pasted/typed multiple words into one input, distribute them.
    if (/\s/.test(raw)) {
      const words = parseWords(raw);
      inputs[i].value = (words[0] ?? "").toLowerCase();
      validateIndex(i);
      if (words.length > 1) applyWords(i + 1, words.slice(1));
      return;
    }

    inputs[i].value = raw.toLowerCase();
    validateIndex(i);
  }

  function onKeyDown(i, e) {
    if (!e) return;
    if (e.key === "Enter" || e.key === " ") {
      if (String(inputs[i].value ?? "").trim()) {
        e.preventDefault();
        focusIndex(i + 1);
      }
      return;
    }
    if (e.key === "Backspace" && !String(inputs[i].value ?? "")) {
      if (i > 0) {
        e.preventDefault();
        focusIndex(i - 1);
      }
      return;
    }
  }

  const grid = h(
    "div",
    { class: "srp-grid srp-grid--input" },
    Array.from({ length: MAX }, (_, i) => {
      const input = h("input", {
        type: "text",
        inputmode: "text",
        autocomplete: "off",
        autocorrect: "off",
        autocapitalize: "none",
        spellcheck: "false",
        enterkeyhint: i === MAX - 1 ? "done" : "next",
        "aria-label": `Word ${i + 1}`,
      });
      input.addEventListener("paste", (e) => onPaste(i, e));
      input.addEventListener("input", () => onInput(i));
      input.addEventListener("keydown", (e) => onKeyDown(i, e));

      const cell = h("div", { class: "srp-word" }, [
        h("div", { class: "srp-word-index", text: String(i + 1) }),
        h("div", { class: "srp-word-input" }, [input]),
      ]);

      inputs[i] = input;
      cells[i] = cell;
      return cell;
    })
  );

  const box = h("div", { class: "box srp-box" }, [grid]);
  const root = h("div", { class: "mnemonic-input" }, [toggleRow, box].filter(Boolean));

  if (btn12) btn12.onclick = () => setCount(12);
  if (btn24) btn24.onclick = () => setCount(24);

  // Initialize
  setCount(count);
  if (initialMnemonic) {
    const words = parseWords(initialMnemonic);
    if (words.length > 12) setCount(24);
    for (let i = 0; i < MAX; i++) inputs[i].value = "";
    applyWords(0, words);
  }
  updateToggle();
  validateAll();

  return {
    el: root,
    /** Get the normalized mnemonic string from the currently visible inputs. */
    getMnemonic() {
      const words = inputs
        .slice(0, count)
        .map((i) => String(i.value ?? "").trim())
        .filter(Boolean);
      return normalizeMnemonic(words.join(" "));
    },
    /** Set and normalize the mnemonic, auto-expanding to 24 words if needed. */
    setMnemonic(mnemonic) {
      const words = parseWords(mnemonic);
      setCount(words.length > 12 ? 24 : 12);
      for (let i = 0; i < MAX; i++) inputs[i].value = "";
      applyWords(0, words);
      validateAll();
    },
    setDisabled(disabled) {
      const d = Boolean(disabled);
      inputs.forEach((i) => (i.disabled = d));
      if (btn12) btn12.disabled = d;
      if (btn24) btn24.disabled = d;
    },
    getWordCount() {
      return count;
    },
    setWordCount(n) {
      setCount(n);
    },
    validateAll,
  };
}
