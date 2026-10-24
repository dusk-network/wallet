import { h } from "../lib/dom.js";

/**
 * A verified .dusk name, shown before the address it names once `lookup` gives
 * one. Until then, and when it gives none, it stays hidden and the address
 * shows alone.
 *
 * @param {Promise<string|null>} lookup - from lookupPrimaryName or lookupShieldedName
 * @param {{ className?: string }} [opts]
 * @returns {HTMLElement}
 */
export function duskNameEl(lookup, { className = "" } = {}) {
  const el = h("div", { class: `dusk-name ${className}`.trim(), hidden: true });
  lookup.then((name) => {
    if (!name) return;
    el.textContent = name;
    el.title = name;
    el.hidden = false;
  });
  return el;
}
