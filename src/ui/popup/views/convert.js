import {
  UI_DISPLAY_DECIMALS,
  formatLuxShort,
  formatLuxToDusk,
  parseDuskToLux,
  safeBigInt,
} from "../../../shared/amount.js";
import { getDefaultGas } from "../../../shared/txDefaults.js";
import { h } from "../../lib/dom.js";
import { subnav } from "../../components/Subnav.js";
import "../../components/GasEditor.js";

function fmtAvail(lux) {
  try {
    return formatLuxShort(lux, UI_DISPLAY_DECIMALS);
  } catch {
    return "—";
  }
}

export function convertFormView(ov, { state, actions } = {}) {
  const draft = state.draft || {};
  const kind = (draft.kind === "unshield" ? "unshield" : "shield");

  const defaultGas = getDefaultGas(kind);
  const feeLux =
    defaultGas && defaultGas.limit != null && defaultGas.price != null
      ? safeBigInt(defaultGas.limit, 0n) * safeBigInt(defaultGas.price, 0n)
      : 0n;

  const amount = h("input", {
    class: "amount-input",
    placeholder: "Amount (DUSK, e.g. 1.25)",
    value: typeof draft.amountDusk === "string" ? draft.amountDusk : "",
  });

  const syncDraft = () => {
    state.draft = {
      ...(state.draft || {}),
      kind,
      amountDusk: String(amount.value || ""),
      gas: state.draft?.gas,
    };
  };

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

  const setKind = (next) => {
    state.draft = {
      ...(state.draft || {}),
      kind: next,
    };
    actions?.render?.().catch(() => {});
  };

  // Basic availability hints
  const pubLux = safeBigInt(ov?.balance?.value, 0n);
  const shSpendLux =
    ov?.shieldedBalance?.spendable != null
      ? safeBigInt(ov.shieldedBalance.spendable, 0n)
      : safeBigInt(ov?.shieldedBalance?.value, 0n);
  const fromLabel = kind === "shield" ? "Public" : "Shielded";
  const toLabel = kind === "shield" ? "Shielded" : "Public";

  const availRaw = kind === "shield" ? pubLux : shSpendLux;
  const avail = availRaw > feeLux ? availRaw - feeLux : 0n;

  const maxBtn = h("button", {
    class: "icon-btn max-btn",
    type: "button",
    text: "MAX",
    title: "Use maximum amount",
    disabled: avail <= 0n,
    onclick: () => {
      amount.value = formatLuxShort(avail, UI_DISPLAY_DECIMALS);
      setSliderRaw(SLIDER_MAX);
      syncDraft();
    },
  });

  const amountRow = h("div", { class: "input-row" }, [amount, maxBtn]);

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

  const slider = h("input", {
    type: "range",
    class: "amount-range",
    min: "0",
    max: String(SLIDER_MAX),
    value: "0",
    disabled: avail <= 0n,
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

  const sliderWrap = h(
    "div",
    { class: "amount-range-wrap", style: avail <= 0n ? "display:none" : "" },
    [sliderTrack, sliderPct]
  );

  const amountCard = h("div", { class: "amount-card" }, [amountRow, sliderWrap]);

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
    syncDraft();
  }

  function syncSliderToAmount() {
    if (avail <= 0n) {
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
      return;
    }

    if (amtLux <= 0n) {
      setSliderRaw(0);
      return;
    }

    let n = Number((amtLux * BigInt(SLIDER_MAX)) / avail);
    if (!Number.isFinite(n)) return;
    if (n < 0) n = 0;
    if (n > SLIDER_MAX) n = SLIDER_MAX;
    setSliderRaw(n);
  }

  slider.addEventListener("input", () => {
    if (avail <= 0n) return;
    const n0 = Math.max(0, Math.min(SLIDER_MAX, Number(slider.value) || 0));
    const n = maybeSnapRaw(n0);
    const amtLux = (avail * BigInt(n)) / BigInt(SLIDER_MAX);
    setSliderRaw(n);
    setAmountLux(amtLux);
  });

  amount.addEventListener("input", () => {
    syncDraft();
    syncSliderToAmount();
  });

  // Initialize slider from any persisted draft amount.
  if (avail > 0n) syncSliderToAmount();

  const info = h("div", { class: "box" }, [
    h("div", { class: "meta-pill", text: `${fromLabel} → ${toLabel}` }),
    h("div", {
      class: "muted",
      style: "margin-top:6px",
      text:
        `Available (${fromLabel}): ${fmtAvail(avail)} DUSK` +
        (feeLux > 0n ? ` · Fee cap: ${formatLuxShort(feeLux, UI_DISPLAY_DECIMALS)} DUSK` : ""),
    }),
  ]);

  const nextBtn = h("button", {
    class: "btn-primary",
    text: "Review",
    onclick: async () => {
      try {
        setErr("");
        const amtLuxStr = parseDuskToLux(amount.value);
        const amtLux = BigInt(amtLuxStr);
        if (amtLux <= 0n) throw new Error("Amount must be > 0");

        // Friendly local pre-check (server will enforce anyway)
        if (amtLux > avail) {
          throw new Error(`Insufficient ${fromLabel.toLowerCase()} balance`);
        }

        const prevGas = draft?.gas;

        state.draft = {
          kind,
          amountLux: amtLuxStr,
          amountDusk: amount.value.trim(),
          gas: prevGas,
        };
        state.route = "convert_confirm";
        await actions?.render?.();
      } catch (e) {
        setErr(e?.message ?? String(e));
      }
    },
  });

  const modeTabs = h("div", { class: "tabs", style: `--seg-index: ${kind === "shield" ? 0 : 1};` }, [
    h(
      "button",
      {
        class: kind === "shield" ? "tab is-active" : "tab",
        onclick: () => setKind("shield"),
      },
      [h("span", { text: "Shield" })]
    ),
    h(
      "button",
      {
        class: kind === "unshield" ? "tab is-active" : "tab",
        onclick: () => setKind("unshield"),
      },
      [h("span", { text: "Unshield" })]
    ),
  ]);

  return [
    subnav({
      title: "Shield",
      onBack: () => {
        state.route = "home";
        state.draft = null;
        actions?.render?.().catch(() => {});
      },
    }),
    h("div", { class: "row" }, [
      modeTabs,
      info,
      h("label", { text: "Amount" }),
      amountCard,
      errBox,
      h("div", { class: "btnrow" }, [nextBtn]),
    ]),
  ].filter(Boolean);
}

export function convertConfirmView(ov, { state, actions } = {}) {
  const d = state.draft;
  if (!d) {
    state.route = "convert";
    return convertFormView(ov, { state, actions });
  }

  const kind = d.kind === "unshield" ? "unshield" : "shield";
  const fromLabel = kind === "shield" ? "Public" : "Shielded";
  const toLabel = kind === "shield" ? "Shielded" : "Public";

  const confirmBtn = h("button", { class: "btn-primary", text: "Confirm" });
  const cancelBtn = h("button", {
    class: "btn-outline",
    text: "Cancel",
    onclick: () => {
      state.route = "convert";
      actions?.render?.().catch(() => {});
    },
  });

  const defaultGas = getDefaultGas(kind);
  const gasEditor = document.createElement("dusk-gas-editor");
  gasEditor.amountLux = d.amountLux;
  gasEditor.maxDecimals = UI_DISPLAY_DECIMALS;
  gasEditor.helpText = defaultGas
    ? `Default gas: ${defaultGas.limit} limit · ${defaultGas.price} price (LUX). Max fee shown is limit × price. Clear both to use node defaults.`
    : "Max fee shown is limit × price. Clear both to use node defaults.";
  gasEditor.setGas(d?.gas ?? defaultGas ?? null);

  confirmBtn.addEventListener("click", async () => {
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Sending…";

    try {
      const gas = gasEditor.readFinalGas();
      if (state.draft) state.draft.gas = gas;

      const res = await actions?.send?.({
        type: "DUSK_UI_SEND_TX",
        params: {
          kind,
          amount: d.amountLux,
          gas: gas || undefined,
        },
      });

      if (res?.error) throw new Error(res.error.message ?? "Transaction failed");
      if (!res?.ok) throw new Error("Transaction failed");

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
        state.route = "convert";
        actions?.render?.().catch(() => {});
      },
    }),
    h("div", { class: "row" }, [
      h("div", { class: "muted", text: kind === "shield" ? "You are about to shield" : "You are about to unshield" }),
      h("div", { class: "meta-pill", text: `${fromLabel} → ${toLabel}` }),
      h("div", { class: "home-balance" }, [
        h("div", {
          class: "balance-amount",
          text: d.amountDusk || formatLuxToDusk(d.amountLux),
        }),
        h("div", { class: "balance-sub", text: "DUSK" }),
      ]),
      gasEditor,
      h("div", { class: "btnrow" }, [cancelBtn, confirmBtn]),
    ]),
  ].filter(Boolean);
}
