import { h } from "../lib/dom.js";
import { sameGas } from "./GasEditor.js";

/**
 * A Review's fee at the network's gas price: the gas limit that suits the
 * transaction at the price the node asks now, and Custom fee for a limit and
 * price of your own, never under the transaction's minimum. A draft that
 * kept its own gas keeps it. Until the node answers, and if it can't, the
 * wallet's default price stands in.
 *
 * @param {{
 *   actions: object, gasEditor: HTMLElement,
 *   defaultLimit: string, fallbackPrice: string,
 *   gas?: { limit: string, price: string } | null,
 *   minLimit?: string | null,
 * }} opts
 */
export function useNetworkGas({ actions, gasEditor, defaultLimit, fallbackPrice, gas, minLimit }) {
  const fallback = defaultLimit && fallbackPrice ? { limit: String(defaultLimit), price: String(fallbackPrice) } : null;
  gasEditor.minLimit = minLimit ?? null;
  gasEditor.networkGas = fallback;
  gasEditor.helpText = "The fee is at most the gas limit times the gas price.";
  gasEditor.setEditContent([
    h("p", { class: "gas-note", text: "The wallet uses the network's gas price and a gas limit that suits this transaction." }),
  ]);
  if (gas) gasEditor.setGas(gas);
  else if (fallback) gasEditor.setGas(fallback);

  (async () => {
    const response = await actions?.send?.({ type: "DUSK_UI_GET_CACHED_GAS_PRICE" });
    if (response?.error) throw new Error(response.error.message ?? "Gas price unavailable");
    const stats = response?.result ?? response;
    const price = String(stats?.median ?? stats?.average ?? "").trim();
    if (!defaultLimit || !/^\d+$/.test(price) || price === "0") return;
    const network = { limit: String(defaultLimit), price };
    // Gas the user set, here or before going back, stays theirs.
    const untouched = !gas && sameGas(gasEditor.getGasInputs(), gasEditor.networkGas);
    gasEditor.networkGas = network;
    if (untouched) gasEditor.setGas(network);
  })().catch(() => {});
}
