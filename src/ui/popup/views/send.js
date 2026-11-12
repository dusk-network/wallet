import { isAccount } from "@dusk-network/networks/account";
import {
  formatDusk,
  formatDuskExact,
  formatFee,
  amountForInput,
  amountProblem,
  formatLuxForInput,
  formatLuxToDusk,
  parseDuskToLux,
  safeBigInt,
} from "../../../shared/amount.js";
import { TX_KIND } from "../../../shared/constants.js";
import { bridgeServiceLine, bridgeServiceTransfer, bridgeServiceWarnings, noBridgeRecipientText } from "../../../shared/bridgeCalls.js";
import { getDefaultGas, getMinimumGas } from "../../../shared/txDefaults.js";
import { BLOCKED_TITLE, blockedRecipient } from "../../../shared/recipientBlocklist.js";
import { ProfileGenerator } from "@dusk/w3sper";
import { h, setChildren } from "../../lib/dom.js";
import { guarded } from "../../lib/clickGuard.js";
import { joinedAddress } from "../../lib/recipient.js";
import { shortAddress } from "../../lib/strings.js";
import { iconSvg } from "../../components/ActionIcon.js";
import { HIDDEN_BALANCE, balance, balancesHidden } from "../../components/Balance.js";
import { subnav } from "../../components/Subnav.js";
import "../../components/GasEditor.js";
import { amountField } from "../../components/AmountField.js";
import { ownProfileName, profileNameEl, withReviewWallet } from "../../components/ProfileName.js";
import { safeTextEl } from "../../components/SafeText.js";
import { fieldLabel, reviewActions, submitOnGasEnter, textInput, wrappingInput } from "../../components/FormControls.js";
import { gasFeeLux, networkGasPrice, payGuard, reviewGas, startingGas } from "../../components/NetworkGas.js";
import { shortfallText } from "../../lib/shortfall.js";
import { nameAddressChoice } from "../../components/NameAddressChoice.js";
import { nameCheckNoteEl } from "../../components/NameCheckNote.js";
import {
  hideRecipientBadge,
  recipientBadge,
  recipientTypeBadgeOptions,
  setRecipientBadge,
} from "../../components/RecipientBadge.js";

import { listAddressBook } from "../../../shared/addressBook.js";
import { asDuskName, closeDuskName, isDuskName } from "@duskdomains/sdk/names";
import {
  duskNameErrorText,
  duskNameRecipient,
  duskNamesNetwork,
  lookupDuskName,
  lookupPrimaryName,
} from "../../../shared/duskNames.js";

import { openQrScanModal } from "../../components/QrScanModal.js";
import { forgetRequestLink, readRequestLink, walletChainOf } from "../../lib/requestLink.js";
import { contactAlikeOf, contactAlikeText, contactNameText } from "../../lib/contactNames.js";
import { sentAlready } from "@dusk-network/app-core/requests";
import { activityRows } from "../activity.js";
import { whenAtText } from "./txRow.js";
import { sendFromReview } from "./sent.js";
import { MAX_MEMO_BYTES, chainLabel, networkMismatch } from "@dusk-network/app-core/payment-links";
import { forgetSendDraft, keepSendDraft } from "../../lib/sendDraft.js";
import { networkTextOf } from "../../../shared/nodeNetwork.js";

// A pasted EVM address, which a Dusk transfer can't pay.
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
// Base58 of an account's length that isn't a key: a mistyped account.
const NOT_AN_ADDRESS_TEXT = "Not a valid address. Check it and try again.";
// The longest a .dusk name can be, with .dusk.
const LONGEST_NAME = 68;
// What the network takes.
export const EVM_ADDRESS_TEXT = "That's an EVM address, not a Dusk account.";
// The longest memo a transaction carries.
const MEMO_TOO_LONG_TEXT = `That memo is too long: ${MAX_MEMO_BYTES} bytes at most.`;
const memoTooLong = (memo) => new TextEncoder().encode(String(memo ?? "").trim()).length > MAX_MEMO_BYTES;

/**
 * The .dusk name the draft's recipient was resolved from, while the recipient
 * is still the address it resolved to. Contacts can replace the recipient, and
 * the name must not stay with an address it doesn't point to.
 * @param {object} draft
 * @returns {{ name: string, nodeUrl: string, to: string } | undefined}
 */
export function draftDuskName(draft) {
  const name = draft?.duskName;
  return name && typeof draft.to === "string" && name.to === draft.to ? name : undefined;
}

// What a request link or a QR code filled in says under the recipient, until
// it changes, with the network it pays on: a plain link says none.
const FILLED_FROM = Object.freeze({ link: "the link", qr: "the QR code" });
const filledText = (from, nodeUrl) =>
  FILLED_FROM[from] ? `Filled in from ${FILLED_FROM[from]}, to pay on ${networkTextOf(String(nodeUrl ?? "")) || "this network"}. Check it before you send.` : "";

/**
 * "You sent 0.02 DUSK to Alice with this memo at 08:53.": a payment made
 * already, for the form and Review, the amount hidden as balances are where
 * Max filled it in.
 * @param {object} ov
 * @param {{ lux: bigint, masked: boolean, to: string, memo: string, name?: string, time: number }} payment
 */
function sentAgainWords(ov, { lux, masked, to, memo, name = "", time }) {
  const own = to === String(ov?.accounts?.[Number(ov?.selectedAccountIndex ?? 0) || 0] ?? "") || to === String(ov?.addresses?.[Number(ov?.selectedAccountIndex ?? 0) || 0] ?? "");
  return [
    "You sent ",
    balance(balancesHidden(ov) && masked, formatDuskExact(lux)),
    ` DUSK to ${own ? "yourself" : name || shortAddress(to)}${memo.trim() ? " with this memo" : ""} ${whenAtText(time)}.`,
  ];
}

