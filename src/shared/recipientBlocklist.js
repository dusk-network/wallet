// Recipients the wallet won't send to, as the network's file lists them
// (@dusk-network/networks): on the node's network, or on any network while
// that isn't known. A guard on this wallet's own forms and approvals only:
// it can't stop transfers from other wallets. The words are the web
// wallet's.

import { blockedReason, networks } from "@dusk-network/networks";

import { networkOf } from "./nodeNetwork.js";

/** The title over a blocked recipient's reason. */
export const BLOCKED_TITLE = "Blocked recipient address";

/** What each reason the files give says. */
const REASONS = Object.freeze({
  compromised: "Transfer restricted: this recipient address has been reported as compromised.",
  scam: "Transfer restricted: this recipient address is associated with reported fraud/scam activity.",
});

/**
 * Why the wallet won't send to `account`, in words, or null when it will.
 * @param {string} account - a public account (or anything typed as a recipient)
 * @param {number | null} [chainId] - the node's chain ID, when known
 * @returns {string | null}
 */
export function blockedRecipient(account, chainId = null) {
  const key = typeof account === "string" ? account.trim() : "";
  if (!key) return null;
  const net = networkOf(chainId);
  const reason = (net ? [net] : Object.values(networks)).map((each) => blockedReason(each, key)).find(Boolean);
  return reason ? REASONS[reason] : null;
}
