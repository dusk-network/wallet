import { UI_DISPLAY_DECIMALS, formatLuxShort, parseDuskToLux } from "../../shared/amount.js";
import { h } from "../lib/dom.js";

// Slider resolution (0–100% in 0.1% steps).
const SLIDER_MAX = 1000;

// Snap points ("magnet" effect) while dragging.
const SNAP_PCTS = [0, 25, 50, 75, 100];
const SNAP_THRESHOLD_PCT = 0.9; // percent points

function clamp(n, a, b) {
  return Math.min(b, Math.max(a, n));
}

function maybeSnapRaw(raw) {
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
  return clamp(n, 0, SLIDER_MAX);
}

/**
 * Amount module with amount input, MAX button and slider.
 *
 * The caller owns max calculation logic. This component owns:
 * - slider<->amount sync
 * - MAX behavior
 * - showing/hiding/enabling slider based on maxLux
 */
export function createAmountSliderCard({
  initialAmountDusk = "",
  placeholder = "Amount (DUSK)",
  actions,
  // Called when user types in the amount input.
  onAmountInput,
  // Called when the component programmatically sets the amount (MAX/slider).
  onAmountChange,
  // Optional extra node(s) to place between the input row and slider.
  children = [],
  // Message shown when user taps MAX while max isn't available.
  maxUnavailableToast = "Enter a valid recipient to calculate max",
} = {}) {
  let maxLux = null;

  const amount = h("input", {
    class: "amount-input",
    placeholder,
    value: typeof initialAmountDusk === "string" ? initialAmountDusk : "",
  });

  const maxBtn = h("button", {
    class: "icon-btn max-btn",
    type: "button",
    text: "MAX",
    title: "Use maximum amount",
    disabled: true,
    onclick: () => {
      if (maxLux == null) {
        actions?.showToast?.(maxUnavailableToast, 2000);
        return;
      }
      if (maxLux <= 0n) return;
      setAmountLux(maxLux, { syncSlider: false });
      setSliderRaw(SLIDER_MAX);
      onAmountChange?.();
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

  // Root card: cohesive component.
  const cardChildren = [amountRow];
  const extra = Array.isArray(children) ? children : [children];
  for (const n of extra) {
    if (n) cardChildren.push(n);
  }
  cardChildren.push(sliderWrap);

  const amountCard = h("div", { class: "amount-card" }, cardChildren);

  function setSliderRaw(raw) {
    const n0 = Number(raw);
    const n = Number.isFinite(n0) ? clamp(n0, 0, SLIDER_MAX) : 0;
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

  function setAmountLux(lux, { syncSlider = true } = {}) {
    amount.value = formatLuxShort(lux, UI_DISPLAY_DECIMALS);
    if (syncSlider) syncSliderToAmount();
  }

  function syncSliderToAmount() {
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
      // Don't fight user's typing (e.g. "1.")
      return;
    }

    if (amtLux <= 0n) {
      setSliderRaw(0);
      return;
    }

    let n = Number((amtLux * BigInt(SLIDER_MAX)) / maxLux);
    if (!Number.isFinite(n)) return;
    n = clamp(n, 0, SLIDER_MAX);
    setSliderRaw(n);
  }

  slider.addEventListener("input", () => {
    if (maxLux == null || maxLux <= 0n) return;
    const n0 = clamp(Number(slider.value) || 0, 0, SLIDER_MAX);
    const n = maybeSnapRaw(n0);
    const amtLux = (maxLux * BigInt(n)) / BigInt(SLIDER_MAX);
    setSliderRaw(n);
    setAmountLux(amtLux, { syncSlider: false });
    onAmountChange?.();
  });

  amount.addEventListener("input", () => {
    onAmountInput?.();
    syncSliderToAmount();
  });

  function setMaxLux(next) {
    maxLux = next == null ? null : BigInt(next);

    if (maxLux == null || maxLux <= 0n) {
      maxBtn.disabled = true;
      slider.disabled = true;
      sliderWrap.style.display = "none";
      setSliderRaw(0);
      return;
    }

    maxBtn.disabled = false;
    slider.disabled = false;
    sliderWrap.style.display = "flex";

    // Keep slider aligned with whatever is in the input.
    syncSliderToAmount();
  }

  // Default state: no max yet.
  setMaxLux(null);

  return {
    el: amountCard,
    amountInput: amount,
    maxBtn,
    slider,
    sliderWrap,
    setMaxLux,
    setAmountLux,
    syncSliderToAmount,
    setSliderRaw,
    get maxLux() {
      return maxLux;
    },
  };
}
