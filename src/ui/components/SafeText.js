import { safeText } from "../../shared/safeText.js";
import { h } from "../lib/dom.js";

/** What flags text the wallet changed to show it. */
export const HIDDEN_CHARACTERS_TEXT = "Hidden characters that can change how this reads show here as � or \\u codes.";

/**
 * What a text's numbers ask a person to check, in words; "" for nothing.
 * @param {{ mixedDigits?: boolean, rtlDigits?: boolean }} [checks] - safeText's
 */
export function numbersText({ mixedDigits = false, rtlDigits = false } = {}) {
  if (!mixedDigits && !rtlDigits) return "";
  const what = mixedDigits && rtlDigits ? "mixes digits of different scripts, and some read right to left" : mixedDigits ? "mixes digits of different scripts" : "is in digits that read right to left";
  return `A number here ${what}. Check it digit by digit.`;
}

/**
 * Text someone else chose, as a memo or a contract call's function, for a
 * row's value: neutralized (safeText.js), and when it had to be, a line under
 * it saying so; a line too when a number in it may not read as its digits say.
 * @param {unknown} raw
 * @param {{ mono?: boolean }} [opts] - in the code font, as a function's name
 * @returns {HTMLElement}
 */
export function safeTextEl(raw, { mono = false } = {}) {
  const { text, checks } = safeText(raw);
  const numbers = numbersText(checks);
  return h("span", { class: "safe-text" }, [
    h("span", { class: mono ? "mono" : undefined, text }),
    checks.hidden ? h("span", { class: "safe-text__flag", text: HIDDEN_CHARACTERS_TEXT }) : null,
    numbers ? h("span", { class: "safe-text__flag", text: numbers }) : null,
  ]);
}
