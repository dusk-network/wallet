import { formatFee } from "../../shared/amount.js";

/**
 * How much DUSK short something is, in the words every form and approval use:
 * of what it moves with its fee, or of a fee alone, which the public balance
 * pays. Rounded up, so it never reads less than is missing.
 *
 * @param {{ missingLux: bigint, moves?: boolean, shielded?: boolean, hidden?: boolean, withFee?: string }} opts -
 *   `moves`: it moves DUSK from the balance as well as paying its fee;
 *   `shielded`: from the shielded balance; `hidden`: Hide balances is on, so
 *   the figure, which gives the balance away, is hidden; `withFee`: what it's
 *   more than the balance with, where that isn't the network fee alone
 * @returns {string}
 */
export function shortfallText({ missingLux, moves = true, shielded = false, hidden = false, withFee = "the network fee" }) {
  const short = hidden ? "••••" : formatFee(missingLux, { max: true });
  const balance = shielded ? "shielded balance" : "public balance";
  return moves ? `That's ${short} DUSK more than your ${balance}, with ${withFee}.` : `The ${balance} doesn't cover the network fee: ${short} DUSK short.`;
}
