import { h } from "../lib/dom.js";
import { HIDDEN_BALANCE } from "./Balance.js";
import { decimalInput } from "./FormControls.js";
import { amountChoices, amountProblem } from "../../shared/amount.js";
import { amountQuestionEls } from "./AmountQuestion.js";

let fieldSeq = 0;

/**
 * A large amount field, the unit after the number, with its error line under
 * it. The input is named by `label` for screen readers, and points to the
 * error line while there is an error.
 *
 * @param {object} opts
 * @param {string} opts.label - the field's name, e.g. "Stake amount"
 * @param {string} [opts.value]
 * @param {string} [opts.unit]
 * @param {boolean} [opts.disabled]
 * @param {boolean} [opts.masked] - the value shows as dots until something's typed
 * @param {() => void} [opts.onInput]
 * @param {() => void} [opts.onEnter]
 * @returns {{ el: HTMLElement, input: HTMLInputElement, error: HTMLElement, setError: (text: string) => void, setProblem: (raw: string, example?: { whole?: string, decimal?: string }) => void, setValue: (value: string, opts?: { masked?: boolean }) => void, isMasked: () => boolean, focus: () => void }}
 */
export function amountField({ label, value = "", unit = "DUSK", disabled = false, masked = false, onInput, onEnter } = {}) {
  const errorId = `amount-error-${++fieldSeq}`;
  const input = decimalInput({
    class: "amount-field__input",
    "aria-label": label,
    placeholder: "0",
    autocomplete: "off",
    inputmode: "decimal",
    value: String(value ?? ""),
    disabled,
    onEnter,
  });
  // What Max fills in while balances are hidden shows as dots, in a field of
  // its own: `input` keeps the amount for what reads it, away from the screen
  // and screen readers. Dots in the field, not a placeholder, so deleting them
  // is a change too: what's left of them goes, and what's typed takes over.
  const cover = decimalInput({
    class: "amount-field__input",
    "aria-label": `${label}, hidden`,
    value: HIDDEN_BALANCE,
    autocomplete: "off",
    inputmode: "decimal",
    disabled,
    hidden: true,
    onEnter,
  });
  const isMasked = () => input.hidden === true;
  const setMasked = (on) => {
    input.hidden = on;
    cover.hidden = !on;
  };
  const focus = () => (isMasked() ? cover : input).focus();
  const el = h("div", { class: "amount-field" }, [
    input,
    cover,
    h("span", { class: "amount-field__unit", "aria-hidden": "true", text: unit }),
  ]);
  // A press anywhere on the field types into it.
  el.addEventListener("click", (e) => {
    if (e?.target !== input && e?.target !== cover && !input.disabled) focus();
  });
  const error = h("div", { id: errorId, class: "field-error amount-field__error", role: "alert", hidden: true });

  // A long number steps down a size rather than running out of the field.
  const fit = () => el.classList.toggle("is-long", String(input.value ?? "").length > 9);
  fit();
  input.addEventListener("input", () => {
    fit();
    onInput?.();
  });
  cover.addEventListener("input", () => {
    input.value = String(cover.value ?? "").replaceAll(HIDDEN_BALANCE[0], "");
    cover.value = HIDDEN_BALANCE;
    setMasked(false);
    fit();
    input.focus();
    onInput?.();
  });

  // What the error line says now, its question's choices too: an alert reads out again on every change.
  let said = "";
  const mark = (text) => {
    el.classList.toggle("is-invalid", Boolean(text));
    for (const field of [input, cover]) {
      if (text) {
        field.setAttribute("aria-invalid", "true");
        field.setAttribute("aria-describedby", errorId);
      } else {
        field.removeAttribute("aria-invalid");
        field.removeAttribute("aria-describedby");
      }
    }
  };
  const setError = (text) => {
    // An alert reads out again on every change: write only a new message.
    if (said === (text || "") && error.hidden === !text) return;
    said = text || "";
    error.textContent = text || "";
    error.hidden = !text;
    mark(text);
  };

  const setValue = (next, { masked: maskIt = false } = {}) => {
    input.value = String(next ?? "");
    setMasked(maskIt && Boolean(input.value));
    fit();
  };

  // What's wrong with what's typed, under the field: for an amount that could
  // be read two ways, its question with a button for each reading, which puts
  // it in the field and reads it again; else in words (amount.js).
  const setProblem = (raw, example) => {
    const asked = amountChoices(raw);
    if (!asked) {
      setError(amountProblem(raw, example));
      return;
    }
    const key = `${asked.question}\n${asked.choices.map((choice) => choice.field).join("\n")}`;
    if (said === key && !error.hidden) return;
    said = key;
    error.replaceChildren(
      ...amountQuestionEls(asked, {
        unit,
        onPick: (picked) => {
          setValue(picked);
          focus();
          onInput?.();
        },
      })
    );
    error.hidden = false;
    mark(asked.question);
  };

  setMasked(masked && Boolean(input.value));

  return { el, input, error, setError, setProblem, setValue, isMasked, focus };
}
