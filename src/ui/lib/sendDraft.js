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
// In the extension a tab that reloads opens on it again the same way, a link's
// payment with it, and on the request form being filled in (`keepOpenRequest`):
// Firefox for Android reloads the tab with a pull down at its top (Marek's,
// Amélie's: a link's payment and a half-filled request went without a word).
// A reset, or removing its wallet, forgets it (shared/sendDraftStore.js).

import { validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { isTauriRuntime } from "../../platform/runtime.js";
import { REQUEST_DRAFT_KEY, SEND_DRAFT_KEY as KEY } from "../../shared/sendDraftStore.js";
// What's kept of the form: what the person typed and chose, and a request's
// network, which Send refuses it on any other (`requestChainId`), with where
// it was filled in from, and that a link or a QR code filled it in
// (`filledIn`: "link" or "qr", which typing over the recipient doesn't
// change), which is never the next Send's; and when a link opened behind the
// lock or before the setup was opened (`linkAt`), and that it was taken.
const FIELDS = ["to", "duskName", "nameChoices", "amountDusk", "amountMasked", "memo", "gas", "requestChainId", "filledFrom", "filledIn", "linkAt", "linkTaken"];

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

// The request form's fields kept as the tab is left: Public or Shielded, and
// what's asked.
const REQUEST_FIELDS = ["tab", "amountDusk", "memo"];

function tabStorage() {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * The request form, open with something typed in it as the tab is left: kept
 * in this tab alone, for the tab to open on again should it reload. Nothing
 * where it isn't open, or nothing's typed.
 * @param {object | null} receive - state.receive
 * @param {object} ov
 */
export function keepOpenRequest(receive, ov) {
  const values = Object.fromEntries(REQUEST_FIELDS.filter((name) => typeof receive?.[name] === "string").map((name) => [name, phrase(receive[name]) ? "" : receive[name]]));
  if (!receive?.requestOpen || (!String(values.amountDusk ?? "").trim() && !String(values.memo ?? "").trim())) return forgetOpenRequest();
  try {
    tabStorage()?.setItem(REQUEST_DRAFT_KEY, JSON.stringify({ owner: sendDraftOwner(ov), values }));
  } catch {
    // Not kept: a reload starts it over.
  }
}

/**
 * The request form kept as the tab was left, for this wallet, profile and
 * network: the tab opens on it once. Null for none; another's goes.
 * @param {object} ov
 * @returns {{ tab?: string, amountDusk?: string, memo?: string } | null}
 */
export function takeOpenRequest(ov) {
  let kept = null;
  try {
    kept = JSON.parse(tabStorage()?.getItem(REQUEST_DRAFT_KEY) ?? "null");
  } catch {
    kept = null;
  }
  forgetOpenRequest();
  return kept?.owner === sendDraftOwner(ov) && kept.values && typeof kept.values === "object" ? { ...kept.values } : null;
}

/** The request form is left, or done with: nothing of it is kept. */
export function forgetOpenRequest() {
  try {
    tabStorage()?.removeItem(REQUEST_DRAFT_KEY);
  } catch {
    // Nothing kept there.
  }
}
