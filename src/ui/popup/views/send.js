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
import { h } from "../../lib/dom.js";
import { subnav } from "../../components/Subnav.js";
import "../../components/GasEditor.js";
import { createAmountSliderCard } from "../../components/AmountSliderCard.js";
import { identiconEl } from "../../components/Identicon.js";

import { listAddressBook } from "../../../shared/addressBook.js";

import { openQrScanModal, parseDuskQrPayload } from "../../components/QrScanModal.js";
import { chainIdFromNodeUrl } from "../../../shared/chain.js";
import { chainLabel, normalizeChainId } from "../../../shared/duskUri.js";

export function sendFormView(ov, { state, actions } = {}) {
  const draft = state.draft || {};

  const to = h("input", {
    placeholder: "Recipient (account or shielded address)",
    value: typeof draft.to === "string" ? draft.to : "",
  });

  // Optional inline contact chip (shown when the recipient matches a saved contact).
  const toChipIco = h("span", { class: "to-chip__ico" });
  const toChipName = h("span", { class: "to-chip__name", text: "" });
  const toChip = h(
    "div",
    { class: "to-chip", style: "display:none" },
    [toChipIco, toChipName]
  );
  const toWrap = h("div", { class: "to-input-wrap" }, [toChip, to]);
  const memo = h("input", {
    placeholder: "Memo (optional)",
    value: typeof draft.memo === "string" ? draft.memo : "",
  });

  // Assigned later (we want to pass it into components as a live closure).
  let syncDraft = () => {};

  // ------------------------------------------------------------
  // Amount helpers (MAX + slider)
  // ------------------------------------------------------------
  // The send screen doesn't expose gas settings yet. We base MAX calculations
  // on the wallet's safe defaults for transfers.
  const defaultGas = getDefaultGas(TX_KIND.TRANSFER);
  const feeLux =
    defaultGas && defaultGas.limit != null && defaultGas.price != null
      ? safeBigInt(defaultGas.limit, 0n) * safeBigInt(defaultGas.price, 0n)
      : 0n;

  // Balances from overview.
  const pubBalLux = safeBigInt(ov?.balance?.value, 0n);
  const shValueLux = safeBigInt(ov?.shieldedBalance?.value, 0n);
  const shSpendLux =
    ov?.shieldedBalance?.spendable != null
      ? safeBigInt(ov.shieldedBalance.spendable, 0n)
      : null;

  let detectedRecipientType = null; // "account" | "address" | null

  const amountMetaMain = h("div", { class: "amount-meta__main", text: "" });
  const amountMetaSub = h("div", { class: "amount-meta__sub", text: "" });
  const amountMeta = h(
    "div",
    { class: "amount-meta", style: "display:none" },
    [h("div", { class: "amount-meta__stack" }, [amountMetaMain, amountMetaSub])]
  );

  const amountCtl = createAmountSliderCard({
    initialAmountDusk: typeof draft.amountDusk === "string" ? draft.amountDusk : "",
    placeholder: "Amount (DUSK, e.g. 1.25)",
    actions,
    onAmountInput: () => syncDraft(),
    onAmountChange: () => syncDraft(),
    children: [amountMeta],
    maxUnavailableToast: "Enter a valid recipient to calculate max",
  });

  const amount = amountCtl.amountInput;
  const amountCard = amountCtl.el;

  const clamp0 = (v) => (v > 0n ? v : 0n);

  function getMaxAmountLux() {
    if (detectedRecipientType === "address") {
      if (shSpendLux == null) return null;
      return clamp0(shSpendLux - feeLux);
    }
    if (detectedRecipientType === "account") {
      // Public transfers are limited by the Moonlight account balance.
      if (ov?.balance?.value == null) return null;
      return clamp0(pubBalLux - feeLux);
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
      amountMetaMain.textContent = `Spendable (shielded): ${formatLuxShort(maxLux, UI_DISPLAY_DECIMALS)} DUSK`;

      const parts = [];
      if (shSpendLux != null && shValueLux > shSpendLux) {
        parts.push(`Total shielded: ${formatLuxShort(shValueLux, UI_DISPLAY_DECIMALS)} DUSK`);
      }
      if (feeLux > 0n) {
        parts.push(`Fee cap: ${formatLuxShort(feeLux, UI_DISPLAY_DECIMALS)} DUSK`);
      }
      amountMetaSub.textContent = parts.join(" · ");
    } else {
      amountMetaMain.textContent = `Available (public): ${formatLuxShort(maxLux, UI_DISPLAY_DECIMALS)} DUSK`;
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
  const toTypePill = h("div", { class: "meta-pill", style: "display:none" });

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

  const updateContactMatch = (addr, typ) => {
    try {
      if (!addr || (typ !== "account" && typ !== "address")) {
        toChip.style.display = "none";
        toChipName.textContent = "";
        toChipIco.innerHTML = "";
        toWrap.classList.remove("has-chip");
        toWrap.style.removeProperty("--chip-w");
        return;
      }

      if (!contactsIndex) rebuildContactsIndex(state.addressBook?.items);
      const hit = contactsIndex?.get(String(addr).toLowerCase());
      const name = String(hit?.name ?? "").trim();
      if (!name) {
        toChip.style.display = "none";
        toChipName.textContent = "";
        toChipIco.innerHTML = "";
        toWrap.classList.remove("has-chip");
        toWrap.style.removeProperty("--chip-w");
        return;
      }

      // Render chip
      toChipName.textContent = name;
      toChipIco.innerHTML = "";
      toChipIco.appendChild(identiconEl(addr));
      toChip.style.display = "flex";
      toWrap.classList.add("has-chip");

      // Measure and shift input text so it doesn't overlap the chip.
      requestAnimationFrame(() => {
        try {
          const w = Math.ceil(toChip.getBoundingClientRect().width);
          if (w > 0) toWrap.style.setProperty("--chip-w", `${w}px`);
        } catch {
          // ignore
        }
      });
    } catch {
      toChip.style.display = "none";
      toChipName.textContent = "";
      toChipIco.innerHTML = "";
      toWrap.classList.remove("has-chip");
      toWrap.style.removeProperty("--chip-w");
    }
  };
  const updateToType = () => {
    const v = String(to.value || "").trim();
    if (!v) {
      toTypePill.style.display = "none";
      toTypePill.textContent = "";
      detectedRecipientType = null;
      updateContactMatch("", null);
      updateAmountHelpers();
      return;
    }

    // Give quick feedback when the user pastes a dusk: request link.
    if (/^dusk:/i.test(v)) {
      toTypePill.style.display = "inline-flex";
      toTypePill.textContent = "Detected: Dusk request link";
      detectedRecipientType = null;
      updateContactMatch("", null);
      updateAmountHelpers();
      return;
    }
    const t = ProfileGenerator.typeOf(v);

    if (t === "account" || t === "address") {
      toTypePill.style.display = "inline-flex";
      toTypePill.textContent = t === "address" ? "Detected: Shielded address" : "Detected: Public account";
      detectedRecipientType = t;
      updateContactMatch(v, t);
      updateAmountHelpers();
      return;
    }

    // Fallback: unknown format
    toTypePill.style.display = "inline-flex";
    toTypePill.textContent = "Detected: Unknown address format";
    detectedRecipientType = null;
    updateContactMatch("", null);
    updateAmountHelpers();
  };

  syncDraft = () => {
    // Keep draft in sync so any toast-triggered re-render doesn't wipe inputs.
    state.draft = {
      ...(state.draft || {}),
      to: String(to.value || ""),
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
  updateToType();

  const scanBtn = h("button", {
    class: "icon-btn icon-only",
    type: "button",
    text: "▦",
    title: "Scan QR",
    onclick: async () => {
      try {
        const payload = await openQrScanModal({
          title: "Scan request",
          hint: "Scan a Dusk request QR (or choose an image)",
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
    text: "★",
    title: "Contacts",
    onclick: async () => {
      try {
        // Ensure the current form state is preserved before navigating.
        syncDraft();

        state.addressBook = {
          ...(state.addressBook || {}),
          mode: "pick",
          fromRoute: "send",
          pickReturnRoute: "send",
          prefillAddress: String(to.value || "").trim(),
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

        const amtLux = parseDuskToLux(amount.value);
        const memoVal = memo.value.trim();

        // Keep any previously edited gas settings if the user goes back and forth.
        const prevGas = draft?.gas;

        state.draft = {
          to: toVal,
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
      h("label", { text: "To" }),
      toRow,
      toTypePill,
      h("label", { text: "Amount" }),
      amountCard,
      h("label", { text: "Memo" }),
      memo,
      errBox,
      h("div", { class: "btnrow" }, [nextBtn]),
    ]),
  ].filter(Boolean);
}

export function sendConfirmView(ov, { state, actions } = {}) {
  const d = state.draft;
  if (!d) {
    state.route = "send";
    return sendFormView(ov, { state, actions });
  }

  const recType = ProfileGenerator.typeOf(String(d.to || "").trim());
  const txTypeLabel = recType === "address" ? "Shielded transfer" : "Public transfer";

  // ------------------------------------------------------------
  // Contacts helper
  // ------------------------------------------------------------
  const toAddr = String(d.to || "").trim();

  const contactPill = h("div", { class: "meta-pill", style: "display:none" });
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
      contactPill.style.display = "inline-flex";
      contactPill.textContent = `Contact: ${name}`;
      saveContactBtn.style.display = "none";
    } else {
      contactPill.style.display = "none";
      contactPill.textContent = "";
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

  const confirmBtn = h("button", { class: "btn-primary", text: "Confirm" });
  const cancelBtn = h("button", {
    class: "btn-outline",
    text: "Cancel",
    onclick: () => {
      state.route = "send";
      actions?.render?.().catch(() => {});
    },
  });

  // Gas editor (collapsed by default)
  const defaultGas = getDefaultGas(TX_KIND.TRANSFER);
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
  gasEditor.helpText =
    "Max fee shown is limit × price. Clear both to use node defaults.";

  // Prefer persisted draft gas. Otherwise we'll fetch the node's current gas
  // price stats and set a recommended default (median).
  gasEditor.setGas(d?.gas ?? null);

  const gasHint = h("div", { class: "muted", text: "Loading gas price suggestion…" });
  const btnAuto = h("button", {
    class: "btn-outline",
    type: "button",
    text: "Auto",
    onclick: () => gasEditor.setGas(null),
  });
  const btnLow = h("button", { class: "btn-outline", type: "button", text: "Low", disabled: true });
  const btnRec = h("button", { class: "btn-outline", type: "button", text: "Recommended", disabled: true });
  const btnHigh = h("button", { class: "btn-outline", type: "button", text: "High", disabled: true });

  const gasQuickRow = h(
    "div",
    { style: "display:flex; gap:10px; flex-wrap:wrap; justify-content:flex-end;" },
    [btnAuto, btnLow, btnRec, btnHigh]
  );

  // Fire-and-forget: fetch suggested prices (cached for 30s).
  (async () => {
    try {
      if (d?.gas) {
        gasHint.textContent = defaultLimit && fallbackPrice
          ? `Default gas: ${defaultLimit} limit · ${fallbackPrice} price (LUX)`
          : "Gas is set.";
        btnLow.disabled = true;
        btnRec.disabled = true;
        btnHigh.disabled = true;
        return;
      }

      const resp = await actions?.send?.({ type: "DUSK_UI_GET_CACHED_GAS_PRICE" });
      if (resp?.error) throw new Error(resp.error.message ?? "Failed to fetch gas price");
      const stats = resp?.result ?? resp;

      const min = String(stats?.min ?? "1");
      const median = String(stats?.median ?? stats?.average ?? "1");
      const max = String(stats?.max ?? median);

      gasHint.textContent = `Gas price (LUX): min ${min} · median ${median} · max ${max}`;
      gasEditor.helpText =
        (defaultLimit
          ? `Suggested gas price comes from the node mempool. Default limit: ${defaultLimit}. `
          : "Suggested gas price comes from the node mempool. ") +
        "Max fee shown is limit × price. Clear both to use node defaults.";

      const apply = (price) => {
        if (!defaultLimit) return;
        gasEditor.setGas({ limit: defaultLimit, price: String(price ?? "") });
      };

      btnLow.disabled = !defaultLimit;
      btnRec.disabled = !defaultLimit;
      btnHigh.disabled = !defaultLimit;
      btnLow.onclick = () => apply(min);
      btnRec.onclick = () => apply(median);
      btnHigh.onclick = () => apply(max);

      // Default to median (recommended) for a predictable UX.
      if (defaultLimit) {
        gasEditor.setGas({ limit: defaultLimit, price: median });
      }
    } catch (e) {
      gasHint.textContent = "Gas price unavailable (using defaults).";
      // Fall back to static defaults so the user still sees a max fee.
      if (defaultLimit && fallbackPrice) {
        gasEditor.setGas({ limit: defaultLimit, price: fallbackPrice });
      }
    }
  })().catch(() => {});

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

  return [
    subnav({
      title: "Review",
      onBack: () => {
        state.route = "send";
        actions?.render?.().catch(() => {});
      },
    }),
    h("div", { class: "row" }, [
      h("div", { class: "muted", text: "You are about to send" }),
      h("div", { class: "meta-pill", text: `Type: ${txTypeLabel}` }),
      h("div", { class: "home-balance" }, [
        h("div", {
          class: "balance-amount",
          text: d.amountDusk || formatLuxToDusk(d.amountLux),
        }),
        h("div", { class: "balance-sub", text: "DUSK" }),
      ]),
      h("div", { class: "muted", text: "To" }),
      h("div", { class: "box" }, [h("code", { text: d.to })]),
      contactLine,
      d.memo
        ? h("div", { class: "row" }, [
            h("div", { class: "muted", text: "Memo" }),
            h("div", { class: "box" }, [h("code", { text: d.memo })]),
          ])
        : h("div"),
      gasEditor,
      gasHint,
      gasQuickRow,
      h("div", { class: "btnrow" }, [cancelBtn, confirmBtn]),
    ]),
  ].filter(Boolean);
}
