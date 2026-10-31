import "../../shared/bufferGlobal.js";
import { validateMnemonic, wordlists } from "bip39";
import { h } from "../lib/dom.js";
import { normalizeMnemonic } from "../lib/strings.js";

// We generate + validate mnemonics against the BIP39 English wordlist.
const WORDSET = new Set(wordlists.english);

let hintIds = 0;

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

// "Word 7", "Words 3 and 7", "Words 3, 5 and 7".
function wordsNamed(numbers) {
  if (numbers.length === 1) return `Word ${numbers[0]}`;
  return `Words ${numbers.slice(0, -1).join(", ")} and ${numbers.at(-1)}`;
}

/**
 * What's wrong with a phrase's words, in one plain sentence; "" when nothing
 * is, or nothing's typed. `words` are the boxes' words in order, "" for an
 * empty one; `pasted`, the count of a paste with more words than boxes.
 * @param {string[]} words
 * @param {{ pasted?: number }} [opts]
 */
function phraseProblem(words, { pasted = 0 } = {}) {
  let last = words.length - 1;
  while (last >= 0 && !words[last]) last--;
  if (last < 0) return "";
  const typed = words.slice(0, last + 1);
  const unknown = typed.flatMap((w, i) => (w && !WORDSET.has(w) ? [i + 1] : []));
  if (unknown.length > 3) return `${unknown.length} words aren't recovery words. Check the marked ones.`;
  if (unknown.length === 1) return `${wordsNamed(unknown)} isn't a recovery word. Check its spelling.`;
  if (unknown.length) return `${wordsNamed(unknown)} aren't recovery words. Check their spelling.`;
  const missing = typed.flatMap((w, i) => (w ? [] : [i + 1]));
  if (missing.length > 3) return `${missing.length} words are missing.`;
  if (missing.length) return `${wordsNamed(missing)} ${missing.length === 1 ? "is" : "are"} missing.`;
  const n = pasted > typed.length ? pasted : typed.length;
  if (n !== 12 && n !== 24) return `That's ${n} ${n === 1 ? "word" : "words"}. A recovery phrase has 12 or 24.`;
  if (!validateMnemonic(typed.join(" "))) return "That isn't a valid recovery phrase. Check each word.";
  return "";
}

/**
 * A recovery phrase's words, each in its own numbered box (12 or 24), as
 * people copy them from paper.
 *
 * - A whole phrase (12 words or more) pasted or typed into any box fills the
 *   boxes from the first, in order, and sets 12 or 24 by its length; a few
 *   words go where they're put.
 * - A word that isn't a recovery word is marked once a paste puts it in or
 *   its box is left, never while it's typed; it clears once it's a word.
 * - `onCheck` hears what's wrong with the words, in one plain sentence ("" for
 *   nothing), after a paste and when the focus leaves the boxes, and "" again
 *   as soon as something's typed. `problem()` says the same on asking.
 * - `hint`: a line above the boxes, which describes them.
 */
