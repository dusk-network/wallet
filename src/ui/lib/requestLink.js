import { readPaymentLink } from "@dusk-network/app-core/payment-links";

import { amountForInput } from "../../shared/amount.js";
import { chainIdFromNodeUrl } from "../../shared/chain.js";
import { chainIdForNode } from "../../shared/nodeNetwork.js";

/**
 * The chain the wallet signs for on a node, by which a request is its network's or not.
 * @param {string} [nodeUrl]
 */
export const walletChainOf = (nodeUrl) => chainIdForNode(String(nodeUrl ?? "")) ?? chainIdFromNodeUrl(String(nodeUrl ?? ""));

/** Why Send fills in nothing from a link whose memo is on more lines than its field holds. */
export const MEMO_LINE_BREAK_TEXT = "This link's memo has a line break, which Send can't take. Ask for a new one.";

/**
 * A request link as Send reads it on the wallet's network, pasted, scanned or
 * opened alike (app-core's readPaymentLink): what it fills in, or why it fills
 * in nothing. Null for what isn't a link, which Send takes as a recipient.
 * Send's memo is one line: a link whose memo has a line break is refused, as
 * it would go on one line and match no request made with it.
 * @param {string} text
 * @param {string} [nodeUrl] - the wallet's node; without one, any network's
 */
export function readRequestLink(text, nodeUrl) {
  const read = readPaymentLink(text, nodeUrl === undefined ? {} : { network: walletChainOf(nodeUrl) });
  return read?.link && /[\r\n\u2028\u2029]/.test(read.link.memo) ? { ...read, link: null, problem: MEMO_LINE_BREAK_TEXT, reason: "unreadable" } : read;
}

/**
 * Send's draft of a request link the page was opened with (`full.html?route=send&link=…`,
 * background/requestLinks.js): only a form filled in, which its checks read as any, and
 * Send refuses for another network. One that can't be read fills in nothing and says
 * why. Null for no link, or what isn't one.
 * @param {string} search - the page's query
 * @returns {{ to: string, amountDusk: string, memo: string, requestChainId?: string, refusedProblem?: string, filledFrom?: "link" } | null}
 */
export function requestDraftOf(search) {
  const read = readRequestLink(new URLSearchParams(search).get("link") ?? "");
  if (!read) return null;
  if (!read.link) return { to: "", amountDusk: "", memo: "", refusedProblem: read.problem };
  const { link } = read;
  return { to: link.to, amountDusk: amountForInput(link.amountDusk), memo: link.memo, requestChainId: link.chainId || undefined, filledFrom: "link" };
}

/**
 * Takes the request link the page was opened with off its address, once it's
 * paid: a reload, or Firefox for Android bringing the tab back, opens the
 * wallet, not the same payment ready to send again.
 * @param {{ location?: Location, history?: History }} [page]
 */
export function forgetPaidLink({ location: where = globalThis.location, history = globalThis.history ?? globalThis.window?.history } = {}) {
  try {
    const params = new URLSearchParams(where?.search ?? "");
    if (!params.has("link")) return;
    params.delete("link");
    params.delete("route");
    const query = params.toString();
    history?.replaceState?.(history.state ?? null, "", `${where.pathname}${query ? `?${query}` : ""}`);
  } catch {
    // An address that can't change stays as it is.
  }
}
