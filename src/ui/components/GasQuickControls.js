import { h } from "../lib/dom.js";

/**
 * The gas price line and the Auto, Low, Recommended and High presets of a
 * Review, in the panel the fee's Edit opens: Review shows the fee and the
 * total until then. Low, Recommended and High set the default gas limit and
 * the node's min, median or max gas price; Auto clears both.
 */
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
  gasEditor.setEditContent([gasHint, gasQuickRow]);
  gasEditor.helpText = "Max fee = gas limit × gas price. Auto uses the wallet's defaults.";

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