export function sendFormView(ov, { state, actions } = {}) {
  // A request for another network leaves nothing of itself here, whether it
  // opened this page or the network changed under it: the form says why.
  if (state.draft?.requestChainId && chainMismatchText(state.draft.requestChainId, ov?.nodeUrl)) {
    state.draft = { ...refusedRequest(state.draft), amountDusk: "", amountMasked: false, memo: "" };
  }
  const draft = state.draft || {};

  // On more lines as it grows: the whole address to check, not its end.
  const to = wrappingInput({
    placeholder: duskNamesNetwork(ov?.nodeUrl)
      ? "Account, shielded address or .dusk name"
      : "Account or shielded address",
    // Back from review, show the .dusk name rather than the account it resolved to.
    value: draftDuskName(draft)?.name || (typeof draft.to === "string" ? draft.to : ""),
    onEnter: () => amount.focus(),
  });

  // Optional inline contact badge (shown when the recipient matches a saved contact).
  const toChip = recipientBadge({
    kind: "contact",
    className: "to-chip",
    hidden: true,
  });
  const toWrap = h("div", { class: "to-input-wrap" }, [toChip, to]);
  const memo = textInput({
    placeholder: "Optional",
    value: typeof draft.memo === "string" ? draft.memo : "",
    onEnter: () => nextBtn.click(),
  });
  const memoError = h("div", { class: "field-error memo-error", role: "alert", hidden: true });
  const checkMemo = () => {
    const tooLong = memoTooLong(memo.value);
    memoError.textContent = tooLong ? MEMO_TOO_LONG_TEXT : "";
    memoError.hidden = !tooLong;
    return !tooLong;
  };

  // Assigned later (we want to pass it into components as a live closure).
  let syncDraft = () => {};

  // ------------------------------------------------------------
  // Amount helpers (MAX + slider)
  // ------------------------------------------------------------
  // Max and the balance check reserve the fee Review starts from: the
  // draft's own gas, custom gas from Settings, or the transfer's default
  // limit at the node's gas price, as Review asks it (till it answers, the
  // wallet's own), so the two say the same fee.
  let networkPrice = null;
  function feeLuxForRecipientType(type) {
    const privacy = type === "address" ? "shielded" : "public";
    const defaultGas = getDefaultGas(TX_KIND.TRANSFER, { privacy });
    return gasFeeLux(
      startingGas({
        defaultGas: networkPrice && defaultGas ? { ...defaultGas, price: networkPrice } : defaultGas,
        minLimit: getMinimumGas(TX_KIND.TRANSFER, { privacy })?.limit,
        customGas: ov?.customGas,
        gas: draft?.gas,
      })
    );
  }

  // Balances from overview.
  const hidden = balancesHidden(ov);
  const pubBalLux = safeBigInt(ov?.balance?.value, 0n);
  const shValueLux = safeBigInt(ov?.shieldedBalance?.value, 0n);
  const shSpendLux =
    ov?.shieldedBalance?.spendable != null
      ? safeBigInt(ov.shieldedBalance.spendable, 0n)
      : null;

  // Whether the spendable shielded balance covers the smallest transfer (1 Lux)
  // plus the shielded fee cap; a .dusk name's shielded address needs it.
  const shieldedCovers = shSpendLux != null && shSpendLux > feeLuxForRecipientType("address");

  // The profile's own public account and shielded address, to flag sending to yourself.
  const ownIdxRaw = Number(ov?.selectedAccountIndex ?? 0);
  const ownIdx = Number.isFinite(ownIdxRaw) && ownIdxRaw >= 0 ? Math.floor(ownIdxRaw) : 0;
  const ownAccount = String(ov?.accounts?.[ownIdx] ?? ov?.accounts?.[0] ?? "");
  const ownAddress = String(ov?.addresses?.[ownIdx] ?? ov?.addresses?.[0] ?? "");

  let detectedRecipientType = null; // "account" | "address" | null

  // The amount: one large field with its error under it, then what's
  // available after fees with Max, and the fee that leaves room for.
  const field = amountField({
    label: "Amount",
    value: typeof draft.amountDusk === "string" ? draft.amountDusk : "",
    masked: hidden && Boolean(draft.amountMasked),
    onInput: () => {
      checkAmount();
      syncDraft();
    },
    onEnter: () => nextBtn.click(),
  });
  const amount = field.input;

  const clamp0 = (v) => (v > 0n ? v : 0n);

  function getMaxAmountLux() {
    if (detectedRecipientType === "address") {
      if (shSpendLux == null) return null;
      return clamp0(shSpendLux - feeLuxForRecipientType("address"));
    }
    if (detectedRecipientType === "account") {
      // Public transfers are limited by the public balance.
      if (ov?.balance?.value == null) return null;
      return clamp0(pubBalLux - feeLuxForRecipientType("account"));
    }
    return null;
  }

  const availText = h("span", { class: "amount-avail__text" });
  const maxBtn = h("button", {
    class: "mini-btn",
    type: "button",
    text: "Max",
    title: "All of it, less the network fee",
    disabled: true,
    onclick: () => {
      const maxLux = getMaxAmountLux();
      if (maxLux == null || maxLux <= 0n) return;
      // The real amount, which gets sent, shown as dots with balances hidden.
      field.setValue(formatLuxForInput(maxLux), { masked: hidden });
      checkAmount();
      syncDraft();
      field.focus();
    },
  });
  const available = h("div", { class: "amount-avail", hidden: true }, [availText, maxBtn]);
  const feeNote = h("div", { class: "amount-fee-note", hidden: true });

  // Review is off while the recipient won't do, or an amount typed won't: the
  // field says why. An empty one leaves it on, for it to say what's missing.
  let recipientOff = false;
  let amountOff = false;
  const syncReview = () => {
    nextBtn.disabled = recipientOff || amountOff;
  };
  const reviewOff = (off) => {
    recipientOff = off;
    syncReview();
  };

  function checkAmount(opts) {
    const lux = readAmount(opts);
    amountOff = lux == null && Boolean(String(amount.value ?? "").trim());
    syncReview();
    return lux;
  }

  // The amount as typed, checked as it is typed: an error under the field,
  // and the amount in Lux when it can be sent.
  function readAmount({ required = false } = {}) {
    const raw = String(amount.value ?? "").trim();
    if (!raw) {
      field.setError(required ? "Enter an amount." : "");
      return null;
    }
    let lux;
    try {
      lux = safeBigInt(parseDuskToLux(raw), 0n);
    } catch {
      field.setError(amountProblem(raw));
      return null;
    }
    if (lux <= 0n) {
      field.setError("Enter an amount greater than 0.");
      return null;
    }
    const maxLux = getMaxAmountLux();
    if (maxLux != null && lux > maxLux) {
      field.setError(shortfallText({ missingLux: lux + feeLuxForRecipientType(detectedRecipientType) - (detectedRecipientType === "address" ? shSpendLux : pubBalLux), shielded: detectedRecipientType === "address", hidden }));
      return null;
    }
    field.setError("");
    return lux;
  }

  function updateAmountHelpers() {
    const maxLux = getMaxAmountLux();
    maxBtn.disabled = maxLux == null || maxLux <= 0n;
    if (maxLux == null) {
      available.hidden = true;
      feeNote.hidden = true;
      checkAmount();
      return;
    }
    const feeLux = feeLuxForRecipientType(detectedRecipientType);
    availText.replaceChildren(
      feeLux > 0n ? "Available after fees " : "Available ",
      balance(hidden, formatDusk(maxLux)),
      " DUSK"
    );
    available.hidden = false;
    const notes = [];
    if (feeLux > 0n) notes.push(`Network fee up to ${formatFee(feeLux, { max: true })} DUSK`);
    if (detectedRecipientType === "address" && shSpendLux != null && shValueLux > shSpendLux) {
      notes.push("Part of your shielded DUSK waits on a pending transaction");
    }
    feeNote.textContent = notes.join(" · ");
    feeNote.hidden = !notes.length;
    checkAmount();
  }

  // A request for another network says so under the recipient, and stays
  // until the recipient changes: its network is kept with the draft, so
  // Review and any redraw say it too.
  const errBox = h("div", { class: "err", style: "display:none" });
  const againNote = h("div", { class: "callout warn send-again", role: "alert", hidden: true });
  const setErr = (txt) => {
    if (!txt) {
      errBox.style.display = "none";
      errBox.textContent = "";
      return;
    }
    errBox.style.display = "block";
    errBox.textContent = txt;
  };

  // A request for another network, or a link that can't be read, is refused:
  // why says so under the recipient, until the recipient changes. What one
  // filled in says so too.
  const chainNote = h("div", { class: "field-error", role: "alert", hidden: true });
  const sayRefused = ({ chainId = "", problem = "" } = {}) => {
    const text = problem || chainMismatchText(chainId, ov?.nodeUrl);
    chainNote.textContent = text;
    chainNote.hidden = !text;
  };
  const filledNote = h("p", { class: "field-hint send-filled-note", role: "status", hidden: true });
  const sayFilled = (from) => {
    filledNote.textContent = filledText(from, ov?.nodeUrl);
    filledNote.hidden = !filledNote.textContent;
  };
  sayRefused({ chainId: state.draft?.refusedChainId, problem: state.draft?.refusedProblem });
  sayFilled(state.draft?.filledFrom);

  // A link read (readRequestLink), as it's pasted, scanned or opened.
  const applyRequest = (read, { source = "request" } = {}) => {
    // For another network, or one that can't be read, it fills in nothing:
    // the whole form empties, so nothing an earlier link or a person put in
    // reads as this one's, and the reason alone is said.
    if (!read?.link) {
      to.value = "";
      field.setValue("");
      memo.value = "";
      checkMemo();
      state.draft = {
        ...refusedRequest({ ...(state.draft || {}), requestChainId: read?.reason === "other-network" ? read.chainId : undefined }, read?.reason === "other-network" ? "" : read?.problem),
        amountDusk: "",
        amountMasked: false,
        memo: "",
      };
      sayRefused({ chainId: state.draft.refusedChainId, problem: state.draft.refusedProblem });
      sayFilled("");
      updateToType();
      return "refused";
    }

    const req = read.link;
    const isDuskReq = req.form === "dusk" || req.form === "https";

    // Update DOM values
    to.value = req.to;

    if (isDuskReq) {
      // A full dusk: request link should define the form values.
      field.setValue(amountForInput(req.amountDusk || ""));
      memo.value = req.memo || "";
    } else {
      // A raw recipient QR should not clobber what the user already typed.
      if (req.amountDusk) field.setValue(amountForInput(req.amountDusk));
      if (req.memo) memo.value = req.memo;
    }

    // Persist into draft so any toast-triggered render doesn't wipe the fields.
    const nextDraft = { ...(state.draft || {}) };
    nextDraft.to = to.value;
    nextDraft.duskName = undefined;

    if (isDuskReq) {
      nextDraft.amountDusk = amount.value;
      nextDraft.memo = memo.value;
    } else {
      if (req.amountDusk) nextDraft.amountDusk = amount.value;
      if (req.memo) nextDraft.memo = memo.value;
    }

    nextDraft.requestChainId = req.chainId || undefined;
    nextDraft.refusedChainId = undefined;
    nextDraft.refusedProblem = undefined;
    nextDraft.filledFrom = source === "qr" ? "qr" : "link";
    nextDraft.filledIn = true;
    state.draft = nextDraft;

    sayRefused();
    sayFilled(nextDraft.filledFrom);
    updateToType();
    // A request paid already says so as it fills the form, as when it opened Send.
    sayAgain();

    return true;
  };

  // A link, read on the wallet's network; what isn't one is a recipient, as a
  // QR code may hold just the address: it fills in To alone.
  const looksLikeRequest = (text) => readRequestLink(text, ov?.nodeUrl) !== null;
  const maybeDecodeRequest = (raw, { source = "request" } = {}) => {
    const s = String(raw || "").trim();
    if (!s) return false;
    const read = readRequestLink(s, ov?.nodeUrl);
    if (read) return applyRequest(read, { source });
    if (source !== "qr") return false;
    to.value = s;
    state.draft = { ...(state.draft || {}), to: s, duskName: undefined, requestChainId: undefined, refusedChainId: undefined, refusedProblem: undefined, filledFrom: "qr", filledIn: true };
    sayRefused();
    sayFilled("qr");
    updateToType();
    return true;
  };

  // Lightweight recipient-type detection (public account vs shielded address)
  // so the user understands what kind of transfer they'll create.
  const toTypePill = recipientBadge({
    kind: "neutral",
    className: "recipient-type-badge",
    hidden: true,
  });

  // If the recipient matches a saved contact, show it inline in the recipient field.
  let contactsIndex = null; // Map<lowercase address, entry>
  let contactsLoading = false;

  const rebuildContactsIndex = (items) => {
    try {
      const map = new Map();
      for (const e of Array.isArray(items) ? items : []) {
        const addr = String(e?.address ?? "").trim();
        if (!addr) continue;
        map.set(addr.toLowerCase(), e);
      }
      contactsIndex = map;
    } catch {
      contactsIndex = new Map();
    }
  };

  const ensureContactsLoaded = () => {
    try {
      const ab = state.addressBook;
      if (ab?.loaded && Array.isArray(ab.items)) {
        rebuildContactsIndex(ab.items);
        return;
      }
      if (contactsLoading) return;
      contactsLoading = true;
      listAddressBook()
        .then((items) => {
          contactsLoading = false;
          try {
            // Cache in shared state so other views (review, contacts picker) can reuse.
            state.addressBook = {
              ...(state.addressBook || {}),
              loaded: true,
              loading: false,
              error: null,
              items,
            };
          } catch {
            // ignore
          }
          rebuildContactsIndex(items);
          // Update pills without forcing a full render.
          updateToType();
        })
        .catch(() => {
          contactsLoading = false;
          contactsIndex = new Map();
        });
    } catch {
      // ignore
    }
  };

  ensureContactsLoaded();

  // A picked contact whose name looks like another's says so: only its address tells them apart.
  const alikeNote = h("div", { class: "send-alike-note", role: "status", hidden: true });
  const sayAlike = (text) => {
    alikeNote.textContent = text ? `${text}. Check the address.` : "";
    alikeNote.hidden = !text;
  };
  const hideContactBadge = () => {
    hideRecipientBadge(toChip);
    sayAlike("");
    if (!toWrap.classList.contains("has-chip")) return;
    toWrap.classList.remove("has-chip");
    to.fitLines?.();
  };

  const updateContactMatch = (addr, typ) => {
    try {
      if (!addr || (typ !== "account" && typ !== "address")) {
        hideContactBadge();
        return;
      }

      if (!contactsIndex) rebuildContactsIndex(state.addressBook?.items);
      const hit = contactsIndex?.get(String(addr).toLowerCase());
      // A saved contact, or another profile of this wallet's.
      const profile = addr === ownAccount || addr === ownAddress ? "" : ownProfileName(ov, addr);
      // A contact's name as the wallet shows it, what can't be seen in it as its codes.
      const name = contactNameText(hit?.name) || profile;
      if (!name) {
        hideContactBadge();
        return;
      }

      setRecipientBadge(toChip, {
        kind: "contact",
        label: name,
        seed: addr,
        title: hit?.name ? `Saved contact: ${name}` : `Your profile: ${name}`,
        className: "to-chip",
      });
      sayAlike(hit ? contactAlikeText(ov, hit, Array.isArray(state.addressBook?.items) ? state.addressBook.items : []) : "");
      // The chip on its own line over the address: the field is as tall as both.
      if (!toWrap.classList.contains("has-chip")) {
        toWrap.classList.add("has-chip");
        to.fitLines?.();
      }
    } catch {
      hideContactBadge();
    }
  };

  // A .dusk name resolves to a public account, a shielded address or both. Review stays off until it does.
  const nameBox = h("div", { class: "row name-box", style: "display:none" });
  const showNameBox = (children) => {
    const shown = children.filter(Boolean);
    setChildren(nameBox, shown);
    nameBox.style.display = shown.length ? "" : "none";
  };

  // Sending to your own account or address only costs a fee: say so, and let
  // it go ahead. A recipient the network's file blocks says why, and Review
  // stays off.
  const selfNote = h("div", { class: "send-self-note", hidden: true });
  const blockedText = h("div", { class: "muted" });
  const blockedNote = h("div", { class: "callout warn send-blocked", role: "alert", hidden: true }, [
    h("div", { class: "callout-title", text: BLOCKED_TITLE }),
    blockedText,
  ]);
  const showSelfNote = (recipient) => {
    const own =
      recipient && recipient === ownAccount
        ? "account"
        : recipient && recipient === ownAddress
          ? "address"
          : "";
    selfNote.textContent = own ? `This is your own ${own}. Sending to yourself only costs a fee.` : "";
    selfNote.hidden = !own;
    const blocked = blockedRecipient(recipient, ov?.chainId);
    blockedText.textContent = blocked ?? "";
    blockedNote.hidden = !blocked;
    if (blocked) reviewOff(true);
    return !blocked;
  };

  // Opens Shield, for a shielded address the shielded balance can't pay.
  const openShield = () => {
    state.route = "convert";
    state.draft = { kind: TX_KIND.SHIELD, amountDusk: "", amountLux: "" };
    actions?.render?.().catch(() => {});
  };

  // Which address of each name with both the user picked, by the name as
  // resolved: retyping a name, Back from Review and re-renders keep its pick,
  // and a name without one starts on its public account.
  const nameChoices = { ...draft.nameChoices };
  const pickedShielded = (result) => nameChoices[result.name] === true;
  const nameRecipient = (result) => duskNameRecipient(result, { shielded: pickedShielded(result) });

  // The resolved name the form shows while the field holds it. Contacts saves
  // the address it sends to, never the name.
  let shownName = null;

  // The .dusk names this wallet knows: contacts saved from one or named as
  // one, the names typed for past sends, and past transfers' verified names.
  const knownDuskNames = () => {
    const names = [
      ...(state.addressBook?.items ?? []).flatMap((c) => [c?.duskName, c?.name]),
      ...(Array.isArray(ov?.txs) ? ov.txs : []).map((tx) => tx?.toName),
      ...(state.activity?.names instanceof Map ? state.activity.names.values() : []),
    ];
    return names.filter((n) => typeof n === "string" && isDuskName(n));
  };

  // Points the form at the address `result` sends to: the balance line and
  // Review follow it. True when Review can go ahead.
  const showNameAddress = (result) => {
    const recipient = nameRecipient(result);
    const t = ProfileGenerator.typeOf(recipient);
    const allowed = showSelfNote(recipient);
    detectedRecipientType = t;
    const sendable = allowed && (t === "account" || shieldedCovers);
    reviewOff(!sendable);
    updateAmountHelpers();
    return sendable;
  };

  // "Did you mean alice.dusk?", which puts the name in the field.
  const suggestionButton = (name) =>
    h("button", {
      class: "text-btn text-btn--inline name-suggestion",
      type: "button",
      text: `Did you mean ${name}?`,
      onclick: () => {
        to.value = name;
        onRecipientInput();
        to.focus?.();
      },
    });

  // The contacts a typed name can mean, by the start of their name or of a word in it.
  const contactsNamed = (typed) => {
    const q = typed.toLowerCase();
    const items = Array.isArray(state.addressBook?.items) ? state.addressBook.items : [];
    return items
      .filter((c) => {
        const name = String(c?.name ?? "").trim().toLowerCase();
        return Boolean(c?.address) && (name.startsWith(q) || name.split(/[^\p{L}\p{N}]+/u).some((word) => word && word.startsWith(q)));
      })
      .slice(0, 3);
  };

  // "Your contact Jan · 26FCH7…", which puts the contact's address in the field;
  // one whose name looks like another's says so, its address beside it.
  const contactButton = (contact) =>
    h("button", {
      class: "text-btn text-btn--inline name-suggestion",
      type: "button",
      text: [
        `Your contact ${contactNameText(contact.name)} · ${shortAddress(contact.address)}`,
        contactAlikeText(ov, contact, Array.isArray(state.addressBook?.items) ? state.addressBook.items : []).toLowerCase(),
      ].filter(Boolean).join(" · "),
      onclick: () => {
        to.value = contact.address;
        onRecipientInput();
        to.focus?.();
      },
    });

  // Shows a lookup result for `v` if the field still holds it; true when Review can go ahead.
  const applyNameResult = (v, result) => {
    if (String(to.value || "").trim() !== v) return false;
    // The transfer type follows from the address it sends to, as for a pasted one.
    const recipient = result.ok ? nameRecipient(result) : "";
    const t = recipient ? ProfileGenerator.typeOf(recipient) : null;
    if (t !== "account" && t !== "address") {
      shownName = null;
      hideRecipientBadge(toTypePill);
      showSelfNote("");
      const failed = result.ok ? { name: result.name, reason: "no_account" } : result;
      // A name that isn't registered may be a typo of one the wallet knows.
      const suggestion = failed.reason === "not_registered" ? closeDuskName(v, knownDuskNames()) : null;
      showNameBox([
        h("div", { class: "err", text: duskNameErrorText(failed) }),
        suggestion ? suggestionButton(suggestion) : null,
        failed.reason === "lookup_failed"
          ? h("div", { class: "btnrow" }, [
              h("button", {
                class: "btn-outline",
                type: "button",
                text: "Try again",
                onclick: () => updateToType(),
              }),
            ])
          : null,
      ]);
      detectedRecipientType = null;
      reviewOff(true);
      updateAmountHelpers();
      return false;
    }

    shownName = result;
    // The name's cards show the transfer type, and pick it when the name has
    // both addresses, so the pill stays off.
    hideRecipientBadge(toTypePill);
    const choice = nameAddressChoice({
      name: result.name,
      account: result.account,
      address: result.address,
      shielded: pickedShielded(result),
      shieldedDisabled: !shieldedCovers,
      onChoose: (shielded) => {
        nameChoices[result.name] = shielded;
        syncDraft();
        choice.set(shielded);
        showNameAddress(result);
      },
      onShield: openShield,
    });
    showNameBox([choice.el, nameCheckNoteEl(ov?.nodeUrl)]);
    return showNameAddress(result);
  };

  // The name lookups the field starts, as the user types and on Review, are
  // numbered, and only the latest one's answer counts: going back to a name
  // while it is looked up starts a second lookup of it, and the first can
  // still answer last.
  let lookupCount = 0;
  const startLookup = (v) => {
    const n = ++lookupCount;
    return { lookup: lookupDuskName(v, { nodeUrl: ov?.nodeUrl }), latest: () => n === lookupCount };
  };

  // A pasted public account with a verified .dusk name shows it, as the
  // explorer does; only the latest lookup's answer counts.
  let primaryCount = 0;
  const showPrimaryName = (account) => {
    const n = ++primaryCount;
    if (!duskNamesNetwork(ov?.nodeUrl) || account === ownAccount) return;
    lookupPrimaryName(account, { nodeUrl: ov?.nodeUrl, stale: true })
      ?.then?.((name) => {
        if (!name || n !== primaryCount || String(to.value || "").trim() !== account) return;
        // Verified, on a network's own node; on another, that node's word.
        const note = nameCheckNoteEl(ov?.nodeUrl);
        showNameBox([
          h("div", { class: "name-verified" }, [
            note ? null : h("span", { class: "btn-ico", "aria-hidden": "true", html: iconSvg("check") }),
            h("span", { class: "name-verified__name", text: name }),
            h("span", { class: "name-verified__note", text: note ? " · its .dusk name" : " · its verified .dusk name" }),
          ]),
          note,
        ]);
      })
      ?.catch?.(() => {});
  };

  const showDuskName = (v) => {
    const { lookup, latest } = startLookup(v);
    if (lookup.result) {
      applyNameResult(v, lookup.result);
      return;
    }
    hideRecipientBadge(toTypePill);
    detectedRecipientType = null;
    reviewOff(true);
    updateAmountHelpers();
    showNameBox([h("div", { class: "muted", text: `Looking up ${v}…` })]);
    lookup.promise.then((result) => {
      if (latest()) applyNameResult(v, result);
    });
  };

  const updateToType = () => {
    // Whatever Review said was about what was here before.
    setErr("");
    to.value = joinedAddress(to.value || "");
    const v = String(to.value || "").trim();
    showSelfNote("");
    shownName = null;
    primaryCount += 1;
    if (!isDuskName(v)) {
      showNameBox([]);
      reviewOff(false);
    }
    if (!v) {
      hideRecipientBadge(toTypePill);
      detectedRecipientType = null;
      updateContactMatch("", null);
      updateAmountHelpers();
      return;
    }

    // Give quick feedback when the user pastes a request link.
    if (looksLikeRequest(v)) {
      setRecipientBadge(toTypePill, {
        kind: "request",
        icon: "request",
        label: "Request",
        title: "Request link",
        className: "recipient-type-badge",
      });
      detectedRecipientType = null;
      updateContactMatch("", null);
      updateAmountHelpers();
      return;
    }

    if (isDuskName(v)) {
      updateContactMatch("", null);
      showDuskName(v);
      return;
    }

    const t = ProfileGenerator.typeOf(v);

    if (t === "account" && !isAccount(v)) {
      hideRecipientBadge(toTypePill);
      showNameBox([h("div", { class: "err", text: NOT_AN_ADDRESS_TEXT })]);
      detectedRecipientType = null;
      reviewOff(true);
      updateContactMatch("", null);
      updateAmountHelpers();
      return;
    }

    if (t === "account" || t === "address") {
      setRecipientBadge(toTypePill, {
        ...recipientTypeBadgeOptions(t),
        className: "recipient-type-badge",
      });
      detectedRecipientType = t;
      updateContactMatch(v, t);
      showSelfNote(v);
      if (t === "account") showPrimaryName(v);
      updateAmountHelpers();
      return;
    }

    // An EVM address can't receive DUSK on Dusk: say what it is, and Review stays off.
    if (EVM_ADDRESS.test(v)) {
      hideRecipientBadge(toTypePill);
      showNameBox([h("div", { class: "err", text: EVM_ADDRESS_TEXT })]);
      detectedRecipientType = null;
      reviewOff(true);
      updateContactMatch("", null);
      updateAmountHelpers();
      return;
    }

    // A contact's name comes before any guess at a .dusk name, which would
    // be somebody else's.
    const named = contactsNamed(v);
    if (named.length) {
      hideRecipientBadge(toTypePill);
      showNameBox(named.map(contactButton));
      detectedRecipientType = null;
      updateContactMatch("", null);
      updateAmountHelpers();
      return;
    }

    // A name typed without .dusk, or with a dot after it, where the network
    // has names: the name it likely means (asDuskName).
    const bare = duskNamesNetwork(ov?.nodeUrl) ? asDuskName(v) : null;
    if (bare) {
      hideRecipientBadge(toTypePill);
      showNameBox([suggestionButton(bare)]);
      detectedRecipientType = null;
      updateContactMatch("", null);
      updateAmountHelpers();
      return;
    }

    // Too long for a name, and it isn't an address: not one in the making.
    if (v.length > LONGEST_NAME) {
      hideRecipientBadge(toTypePill);
      showNameBox([h("div", { class: "err", text: NOT_AN_ADDRESS_TEXT })]);
      detectedRecipientType = null;
      reviewOff(true);
      updateContactMatch("", null);
      updateAmountHelpers();
      return;
    }

    // Fallback: unknown format
    setRecipientBadge(toTypePill, {
      kind: "unknown",
      icon: "?",
      label: "Unknown",
      title: "Unknown address format",
      className: "recipient-type-badge",
    });
    detectedRecipientType = null;
    updateContactMatch("", null);
    updateAmountHelpers();
  };

  // The same payment, made already: said on the form as soon as it's filled
  // in, from a link opened again too, as Review says it.
  const sayAgain = () => {
    const recipient = String(to.value ?? "").trim();
    const kind = recipient ? ProfileGenerator.typeOf(recipient) : "";
    let lux = null;
    try {
      lux = kind === "account" || kind === "address" ? parseDuskToLux(String(amount.value ?? "")) : null;
    } catch {
      // Not an amount yet: nothing to say.
    }
    const made = lux ? sentAlready(activityRows(ov, state), { lux: BigInt(lux), memo: String(memo.value ?? ""), to: recipient }) : null;
    setChildren(againNote, made && made.time !== null ? [h("div", { class: "callout-title" }, sentAgainWords(ov, { lux: BigInt(lux), masked: field.isMasked(), to: recipient, memo: String(memo.value ?? ""), name: ownProfileName(ov, recipient) || contactNameText(contactsIndex?.get(recipient.toLowerCase())?.name), time: made.time }))] : []);
    againNote.hidden = !againNote.children.length;
  };

  syncDraft = () => {
    sayAgain();
    // Keep draft in sync so any toast-triggered re-render doesn't wipe inputs.
    state.draft = {
      ...(state.draft || {}),
      to: String(to.value || ""),
      // The field is the recipient again; drop a name kept from review.
      duskName: undefined,
      nameChoices: { ...nameChoices },
      amountDusk: String(amount.value || ""),
      amountMasked: field.isMasked(),
      memo: String(memo.value || ""),
      // preserve any gas edits the user may have made on the confirm screen
      gas: state.draft?.gas,
    };
  };

  // What To held before this input, to tell a link put in whole from one typed.
  let toBefore = String(to.value ?? "");
  function onRecipientInput(e) {
    const now = String(to.value ?? "");
    const whole = /^insertFrom/.test(String(e?.inputType ?? "")) || now.length - toBefore.length > 1;
    toBefore = now;
    sayRefused();
    sayFilled("");
    // Another recipient: the request, and whether it was refused, no longer apply.
    if (state.draft) Object.assign(state.draft, { requestChainId: undefined, refusedChainId: undefined, refusedProblem: undefined, filledFrom: undefined });
    // A link put in whole is read at once, as a paste is: one for another
    // network, or that can't be read, says so then, not at Review.
    if (whole && looksLikeRequest(now.trim()) && maybeDecodeRequest(now, { source: "request" })) {
      toBefore = String(to.value ?? "");
      return;
    }
    updateToType();
    syncDraft();
  }
  to.addEventListener("input", onRecipientInput);
  memo.addEventListener("input", () => {
    checkMemo();
    syncDraft();
  });
  to.addEventListener("paste", (e) => {
    try {
      const txt = String(e?.clipboardData?.getData?.("text") ?? "").trim();
      if (txt && looksLikeRequest(txt)) {
        e.preventDefault();
        if (!maybeDecodeRequest(txt, { source: "request" })) {
          // Fall back to normal paste
          to.value = txt;
        }
      }
    } catch {
      // ignore
    }
  });
  to.addEventListener("blur", () => {
    const v = String(to.value || "").trim();
    if (looksLikeRequest(v)) {
      maybeDecodeRequest(v, { source: "request" });
    }
  });

  const scanBtn = h("button", {
    class: "icon-btn icon-only",
    type: "button",
    html: iconSvg("qr"),
    title: "Scan QR",
    "aria-label": "Scan QR",
    onclick: async () => {
      try {
        const payload = await openQrScanModal({
          title: "Scan request",
          hint: "Scan a Dusk request QR or choose an image.",
        });
        if (!payload) return;
        const ok = maybeDecodeRequest(payload, { source: "qr" });
        if (!ok) setErr("This QR code isn't a Dusk account, address or request.");
        toBefore = String(to.value ?? "");
      } catch (e) {
        setErr(e?.message ?? String(e));
      }
    },
  });

  const bookBtn = h("button", {
    class: "icon-btn icon-only",
    type: "button",
    html: iconSvg("contacts"),
    title: "Contacts",
    "aria-label": "Contacts",
    onclick: async () => {
      try {
        // Ensure the current form state is preserved before navigating.
        syncDraft();
        const toVal = String(to.value || "").trim();

        state.addressBook = {
          ...(state.addressBook || {}),
          mode: "pick",
          fromRoute: "send",
          pickReturnRoute: "send",
          // A new contact gets the address a shown name sends to, in full in its form.
          // A name still being looked up, or one that didn't resolve, gives no address.
          prefillAddress: shownName ? nameRecipient(shownName) : isDuskName(toVal) ? "" : toVal,
          prefillName: "",
          view: "list",
          query: "",
          loaded: false,
          loading: false,
          error: null,
          items: null,
          editId: null,
          editName: "",
          editAddress: "",
        };

        state.route = "contacts";
        await actions?.render?.();
      } catch (e) {
        actions?.showToast?.(e?.message ?? String(e), 2500);
      }
    },
  });

  const toRow = h("div", { class: "input-row" }, [toWrap, scanBtn, bookBtn]);

  const nextBtn = h("button", {
    class: "btn-primary",
    text: "Review",
    onclick: async () => {
      try {
        setErr("");
        // Allow a request link to be pasted directly into the recipient field:
        // one for another network, or that can't be read, says why under the
        // field, and goes no further.
        const rawTo = to.value.trim();
        if (looksLikeRequest(rawTo) && maybeDecodeRequest(rawTo, { source: "request" }) === "refused") return;

        const toVal = to.value.trim();
        // A link refused says why under the field already: that's all.
        if (!toVal && !chainNote.hidden) return;
        if (!toVal) throw new Error("Recipient is required");

        // A .dusk name sends to the address it resolves to, as shown under the field.
        let recipient = toVal;
        let duskName;
        if (isDuskName(toVal)) {
          reviewOff(true);
          const { lookup, latest } = startLookup(toVal);
          const result = await lookup.promise;
          // A lookup that ends after the user left Send, after a redraw replaced this form, or after the
          // field started a newer one, changes nothing.
          if (!to.isConnected || state.route !== "send" || !latest()) return;
          if (!applyNameResult(toVal, result)) return;
          recipient = nameRecipient(result);
          duskName = { name: result.name, nodeUrl: String(ov?.nodeUrl ?? ""), to: recipient };
        }

        const recType = ProfileGenerator.typeOf(recipient);
        if (recType !== "account" && recType !== "address") {
          throw new Error(contactsNamed(toVal).length ? "Tap the contact above to use it." : NOT_AN_ADDRESS_TEXT);
        }
        const blocked = blockedRecipient(recipient, ov?.chainId);
        if (blocked) throw new Error(blocked);
        const privacy = recType === "address" ? "shielded" : "public";

        // The amount says what's wrong under it; Review waits until it's right.
        const amtLuxBig = checkAmount({ required: true });
        if (amtLuxBig == null) {
          amount.focus();
          return;
        }
        if (!checkMemo()) {
          memo.focus();
          return;
        }
        const amtLux = amtLuxBig.toString();
        const memoVal = memo.value.trim();

        // Keep any previously edited gas settings if the user goes back and forth.
        const prevGas = draft?.gas;

        state.draft = {
          to: recipient,
          duskName,
          nameChoices: { ...nameChoices },
          privacy,
          amountLux: amtLux,
          amountDusk: amount.value.trim(),
          amountMasked: field.isMasked(),
          memo: memoVal,
          gas: prevGas,
          // A request link's network, for Review to say so when it isn't this
          // one; and what a link or a QR code filled in, as Back to the form has it.
          requestChainId: state.draft?.requestChainId,
          filledFrom: state.draft?.filledFrom,
          filledIn: state.draft?.filledIn,
          reviewedFor: reviewedFor(ov),
        };
        state.route = "confirm";
        await actions?.render?.();
      } catch (e) {
        setErr(e?.message ?? String(e));
      }
    },
  });

  // Runs once the Review button exists, since a .dusk name toggles it.
  updateToType();
  // A link already paid says so as it opens.
  sayAgain();
  // The node's gas price, as Review asks it: the fee and Max from it.
  networkGasPrice(actions)
    .then((price) => {
      if (!price || price === networkPrice) return;
      networkPrice = price;
      updateAmountHelpers();
    })
    .catch(() => {});

  return [
    subnav({
      title: "Send",
      onBack: () => {
        // Kept for Send's next opening: Back on a phone is pressed by the way.
        // Not what a link or a QR code filled in, edited since or not: it
        // isn't the next payment's.
        if (state.draft?.filledIn) forgetSendDraft();
        else keepSendDraft(state.draft, ov);
        state.route = "home";
        state.draft = null;
        actions?.render?.().catch(() => {});
      },
    }),
    h("div", { class: "row send-form" }, [
      fieldLabel(to, "To"),
      toRow,
      alikeNote,
      toTypePill,
      chainNote,
      filledNote,
      nameBox,
      selfNote,
      blockedNote,
      fieldLabel(amount, "Amount"),
      h("div", { class: "amount-entry send-amount" }, [field.el, field.error, available, feeNote]),
      fieldLabel(memo, "Memo"),
      memo,
      memoError,
      againNote,
      errBox,
      h("div", { class: "btnrow" }, [nextBtn]),
    ]),
  ].filter(Boolean);
}

