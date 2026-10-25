// The verified .dusk names of the wallet's profiles for sites and approvals.
//
// They are the checks kept in verifiedNames.js, so reading them never waits
// for a lookup. A profile's name checked over a minute ago is checked again by
// the engine, which loads the names code and the lens driver so the service
// worker never does. The engine can't keep its checks, as Chrome's offscreen
// document has no storage: it sends each one here (DUSK_NAME_CHECKED), and an
// answer that changes a connected site's profile reaches it as profilesChanged
// (dappEvents.js).
//
// The approval of a site's request to send also shows its recipient's name,
// which the engine looks up once the approval shows and nothing keeps.

import {
  duskNamesNetwork,
  namesToRecheck,
  readVerifiedNames,
  rememberVerifiedName,
  verifiedNamesFor,
} from "../shared/verifiedNames.js";
import { runtimeGetURL } from "../platform/extensionApi.js";
import { engineCall, getEngineStatus } from "./engineHost.js";

// The pages the engine runs in: Chrome's offscreen document and Firefox's
// engine page.
const ENGINE_PAGES = ["offscreen.html", "engine.html"];

// Changes to what sites see of the profiles: a lock or unlock, a permission
// change, a move to a network with other .dusk names, or a new name check.
// Everything that gives a site a profile reads it with readCurrent and sends
// it right away, so a profile read before a change never goes out after it.
let generation = 0;

/** Note a change to what sites see of the profiles. */
export function profileVisibilityChanged() {
  generation += 1;
}

/**
 * What `read` gives, read again until no change to what sites see came in
 * while it read.
 *
 * @template T
 * @param {() => Promise<T>} read
 * @returns {Promise<T>}
 */
export async function readCurrent(read) {
  for (;;) {
    const at = generation;
    const value = await read();
    if (at === generation) return value;
  }
}

/**
 * The names sites and approvals may get on the node's network, by account.
 * Those of `accounts` checked over a minute ago are checked again, without
 * waiting for it.
 *
 * @param {string} nodeUrl - the wallet's node
 * @param {string[]} [accounts] - the accounts whose names are about to be shown
 * @returns {Promise<Map<string, string>>}
 */
export async function siteNames(nodeUrl, accounts = []) {
  const all = await readVerifiedNames();
  const due = namesToRecheck(all, nodeUrl, accounts);
  if (due.length) engineCall("engine_checkNames", { nodeUrl, accounts: due }).catch(() => {});
  return verifiedNamesFor(all, nodeUrl);
}

/**
 * Keep a check the engine sent (DUSK_NAME_CHECKED): only one from the
 * extension's own engine page, of an account of the unlocked wallet.
 *
 * @param {{ nodeUrl?: string, account?: string, name?: string|null }} message
 * @param {{ url?: string }} sender - the message's sender
 * @returns {Promise<boolean>} whether it was taken
 */
export async function keepEngineNameCheck(message, sender) {
  const from = String(sender?.url ?? "").split(/[?#]/)[0];
  const fromEngine = Boolean(from) && ENGINE_PAGES.map((page) => runtimeGetURL(page)).includes(from);
  const { nodeUrl, account, name } = message ?? {};
  const answer = name === null || (typeof name === "string" && name.endsWith(".dusk"));
  if (!fromEngine || typeof account !== "string" || !answer) return false;

  const status = await getEngineStatus();
  if (!status?.isUnlocked || !status.accounts?.includes(account)) return false;
  await rememberVerifiedName(String(nodeUrl ?? ""), account, name);
  return true;
}

/**
 * The .dusk name of the recipient of a site's request to send, for its
 * approval: the engine looks the account's primary name up on the approval's
 * network and checks that the name points back to it (lookupRecipientName).
 * Null for any other request, off Mainnet and Testnet, and when the lookup
 * fails.
 *
 * @param {{ kind?: string, params?: { nodeUrl?: string } } | null} approval - the pending request
 * @param {string} recipient - its recipient, as the approval shows it
 * @returns {Promise<string|null>}
 */
export async function approvalRecipientName(approval, recipient) {
  const nodeUrl = String(approval?.params?.nodeUrl ?? "");
  if (approval?.kind !== "send_tx" || !duskNamesNetwork(nodeUrl)) return null;
  try {
    const name = await engineCall("engine_recipientName", { nodeUrl, recipient: String(recipient ?? "") });
    return typeof name === "string" ? name : null;
  } catch {
    return null;
  }
}
