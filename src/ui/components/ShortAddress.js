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

/**
 * An account or address in full, to read and compare: its first and last six
 * characters stand out, as the web wallet shows them, and the last six never
 * split across lines. The whole is in its tooltip too.
 *
 * @param {string} address
 * @param {{ className?: string }} [opts]
 * @returns {HTMLElement}
 */
export function fullAddressEl(address, { className = "" } = {}) {
  const full = String(address ?? "");
  const [head, middle, tail] = full.length > 12 ? [full.slice(0, 6), full.slice(6, -6), full.slice(-6)] : ["", full, ""];
  return h("code", { class: ["full-address", className].filter(Boolean).join(" "), title: full || undefined }, [
    head ? h("b", { text: head }) : null,
    h("span", { class: "full-address__middle", text: middle }),
    tail ? h("b", { class: "full-address__tail", text: tail }) : null,
  ]);
}