/**
 * A draft with its request refused: no recipient, and the network the request
 * was for, to say so. What else it holds stays.
 * @param {object} draft
 * @returns {object}
 */
/**
 * When a payment went, from now: "at 14:32", "yesterday at 14:32" or "on Fri 24 Oct at 14:32".
 * @param {number} ms
 */

const refusedRequest = (draft, problem = "") => ({ ...draft, to: "", duskName: undefined, requestChainId: undefined, refusedChainId: draft?.requestChainId, refusedProblem: problem || undefined, filledFrom: undefined });

/**
 * "This request is for Mainnet. You are on Testnet." for a request link of
 * another network than the wallet's, else "".
 * @param {string} [reqChain] - the request's chain ID, "dusk:1"
 * @param {string} [nodeUrl] - the wallet's node
 * @returns {string}
 */
export function chainMismatchText(reqChain, nodeUrl) {
  const node = String(nodeUrl ?? "");
  // The chain the wallet signs for on this node, by which a request is the same network or not.
  const current = walletChainOf(node);
  if (!networkMismatch(reqChain, current)) return "";
  // The wallet by its node's name: a custom node is never called a network.
  return `This request is for ${chainLabel(reqChain)}. You are on ${networkTextOf(node) || chainLabel(current)}.`;
}

// Who pays and on which network, as a Review was asked for.
// What leaving a Review for a switch of wallet, profile or network says.
const notSentNotice = (actions) => actions?.showToast?.("The wallet, profile or network changed. Check the send again.", 3000);

