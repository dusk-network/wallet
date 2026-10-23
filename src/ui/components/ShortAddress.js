import { h } from "../lib/dom.js";
import { shortAddress } from "../lib/strings.js";

/**
 * An account or address shown short (6…6), with the full one in its tooltip
 * and, for screen readers, in place of the short one.
 *
 * @param {string} address
 * @param {{ tag?: string, className?: string }} [opts]
 * @returns {HTMLElement}
 */
export function shortAddressEl(address, { tag = "code", className = "" } = {}) {
  const full = String(address ?? "");
  const short = shortAddress(full);
  return h(
    tag,
    { class: className, title: full || undefined },
    short === full
      ? [full]
      : [h("span", { "aria-hidden": "true", text: short }), h("span", { class: "sr-only", text: full })]
  );
}
