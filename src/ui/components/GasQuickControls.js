import { h } from "../lib/dom.js";

export function createGasQuickControls({
  actions,
  defaultLimit,
  fallbackPrice,
  gas,
  gasEditor,
  overrideHint,
}) {
  const gasHint = h("div", { class: "muted", text: "Loading gas price suggestion…" });
  const btnAuto = h("button", {
    class: "btn-outline",
    type: "button",
    text: "Auto",
    onclick: () => gasEditor.setGas(null),
  });
  const btnLow = h("button", { class: "btn-outline", type: "button", text: "Low", disabled: true });
  const btnRecommended = h("button", {
    class: "btn-outline",
    type: "button",
    text: "Recommended",
    disabled: true,
  });
  const btnHigh = h("button", { class: "btn-outline", type: "button", text: "High", disabled: true });
  const gasQuickRow = h("div", { class: "gas-quick-row" }, [btnAuto, btnLow, btnRecommended, btnHigh]);

  (async () => {
    try {
      if (gas) {
        gasHint.textContent = overrideHint ?? (
          defaultLimit && fallbackPrice
            ? `Default gas: ${defaultLimit} limit · ${fallbackPrice} price (LUX)`
            : "Gas is set."
        );
        return;
      }

      const response = await actions?.send?.({ type: "DUSK_UI_GET_CACHED_GAS_PRICE" });
      if (response?.error) throw new Error(response.error.message ?? "Failed to fetch gas price");
      const stats = response?.result ?? response;
      const min = String(stats?.min ?? "1");
      const median = String(stats?.median ?? stats?.average ?? "1");
      const max = String(stats?.max ?? median);

      gasHint.textContent = `Gas price (LUX): min ${min} · median ${median} · max ${max}`;
      gasEditor.helpText =
        (defaultLimit
          ? `Suggested gas price comes from the node mempool. Default limit: ${defaultLimit}. `
          : "Suggested gas price comes from the node mempool. ") +
        "Max fee shown is limit × price. Clear both to use wallet defaults.";

      const apply = (price) => {
        if (!defaultLimit) return;
        gasEditor.setGas({ limit: defaultLimit, price: String(price ?? "") });
      };

      btnLow.disabled = !defaultLimit;
      btnRecommended.disabled = !defaultLimit;
      btnHigh.disabled = !defaultLimit;
      btnLow.onclick = () => apply(min);
      btnRecommended.onclick = () => apply(median);
      btnHigh.onclick = () => apply(max);
      if (defaultLimit) apply(median);
    } catch {
      gasHint.textContent = "Gas price unavailable (using defaults).";
      if (defaultLimit && fallbackPrice) {
        gasEditor.setGas({ limit: defaultLimit, price: fallbackPrice });
      }
    }
  })().catch(() => {});

  return { gasHint, gasQuickRow };
}
