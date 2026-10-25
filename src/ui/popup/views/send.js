import {
  UI_DISPLAY_DECIMALS,
  formatLuxShort,
  formatLuxToDusk,
  parseDuskToLux,
  safeBigInt,
} from "../../../shared/amount.js";
import { TX_KIND } from "../../../shared/constants.js";
import { getDefaultGas } from "../../../shared/txDefaults.js";
import { ProfileGenerator } from "@dusk/w3sper";
import { h, setChildren } from "../../lib/dom.js";
import { iconSvg } from "../../components/ActionIcon.js";
import { balance, balancesHidden } from "../../components/Balance.js";
import { subnav } from "../../components/Subnav.js";
import "../../components/GasEditor.js";
import { createAmountSliderCard } from "../../components/AmountSliderCard.js";
import { fieldLabel, submitOnGasEnter, textInput } from "../../components/FormControls.js";
import { createGasQuickControls } from "../../components/GasQuickControls.js";
import { nameAddressChoice } from "../../components/NameAddressChoice.js";
import {
  hideRecipientBadge,
  recipientBadge,
  recipientTypeBadgeOptions,
  setRecipientBadge,
} from "../../components/RecipientBadge.js";

import { listAddressBook } from "../../../shared/addressBook.js";
import {
  duskNameErrorText,
  duskNameRecipient,
  duskNamesNetwork,
  isDuskName,
  lookupDuskName,
} from "../../../shared/duskNames.js";
import {
  isShieldedPaused,
  shieldedPausedNotice,
  shieldedPausedText,
} from "../../components/ShieldedPausedNotice.js";

import { openQrScanModal, parseDuskQrPayload } from "../../components/QrScanModal.js";
import { chainIdFromNodeUrl } from "../../../shared/chain.js";
import { chainLabel, normalizeChainId } from "../../../shared/duskUri.js";

// Review's .dusk name over the full address it resolved to: the name leads,
// and the address follows smaller and muted.
const namedAddressBox = (name, addressEl) =>
  h("div", { class: "box named-address" }, [h("div", { class: "dusk-name", text: name, title: name }), addressEl]);

/**
 * The line Review shows under the transfer's Public/Shielded pill: what the
 * chain shows.
 * @param {"public"|"shielded"} privacy
 * @returns {string}
 */
export function transferLine(privacy) {
  return privacy === "shielded" ? "Private" : "Visible on chain";
}

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

