// The verified .dusk names of the wallet's profiles for sites and approvals.
//
// They are the checks kept in verifiedNames.js, so reading them never waits
// for a lookup. A profile's name checked over a minute ago is checked again by
// the engine, which loads the names code and the lens driver so the service
// worker never does. The engine can't keep its checks, as Chrome's offscreen
// document has no storage: it sends each one here (DUSK_NAME_CHECKED), and an
// answer that changes a connected site's profile reaches it as profilesChanged
// (dappEvents.js).

import {
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
// change, or a move to a network with other .dusk names. A profile update
// begun before one is stale: the change sends sites their profiles again
// (dappEvents.js).
let generation = 0;

/** Note a change to what sites see of the profiles. */
export function profileVisibilityChanged() {
  generation += 1;
}

/** The changes so far: an update begun at another count is stale. */
export function profileVisibilityGeneration() {
  return generation;
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
