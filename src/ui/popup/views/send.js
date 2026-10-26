import {
  UI_DISPLAY_DECIMALS,
  formatDusk,
  formatDuskExact,
  formatFee,
  formatLuxToDusk,
  parseDuskToLux,
  safeBigInt,
} from "../../../shared/amount.js";
import { TX_KIND } from "../../../shared/constants.js";
import { getDefaultGas, getMinimumGas } from "../../../shared/txDefaults.js";
import { ProfileGenerator } from "@dusk/w3sper";
import { h, setChildren } from "../../lib/dom.js";
import { shortAddress } from "../../lib/strings.js";
import { iconSvg } from "../../components/ActionIcon.js";
import { balance, balancesHidden } from "../../components/Balance.js";
import { subnav } from "../../components/Subnav.js";
import "../../components/GasEditor.js";
import { amountField } from "../../components/AmountField.js";
import { profileNameEl } from "../../components/ProfileName.js";
import { fieldLabel, submitOnGasEnter, textInput } from "../../components/FormControls.js";
import { gasFeeLux, startingGas, useNetworkGas } from "../../components/NetworkGas.js";
import { nameAddressChoice } from "../../components/NameAddressChoice.js";
import {
  hideRecipientBadge,
  recipientBadge,
  recipientTypeBadgeOptions,
  setRecipientBadge,
} from "../../components/RecipientBadge.js";

import { listAddressBook } from "../../../shared/addressBook.js";
import { closeDuskName } from "../../lib/nameSuggest.js";
import {
  duskNameErrorText,
  duskNameRecipient,
  duskNamesNetwork,
  isDuskName,
  lookupDuskName,
  lookupPrimaryName,
} from "../../../shared/duskNames.js";

