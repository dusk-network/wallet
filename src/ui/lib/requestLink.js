import { linkAmount, readPaymentLink } from "@dusk-network/app-core/payment-links";

import { chainIdFromNodeUrl } from "../../shared/chain.js";
import { chainIdForNode } from "../../shared/nodeNetwork.js";

/**
 * The chain the wallet signs for on a node, by which a request is its network's or not.
 * @param {string} [nodeUrl]
 */
export const walletChainOf = (nodeUrl) => chainIdForNode(String(nodeUrl ?? "")) ?? chainIdFromNodeUrl(String(nodeUrl ?? ""));

/**
 * A request link as Send reads it on the wallet's network, pasted, scanned or
 * opened alike (app-core's readPaymentLink, as the web wallet reads it): what
 * it fills in, or why it fills in nothing, a memo with a line break too, which
 * would go on one line and match no request made with it. Null for what isn't
 * a link, which Send takes as a recipient.
 * @param {string} text
 * @param {string} [nodeUrl] - the wallet's node; without one, any network's
 */
export function readRequestLink(text, nodeUrl) {
  return readPaymentLink(text, nodeUrl === undefined ? {} : { network: walletChainOf(nodeUrl) });
}

/**
 * Send's draft of a request link the page was opened with (`full.html?route=send&link=…`,
 * background/requestLinks.js): only a form filled in, which its checks read as any, and
 * Send refuses for another network. One that can't be read fills in nothing and says
 * why. Null for no link, or what isn't one.
 * @param {string} search - the page's query
 * @returns {{ to: string, amountDusk: string, memo: string, requestChainId?: string, refusedProblem?: string, filledFrom?: "link", filledIn?: true } | null}
 */
export function requestDraftOf(search) {
  const read = readRequestLink(new URLSearchParams(search).get("link") ?? "");
  if (!read) return null;
  if (!read.link) return { to: "", amountDusk: "", memo: "", refusedProblem: read.problem };
  const { link } = read;
  // Its amount as typing reads it (app-core's linkAmount): a link's 2.125 asks, as typed 2.125 does.
  return { to: link.to, amountDusk: linkAmount(link).field, memo: link.memo, requestChainId: link.chainId || undefined, filledFrom: "link", filledIn: true };
}

// The pages whose request link went, paid or left (forgetRequestLink).
const linkGone = new WeakSet();

/**
 * Takes the request link the page was opened with off its address, once it's
 * paid or left: a reload, or Firefox for Android bringing the tab back, opens
 * the wallet, not the same payment ready to send again. Off each entry of the
 * page's history it comes to from then on too: the entries the wallet puts up
 * for a phone's Back (systemBack.js) carry the address the page opened with,
 * and Done or Back steps back onto them.
 * @param {Window} [win] - the page
 */
export function forgetRequestLink(win = globalThis.window ?? globalThis) {
  // Whether the address on now had the link.
  const strip = () => {
    try {
      const where = win?.location ?? globalThis.location;
      const history = win?.history ?? globalThis.history;
      const params = new URLSearchParams(where?.search ?? "");
      if (!params.has("link")) return false;
      params.delete("link");
      params.delete("route");
      const query = params.toString();
      history?.replaceState?.(history.state ?? null, "", `${where.pathname}${query ? `?${query}` : ""}`);
      return true;
    } catch {
      // An address that can't change stays as it is.
      return false;
    }
  };
  if (!strip() || !win || linkGone.has(win)) return;
  linkGone.add(win);
  win.addEventListener?.("popstate", strip);
}
