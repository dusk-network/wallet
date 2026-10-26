import { h } from "../lib/dom.js";
import { decimalInput } from "./FormControls.js";

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
 * @param {() => void} [opts.onInput]
 * @param {() => void} [opts.onEnter]
 * @returns {{ el: HTMLElement, input: HTMLInputElement, error: HTMLElement, setError: (text: string) => void, setValue: (value: string) => void }}
 */
export function amountField({ label, value = "", unit = "DUSK", disabled = false, onInput, onEnter } = {}) {
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
  const el = h("div", { class: "amount-field" }, [
    input,
    h("span", { class: "amount-field__unit", "aria-hidden": "true", text: unit }),
  ]);
  // A press anywhere on the field types into it.
  el.addEventListener("click", (e) => {
    if (e?.target !== input && !input.disabled) input.focus();
  });
  const error = h("div", { id: errorId, class: "field-error amount-field__error", role: "alert", hidden: true });

  // A long number steps down a size rather than running out of the field.
  const fit = () => el.classList.toggle("is-long", String(input.value ?? "").length > 9);
  fit();
  input.addEventListener("input", () => {
    fit();
    onInput?.();
  });

  const setError = (text) => {
    // An alert reads out again on every change: write only a new message.
    if ((error.textContent || "") === (text || "") && error.hidden === !text) return;
    error.textContent = text || "";
    error.hidden = !text;
    el.classList.toggle("is-invalid", Boolean(text));
    if (text) {
      input.setAttribute("aria-invalid", "true");
      input.setAttribute("aria-describedby", errorId);
    } else {
      input.removeAttribute("aria-invalid");
      input.removeAttribute("aria-describedby");
    }
  };

  const setValue = (next) => {
    input.value = String(next ?? "");
    fit();
  };

  return { el, input, error, setError, setValue };
}