const reviewedFor = (ov) => `${ov?.accounts?.[0] ?? ""} ${Number(ov?.selectedAccountIndex ?? 0) || 0} ${ov?.nodeUrl ?? ""}`;

/**
 * What a public send shows everyone, for Review: "Visible to everyone:
 * amount, memo, your name alice.dusk, and the recipient's account." Without a memo it leaves memo
 * out, and without a verified name it says "your account". `memoAs` names
 * the memo by what it is, as the recipient on another chain a bridge pays.
 * @param {{ memo?: string, name?: string|null, memoAs?: string }} parts
 * @returns {string}
 */
export function publicSendLine({ memo, name, memoAs = "memo" } = {}) {
  // Sent to the bridge, what shows of the recipient is the memo.
  const to = memoAs === "memo" ? "the recipient's account" : "";
  const items = ["amount", memo ? memoAs : "", name ? `your name ${name}` : "your account", to].filter(Boolean);
  const list = items.length > 2 ? `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}` : items.join(" and ");
  return `Visible to everyone: ${list}.`;
}

export function sendConfirmView(ov, { state, actions } = {}) {
  const d = state.draft;
  const duskName = draftDuskName(d);
  // A .dusk name resolved through another node is looked up again first, and
  // a switch of wallet, profile or network means who pays changed: back to
  // the form, rather than a Review that quietly says something else.
  if (!d || (duskName && duskName.nodeUrl !== String(ov?.nodeUrl ?? "")) || (d.reviewedFor && d.reviewedFor !== reviewedFor(ov))) {
    state.route = "send";
    const form = sendFormView(ov, { state, actions });
    if (d?.reviewedFor && d.reviewedFor !== reviewedFor(ov)) notSentNotice(actions);
    return form;
  }

  const recType = ProfileGenerator.typeOf(String(d.to || "").trim());
  // Public or shielded follows the recipient: Contacts can replace it after
  // the draft's privacy was set.
  const privacy = recType === "address" ? "shielded" : "public";
  const toAddr = String(d.to || "").trim();
  // To the bridge's account: it pays the memo's address on another chain
  // what's left once it takes its fee. An amount the fee takes whole, or a
  // memo that's no address there, stays here, as nothing would arrive.
  const service = privacy === "public" ? bridgeServiceTransfer({ nodeUrl: ov?.nodeUrl, to: toAddr, memo: d.memo, amount: d.amountLux }) : null;
  const serviceNotes = service ? bridgeServiceWarnings(service) : [];
  const tooLittle = serviceNotes.some((n) => n.kind === "fee");
  const noRecipient = Boolean(service && !service.recipientOk);
  // A request link for another network is never confirmed, however it got here.
  const otherNetwork = chainMismatchText(d.requestChainId, ov?.nodeUrl);
  const nothingArrives = tooLittle || noRecipient || Boolean(otherNetwork);

  // The profile it's sent from, by its verified .dusk name as the header
  // shows it; what a public send shows everyone names it too.
  const ownIdxRaw = Number(ov?.selectedAccountIndex ?? 0);
  const ownIdx = Number.isFinite(ownIdxRaw) && ownIdxRaw >= 0 ? Math.floor(ownIdxRaw) : 0;
  const ownAccount = String(ov?.accounts?.[ownIdx] ?? "");
  const ownAddress = String(ov?.addresses?.[ownIdx] ?? "");
  // To the bridge, the memo is the recipient on the other chain.
  const memoAs = service ? `the recipient on ${service.chain}` : "memo";
  const visibleLine = h("div", { class: "review-line review-visible", text: publicSendLine({ memo: d.memo, name: null, memoAs }) });
  const fromName = profileNameEl(ov, {
    index: ownIdx,
    onName: (name) => {
      visibleLine.textContent = publicSendLine({ memo: d.memo, name, memoAs });
    },
  });

  const own = toAddr === ownAccount || toAddr === ownAddress;
  // Who it goes to: a saved contact's label and the recipient's .dusk name,
  // both when there are both, over the full address.
  const contactName = () => {
    const key = toAddr.toLowerCase();
    const hit = (Array.isArray(state.addressBook?.items) ? state.addressBook.items : []).find(
      (e) => String(e?.address ?? "").trim().toLowerCase() === key
    );
    // Or another profile of this wallet's, which needs no saving: said as yours,
    // so a contact named like it never reads the same.
    const profile = own ? "" : ownProfileName(ov, toAddr);
    return profile ? `Your profile ${profile}` : contactNameText(hit?.name);
  };
  // A contact whose name looks like another's says so beside it, over the address.
  const alike = own || ownProfileName(ov, toAddr) ? "" : contactAlikeOf(ov, state.addressBook?.items)(toAddr).toLowerCase();
  let verifiedName = "";
  const toNames = h("div", { class: "review-to__names" });
  const toNameNote = nameCheckNoteEl(ov?.nodeUrl, { hidden: true });
  const showToNames = () => {
    const names = service ? [`The bridge's account for ${service.chain}`] : [contactName(), alike, duskName?.name || verifiedName].filter(Boolean);
    const unique = names.filter((n, i) => names.findIndex((m) => m.toLowerCase() === n.toLowerCase()) === i);
    toNames.textContent = unique.join(" · ");
    toNames.hidden = !unique.length;
    if (toNameNote) toNameNote.hidden = Boolean(service) || !(duskName?.name || verifiedName);
  };

  // The same payment, made already: moments ago, or with this memo whenever,
  // as a request paid once. Said, not stopped: it can be meant.
  const madeAgain = sentAlready(activityRows(ov, state), { lux: safeBigInt(d.amountLux, 0n), memo: String(d.memo ?? ""), to: toAddr });
  const repeat = Boolean(madeAgain && madeAgain.time !== null);
  const againNote = repeat
    ? h("div", { class: "callout warn review-again", role: "alert" }, [
        h(
          "div",
          { class: "callout-title" },
          // Another profile of this wallet's by its own name, as the form says it: "to Profile 1".
          sentAgainWords(ov, { lux: safeBigInt(d.amountLux, 0n), masked: Boolean(d.amountMasked), to: toAddr, memo: String(d.memo ?? ""), name: own ? "" : ownProfileName(ov, toAddr) || contactName() || duskName?.name || "", time: madeAgain.time })
        ),
      ])
    : null;

  // Save to Contacts, unless it's saved already or it's this wallet's own.
  const saveContactBtn = h("button", {
    class: "text-btn text-btn--inline review-save-contact",
    type: "button",
    text: "Save to Contacts",
    hidden: true,
    onclick: async () => {
      try {
        // Open Contacts in a flow that returns back to this review screen.
        state.addressBook = {
          ...(state.addressBook || {}),
          mode: "pick",
          fromRoute: "confirm",
          pickReturnRoute: "confirm",
          prefillAddress: toAddr,
          prefillName: duskName?.name || verifiedName || "",
          view: "edit",
          query: "",
          // keep any cached items so we can detect instantly on return
          loaded: !!state.addressBook?.loaded,
          loading: false,
          error: null,
          items: state.addressBook?.items ?? null,
          editId: null,
          editName: "",
          editAddress: toAddr,
        };
        state.route = "contacts";
        await actions?.render?.();
      } catch (e) {
        actions?.showToast?.(e?.message ?? String(e), 2500);
      }
    },
  });
  const refreshContactUI = () => {
    showToNames();
    saveContactBtn.hidden = own || Boolean(contactName());
  };
  refreshContactUI();
  if (!state.addressBook?.loaded && toAddr) {
    listAddressBook()
      .then((items) => {
        state.addressBook = { ...(state.addressBook || {}), loaded: true, loading: false, error: null, items };
        refreshContactUI();
      })
      .catch(() => {});
  }

  // The names this Review shows come from the lookups the form and the
  // header made, kept for a while: no new requests in the common case.
  if (duskNamesNetwork(ov?.nodeUrl)) {
    if (!duskName && recType === "account" && !own && !service) {
      lookupPrimaryName(toAddr, { nodeUrl: ov?.nodeUrl, stale: true })
        ?.then?.((name) => {
          if (!name) return;
          verifiedName = name;
          showToNames();
        })
        ?.catch?.(() => {});
    }
  }

  // Back returns to Send with the draft, so Review has no Cancel. A payment
  // made already says on its button that it sends it again, as the web wallet's does.
  const amountShown = balancesHidden(ov) && Boolean(d.amountMasked) ? HIDDEN_BALANCE : formatDuskExact(d.amountLux);
  const confirmBtn = h("button", { class: "btn-primary", text: repeat ? `Send ${amountShown} DUSK again` : "Confirm", disabled: nothingArrives });

  // What Max filled in stays hidden with the balances; an amount typed shows.
  const amountMasked = balancesHidden(ov) && Boolean(d.amountMasked);
  // The network's gas price by default; Custom fee for gas of your own.
  const { defaultGas, editor: gasEditor, error: confirmError, readGas } = reviewGas({
    kind: TX_KIND.TRANSFER,
    gasOpts: { privacy },
    amountLux: d.amountLux,
    hideTotal: amountMasked,
    ov,
    actions,
    gas: d?.gas,
  });

  // What pays covers it, with the fee as Custom fee changes it.
  const paying = privacy === "shielded" ? ov?.shieldedBalance?.spendable : ov?.balance?.value;
  const pay = payGuard({
    editor: gasEditor,
    availableLux: paying != null ? safeBigInt(paying, 0n) : null,
    sendsLux: safeBigInt(d.amountLux, 0n),
    shielded: privacy === "shielded",
    hidden: balancesHidden(ov),
    button: confirmBtn,
    ready: () => !nothingArrives,
  });

  // It ignores a click for a moment once Review is up (clickGuard.js).
  confirmBtn.addEventListener("click", guarded(async () => {
    if (nothingArrives || !pay.covered()) return;
    const gas = readGas();
    if (gas === false) return;
    confirmBtn.disabled = true;

    // Persist edits so Back/forward keeps them, on this review's own draft.
    d.gas = gas;

    const capGas = gas ?? defaultGas;
    await sendFromReview({
      state,
      actions,
      message: {
        type: "DUSK_UI_SEND_TX",
        params: {
          kind: TX_KIND.TRANSFER,
          privacy,
          to: d.to,
          amount: d.amountLux,
          memo: d.memo || undefined,
          gas: gas || undefined,
        },
        // Activity names the recipient as typed.
        toName: duskName?.name || undefined,
      },
      summary: {
        title: "Send",
        amountLux: d.amountLux,
        to: { name: duskName?.name || contactName() || verifiedName || "", address: d.to, short: shortAddress(d.to) },
        from: privacy === "shielded" ? "from your shielded balance" : "from your public balance",
        memo: d.memo || "",
        feeCapLux: (safeBigInt(capGas?.limit, 0n) * safeBigInt(capGas?.price, 0n)).toString(),
      },
      backRoute: "confirm",
      doneRoute: "home",
      onSent: () => {
        // Done with, unless a newer draft took its place meanwhile, and nothing
        // of it kept for the next Send.
        if (state.draft === d) state.draft = null;
        forgetSendDraft();
        // Paid: the link the page opened with goes from its address.
        forgetRequestLink();
      },
    });
    pay.draw();
  }));
  submitOnGasEnter(gasEditor, confirmBtn, { ready: () => !nothingArrives && pay.covered() });

  const kv = (label, value, className = "") =>
    h("div", { class: ["kv", className].filter(Boolean).join(" ") }, [
      h("span", { class: "kv-label", text: label }),
      h("span", { class: "kv-value" }, [].concat(value)),
    ]);

  return [
    subnav({
      title: "Review",
      onBack: () => {
        state.route = "send";
        actions?.render?.().catch(() => {});
      },
    }),
    h("div", { class: "row send-review" }, [
      h("div", { class: "review-head" }, [
        h("div", {
          class: "review-kind",
          text: service ? `Bridge to ${service.chain}` : privacy === "shielded" ? "Shielded transfer" : "Public transfer",
        }),
        h("div", { class: "balance-amount" }, [
          balance(amountMasked, formatDuskExact(d.amountLux)),
          h("span", { class: "balance-unit", text: " DUSK" }),
        ]),
        // To the bridge: what arrives on the other chain, once it takes its fee.
        service && !amountMasked ? h("div", { class: "review-line review-bridge-fee", text: bridgeServiceLine(service) }) : null,
        // What a public send shows everyone; a shielded one has no such line.
        privacy === "public" ? visibleLine : null,
      ].filter(Boolean)),
      h("div", { class: "group" }, [
        kv("To", h("span", { class: "review-to" }, [toNames, h("span", { class: "mono review-to__address", text: toAddr })]), "kv--wrap"),
        // With more than one wallet, the wallet first: "Wallet 2 · alice.dusk · Public".
        kv("From", h("span", {}, [withReviewWallet(fromName, actions?.review), h("span", { class: "kv-muted", text: privacy === "shielded" ? " · Shielded" : " · Public" })])),
        d.memo ? kv(service ? `Recipient on ${service.chain}` : "Memo", safeTextEl(d.memo), "kv--wrap") : null,
      ].filter(Boolean)),
      // As the form said it: it goes, for a fee.
      own ? h("div", { class: "send-self-note review-self-note", text: `This is your own ${toAddr === ownAccount ? "account" : "shielded address"}. Sending to yourself only costs a fee.` }) : null,
      againNote,
      toNameNote,
      ...serviceNotes
        .filter((n) => n.kind !== "fee")
        .map((n) => h("div", { class: "callout warn", role: "note" }, [h("div", { class: "callout-title", text: n.title }), h("div", { class: "muted", text: n.text })])),
      service && !service.recipientOk
        ? h("div", { class: "callout warn", role: "note" }, [
            h("div", { class: "callout-title", text: `The memo isn't an address on ${service.chain}` }),
            h("div", { class: "muted", text: "The bridge pays out to the address in the memo. Go back and check it." }),
          ])
        : null,
      saveContactBtn,
      gasEditor,
      reviewActions(
        confirmBtn,
        tooLittle
          ? h("div", { class: "field-error", role: "alert", text: `Send more than the ${formatDuskExact(service.feeLux)} DUSK bridge fee.` })
          : null,
        noRecipient ? h("div", { class: "field-error", role: "alert", text: `${noBridgeRecipientText(service.chain)}.` }) : null,
        otherNetwork ? h("div", { class: "field-error send-chain-note", role: "alert", text: otherNetwork }) : null,
        confirmError,
        pay.el
      ),
    ]),
  ];
}
