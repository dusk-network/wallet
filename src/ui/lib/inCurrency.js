// What an amount of DUSK comes to in the person's currency now, beside the
// DUSK, with the time of the price, in both wallets' words (app-core's
// /prices): on a request, and on the payer's Send and Review. The price comes
// from the source the wallet's values in a currency come from already,
// CoinGecko, read at most once in 5 minutes a currency; on mainnet alone, as
// test DUSK has no price. The person's currency is the one their region's
// language gives, as the export's and the rewards' (app-core's defaultCurrency).

import { defaultCurrency } from "@dusk-network/app-core/amounts";
import { duskPrice, inCurrency } from "@dusk-network/app-core/prices";

import { networkForNode } from "../../shared/nodeNetwork.js";
import { h } from "./dom.js";

// The prices read, by currency, for every screen of this page; and the read
// under way, by currency, which every line asking meanwhile shares.
const prices = new Map();
const reading = new Map();

/**
 * DUSK's price now in the person's currency on the overview's network: null
 * off mainnet, and where it can't be read.
 * @param {object} ov - the overview
 * @returns {Promise<import("@dusk-network/app-core/prices").DuskPrice | null>}
 */
export function priceNow(ov) {
  const network = networkForNode(String(ov?.nodeUrl ?? ""));
  if (network?.name !== "mainnet") return Promise.resolve(null);
  const currency = defaultCurrency();
  if (!reading.has(currency)) {
    reading.set(
      currency,
      duskPrice({ currency, network, cache: prices })
        .catch(() => null)
        .finally(() => reading.delete(currency))
    );
  }
  return reading.get(currency);
}

/**
 * A line saying what an amount comes to in the person's currency, "≈ 1,82 € ·
 * price at 12:03", filled in once the price is read, and hidden while there's
 * nothing to say: no amount, test DUSK, no price, or an amount hidden with the
 * balances. `set` gives it the amount, in lux (a bigint or its digits), or null.
 * @param {object} ov - the overview
 * @param {string} className
 * @returns {{ el: HTMLElement, set: (lux: bigint | null) => void }}
 */
export function inCurrencyLine(ov, className) {
  const el = h("div", { class: `muted in-currency ${className}`, hidden: true });
  let quote = null;
  let lux = null;
  const draw = () => {
    const said = lux !== null && quote ? inCurrency(lux, quote, { language: globalThis.navigator?.language }) : null;
    el.textContent = said?.text ?? "";
    el.hidden = !said;
  };
  priceNow(ov).then((read) => {
    quote = read;
    draw();
  });
  return {
    el,
    set(next) {
      // In lux, as a bigint or its digits, as a request keeps it.
      const amount = typeof next === "bigint" ? next : /^\d+$/.test(String(next ?? "")) ? BigInt(String(next)) : null;
      lux = amount !== null && amount > 0n ? amount : null;
      draw();
    },
  };
}