import { openQrScanModal, parseDuskQrPayload } from "../../components/QrScanModal.js";
import { sendFromReview } from "./sent.js";
import { chainIdFromNodeUrl } from "../../../shared/chain.js";
import { chainLabel, normalizeChainId } from "../../../shared/duskUri.js";

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
  // Max and the balance check reserve the fee Review starts from: the
  // draft's own gas, custom gas from Settings, or the transfer's default.
  function feeLuxForRecipientType(type) {
    const privacy = type === "address" ? "shielded" : "public";
    return gasFeeLux(
      startingGas({
        defaultGas: getDefaultGas(TX_KIND.TRANSFER, { privacy }),
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
      // The real amount, with balances hidden too: it's what gets sent.
      field.setValue(formatLuxToDusk(maxLux));
      checkAmount();
      syncDraft();
      amount.focus();
    },
  });
  const available = h("div", { class: "amount-avail", hidden: true }, [availText, maxBtn]);
  const feeNote = h("div", { class: "amount-fee-note", hidden: true });

  // The amount as typed, checked as it is typed: an error under the field,
  // and the amount in Lux when it can be sent.
  function checkAmount({ required = false } = {}) {
    const raw = String(amount.value ?? "").trim();
    if (!raw) {
      field.setError(required ? "Enter an amount." : "");
      return null;
    }
    let lux;
    try {
      lux = safeBigInt(parseDuskToLux(raw), 0n);
    } catch {
      field.setError("Enter an amount such as 1 or 0.5.");
      return null;
    }
    if (lux <= 0n) {
      field.setError("Enter an amount greater than 0.");
      return null;
    }
    const maxLux = getMaxAmountLux();
    if (maxLux != null && lux > maxLux) {
      field.setError("That's more than you have, with the network fee.");
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

  const currentChain = normalizeChainId(chainIdFromNodeUrl(ov?.nodeUrl ?? ""));

  // A request for another network says so under the recipient, and stays
  // until the recipient changes: Review doesn't clear it.
  const chainNote = h("div", { class: "field-error", role: "alert", hidden: true });
  const warnChainMismatch = (reqChain) => {
    const want = normalizeChainId(reqChain);
    const mismatch = Boolean(want && currentChain && want !== currentChain);
    // Labelled from the full chain ids ("dusk:1"): the bare references don't name a network.
    const wantLabel = chainLabel(reqChain) || `Chain ${want}`;
    const curLabel = chainLabel(chainIdFromNodeUrl(ov?.nodeUrl ?? "")) || `Chain ${currentChain}`;
    chainNote.textContent = mismatch ? `This request is for ${wantLabel}. You are on ${curLabel}.` : "";
    chainNote.hidden = !mismatch;
  };

  const applyRequest = (req, { source = "request" } = {}) => {
    if (!req?.to) return false;

    const isDuskReq = req.kind === "public" || req.kind === "shielded";

    // Update DOM values
    to.value = req.to;

    if (isDuskReq) {
      // A full dusk: request link should define the form values.
      field.setValue(req.amountDusk || "");
      memo.value = req.memo || "";
    } else {
      // A raw recipient QR should not clobber what the user already typed.
      if (req.amountDusk) field.setValue(req.amountDusk);
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
    showSelfNote(recipient);
    detectedRecipientType = t;
    const sendable = t === "account" || shieldedCovers;
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
      // A name that isn't registered may be a typo of one the wallet knows.
      const suggestion = failed.reason === "not_registered" ? closeDuskName(v, knownDuskNames()) : null;
      showNameBox([
        h("div", { class: "err", text: duskNameErrorText(failed) }),
        suggestion
          ? h("button", {
              class: "text-btn text-btn--inline name-suggestion",
              type: "button",
              text: `Did you mean ${suggestion}?`,
              onclick: () => {
                to.value = suggestion;
                onRecipientInput();
                to.focus?.();
              },
            })
          : null,
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
      shieldedDisabled: !shieldedCovers,
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

  // A pasted public account with a verified .dusk name shows it, as the
  // explorer does; only the latest lookup's answer counts.
  let primaryCount = 0;
  const showPrimaryName = (account) => {
    const n = ++primaryCount;
    if (!duskNamesNetwork(ov?.nodeUrl) || account === ownAccount) return;
    lookupPrimaryName(account, { nodeUrl: ov?.nodeUrl, stale: true })
      ?.then?.((name) => {
        if (!name || n !== primaryCount || String(to.value || "").trim() !== account) return;
        showNameBox([
          h("div", { class: "name-verified" }, [
            h("span", { class: "btn-ico", "aria-hidden": "true", html: iconSvg("check") }),
            h("span", { class: "name-verified__name", text: name }),
            h("span", { class: "name-verified__note", text: " · its verified .dusk name" }),
          ]),
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
    shownName = null;
    primaryCount += 1;
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
      if (t === "account") showPrimaryName(v);
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

  function onRecipientInput() {
    chainNote.textContent = "";
    chainNote.hidden = true;
    updateToType();
    syncDraft();
  }
  to.addEventListener("input", onRecipientInput);
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
        if (!ok) setErr("This QR code isn't a Dusk account, address or request.");
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

        // The amount says what's wrong under it; Review waits until it's right.
        const amtLuxBig = checkAmount({ required: true });
        if (amtLuxBig == null) {
          amount.focus();
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
    h("div", { class: "row send-form" }, [
      fieldLabel(to, "To"),
      toRow,
      toTypePill,
      chainNote,
      nameBox,
      selfNote,
      fieldLabel(amount, "Amount"),
      h("div", { class: "amount-entry send-amount" }, [field.el, field.error, available, feeNote]),
      fieldLabel(memo, "Memo"),
      memo,
      errBox,
      h("div", { class: "btnrow" }, [nextBtn]),
    ]),
  ].filter(Boolean);
}

/**
 * What a public send shows everyone, for Review: "Visible to everyone:
 * amount, memo, and your name alice.dusk." Without a memo it leaves memo
 * out, and without a verified name it says "your account".
 * @param {{ memo?: string, name?: string|null }} parts
 * @returns {string}
 */
export function publicSendLine({ memo, name } = {}) {
  const items = ["amount", memo ? "memo" : "", name ? `your name ${name}` : "your account"].filter(Boolean);
  const list = items.length > 2 ? `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}` : items.join(" and ");
  return `Visible to everyone: ${list}.`;
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
  // Public or shielded follows the recipient: Contacts can replace it after
  // the draft's privacy was set.
  const privacy = recType === "address" ? "shielded" : "public";
  const toAddr = String(d.to || "").trim();

  // The profile it's sent from, by its verified .dusk name as the header
  // shows it; what a public send shows everyone names it too.
  const ownIdxRaw = Number(ov?.selectedAccountIndex ?? 0);
  const ownIdx = Number.isFinite(ownIdxRaw) && ownIdxRaw >= 0 ? Math.floor(ownIdxRaw) : 0;
  const ownAccount = String(ov?.accounts?.[ownIdx] ?? "");
  const ownAddress = String(ov?.addresses?.[ownIdx] ?? "");
  const visibleLine = h("div", { class: "review-line review-visible", text: publicSendLine({ memo: d.memo, name: null }) });
  const fromName = profileNameEl(ov, {
    index: ownIdx,
    onName: (name) => {
      visibleLine.textContent = publicSendLine({ memo: d.memo, name });
    },
  });

  // Who it goes to: a saved contact's label and the recipient's .dusk name,
  // both when there are both, over the full address.
  const contactName = () => {
    const key = toAddr.toLowerCase();
    const hit = (Array.isArray(state.addressBook?.items) ? state.addressBook.items : []).find(
      (e) => String(e?.address ?? "").trim().toLowerCase() === key
    );
    return String(hit?.name ?? "").trim();
  };
  let verifiedName = "";
  const toNames = h("div", { class: "review-to__names" });
  const showToNames = () => {
    const names = [contactName(), duskName?.name || verifiedName].filter(Boolean);
    const unique = names.filter((n, i) => names.findIndex((m) => m.toLowerCase() === n.toLowerCase()) === i);
    toNames.textContent = unique.join(" · ");
    toNames.hidden = !unique.length;
  };

  // Save to Contacts, unless it's saved already or it's this wallet's own.
  const own = toAddr === ownAccount || toAddr === ownAddress;
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
    if (!duskName && recType === "account" && !own) {
      lookupPrimaryName(toAddr, { nodeUrl: ov?.nodeUrl, stale: true })
        ?.then?.((name) => {
          if (!name) return;
          verifiedName = name;
          showToNames();
        })
        ?.catch?.(() => {});
    }
  }

  // Back returns to Send with the draft, so Review has no Cancel.
  const confirmBtn = h("button", { class: "btn-primary", text: "Confirm" });

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

  // The network's gas price by default; Custom fee for gas of your own.
  useNetworkGas({
    customGas: ov?.customGas,
    actions,
    defaultLimit,
    fallbackPrice,
    gas: d?.gas,
    gasEditor,
    minLimit: getMinimumGas(TX_KIND.TRANSFER, { privacy })?.limit,
  });

  // Gas that won't do says so above Confirm; nothing is sent.
  const confirmError = h("div", { class: "field-error", role: "alert", hidden: true });

  confirmBtn.addEventListener("click", async () => {
    let gas;
    try {
      gas = gasEditor.readFinalGas();
    } catch (e) {
      confirmError.textContent = e?.message ?? String(e);
      confirmError.hidden = false;
      return;
    }
    confirmError.hidden = true;
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
        // Done with, unless a newer draft took its place meanwhile.
        if (state.draft === d) state.draft = null;
      },
    });
    confirmBtn.disabled = false;
  });
  submitOnGasEnter(gasEditor, confirmBtn);

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
        h("div", { class: "review-kind", text: privacy === "shielded" ? "Shielded transfer" : "Public transfer" }),
        h("div", { class: "balance-amount" }, [
          formatDuskExact(d.amountLux),
          h("span", { class: "balance-unit", text: " DUSK" }),
        ]),
        // What a public send shows everyone; a shielded one has no such line.
        privacy === "public" ? visibleLine : null,
      ].filter(Boolean)),
      h("div", { class: "group" }, [
        kv("To", h("span", { class: "review-to" }, [toNames, h("span", { class: "mono review-to__address", text: toAddr })]), "kv--wrap"),
        kv("From", h("span", {}, [fromName, h("span", { class: "kv-muted", text: privacy === "shielded" ? " · Shielded" : " · Public" })])),
        d.memo ? kv("Memo", d.memo, "kv--wrap") : null,
      ].filter(Boolean)),
      saveContactBtn,
      gasEditor,
      confirmError,
      h("div", { class: "btnrow" }, [confirmBtn]),
    ]),
  ];
}
