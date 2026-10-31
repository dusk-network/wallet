import { duskNamesNetwork, lookupPrimaryName } from "../../shared/duskNames.js";
import { walletLabel } from "../../shared/wallets.js";
import { h } from "../lib/dom.js";

/**
 * The open wallet's name ("Wallet 2", or the one it was given) when there's
 * more than one wallet here, for what names a profile to say whose it is;
 * "" with one.
 * @param {object} ov - the overview
 */
export function walletNameOf(ov) {
  const wallets = Array.isArray(ov?.wallets) ? ov.wallets : [];
  const open = wallets.length > 1 ? wallets.find((w) => w?.active) : null;
  return open ? walletLabel(open) : "";
}

/**
 * A profile on a Review, after its wallet's name when there's more than one
 * wallet: "Wallet 2 · alice.dusk". The wallet is the one the Review was drawn
 * for (`review`, reviewOf), never the one open since.
 * @param {HTMLElement} profileEl - the profile's name (profileNameEl)
 * @param {{ walletName?: string }} [review] - the Review's binding
 * @returns {HTMLElement}
 */
export function withReviewWallet(profileEl, review) {
  const wallet = String(review?.walletName ?? "").trim();
  return wallet ? h("span", { class: "review-wallet" }, [`${wallet} · `, profileEl]) : profileEl;
}

/**
 * A profile's index: the one given, else the overview's selected profile.
 * @param {object} ov
 * @param {number} [index]
 */
export function profileIndexOf(ov, index) {
  const raw = Number(index ?? ov?.selectedAccountIndex ?? 0);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
}

/**
 * A profile's label on this device, else "Profile N".
 * @param {object} ov
 * @param {number} [index]
 */
export function profileLabelOf(ov, index) {
  const idx = profileIndexOf(ov, index);
  return String(ov?.accountNames?.[String(idx)] ?? "").trim() || `Profile ${idx + 1}`;
}

/**
 * A profile's name as the header shows it: its verified .dusk name once
 * looked up (the header's lookup, kept for a while), else its label on this
 * device, else "Profile N". The element updates itself when the name
 * arrives, and `onName` hears it.
 *
 * @param {object} ov - the overview
 * @param {{ index?: number, onName?: (name: string) => void, className?: string }} [opts]
 * @returns {HTMLSpanElement}
 */
export function profileNameEl(ov, { index, onName, className = "profile-name" } = {}) {
  const idx = profileIndexOf(ov, index);
  const el = h("span", { class: className, text: profileLabelOf(ov, idx) });
  const account = String(ov?.accounts?.[idx] ?? "");
  if (account && duskNamesNetwork(ov?.nodeUrl)) {
    lookupPrimaryName(account, { nodeUrl: ov?.nodeUrl, stale: true })
      ?.then?.((name) => {
        if (!name) return;
        el.textContent = name;
        onName?.(name);
      })
      ?.catch?.(() => {});
  }
  return el;
}
