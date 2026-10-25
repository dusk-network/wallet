import { h } from "../lib/dom.js";
import { safeBigInt } from "../../shared/amount.js";
import { phoenixPausedMessage } from "../../shared/phoenixPause.js";
import { balancesHidden } from "./Balance.js";

// While a network has shielded transactions paused, views show this notice
// where the shielded actions would be. It uses the neutral callout style.

/** Whether the overview says shielded transactions are paused on its network. */
export function isShieldedPaused(ov) {
  return ov?.phoenixPaused === true;
}

/** "Shielded transactions are paused on {Network}." */
export function shieldedPausedText(ov) {
  return phoenixPausedMessage(ov?.networkName);
}

/** Turns a Shield navigation item off while shielded transactions are paused. */
export function syncShieldNavItem(item, ov) {
  const paused = isShieldedPaused(ov);
  item.disabled = paused;
  if (paused) item.title = shieldedPausedText(ov);
  else item.removeAttribute("title");
}

/**
 * The paused notice. With a shielded balance above 0 it adds a line saying the
 * funds stay put; `balanceLine: false` keeps it to the one sentence. That line
 * would give away a shielded balance, so it stays off while balances are hidden.
 * @param {any} ov - The popup overview.
 * @param {{ balanceLine?: boolean }} [opts]
 */
export function shieldedPausedNotice(ov, { balanceLine = true } = {}) {
  const shieldedLux = safeBigInt(ov?.shieldedBalance?.value ?? ov?.shieldedBalance, 0n);
  const withBalanceLine = balanceLine && !balancesHidden(ov) && shieldedLux > 0n;
  return h("div", { class: "callout shielded-paused" }, [
    h("div", {
      class: "callout-title",
      text: shieldedPausedText(ov),
      style: withBalanceLine ? undefined : "margin-bottom:0",
    }),
    withBalanceLine
      ? h("div", { class: "muted", text: "Your shielded DUSK stays where it is until they're back." })
      : null,
  ]);
}
