import { h } from "../lib/dom.js";

/** What a hidden balance shows, whatever the amount. */
export const HIDDEN_BALANCE = "••••";

/**
 * Whether balances are hidden: the Hide balances setting, which comes with
 * the overview.
 * @param {object} ov - the overview
 * @returns {boolean}
 */
export function balancesHidden(ov) {
  return ov?.hideBalances === true;
}

/**
 * A balance, for h()'s children: the amount as it is or, while balances are
 * hidden, four dots that screen readers skip, with "hidden" read instead. The
 * unit or label around it stays as it is.
 * @param {boolean} hidden - balancesHidden(ov)
 * @param {string} amount - e.g. "1482.9383"
 * @param {string} [mask] - what shows in its place, if not the four dots
 * @returns {string|HTMLElement}
 */
export function balance(hidden, amount, mask = HIDDEN_BALANCE) {
  if (!hidden) return String(amount ?? "");
  return h("span", { class: "balance-hidden" }, [
    h("span", { "aria-hidden": "true", text: mask }),
    h("span", { class: "sr-only", text: "hidden" }),
  ]);
}
