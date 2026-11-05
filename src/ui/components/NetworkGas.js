import { UI_DISPLAY_DECIMALS } from "../../shared/amount.js";
import { getDefaultGas, getMinimumGas } from "../../shared/txDefaults.js";
import { h } from "../lib/dom.js";
import { shortfallText } from "../lib/shortfall.js";
import { sameGas } from "./GasEditor.js";

const whole = (v) => /^\d+$/.test(String(v ?? "").trim());

/**
 * The gas a Review starts from: the draft's own, else custom gas from
 * Settings, else the transaction's default. Custom gas brings its price, and
 * its limit only where the transaction has a minimum the limit clears: a
 * transaction without one, such as a contract call, keeps its own limit,
 * which may need more. Amount forms reserve this gas's fee, so Max and the
 * balance check match what Review asks.
 *
 * @param {{
 *   defaultGas?: { limit?: string|number|bigint, price?: string|number|bigint } | null,
 *   minLimit?: string | null,
 *   customGas?: { limit: string, price: string } | null,
 *   gas?: { limit: string, price: string } | null,
 * }} opts
 * @returns {{ limit: string, price: string } | null}
 */
export function startingGas({ defaultGas, minLimit, customGas, gas } = {}) {
  if (whole(gas?.limit) && whole(gas?.price)) return { limit: String(gas.limit), price: String(gas.price) };
  if (!whole(defaultGas?.limit)) return null;
  const own = String(defaultGas.limit);
  if (whole(customGas?.limit) && whole(customGas?.price)) {
    const clears = whole(minLimit) && BigInt(customGas.limit) >= BigInt(minLimit);
    return { limit: clears ? String(customGas.limit) : own, price: String(customGas.price) };
  }
  return whole(defaultGas?.price) ? { limit: own, price: String(defaultGas.price) } : null;
}

/** A gas's fee at most: limit times price, in Lux; 0 without gas. */
export function gasFeeLux(gas) {
  return gas ? BigInt(gas.limit) * BigInt(gas.price) : 0n;
}

/**
 * A Review's fee at the network's gas price: the gas limit that suits the
 * transaction at the price the node asks now, and Custom fee for a limit and
 * price of your own, never under the transaction's minimum. A draft that
 * kept its own gas keeps it, and custom gas from Settings comes before the
 * network's price (startingGas): its price, and its limit where that clears
 * the transaction's minimum, else the transaction's own. Until the node
 * answers, and if it can't, the wallet's default price stands in. `extra`
 * goes in the Custom fee panel, after its note.
 *
 * @param {{
 *   actions: object, gasEditor: HTMLElement,
 *   defaultLimit: string, fallbackPrice: string,
 *   gas?: { limit: string, price: string } | null,
 *   minLimit?: string | null,
 *   customGas?: { limit: string, price: string } | null,
 *   extra?: Node | null,
 * }} opts
 */
export function useNetworkGas({ actions, gasEditor, defaultLimit, fallbackPrice, gas, minLimit, customGas, extra = null }) {
  const fallback = defaultLimit && fallbackPrice ? { limit: String(defaultLimit), price: String(fallbackPrice) } : null;
  const custom =
    !gas && whole(customGas?.limit) && whole(customGas?.price) && defaultLimit
      ? startingGas({ defaultGas: { limit: defaultLimit }, minLimit, customGas })
      : null;
  gasEditor.minLimit = minLimit ?? null;
  gasEditor.networkGas = fallback;
  gasEditor.helpText = "The fee is at most the gas limit times the gas price.";
  gasEditor.setEditContent([
    h("p", {
      class: "gas-note",
      text: custom
        ? "The wallet uses your custom gas from Settings."
        : "The wallet uses the network's gas price and a gas limit that suits this transaction.",
    }),
    extra,
  ]);
  if (gas) gasEditor.setGas(gas);
  else if (custom) gasEditor.setGas(custom);
  else if (fallback) gasEditor.setGas(fallback);

  (async () => {
    const response = await actions?.send?.({ type: "DUSK_UI_GET_CACHED_GAS_PRICE" });
    if (response?.error) throw new Error(response.error.message ?? "Gas price unavailable");
    const stats = response?.result ?? response;
    const price = String(stats?.median ?? stats?.average ?? "").trim();
    if (!defaultLimit || !/^\d+$/.test(price) || price === "0") return;
    const network = { limit: String(defaultLimit), price };
    // Gas the user set, here, in Settings or before going back, stays theirs.
    const untouched = !gas && !custom && sameGas(gasEditor.getGasInputs(), gasEditor.networkGas);
    gasEditor.networkGas = network;
    if (untouched) gasEditor.setGas(network);
  })().catch(() => {});
}