export function createMnemonicInput({
  initialMnemonic = "",
  wordCount = 12,
  allowWordCountToggle = true,
  label12 = "12 words",
  label24 = "24 words",
  hint = "",
  onComplete,
  onCheck,
} = {}) {
  const MAX = 24;
  let count = wordCount === 24 ? 24 : 12;
  // A paste with more words than there are boxes: its count, until the next edit.
  let overflow = 0;

  /** @type {HTMLInputElement[]} */
  const inputs = [];
  /** @type {HTMLDivElement[]} */
  const cells = [];

  // Toggle buttons (optional)
  const btn12 = allowWordCountToggle
    ? h("button", { class: "tab", type: "button", text: label12 })
    : null;
  const btn24 = allowWordCountToggle
    ? h("button", { class: "tab", type: "button", text: label24 })
    : null;

  const toggleRow = allowWordCountToggle
    ? h("div", { class: "tabs tabs--mini srp-toggle" }, [btn12, btn24])
    : null;

  function updateToggle() {
    if (!btn12 || !btn24) return;
    btn12.classList.toggle("is-active", count === 12);
    btn24.classList.toggle("is-active", count === 24);

    // Sliding indicator for the segmented toggle.
    try {
      if (toggleRow) {
        toggleRow.style.setProperty("--seg-index", count === 24 ? "1" : "0");
      }
    } catch {
      // ignore
    }
  }

  function setCount(next) {
    count = next === 24 ? 24 : 12;
    for (let i = 0; i < MAX; i++) {
      cells[i].style.display = i < count ? "" : "none";
    }
    updateToggle();
  }

  // Marks the word in box `i` when it isn't a recovery word, for screen
  // readers too; an empty box or a word clears the mark.
  function validateIndex(i) {
    const v = String(inputs[i]?.value ?? "").trim().toLowerCase();
    const invalid = Boolean(v) && !isValidWord(v);
    cells[i].classList.toggle("is-invalid", invalid);
    if (invalid) inputs[i].setAttribute("aria-invalid", "true");
    else inputs[i].removeAttribute("aria-invalid");
  }

  function validateAll() {
    for (let i = 0; i < count; i++) validateIndex(i);
  }

  function focusIndex(i) {
    if (i < 0 || i >= count) return;
    inputs[i].focus();
    inputs[i].select?.();
  }

  const shownWords = () => inputs.slice(0, count).map((i) => String(i.value ?? "").trim().toLowerCase());
  const problem = () => phraseProblem(shownWords(), { pasted: overflow });

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

  // A whole phrase: every box from the first, 12 or 24 by its length (24
  // for any other count over 12, so every word shows), then the last word's
  // box, from which Tab leaves the words.
  function applyPhrase(words) {
    setCount(words.length > 12 ? 24 : 12);
    for (let i = 0; i < MAX; i++) inputs[i].value = "";
    for (let j = 0; j < words.length && j < MAX; j++) inputs[j].value = String(words[j]).toLowerCase();
    validateAll();
    overflow = words.length > MAX ? words.length : 0;
    inputs[Math.min(words.length, count) - 1].focus();
  }

  // Words that came at once, by a paste or typed with spaces, into box `i`.
  function placeWords(i, words) {
    if (words.length >= 12) {
      applyPhrase(words);
      onCheck?.(problem());
      return;
    }
    overflow = 0;
    applyWords(i, words);
    // A few words: only words that aren't recovery words, said now.
    const unknown = shownWords().some((w) => w && !WORDSET.has(w));
    onCheck?.(unknown ? problem() : "");
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
    placeWords(i, words);
  }

  function onInput(i) {
    const raw = String(inputs[i].value ?? "");
    // If user pasted/typed multiple words into one input, distribute them.
    if (/\s/.test(raw)) {
      const words = parseWords(raw);
      if (words.length >= 12) {
        placeWords(i, words);
        return;
      }
      inputs[i].value = (words[0] ?? "").toLowerCase();
      validateIndex(i);
      overflow = 0;
      if (words.length > 1) {
        placeWords(i + 1, words.slice(1));
        return;
      }
      onCheck?.("");
      return;
    }

    inputs[i].value = raw.toLowerCase();
    overflow = 0;
    // A word typed: its mark, if it has one, goes once it's a word; a new
    // one waits for the box to be left.
    if (cells[i].classList.contains("is-invalid")) validateIndex(i);
    onCheck?.("");
  }

  function onKeyDown(i, e) {
    if (!e) return;
    if (e.key === "Enter" || e.key === " ") {
      if (String(inputs[i].value ?? "").trim()) {
        e.preventDefault();
        if (i >= count - 1) {
          onComplete?.();
        } else {
          focusIndex(i + 1);
        }
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
  const hintEl = hint ? h("p", { class: "srp-hint", id: `srp-hint-${++hintIds}`, text: hint }) : null;
  const root = h("div", { class: "mnemonic-input" }, [toggleRow, hintEl, box].filter(Boolean));
  if (hintEl) root.setAttribute("aria-describedby", hintEl.id);

  // A box left: its word marked if it isn't one. The words left for
  // something else: what's wrong with them, once there are any.
  root.addEventListener("focusout", (e) => {
    const i = inputs.indexOf(e?.target);
    if (i < 0) return;
    validateIndex(i);
    if (root.contains(e.relatedTarget ?? null)) return;
    onCheck?.(problem());
  });

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
    /** What's wrong with the words, as `onCheck` hears it; "" for nothing, or nothing typed. */
    problem,
    /** Set and normalize the mnemonic, auto-expanding to 24 words if needed. */
    setMnemonic(mnemonic) {
      const words = parseWords(mnemonic);
      setCount(words.length > 12 ? 24 : 12);
      for (let i = 0; i < MAX; i++) inputs[i].value = "";
      overflow = 0;
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
