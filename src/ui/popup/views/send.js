import {
  UI_DISPLAY_DECIMALS,
  formatLuxShort,
  formatLuxToDusk,
  parseDuskToLux,
  safeBigInt,
} from "../../../shared/amount.js";
import { getDefaultGas } from "../../../shared/txDefaults.js";
import { ProfileGenerator } from "@dusk/w3sper";
import { h } from "../../lib/dom.js";
import { subnav } from "../../components/Subnav.js";
import "../../components/GasEditor.js";

import { openQrScanModal, parseDuskQrPayload } from "../../components/QrScanModal.js";
import {
  chainIdFromNodeUrlDecimal,
  chainLabel,
  normalizeChainId,
} from "../../../shared/duskUri.js";

export function sendFormView(ov, { state, actions } = {}) {
  const draft = state.draft || {};

  const to = h("input", {
    placeholder: "Recipient (account or shielded address)",
    value: typeof draft.to === "string" ? draft.to : "",
  });
  const amount = h("input", {
    class: "amount-input",
    placeholder: "Amount (DUSK, e.g. 1.25)",
    value: typeof draft.amountDusk === "string" ? draft.amountDusk : "",
  });
  const memo = h("input", {
    placeholder: "Memo (optional)",
    value: typeof draft.memo === "string" ? draft.memo : "",
  });

  // ------------------------------------------------------------
  // Amount helpers (MAX + slider)
  // ------------------------------------------------------------
  // The send screen doesn't expose gas settings yet. We base MAX calculations
  // on the wallet's safe defaults for transfers.
  const defaultGas = getDefaultGas("transfer");
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

  const SLIDER_MAX = 1000; // 0.1% steps
  const SNAP_PCTS = [0, 25, 50, 75, 100];
  const SNAP_THRESHOLD_PCT = 0.9; // subtle magnet effect

  const maybeSnapRaw = (raw) => {
    const n = Number(raw);
    if (!Number.isFinite(n)) return 0;
    const pct = (n * 100) / SLIDER_MAX;
    let best = null;
    let bestDist = Infinity;
    for (const p of SNAP_PCTS) {
      const d = Math.abs(pct - p);
      if (d < bestDist) {
        bestDist = d;
        best = p;
      }
    }
    if (best != null && bestDist <= SNAP_THRESHOLD_PCT) {
      return Math.round((best * SLIDER_MAX) / 100);
    }
    return Math.max(0, Math.min(SLIDER_MAX, n));
  };

  const maxBtn = h("button", {
    class: "icon-btn max-btn",
    type: "button",
    text: "MAX",
    title: "Use maximum amount",
    disabled: true,
    onclick: () => {
      const maxLux = getMaxAmountLux();
      if (maxLux == null) {
        try {
          actions?.showToast?.("Enter a valid recipient to calculate max", 2000);
        } catch {
          // ignore
        }
        return;
      }
      setAmountLux(maxLux);
      setSliderRaw(SLIDER_MAX);
    },
  });
  const amountRow = h("div", { class: "input-row" }, [amount, maxBtn]);

  const slider = h("input", {
    type: "range",
    class: "amount-range",
    min: "0",
    max: String(SLIDER_MAX),
    value: "0",
    disabled: true,
  });
  slider.style.setProperty("--range-pct", "0%");

  const sliderPct = h("div", { class: "amount-range__pct", text: "0%" });

  const ticks = h(
    "div",
    { class: "amount-range__ticks", "aria-hidden": "true" },
    [0, 25, 50, 75, 100].map((p) =>
      h("span", {
        class: "amount-range__tick" + (p === 0 || p === 100 ? " is-edge" : ""),
        style:
          p === 0
            ? "left:0%"
            : p === 100
              ? "left:100%; transform: translateX(-100%)"
              : `left:${p}%; transform: translateX(-50%)`,
      })
    )
  );

  const sliderTrack = h("div", { class: "amount-range__track" }, [slider, ticks]);

  const sliderWrap = h("div", { class: "amount-range-wrap", style: "display:none" }, [
    sliderTrack,
    sliderPct,
  ]);

  // Amount module groups input + helpers as one cohesive component.
  const amountCard = h("div", { class: "amount-card" }, [amountRow, amountMeta, sliderWrap]);

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

  function setSliderRaw(raw) {
    const n0 = Number(raw);
    const n = Number.isFinite(n0) ? Math.max(0, Math.min(SLIDER_MAX, n0)) : 0;
    slider.value = String(n);

    const pctExact = (n * 100) / SLIDER_MAX;
    slider.style.setProperty("--range-pct", `${pctExact}%`);

    const pctInt = Math.round(pctExact);
    if (n > 0 && pctInt === 0) {
      sliderPct.textContent = "<1%";
    } else if (pctInt >= 100) {
      sliderPct.textContent = "100%";
    } else {
      sliderPct.textContent = `${pctInt}%`;
    }
  }

  function setAmountLux(lux) {
    amount.value = formatLuxShort(lux, UI_DISPLAY_DECIMALS);
    // Keep draft in sync so toast-triggered re-renders don't wipe the value.
    try {
      syncDraft();
    } catch {
      // ignore
    }
  }

  function syncSliderToAmount() {
    const maxLux = getMaxAmountLux();
    if (maxLux == null || maxLux <= 0n) {
      setSliderRaw(0);
      return;
    }

    const raw = String(amount.value || "").trim();
    if (!raw) {
      setSliderRaw(0);
      return;
    }

    let amtLux = 0n;
    try {
      amtLux = BigInt(parseDuskToLux(raw));
    } catch {
      // Don't fight the user's typing (e.g. "1."), just keep slider as-is.
      return;
    }

    if (amtLux <= 0n) {
      setSliderRaw(0);
      return;
    }

    let n = Number((amtLux * BigInt(SLIDER_MAX)) / maxLux);
    if (!Number.isFinite(n)) return;
    if (n < 0) n = 0;
    if (n > SLIDER_MAX) n = SLIDER_MAX;
    setSliderRaw(n);
  }

  slider.addEventListener("input", () => {
    const maxLux = getMaxAmountLux();
    if (maxLux == null || maxLux <= 0n) return;

    const n0 = Math.max(0, Math.min(SLIDER_MAX, Number(slider.value) || 0));
    const n = maybeSnapRaw(n0);
    const amtLux = (maxLux * BigInt(n)) / BigInt(SLIDER_MAX);
    setSliderRaw(n);
    setAmountLux(amtLux);
  });

  function updateAmountHelpers() {
    const maxLux = getMaxAmountLux();

    if (maxLux == null) {
      amountMeta.style.display = "none";
      sliderWrap.style.display = "none";
      maxBtn.disabled = true;
      slider.disabled = true;
      setSliderRaw(0);
      return;
    }

    amountMeta.style.display = "flex";
    sliderWrap.style.display = "flex";
    maxBtn.disabled = maxLux <= 0n;
    slider.disabled = maxLux <= 0n;

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

    // Keep slider in sync with whatever is in the input.
    if (maxLux <= 0n) {
      setSliderRaw(0);
    } else {
      syncSliderToAmount();
    }
  }

  const currentChain = normalizeChainId(chainIdFromNodeUrlDecimal(ov?.nodeUrl ?? ""));

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
  const updateToType = () => {
    const v = String(to.value || "").trim();
    if (!v) {
      toTypePill.style.display = "none";
      toTypePill.textContent = "";
      detectedRecipientType = null;
      updateAmountHelpers();
      return;
    }

    // Give quick feedback when the user pastes a dusk: request link.
    if (/^dusk:/i.test(v)) {
      toTypePill.style.display = "inline-flex";
      toTypePill.textContent = "Detected: Dusk request link";
      detectedRecipientType = null;
      updateAmountHelpers();
      return;
    }
    const t = ProfileGenerator.typeOf(v);

    if (t === "account" || t === "address") {
      toTypePill.style.display = "inline-flex";
      toTypePill.textContent = t === "address" ? "Detected: Shielded address" : "Detected: Public account";
      detectedRecipientType = t;
      updateAmountHelpers();
      return;
    }

    // Fallback: unknown format
    toTypePill.style.display = "inline-flex";
    toTypePill.textContent = "Detected: Unknown address format";
    detectedRecipientType = null;
    updateAmountHelpers();
  };

  const syncDraft = () => {
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
  amount.addEventListener("input", () => {
    syncDraft();
    syncSliderToAmount();
  });
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

  const toRow = h("div", { class: "input-row" }, [to, scanBtn]);

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
  const defaultGas = getDefaultGas("transfer");
  const gasEditor = document.createElement("dusk-gas-editor");
  gasEditor.amountLux = d.amountLux;
  gasEditor.maxDecimals = UI_DISPLAY_DECIMALS;
  gasEditor.helpText = defaultGas
    ? `Default gas: ${defaultGas.limit} limit · ${defaultGas.price} price (LUX). Max fee shown is limit × price. Clear both to use node defaults.`
    : "Max fee shown is limit × price. Clear both to use node defaults.";

  // Prefer persisted draft gas, otherwise show defaults.
  gasEditor.setGas(d?.gas ?? defaultGas ?? null);

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
          kind: "transfer",
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
      d.memo
        ? h("div", { class: "row" }, [
            h("div", { class: "muted", text: "Memo" }),
            h("div", { class: "box" }, [h("code", { text: d.memo })]),
          ])
        : h("div"),
      gasEditor,
      h("div", { class: "btnrow" }, [cancelBtn, confirmBtn]),
    ]),
  ].filter(Boolean);
}