const feeOfGas = (gas) => {
  const { limit, price } = gas ?? {};
  return whole(limit) && whole(price) ? BigInt(limit) * BigInt(price) : null;
};

/**
 * Whether the balance covers what's being sent and its fee, before Confirm or
 * Approve: how much is missing above the button, and the button off, as the
 * fee changes. A balance that couldn't be read checks nothing: the node still
 * says no, in plain words. The gas in the editor counts from the start, and
 * `gas` where it hasn't drawn yet.
 *
 * @param {{
 *   editor: HTMLElement, availableLux: bigint | null, sendsLux?: bigint, shielded?: boolean, hidden?: boolean,
 *   button?: HTMLButtonElement, ready?: () => boolean, gas?: { limit: unknown, price: unknown } | null,
 * }} opts - `sendsLux`: what it takes from the balance besides its fee; `ready`:
 *   whether the rest of the page lets the button on
 * @returns {{ el: HTMLElement, covered: () => boolean, draw: () => void }}
 */
export function payGuard({ editor, availableLux, sendsLux = 0n, shielded = false, hidden = false, button, ready = () => true, gas = null }) {
  const el = h("div", { class: "field-error pay-guard", role: "alert", hidden: true });
  let feeLux = feeOfGas(editor?.getGasInputs?.() ?? gas) ?? feeOfGas(gas);
  const missing = () => {
    if (availableLux === null || availableLux === undefined) return 0n;
    const need = sendsLux + (feeLux ?? 0n);
    return need > availableLux ? need - availableLux : 0n;
  };
  const draw = () => {
    const missingLux = missing();
    const text = missingLux > 0n ? shortfallText({ missingLux, moves: sendsLux > 0n, shielded, hidden }) : "";
    if (el.textContent !== text) el.textContent = text;
    el.hidden = !text;
    if (button) button.disabled = Boolean(text) || Boolean(editor?.error) || !ready();
  };
  editor?.addEventListener?.("dusk-gas-fee", (event) => {
    feeLux = event?.detail?.feeLux ?? null;
    draw();
  });
  draw();
  return { el, covered: () => missing() === 0n, draw };
}

/**
 * A Review's fee, as Send, Staking, Shield and Unshield and a token's Review
 * set it up: the gas editor for `kind` at the network's price
 * (useNetworkGas), the error above Confirm when gas won't do, and readGas:
 * the gas to send, undefined for the network's, or false once the error
 * says why it can't be sent.
 *
 * @param {{
 *   kind: string, gasOpts?: object, amountLux?: string, ov?: object, actions: object,
 *   gas?: { limit: string, price: string } | null, fallbackPrice?: string,
 * }} opts
 */
export function reviewGas({ kind, gasOpts, amountLux, hideTotal = false, ov, actions, gas, fallbackPrice = "" }) {
  const defaultGas = getDefaultGas(kind, gasOpts);
  const editor = document.createElement("dusk-gas-editor");
  editor.hideTotal = hideTotal;
  editor.amountLux = amountLux;
  editor.maxDecimals = UI_DISPLAY_DECIMALS;
  useNetworkGas({
    customGas: ov?.customGas,
    actions,
    defaultLimit: defaultGas?.limit != null ? String(defaultGas.limit) : "",
    fallbackPrice: defaultGas?.price != null ? String(defaultGas.price) : fallbackPrice,
    gas,
    gasEditor: editor,
    minLimit: getMinimumGas(kind, gasOpts)?.limit,
  });
  // Gas that won't do says so above Confirm; nothing is sent.
  const error = h("div", { class: "field-error", role: "alert", hidden: true });
  const readGas = () => {
    try {
      const final = editor.readFinalGas();
      error.hidden = true;
      return final;
    } catch (e) {
      error.textContent = e?.message ?? String(e);
      error.hidden = false;
      return false;
    }
  };
  return { defaultGas, editor, error, readGas };
}
