import { h } from "../lib/dom.js";
import { installNumericInputGuard, installPrimaryEnter } from "../lib/inputGuards.js";

let fieldIds = 0;

// An id for `el` that no other element has, also when a view is drawn twice.
// An id it already has stays: other code may look it up.
function uniqueId(el) {
  if (!el.id) el.id = `field-${++fieldIds}`;
  return el.id;
}

/**
 * The visible label of `field` (an input, select or textarea), tied to it, so
 * screen readers name the field by its label rather than by its placeholder.
 * @param {HTMLElement} field
 * @param {string} text
 * @returns {HTMLLabelElement}
 */
export function fieldLabel(field, text) {
  return h("label", { for: uniqueId(field), text });
}

/**
 * The visible label of a group of fields, such as a recovery phrase's words:
 * the group takes it as its name, and each field keeps its own.
 * @param {HTMLElement} group
 * @param {string} text
 * @returns {HTMLLabelElement}
 */
export function groupLabel(group, text) {
  const label = h("label", { text });
  group.setAttribute("role", "group");
  group.setAttribute("aria-labelledby", uniqueId(label));
  return label;
}

// `id` first among what describes `field` (on), or out of it; the others stay.
function describedBy(field, id, on) {
  const others = (field.getAttribute("aria-describedby") ?? "").split(/\s+/).filter((x) => x && x !== id);
  const ids = on ? [id, ...others] : others;
  if (ids.length) field.setAttribute("aria-describedby", ids.join(" "));
  else field.removeAttribute("aria-describedby");
}

/**
 * A short line under `field` that says more about it, always shown; the
 * field is described by it, and by its error first while one shows.
 * @param {HTMLElement} field
 * @param {string} text
 * @returns {HTMLParagraphElement}
 */
export function fieldHint(field, text) {
  const el = h("p", { class: "field-hint", text });
  describedBy(field, uniqueId(el), true);
  return el;
}

/**
 * An error line under `field`, hidden until `show` gives it words; the field
 * is described by it, and marked invalid, while it shows. A group of fields
 * (`markInvalid: false`) is only described by it: ARIA has no invalid group.
 * @param {HTMLElement} field
 * @param {{ markInvalid?: boolean }} [opts]
 * @returns {{ el: HTMLElement, show: (text?: string) => void }}
 */
export function fieldError(field, { markInvalid = true } = {}) {
  const el = h("div", { class: "field-error", role: "alert", hidden: true });
  const id = uniqueId(el);
  return {
    el,
    show(text) {
      el.textContent = text || "";
      el.hidden = !text;
      if (!text) field.removeAttribute("aria-invalid");
      else if (markInvalid) field.setAttribute("aria-invalid", "true");
      describedBy(field, id, Boolean(text));
    },
  };
}

/**
 * The password the wallets here share, for a change to them (adding one,
 * removing one): named for what it is, with no placeholder, a line under it
 * that says one password unlocks them all, and its error under that.
 * @param {{ onEnter?: () => void }} [opts]
 */
export function unlockPasswordField({ onEnter } = {}) {
  const input = passwordInput({ autocomplete: "current-password", onEnter });
  const hint = fieldHint(input, "One password unlocks every wallet here.");
  const error = fieldError(input);
  input.addEventListener("input", () => error.show(""));
  return { input, error, els: [fieldLabel(input, "Password you unlock with"), input, hint, error.el] };
}

export function textInput({ numericMode, onEnter, ...attrs } = {}) {
  const input = h("input", attrs);
  if (numericMode) installNumericInputGuard(input, { mode: numericMode });
  if (onEnter) installPrimaryEnter(input, onEnter);
  return input;
}

export function decimalInput(attrs = {}) {
  return textInput({ ...attrs, numericMode: "decimal" });
}

export function integerInput(attrs = {}) {
  return textInput({ ...attrs, numericMode: "integer" });
}

export function passwordInput(attrs = {}) {
  return textInput({ ...attrs, type: "password" });
}

export function checkboxInput(attrs = {}) {
  return textInput({ ...attrs, type: "checkbox" });
}

export function searchInput(attrs = {}) {
  return textInput({ ...attrs, type: "search" });
}

export function urlInput(attrs = {}) {
  return textInput({ ...attrs, type: "url" });
}

// Buttons a gas editor turned off, to turn back on once its gas will do.
const offForGas = new WeakSet();

/**
 * Ties a page's submit button to its gas editor: Enter in the gas price
 * presses it, and gas that won't do (a limit under the minimum, a price of 0)
 * keeps it off while the editor says why. Once the gas will do, the button
 * comes back on if `ready` says the rest of the page is ready too.
 * @param {HTMLElement} gasEditor - a dusk-gas-editor
 * @param {HTMLButtonElement} submitButton
 * @param {{ ready?: () => boolean }} [opts]
 */
export function submitOnGasEnter(gasEditor, submitButton, { ready } = {}) {
  gasEditor?.addEventListener?.("dusk-gas-enter", () => {
    if (!submitButton?.disabled) submitButton?.click();
  });
  const sync = () => {
    if (!submitButton) return;
    if (gasEditor?.error) {
      submitButton.disabled = true;
      offForGas.add(submitButton);
    } else if (offForGas.has(submitButton)) {
      offForGas.delete(submitButton);
      submitButton.disabled = typeof ready === "function" ? !ready() : false;
    }
  };
  gasEditor?.addEventListener?.("dusk-gas-validity", sync);
  sync();
  return gasEditor;
}
