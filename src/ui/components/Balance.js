import { h } from "../lib/dom.js";

/**
 * The shielded balance as it can be said, in lux: its `value`, or what can be
 * spent now (`spendable`); null where it can't be read, so a dash shows,
 * never 0 DUSK. Till a sync has gone through, or while one fails, a 0 is no
 * reading; nor is a 0 kept from before while it can't be read now (Lena's and
 * Chen's: "Shielded · can't be read now 0 DUSK" as the wallet opened with no
 * signal, its total counting it). An amount kept from before shows, said to
 * be maybe out of date.
 * @param {object} ov - the overview
 * @param {"value" | "spendable"} [part]
 * @returns {bigint | null}
 */
export function shieldedLuxOf(ov, part = "value") {
  const kept = ov?.shieldedBalance;
  const raw = part === "value" ? (kept?.value ?? (typeof kept === "object" ? undefined : kept)) : kept?.spendable;
  if (raw === undefined || raw === null || !/^\d+$/.test(String(raw))) return null;
  const lux = BigInt(String(raw));
  if (lux > 0n) return lux;
  const sync = ov?.shieldedSync?.state ?? null;
  const unread = (sync === "idle" || sync === "syncing" || sync === "error") && !ov?.shieldedStale;
  return unread || ov?.shieldedStale || ov?.shieldedError ? null : lux;
}

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