export function sendFormView(ov, { state, actions } = {}) {
  const draft = state.draft || {};

  const to = textInput({
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

  // Assigned later (we want to pass it into components as a live closure).
  let syncDraft = () => {};

  // ------------------------------------------------------------
  // Amount helpers (MAX + slider)
  // ------------------------------------------------------------
  // The send screen doesn't expose gas settings yet. We base MAX calculations
  // on the wallet's safe defaults for transfers.
  function defaultGasForRecipientType(type) {
    return getDefaultGas(TX_KIND.TRANSFER, {
      privacy: type === "address" ? "shielded" : "public",
    });
  }

  function feeLuxForRecipientType(type) {
    const defaultGas = defaultGasForRecipientType(type);
    return defaultGas && defaultGas.limit != null && defaultGas.price != null
      ? safeBigInt(defaultGas.limit, 0n) * safeBigInt(defaultGas.price, 0n)
      : 0n;
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

  // While shielded transactions are paused, a shielded address gets this
  // message and the form stops before Review. A .dusk name's shielded card
  // says it itself.
  const shieldedPaused = isShieldedPaused(ov);
  const pausedNote = shieldedPausedNotice(ov, { balanceLine: false });
  pausedNote.hidden = true;

  const amountMetaMain = h("div", { class: "amount-meta__main", text: "" });
  const amountMetaSub = h("div", { class: "amount-meta__sub", text: "" });
  const amountMeta = h(
    "div",
    { class: "amount-meta", style: "display:none" },
    [h("div", { class: "amount-meta__stack" }, [amountMetaMain, amountMetaSub])]
  );

  const amountCtl = createAmountSliderCard({
    initialAmountDusk: typeof draft.amountDusk === "string" ? draft.amountDusk : "",
    actions,
    onAmountInput: () => syncDraft(),
    onAmountChange: () => syncDraft(),
    onEnter: () => nextBtn.click(),
    children: [amountMeta],
    maxUnavailableToast: "Enter a valid recipient to calculate max",
    hidden,
  });

  const amount = amountCtl.amountInput;
  const amountCard = amountCtl.el;

  const clamp0 = (v) => (v > 0n ? v : 0n);

  function getMaxAmountLux() {
    if (detectedRecipientType === "address") {
      if (shSpendLux == null) return null;
      return clamp0(shSpendLux - feeLuxForRecipientType("address"));
    }
    if (detectedRecipientType === "account") {
      // Public transfers are limited by the Moonlight account balance.
      if (ov?.balance?.value == null) return null;
      return clamp0(pubBalLux - feeLuxForRecipientType("account"));
    }
    return null;
  }

  function updateAmountHelpers() {
    const maxLux = getMaxAmountLux();

    // Enable/disable the slider and MAX button.
    amountCtl.setMaxLux(maxLux);

    if (maxLux == null) {
      amountMeta.style.display = "none";
      return;
    }

    amountMeta.style.display = "flex";

    if (detectedRecipientType === "address") {
      const feeLux = feeLuxForRecipientType("address");
      amountMetaMain.replaceChildren(
        "Spendable (shielded): ",
        balance(hidden, formatLuxShort(maxLux, UI_DISPLAY_DECIMALS)),
        " DUSK"
      );

      const parts = [];
      if (shSpendLux != null && shValueLux > shSpendLux) {
        parts.push(["Total shielded: ", balance(hidden, formatLuxShort(shValueLux, UI_DISPLAY_DECIMALS)), " DUSK"]);
      }
      if (feeLux > 0n) {
        parts.push([`Fee cap: ${formatLuxShort(feeLux, UI_DISPLAY_DECIMALS)} DUSK`]);
      }
      amountMetaSub.replaceChildren(...parts.flatMap((part, i) => (i ? [" · ", ...part] : part)));
    } else {
      const feeLux = feeLuxForRecipientType("account");
      amountMetaMain.replaceChildren(
        "Available (public): ",
        balance(hidden, formatLuxShort(maxLux, UI_DISPLAY_DECIMALS)),
        " DUSK"
      );
      amountMetaSub.textContent = feeLux > 0n ? `Fee cap: ${formatLuxShort(feeLux, UI_DISPLAY_DECIMALS)} DUSK` : "";
    }

    // Keep slider aligned with whatever is in the input.
    // (amountCtl.setMaxLux already syncs when maxLux is usable)
  }

  const currentChain = normalizeChainId(chainIdFromNodeUrl(ov?.nodeUrl ?? ""));

  const warnChainMismatch = (reqChain) => {
    const want = normalizeChainId(reqChain);
    if (!want || !currentChain || want === currentChain) return;
    const wantLabel = chainLabel(want) || `Chain ${want}`;
    const curLabel = chainLabel(currentChain) || `Chain ${currentChain}`;
    actions?.showToast?.(`Request is for ${wantLabel}. You are on ${curLabel}.`, 4000);
  };

  const applyRequest = (req, { source = "request" } = {}) => {
    if (!req?.to) return false;

    const isDuskReq = req.kind === "public" || req.kind === "shielded";

    // Update DOM values
    to.value = req.to;

    if (isDuskReq) {
      // A full dusk: request link should define the form values.
      amount.value = req.amountDusk || "";
      memo.value = req.memo || "";
    } else {
      // A raw recipient QR should not clobber what the user already typed.
      if (req.amountDusk) amount.value = req.amountDusk;
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

    state.draft = nextDraft;

    warnChainMismatch(req.chainId);
    updateToType();

    // Show a small hint toast so user understands it worked.
    // (Toast triggers a render, hence why we persist draft first.)
    try {
      actions?.showToast?.(source === "qr" ? "Filled from QR" : "Request decoded", 1800);
    } catch {
      // ignore
    }

    return true;
  };

  const maybeDecodeRequest = (raw, { source = "request" } = {}) => {
    const s = String(raw || "").trim();
    if (!s) return false;
    const req = parseDuskQrPayload(s);
    if (!req) return false;
    return applyRequest(req, { source });
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

  const hideContactBadge = () => {
    hideRecipientBadge(toChip);
    toWrap.classList.remove("has-chip");
    toWrap.style.removeProperty("--chip-w");
  };

  const updateContactMatch = (addr, typ) => {
    try {
      if (!addr || (typ !== "account" && typ !== "address")) {
        hideContactBadge();
        return;
      }

      if (!contactsIndex) rebuildContactsIndex(state.addressBook?.items);
      const hit = contactsIndex?.get(String(addr).toLowerCase());
      const name = String(hit?.name ?? "").trim();
      if (!name) {
        hideContactBadge();
        return;
      }

      setRecipientBadge(toChip, {
        kind: "contact",
        label: name,
        seed: addr,
        title: `Saved contact: ${name}`,
        className: "to-chip",
      });
      toWrap.classList.add("has-chip");

      // Measure and shift input text so it doesn't overlap the badge.
      requestAnimationFrame(() => {
        try {
          const w = Math.ceil(toChip.getBoundingClientRect().width);
          if (w > 0) toWrap.style.setProperty("--chip-w", `${w}px`);
        } catch {
          // ignore
        }
      });
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

  // Sending to your own account or address only costs a fee: say so, and let it go ahead.
  const selfNote = h("div", { class: "send-self-note", hidden: true });
  const showSelfNote = (recipient) => {
    const own =
      recipient && recipient === ownAccount
        ? "account"
        : recipient && recipient === ownAddress
          ? "address"
          : "";
    selfNote.textContent = own ? `This is your own ${own}. Sending to yourself only costs a fee.` : "";
    selfNote.hidden = !own;
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

  // Points the form at the address `result` sends to: the balance line and
  // Review follow it. True when Review can go ahead.
  const showNameAddress = (result) => {
    const recipient = nameRecipient(result);
    const t = ProfileGenerator.typeOf(recipient);
    showSelfNote(recipient);
    detectedRecipientType = t;
    const sendable = t === "account" || (shieldedCovers && !shieldedPaused);
    nextBtn.disabled = !sendable;
    updateAmountHelpers();
    return sendable;
  };

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
      showNameBox([
        h("div", { class: "err", text: duskNameErrorText(failed) }),
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
      nextBtn.disabled = true;
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
      shieldedDisabled: !shieldedCovers || shieldedPaused,
      // While paused, the card says so in place of the offer to shield.
      shieldedNote: shieldedPaused ? shieldedPausedText(ov) : undefined,
      onChoose: (shielded) => {
        nameChoices[result.name] = shielded;
        syncDraft();
        choice.set(shielded);
        showNameAddress(result);
      },
      onShield: openShield,
    });
    showNameBox([choice.el]);
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

  const showDuskName = (v) => {
    const { lookup, latest } = startLookup(v);
    if (lookup.result) {
      applyNameResult(v, lookup.result);
      return;
    }
    hideRecipientBadge(toTypePill);
    detectedRecipientType = null;
    nextBtn.disabled = true;
    updateAmountHelpers();
    showNameBox([h("div", { class: "muted", text: `Looking up ${v}…` })]);
    lookup.promise.then((result) => {
      if (latest()) applyNameResult(v, result);
    });
  };

  const updateToType = () => {
    const v = String(to.value || "").trim();
    showSelfNote("");
    pausedNote.hidden = true;
    shownName = null;
    if (!isDuskName(v)) {
      showNameBox([]);
      nextBtn.disabled = false;
    }
    if (!v) {
      hideRecipientBadge(toTypePill);
      detectedRecipientType = null;
      updateContactMatch("", null);
      updateAmountHelpers();
      return;
    }

    // Give quick feedback when the user pastes a dusk: request link.
    if (/^dusk:/i.test(v)) {
      setRecipientBadge(toTypePill, {
        kind: "request",
        icon: "request",
        label: "Request",
        title: "Dusk request link",
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

    if (t === "account" || t === "address") {
      setRecipientBadge(toTypePill, {
        ...recipientTypeBadgeOptions(t),
        className: "recipient-type-badge",
      });
      detectedRecipientType = t;
      updateContactMatch(v, t);
      showSelfNote(v);
      pausedNote.hidden = !(shieldedPaused && t === "address");
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

  syncDraft = () => {
    // Keep draft in sync so any toast-triggered re-render doesn't wipe inputs.
    state.draft = {
      ...(state.draft || {}),
      to: String(to.value || ""),
      // The field is the recipient again; drop a name kept from review.
      duskName: undefined,
      nameChoices: { ...nameChoices },
      amountDusk: String(amount.value || ""),
      memo: String(memo.value || ""),
      // preserve any gas edits the user may have made on the confirm screen
      gas: state.draft?.gas,
    };
  };

  to.addEventListener("input", () => {
    updateToType();
    syncDraft();
  });
  // Amount input is managed by the shared amount slider component.
  memo.addEventListener("input", syncDraft);
  to.addEventListener("paste", (e) => {
    try {
      const txt = e?.clipboardData?.getData?.("text") ?? "";
      if (txt && /^dusk:/i.test(txt)) {
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
    if (/^dusk:/i.test(v)) {
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
        if (!ok) actions?.showToast?.("Unrecognized QR code", 2500);
      } catch (e) {
        actions?.showToast?.(e?.message ?? String(e), 3000);
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

  const errBox = h("div", { class: "err", style: "display:none" });
  const setErr = (txt) => {
    if (!txt) {
      errBox.style.display = "none";
      errBox.textContent = "";
      return;
    }
    errBox.style.display = "block";
    errBox.textContent = txt;
  };

  const nextBtn = h("button", {
    class: "btn-primary",
    text: "Review",
    onclick: async () => {
      try {
        setErr("");
        // Allow a dusk: request link to be pasted directly into the recipient field.
        const rawTo = to.value.trim();
        if (/^dusk:/i.test(rawTo)) {
          maybeDecodeRequest(rawTo, { source: "request" });
        }

        const toVal = to.value.trim();
        if (!toVal) throw new Error("Recipient is required");

        // A .dusk name sends to the address it resolves to, as shown under the field.
        let recipient = toVal;
        let duskName;
        if (isDuskName(toVal)) {
          nextBtn.disabled = true;
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
          throw new Error("Invalid recipient: expected a Dusk account or shielded address");
        }
        const privacy = recType === "address" ? "shielded" : "public";
        if (privacy === "shielded" && shieldedPaused) {
          pausedNote.hidden = false;
          return;
        }

        const amtLux = parseDuskToLux(amount.value);
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
          memo: memoVal,
          gas: prevGas,
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

  return [
    subnav({
      title: "Send",
      onBack: () => {
        state.route = "home";
        state.draft = null;
        actions?.render?.().catch(() => {});
      },
    }),
    h("div", { class: "row" }, [
      fieldLabel(to, "To"),
      toRow,
      toTypePill,
      pausedNote,
      nameBox,
      selfNote,
      fieldLabel(amount, "Amount"),
      amountCard,
      fieldLabel(memo, "Memo"),
      memo,
      errBox,
      h("div", { class: "btnrow" }, [nextBtn]),
    ]),
  ].filter(Boolean);
}

export function sendConfirmView(ov, { state, actions } = {}) {
  const d = state.draft;
  const duskName = draftDuskName(d);
  // A .dusk name resolved through another node is looked up again first.
  if (!d || (duskName && duskName.nodeUrl !== String(ov?.nodeUrl ?? ""))) {
    state.route = "send";
    return sendFormView(ov, { state, actions });
  }

  const recType = ProfileGenerator.typeOf(String(d.to || "").trim());
  // Public or shielded follows the recipient, as the pill does: Contacts can
  // replace it after the draft's privacy was set.
  const privacy = recType === "address" ? "shielded" : "public";
  // A shielded draft goes back to the form, which says why it can't be sent.
  if (privacy === "shielded" && isShieldedPaused(ov)) {
    state.route = "send";
    return sendFormView(ov, { state, actions });
  }
  const txTypeLabel = recType === "address" ? "Shielded transfer" : "Public transfer";
  const txTypeBadge = recipientBadge({
    ...(recipientTypeBadgeOptions(recType) || {
      kind: "unknown",
      icon: "?",
      label: "Unknown",
      title: "Unknown transfer",
    }),
    className: "recipient-type-badge",
    title: txTypeLabel,
  });

  // ------------------------------------------------------------
  // Contacts helper
  // ------------------------------------------------------------
  const toAddr = String(d.to || "").trim();

  const contactPill = recipientBadge({
    kind: "contact",
    className: "confirm-contact-badge",
    hidden: true,
  });
  const saveContactBtn = h("button", {
    class: "btn-outline",
    type: "button",
    text: "Save to Contacts",
    onclick: async () => {
      try {
        // Open Contacts in a flow that returns back to this review screen.
        state.addressBook = {
          ...(state.addressBook || {}),
          mode: "pick",
          fromRoute: "confirm",
          pickReturnRoute: "confirm",
          prefillAddress: toAddr,
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

  const contactLine = h(
    "div",
    {
      style:
        "display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-top:10px;",
    },
    [contactPill, saveContactBtn]
  );

  const findContactName = (items) => {
    const arr = Array.isArray(items) ? items : [];
    const key = toAddr.toLowerCase();
    for (const e of arr) {
      const addr = String(e?.address ?? "").trim().toLowerCase();
      if (addr && addr === key) return String(e?.name ?? "").trim();
    }
    return "";
  };

  const refreshContactUI = (items) => {
    const name = findContactName(items);
    if (name) {
      setRecipientBadge(contactPill, {
        kind: "contact",
        label: name,
        seed: toAddr,
        title: `Saved contact: ${name}`,
        className: "confirm-contact-badge",
      });
      saveContactBtn.style.display = "none";
    } else {
      hideRecipientBadge(contactPill);
      saveContactBtn.style.display = "inline-flex";
    }
  };

  // Initial best-effort check from cached state.
  refreshContactUI(state.addressBook?.items);

  // If not loaded yet, load once and patch the UI without forcing a re-render.
  try {
    if (!state.addressBook?.loaded && toAddr) {
      listAddressBook()
        .then((items) => {
          try {
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
          refreshContactUI(items);
        })
        .catch(() => {
          // ignore
        });
    }
  } catch {
    // ignore
  }

  // Back returns to Send with the draft, so Review has no Cancel.
  const confirmBtn = h("button", { class: "btn-primary", text: "Confirm" });

  // Gas editor (collapsed by default)
  const defaultGas = getDefaultGas(TX_KIND.TRANSFER, { privacy });
  const defaultLimit =
    defaultGas?.limit !== undefined && defaultGas?.limit !== null
      ? String(defaultGas.limit)
      : "";
  const fallbackPrice =
    defaultGas?.price !== undefined && defaultGas?.price !== null
      ? String(defaultGas.price)
      : "";

  const gasEditor = document.createElement("dusk-gas-editor");
  gasEditor.amountLux = d.amountLux;
  gasEditor.maxDecimals = UI_DISPLAY_DECIMALS;

  // Prefer persisted draft gas. Otherwise we'll fetch the node's current gas
  // price stats and set a recommended default (median).
  gasEditor.setGas(d?.gas ?? null);

  // The gas price line and the presets open with the fee's Edit.
  createGasQuickControls({
    actions,
    defaultLimit,
    fallbackPrice,
    gas: d?.gas,
    gasEditor,
  });

  confirmBtn.addEventListener("click", async () => {
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Sending…";

    try {
      const gas = gasEditor.readFinalGas();

      // Persist edits so Back/forward keeps them.
      if (state.draft) state.draft.gas = gas;

      const res = await actions?.send?.({
        type: "DUSK_UI_SEND_TX",
        params: {
          kind: TX_KIND.TRANSFER,
          privacy,
          to: d.to,
          amount: d.amountLux,
          memo: d.memo || undefined,
          gas: gas || undefined,
        },
      });

      if (res?.error) throw new Error(res.error.message ?? "Transfer failed");
      if (!res?.ok) throw new Error("Transfer failed");

      const hash = res.result?.hash ?? "";
      try {
        const shortHash = hash && hash.length > 18 ? `${hash.slice(0, 10)}…${hash.slice(-8)}` : hash;
        actions?.showToast?.(shortHash ? `Transaction submitted: ${shortHash}` : "Transaction submitted", 2500);
      } catch {
        // ignore
      }
      state.route = "home";
      state.draft = null;
      state.needsRefresh = true;
      await actions?.render?.({ forceRefresh: true });
    } catch (e) {
      try {
        actions?.showToast?.(e?.message ?? String(e), 3000);
      } catch {
        // ignore
      }
      confirmBtn.disabled = false;
      confirmBtn.textContent = "Confirm";
    }
  });
  submitOnGasEnter(gasEditor, confirmBtn);

  return [
    subnav({
      title: "Review",
      onBack: () => {
        state.route = "send";
        actions?.render?.().catch(() => {});
      },
    }),
    h("div", { class: "row" }, [
      txTypeBadge,
      // What the chain shows.
      h("div", {
        class: "muted transfer-line",
        text: transferLine(privacy),
      }),
      h("div", { class: "home-balance" }, [
        h("div", {
          class: "balance-amount",
          text: d.amountDusk || formatLuxToDusk(d.amountLux),
        }),
        h("div", { class: "balance-sub", text: "DUSK" }),
      ]),
      h("div", { class: "muted", text: "To" }),
      duskName
        ? namedAddressBox(duskName.name, h("code", { text: d.to }))
        : h("div", { class: "box" }, [h("code", { text: d.to })]),
      contactLine,
      d.memo
        ? h("div", { class: "row" }, [
            h("div", { class: "muted", text: "Memo" }),
            h("div", { class: "box" }, [h("code", { text: d.memo })]),
          ])
        : h("div"),
      gasEditor,
      h("div", { class: "btnrow" }, [confirmBtn]),
    ]),
  ].filter(Boolean);
}
