import { h } from "../lib/dom.js";

/**
 * What the wallet waits for, in words, with a small ring that turns beside them
 * from the first moment (ui.css), and stands still with reduced motion.
 *
 * @param {string} text
 * @param {{ tag?: string, className?: string }} [opts]
 * @returns {HTMLElement}
 */
export const waiting = (text, { tag = "div", className = "muted" } = {}) =>
  h(tag, { class: `${className} waiting` }, [h("span", { class: "waiting__ring", "aria-hidden": "true" }), h("span", { text })]);
