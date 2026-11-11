// A request link from the web wallet's Send, for the extension's own Send: what
// the page's offer asks (requestLinkOffer.js), or the web wallet itself through
// the provider (dusk_openPaymentLink). Only a link of the page it comes from, on
// a network's own web wallet, and only as a form to fill in: nothing goes until
// its Review and Confirm.

import { makePaymentLink, parsePaymentLink, readPaymentLink } from "@dusk-network/app-core/payment-links";

import { openWalletTab } from "./walletTab.js";
import { isPhone } from "../ui/lib/device.js";
import { ERROR_CODES, rpcError } from "../shared/errors.js";
import { isLocalHttpHostname } from "../shared/securityPolicy.js";
import { getSettings } from "../shared/settings.js";
import { loadVault } from "../shared/vault.js";

const originOf = (url) => {
  try {
    return new URL(String(url ?? "")).origin;
  } catch {
    return "";
  }
};

// Whether an address is on this machine.
const onThisMachine = (url) => {
  try {
    return isLocalHttpHostname(new URL(String(url ?? "")).hostname);
  } catch {
    return false;
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

// The extension's Send, with the link filled in, in the wallet's tab. On a
// phone, in place of the web page's tab that handed it over (`fromTab`):
// both are called Dusk Wallet, and one more piled up with each link.
const openSend = (link, fromTab) =>
  openWalletTab(`full.html?route=send&link=${encodeURIComponent(link)}`, { replacing: isPhone() ? fromTab : undefined });

/**
 * Opens the extension's Send on a tab of its own, with the link filled in.
 * @param {{ link?: string }} message
 * @param {{ url?: string, tab?: { url?: string } }} sender
 * @returns {Promise<boolean>} whether it opened
 */
export async function openRequestLink(message, sender) {
  const link = linkOf(message, sender);
  if (!link) return false;
  await openSend(link, sender?.tab?.id);
  return true;
}

// A web wallet's own request link, as Send reads it: a network's web wallet's
// as it is, for Send to read and refuse as it does any; one on this machine's,
// while the wallet's node is on this machine too, as its network's would be,
// once it reads as Send reads one (`problem`: what Send would say of it) and
// says the network it's for, which what's rebuilt keeps, saying no more than
// it reads to. Any other page on this machine is no web wallet.
async function siteLinkOf(origin, raw) {
  const link = String(raw ?? "");
  if (!origin || originOf(link) !== origin) return {};
  if (parsePaymentLink(link)?.form === "https") return { link };
  const at = link.indexOf("/dashboard/send");
  if (!onThisMachine(origin) || at <= 0) return {};
  if (!onThisMachine((await getSettings())?.nodeUrl)) return { problem: "params.link from this machine needs the wallet on a node on this machine" };
  const read = readPaymentLink(link, { walletUrl: link.slice(0, at) });
  if (!read?.link || read.link.form !== "https") return { problem: read?.problem ?? "" };
  if (!read.link.chainId) return { problem: "params.link must say the network it's for" };
  const { chainId, label, lux, memo, to } = read.link;
  const made = makePaymentLink({ amountLux: lux === null ? "" : String(lux), label, memo, network: chainId, to });
  return made.ok ? { link: made.https ?? made.dusk } : { problem: Object.values(made.problems)[0] ?? "" };
}

/**
 * A web wallet's request, handed to the extension's Send (dusk_openPaymentLink):
 * a link of the asking page's own web wallet, a network's or one on this
 * machine, asked on a person's press. Opens Send filled in; nothing goes until
 * its Review and Confirm. False where there's no wallet here to pay it with.
 * @param {string} origin - the asking page's
 * @param {unknown} link
 * @param {{ pressed?: boolean, tabId?: number }} [context] - whether the page had a press when it asked, where the browser says, and its tab
 * @returns {Promise<boolean>} whether Send opened
 */
export async function handOverRequestLink(origin, link, { pressed, tabId } = {}) {
  const { link: own, problem } = await siteLinkOf(origin, link);
  if (!own) throw rpcError(ERROR_CODES.INVALID_PARAMS, problem || "params.link must be a request link to this web wallet's own Send");
  if (pressed === false) throw rpcError(ERROR_CODES.UNAUTHORIZED, "Hand a request over from a press of the person's");
  if (!(await loadVault())) return false;
  await openSend(own, tabId);
  return true;
}
