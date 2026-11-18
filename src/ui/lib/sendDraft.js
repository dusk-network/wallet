// What Send keeps of what's typed in it: only a Send kept on purpose, never
// one left with Back, which drops it (Amélie's: a payment back to a stranger,
// left with Back twice, was there again, 0,1 and all, the next time Send
// opened). Android ends an app left in the background, its session with it:
// Send left that way is kept as open (`keepOpenSend`), on the phone itself
// (localStorage), and the app opens on it again once unlocked
// (`takeOpenSend`). In the extension a tab that reloads opens on it the same
// way, from its own sessionStorage, a link's payment with it, and on the
// request form being filled in (`keepOpenRequest`): Firefox for Android
// reloads the tab with a pull down at its top (Marek's, Amélie's: a link's
// payment and a half-filled request went without a word). A page going (a
// popup closed, its tab closed) keeps it in the extension's session store too
// (`pastPage`), which outlives the page as its sessionStorage doesn't, till
// the browser closes: the next page opens on it (`loadKeptSend`; round 40's
// review: a toolbar popup opened again is a page of its own, its
// sessionStorage new). Such a Send says it's "Your
// unfinished payment" (`asKept`); one the app couldn't open on at once waits
// for Home's Send (`keptSendDraft`). It goes once the send goes out. A lock
// leaves the screen as it was, the form with it (popup/app.js). Nothing here
// is a secret: never a recovery phrase pasted into a field by mistake, nor a
// password, which Send has none of.
// A reset, or removing its wallet, forgets it (shared/sendDraftStore.js).

import { validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { storageSessionGet, storageSessionRemove, storageSessionSet } from "../../platform/extensionApi.js";
import { isExtensionRuntime, isTauriRuntime } from "../../platform/runtime.js";
import { REQUEST_DRAFT_KEY, SEND_DRAFT_KEY as KEY } from "../../shared/sendDraftStore.js";
// What's kept of the form: what the person typed and chose, and a request's
// network, which Send refuses it on any other (`requestChainId`), with where
// it was filled in from, and that a link or a QR code filled it in
// (`filledIn`: "link" or "qr", which typing over the recipient doesn't
// change), which is never the next Send's; when a link opened behind the
// lock or before the setup was opened (`linkAt`), and that it was taken;
// which of Amount and Memo a link or a kept Send put there, untouched since
// (`carried`), with the recipient they're for (`carriedTo`); and that it's
// one kept on purpose (`kept`).
const FIELDS = ["to", "duskName", "nameChoices", "amountDusk", "amountMasked", "memo", "gas", "requestChainId", "filledFrom", "filledIn", "linkAt", "linkTaken", "carried", "carriedTo", "kept"];

let held = null;
// What the extension's session store held as this page opened (loadKeptSend).
let fromSession = null;
let sessionRead = null;
const inExtension = () => !isTauriRuntime() && isExtensionRuntime();

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
      return kept ? JSON.parse(kept) : fromSession;
    }
  } catch {
    // Not readable there: what's held here.
  }
  return held ?? fromSession;
}

/**
 * In the extension, what the page before this one kept as it went, from the
 * extension's session store: read once, as the page opens, for Send to open
 * on (takeOpenSend, keptSendDraft) where this page's own store holds none.
 * Never fails.
 * @returns {Promise<void>}
 */
export function loadKeptSend() {
  if (!inExtension()) return Promise.resolve();
  sessionRead ??= storageSessionGet(KEY)
    .then((items) => {
      const kept = items?.[KEY];
      if (kept && typeof kept === "object") fromSession = kept;
    })
    .catch(() => {});
  return sessionRead;
}

/**
 * Whether Send's draft holds anything of a payment: a recipient, an amount or
 * a memo.
 * @param {object | null} draft
 */
export const holdsPayment = (draft) => ["to", "amountDusk", "memo"].some((name) => String(draft?.[name] ?? "").trim());

/**
 * Keeps what's typed in Send, for Send to open on again: nothing when nothing
 * is typed. `pastPage`: for the page after this one too, as this one goes.
 * @param {object | null} draft - state.draft
 * @param {object} ov
 * @param {{ open?: boolean, pastPage?: boolean }} [options]
 */
