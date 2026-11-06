// A request link from the web wallet's Send, for the extension's own Send: what
// the page's offer asks (requestLinkOffer.js), or the web wallet itself through
// the provider (dusk_openPaymentLink). Only a link of the page it comes from, on
// a network's own web wallet, and only as a form to fill in: nothing goes until
// its Review and Confirm.

import { makePaymentLink, parsePaymentLink } from "@dusk-network/app-core/payment-links";

import { runtimeGetURL, tabsCreate } from "../platform/extensionApi.js";
import { ERROR_CODES, rpcError } from "../shared/errors.js";
import { isLocalHttpHostname } from "../shared/securityPolicy.js";
import { loadVault } from "../shared/vault.js";

const originOf = (url) => {
  try {
    return new URL(String(url ?? "")).origin;
  } catch {
    return "";
  }
};

// The link in a message, or null: one to a network's web wallet's Send, sent from that very site.
function linkOf(message, sender) {
  const link = String(message?.link ?? "");
  if (parsePaymentLink(link)?.form !== "https") return null;
  const from = originOf(sender?.url ?? sender?.tab?.url);
  return from && from === originOf(link) ? link : null;
}

/**
 * Whether the page gets its offer: it's such a link, and there's a wallet here to pay it with.
 * @param {{ link?: string }} message
 * @param {{ url?: string, tab?: { url?: string } }} sender
 * @returns {Promise<boolean>}
 */
export async function offersRequestLink(message, sender) {
  return Boolean(linkOf(message, sender)) && Boolean(await loadVault());
}

// The extension's Send on a tab of its own, with the link filled in.
const openSend = (link) => tabsCreate({ url: runtimeGetURL(`full.html?route=send&link=${encodeURIComponent(link)}`) });

/**
 * Opens the extension's Send on a tab of its own, with the link filled in.
 * @param {{ link?: string }} message
 * @param {{ url?: string, tab?: { url?: string } }} sender
 * @returns {Promise<boolean>} whether it opened
 */
export async function openRequestLink(message, sender) {
  const link = linkOf(message, sender);
  if (!link) return false;
  await openSend(link);
  return true;
}

// A web wallet's own request link, as Send reads it: a network's web wallet's
// as it is, and one on this machine's as its network's would be.
function siteLinkOf(origin, raw) {
  const link = String(raw ?? "");
  if (!origin || originOf(link) !== origin) return null;
  if (parsePaymentLink(link)?.form === "https") return link;
  let local = false;
  try {
    local = isLocalHttpHostname(new URL(origin).hostname);
  } catch {
    local = false;
  }
  const at = link.indexOf("/dashboard/send");
  const read = local && at > 0 ? parsePaymentLink(link, { walletUrl: link.slice(0, at) }) : null;
  if (read?.form !== "https") return null;
  const made = makePaymentLink({ amountLux: read.lux === null ? "" : String(read.lux), label: read.label, memo: read.memo, network: read.chainId, to: read.to });
  return made.ok ? made.https ?? made.dusk : null;
}

/**
 * A web wallet's request, handed to the extension's Send (dusk_openPaymentLink):
 * a link of the asking page's own web wallet, a network's or one on this
 * machine, asked on a person's press. Opens Send filled in; nothing goes until
 * its Review and Confirm. False where there's no wallet here to pay it with.
 * @param {string} origin - the asking page's
 * @param {unknown} link
 * @param {{ pressed?: boolean }} [context] - whether the page had a press when it asked, where the browser says
 * @returns {Promise<boolean>} whether Send opened
 */
export async function handOverRequestLink(origin, link, { pressed } = {}) {
  const own = siteLinkOf(origin, link);
  if (!own) throw rpcError(ERROR_CODES.INVALID_PARAMS, "params.link must be a request link to this web wallet's own Send");
  if (pressed === false) throw rpcError(ERROR_CODES.UNAUTHORIZED, "Hand a request over from a press of the person's");
  if (!(await loadVault())) return false;
  await openSend(own);
  return true;
}
