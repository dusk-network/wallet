import { parsePaymentLink } from "@dusk-network/app-core/payment-links";

import { amountForInput } from "../../shared/amount.js";

/**
 * Send's draft of a request link the page was opened with (`full.html?route=send&link=…`,
 * background/requestLinks.js): only a form filled in, which its checks read as any. Null
 * for no link, or one that isn't one.
 * @param {string} search - the page's query
 * @returns {{ to: string, amountDusk: string, memo: string, requestChainId?: string } | null}
 */
export function requestDraftOf(search) {
  const link = parsePaymentLink(new URLSearchParams(search).get("link"));
  if (!link || link.form === "raw") return null;
  return { to: link.to, amountDusk: amountForInput(link.amountDusk), memo: link.memo, requestChainId: link.chainId || undefined };
}
