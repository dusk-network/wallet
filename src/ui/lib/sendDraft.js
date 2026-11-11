// What Send keeps of what's typed in it, as the web wallet does: left with
// Back, it's there again the next time Send opens, for the wallet, profile
// and network it was typed for, in this tab alone (sessionStorage, which a
// tab that reloads keeps); it goes once the send goes out. A lock leaves the
// screen as it was, the form with it (popup/app.js). Nothing here is a
// secret: never a recovery phrase pasted into a field by mistake.

import { validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";

const KEY = "dusk_send_draft";
// What's kept of the form: what the person typed and chose.
const FIELDS = ["to", "duskName", "nameChoices", "amountDusk", "amountMasked", "memo", "gas"];

let held = null;

/**
 * Who a draft is for: the wallet (its first account), the profile and the node.
 * @param {object} ov - the overview the form was drawn from
 */
export const sendDraftOwner = (ov) => [ov?.accounts?.[0] ?? "", Number(ov?.selectedAccountIndex ?? 0) || 0, ov?.nodeUrl ?? ""].join(" ");

const phrase = (value) => typeof value === "string" && validateMnemonic(value.trim().toLowerCase().split(/\s+/).join(" "), wordlist);

function storage() {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function read() {
  try {
    const kept = storage()?.getItem(KEY);
    if (kept) return JSON.parse(kept);
  } catch {
    // Not kept there: what's held here.
  }
  return held;
}

/**
 * Keeps what's typed in Send, left with Back: nothing when nothing is typed.
 * @param {object | null} draft - state.draft
 * @param {object} ov
 */
export function keepSendDraft(draft, ov) {
  const values = Object.fromEntries(FIELDS.filter((name) => draft?.[name] !== undefined).map((name) => [name, phrase(draft[name]) ? "" : draft[name]]));
  if (!String(values.to ?? "").trim() && !String(values.amountDusk ?? "").trim() && !String(values.memo ?? "").trim()) return forgetSendDraft();
  held = { owner: sendDraftOwner(ov), values };
  try {
    storage()?.setItem(KEY, JSON.stringify(held));
  } catch {
    // Kept here alone, till the page goes.
  }
}

/**
 * What Send opens with: what was kept, for this wallet, profile and network,
 * or nothing. Another's goes.
 * @param {object} ov
 * @returns {object | null}
 */
export function keptSendDraft(ov) {
  const kept = read();
  if (kept?.owner === sendDraftOwner(ov) && kept.values && typeof kept.values === "object") return { ...kept.values };
  if (kept) forgetSendDraft();
  return null;
}

/** It went out, or another wallet came: nothing of it stays. */
export function forgetSendDraft() {
  held = null;
  try {
    storage()?.removeItem(KEY);
  } catch {
    // Nothing kept there.
  }
}
