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

export function submitOnGasEnter(gasEditor, submitButton) {
  gasEditor?.addEventListener?.("dusk-gas-enter", () => {
    if (!submitButton?.disabled) submitButton?.click();
  });
  return gasEditor;
}
