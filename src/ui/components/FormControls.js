import { h } from "../lib/dom.js";
import { installNumericInputGuard, installPrimaryEnter } from "../lib/inputGuards.js";
import { holdWhileOffline } from "../lib/offline.js";

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
  return { input, error, els: [passwordForm([fieldLabel(input, "Password you unlock with"), input, hint, error.el])] };
}

/**
 * A form of their own for a password's fields, their captions and errors
 * with them, laid out as if it weren't there (ui.css), in a box of its own
 * that a screen reader reads into. A browser's password
 * manager reads a form's fields together: a box before a password is the
 * password's username to it, and Firefox counts the boxes beside a password
 * to tell a new one, for which it offers a password of its own. Apart, a
 * recovery word or an amount is never either. Nothing submits it.
 * @param {Array<Node | null | undefined>} children
 * @returns {HTMLFormElement}
 */
export function passwordForm(children) {
  const form = h("form", { class: "password-form", novalidate: "" }, children.filter(Boolean));
  form.addEventListener("submit", (e) => e.preventDefault());
  return form;
}

/**
 * A field for a new password, and its error under it, captioned as a label
 * captions a field: but named by its title, not a <label>. Firefox reads a
 * label's "New" or "Confirm" as a sign-up, and offers a password of its own
 * over the field, one nobody wrote down.
 * @param {{ caption: string, placeholder?: string, onEnter?: () => void }} opts
 * @returns {{ input: HTMLInputElement, error: { el: HTMLElement, show: (text?: string) => void }, els: HTMLElement[] }}
 */
export function newPasswordField({ caption, placeholder, onEnter }) {
  const input = passwordInput({ title: caption, placeholder, autocomplete: NEW_PASSWORD, onEnter });
  const error = fieldError(input);
  input.addEventListener("input", () => error.show(""));
  return { input, error, els: [h("p", { class: "field-caption", text: caption }), input, error.el] };
}

export function textInput({ numericMode, onEnter, ...attrs } = {}) {
  const input = h("input", attrs);
  if (numericMode) installNumericInputGuard(input, { mode: numericMode });
  if (onEnter) installPrimaryEnter(input, onEnter);
  return input;
}

// The `value` accessor a field's prototypes give it.
function valueAccessor(el) {
  for (let proto = Object.getPrototypeOf(el); proto; proto = Object.getPrototypeOf(proto)) {
    const own = Object.getOwnPropertyDescriptor(proto, "value");
    if (own?.get && own?.set) return own;
  }
  return null;
}

/**
 * A one-line field that wraps onto more lines as what's in it grows, so a
 * long address shows whole, start to end, rather than its end alone: a
 * textarea that takes no line breaks (a paste's are dropped, as a one-line
 * field drops them), Enter doing what `onEnter` says.
 * @param {{ value?: string, onEnter?: (e: Event) => void, [attr: string]: any }} [opts]
 * @returns {HTMLTextAreaElement}
 */
export function wrappingInput({ value = "", onEnter, ...attrs } = {}) {
  const field = h("textarea", { rows: "1", ...attrs, class: ["wrap-input", attrs.class].filter(Boolean).join(" ") });
  const own = valueAccessor(field);
  // As tall as its lines, borders and all; once it's on the page.
  const fit = () => {
    if (!field.isConnected || !field.style) return;
    field.style.height = "auto";
    const lines = Number(field.scrollHeight) || 0;
    if (lines > 0) field.style.height = `${lines + ((Number(field.offsetHeight) || 0) - (Number(field.clientHeight) || 0))}px`;
  };
  if (own) {
    Object.defineProperty(field, "value", {
      configurable: true,
      get() {
        return own.get.call(this);
      },
      set(next) {
        own.set.call(this, String(next ?? "").replace(/[\r\n]+/g, ""));
        fit();
      },
    });
  }
  field.value = value;
  field.addEventListener("input", () => {
    if (/[\r\n]/.test(field.value)) field.value = field.value;
    else fit();
  });
  field.addEventListener("focus", fit);
  // Fitted again on asking, as when what's drawn in it (a contact's chip) changes its room.
  field.fitLines = fit;
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(fit);
  // Narrower or wider (a contact's chip beside the text, the phone turned),
  // its lines change: fitted again. Only the width: fitting sets the height.
  if (typeof ResizeObserver === "function") {
    let width = -1;
    new ResizeObserver(([entry]) => {
      const now = entry?.contentRect?.width ?? -1;
      if (now === width) return;
      width = now;
      fit();
    }).observe(field);
  }
  if (onEnter) installPrimaryEnter(field, onEnter);
  return field;
}

export function decimalInput(attrs = {}) {
  return textInput({ ...attrs, numericMode: "decimal" });
}

export function integerInput(attrs = {}) {
  return textInput({ ...attrs, numericMode: "integer" });
}

/**
 * The `autocomplete` of a field for a new wallet password: not
 * "new-password", for which Firefox for Android offers a strong password of
 * its own over the field, one nobody wrote down.
 */
export const NEW_PASSWORD = "off";

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
 * The end of a Review, which stays in view however long the Review is (ui.css):
 * what stops it, then Confirm, so an off Confirm never hides why. Confirm is
 * held while the browser is offline, saying so.
 * @param {HTMLButtonElement} button
 * @param {...(HTMLElement|null)} reasons
 * @returns {HTMLElement}
 */
export function reviewActions(button, ...reasons) {
  const offline = holdWhileOffline(button, { text: "You're offline. Confirm once you're back online." });
  return stepActions(button, ...reasons, offline);
}

/**
 * A step's button at its end, in view as a Review's is, with what stops it above.
 * @param {HTMLButtonElement} button
 * @param {...(HTMLElement|null)} reasons
 * @returns {HTMLElement}
 */
export function stepActions(button, ...reasons) {
  return h("div", { class: "review-actions" }, [...reasons.filter(Boolean), h("div", { class: "btnrow" }, [button])]);
}

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