export function keepSendDraft(draft, ov, { open = false, pastPage = false } = {}) {
  const values = Object.fromEntries(FIELDS.filter((name) => draft?.[name] !== undefined).map((name) => [name, phrase(draft[name]) ? "" : draft[name]]));
  if (!holdsPayment(values)) return forgetSendDraft();
  held = { owner: sendDraftOwner(ov), values, ...(open ? { open: true } : {}) };
  try {
    storage()?.setItem(KEY, JSON.stringify(held));
  } catch {
    // Kept here alone, till the page goes.
  }
  // For the page after this one too, in the extension.
  if (pastPage && inExtension()) storageSessionSet({ [KEY]: held }).catch(() => {});
}

/**
 * Send, left open as the app went to the background: kept with what's typed,
 * to open on again should Android end the app meanwhile; or as the page goes
 * (`pastPage`), for the next page to open on.
 * @param {object | null} draft - state.draft
 * @param {object} ov
 * @param {{ pastPage?: boolean }} [options]
 */
export const keepOpenSend = (draft, ov, { pastPage = false } = {}) => keepSendDraft(draft, ov, { open: true, pastPage });

/**
 * What Send held as the app was ended in the background, or the tab reloaded
 * or the popup closed, for this wallet, profile and network: Send opens on it
 * again, once, and it's no longer kept here. Null for none.
 * @param {object} ov
 * @returns {object | null}
 */
export function takeOpenSend(ov) {
  const kept = read();
  if (!kept?.open || kept.owner !== sendDraftOwner(ov) || !kept.values || typeof kept.values !== "object") return null;
  forgetSendDraft();
  return { ...kept.values };
}

/**
 * A Send kept on purpose, as it opens again: "Your unfinished payment", its
 * Amount and Memo for the recipient it holds, so that choosing another
 * clears them (Amélie's: the 0,1 meant for a stranger stayed as she chose
 * Chen); for the one a link filled them in for, where they still were, To
 * cleared or half typed since (round 40's review: kept with To cleared, they
 * stayed for whoever was chosen next).
 * @param {object} values - a draft
 * @returns {object}
 */
export function asKept(values) {
  const filled = ["amount", "memo"].filter((name) => String(values?.[name === "amount" ? "amountDusk" : "memo"] ?? "").trim());
  return { ...values, kept: true, carried: filled, carriedTo: String(values?.carriedTo ?? "").trim() || String(values?.to ?? "").trim() };
}

/**
 * Another recipient chosen for a draft: what a link or a kept Send put in its
 * Amount and Memo for the one it came with (`carried`, `carriedTo`) goes, and
 * with it that it was that payment. The changes to make, or null where it's
 * that same recipient, or nothing was carried.
 * @param {object | null} draft
 * @param {string} recipient - the address chosen
 * @returns {object | null}
 */
export function carriedDropped(draft, recipient) {
  const from = String(draft?.carriedTo ?? "");
  const chosen = String(recipient ?? "").trim();
  if (!from || !chosen || chosen === from) return null;
  const carried = Array.isArray(draft.carried) ? draft.carried : [];
  return {
    ...(carried.includes("amount") ? { amountDusk: "", amountLux: undefined, amountMasked: false } : {}),
    ...(carried.includes("memo") ? { memo: "" } : {}),
    carried: undefined,
    carriedTo: undefined,
    kept: undefined,
    filledIn: undefined,
  };
}

/**
 * What Send opens with from Home: a Send kept on purpose the app couldn't
 * open on at once, for this wallet, profile and network, or nothing; once.
 * Another's goes, and so does what a link or a QR code filled in, which is
 * that Send's alone.
 * @param {object} ov
 * @returns {object | null}
 */
export function keptSendDraft(ov) {
  const kept = read();
  if (kept) forgetSendDraft();
  return kept?.owner === sendDraftOwner(ov) && kept.values && typeof kept.values === "object" && !kept.values.filledIn ? asKept(kept.values) : null;
}

/** It went out, or another wallet came: nothing of it stays. */
export function forgetSendDraft() {
  held = null;
  fromSession = null;
  try {
    storage()?.removeItem(KEY);
  } catch {
    // Nothing kept there.
  }
  if (inExtension()) storageSessionRemove(KEY).catch(() => {});
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
