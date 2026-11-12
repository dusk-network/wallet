// What Send keeps of what's typed in it, as the web wallet does: left with
// Back, it's there again the next time Send opens, for the wallet, profile
// and network it was typed for, in this tab alone (sessionStorage, which a
// tab that reloads keeps); it goes once the send goes out. A lock leaves the
// screen as it was, the form with it (popup/app.js). Nothing here is a
// secret: never a recovery phrase pasted into a field by mistake, nor a
// password, which Send has none of.
//
// In the app, on the phone itself (localStorage): Android ends an app left in
// the background, its session with it. Send left that way is kept as open
// (`keepOpenSend`), and the app opens on it again once unlocked (`takeOpenSend`).
// A reset, or removing its wallet, forgets it (shared/sendDraftStore.js).

import { validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { isTauriRuntime } from "../../platform/runtime.js";
import { SEND_DRAFT_KEY as KEY } from "../../shared/sendDraftStore.js";
// What's kept of the form: what the person typed and chose, and a request's
// network, which Send refuses it on any other (`requestChainId`), with where
// it was filled in from, and that a link or a QR code filled it in
// (`filledIn`), which is never the next Send's.
const FIELDS = ["to", "duskName", "nameChoices", "amountDusk", "amountMasked", "memo", "gas", "requestChainId", "filledFrom", "filledIn"];

let held = null;

/**
 * Who a draft is for: the wallet (its first account), the profile and the node.
 * @param {object} ov - the overview the form was drawn from
 */
export const sendDraftOwner = (ov) => [ov?.accounts?.[0] ?? "", Number(ov?.selectedAccountIndex ?? 0) || 0, ov?.nodeUrl ?? ""].join(" ");

const phrase = (value) => typeof value === "string" && validateMnemonic(value.trim().toLowerCase().split(/\s+/).join(" "), wordlist);

function storage() {
  try {
    return (isTauriRuntime() ? globalThis.localStorage : globalThis.sessionStorage) ?? null;
  } catch {
    return null;
  }
}

// What's kept where it's kept: what's held here only where nothing can be,
// so a draft forgotten there (a reset) isn't brought back from here.
function read() {
  try {
    const store = storage();
    if (store) {
      const kept = store.getItem(KEY);
      return kept ? JSON.parse(kept) : null;
    }
  } catch {
    // Not readable there: what's held here.
  }
  return held;
}

/**
 * Keeps what's typed in Send, left with Back: nothing when nothing is typed.
 * @param {object | null} draft - state.draft
 * @param {object} ov
 */
export function keepSendDraft(draft, ov, { open = false } = {}) {
  const values = Object.fromEntries(FIELDS.filter((name) => draft?.[name] !== undefined).map((name) => [name, phrase(draft[name]) ? "" : draft[name]]));
  if (!String(values.to ?? "").trim() && !String(values.amountDusk ?? "").trim() && !String(values.memo ?? "").trim()) return forgetSendDraft();
  held = { owner: sendDraftOwner(ov), values, ...(open ? { open: true } : {}) };
  try {
    storage()?.setItem(KEY, JSON.stringify(held));
  } catch {
    // Kept here alone, till the page goes.
  }
}

/**
 * Send, left open as the app went to the background: kept with what's typed,
 * to open on again should Android end the app meanwhile.
 * @param {object | null} draft - state.draft
 * @param {object} ov
 */
export const keepOpenSend = (draft, ov) => keepSendDraft(draft, ov, { open: true });

/**
 * What Send held as the app was ended in the background, for this wallet,
 * profile and network: Send opens on it again, once. Null for none.
 * @param {object} ov
 * @returns {object | null}
 */
export function takeOpenSend(ov) {
  const kept = read();
  if (!kept?.open || kept.owner !== sendDraftOwner(ov) || !kept.values || typeof kept.values !== "object") return null;
  // What a link or a QR code filled in is that Send's alone: kept for no other.
  if (kept.values.filledIn) forgetSendDraft();
  else keepSendDraft(kept.values, ov);
  return { ...kept.values };
}

/**
 * What Send opens with: what was kept, for this wallet, profile and network,
 * or nothing. Another's goes.
 * @param {object} ov
 * @returns {object | null}
 */
export function keptSendDraft(ov) {
  const kept = read();
  if (kept?.owner === sendDraftOwner(ov) && kept.values && typeof kept.values === "object" && !kept.values.filledIn) return { ...kept.values };
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
