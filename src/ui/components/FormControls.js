import { h } from "../lib/dom.js";
import { installNumericInputGuard, installPrimaryEnter } from "../lib/inputGuards.js";

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
