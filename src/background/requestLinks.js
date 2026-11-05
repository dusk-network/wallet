// A request link from the web wallet's Send, for the extension's own Send: what
// the page's offer asks (requestLinkOffer.js). Only a link of the page it comes
// from, on a network's own web wallet, and only as a form to fill in: nothing
// goes until its Review and Confirm.

import { parsePaymentLink } from "@dusk-network/app-core/payment-links";

import { runtimeGetURL, tabsCreate } from "../platform/extensionApi.js";
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

/**
 * Opens the extension's Send on a tab of its own, with the link filled in.
 * @param {{ link?: string }} message
 * @param {{ url?: string, tab?: { url?: string } }} sender
 * @returns {Promise<boolean>} whether it opened
 */
export async function openRequestLink(message, sender) {
  const link = linkOf(message, sender);
  if (!link) return false;
  await tabsCreate({ url: runtimeGetURL(`full.html?route=send&link=${encodeURIComponent(link)}`) });
  return true;
}
