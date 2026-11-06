import { safeText } from "../../shared/safeText.js";
import { h } from "../lib/dom.js";

/** What flags text the wallet changed to show it. */
export const HIDDEN_CHARACTERS_TEXT = "Hidden characters that can change how this reads show here as � or \\u codes.";

/**
 * Text someone else chose, as a memo or a contract call's function, for a
 * row's value: neutralized (safeText.js), and when it had to be, a line under
 * it saying so.
 * @param {unknown} raw
 * @param {{ mono?: boolean }} [opts] - in the code font, as a function's name
 * @returns {HTMLElement}
 */
export function safeTextEl(raw, { mono = false } = {}) {
  const { text, flagged } = safeText(raw);
  return h("span", { class: "safe-text" }, [
    h("span", { class: mono ? "mono" : undefined, text }),
    flagged ? h("span", { class: "safe-text__flag", text: HIDDEN_CHARACTERS_TEXT }) : null,
  ]);
}
