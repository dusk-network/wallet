// The verified .dusk names of the wallet's profiles for sites and approvals.
//
// They are the checks kept in verifiedNames.js, so reading them never waits
// for a lookup. A profile's name checked over a minute ago is checked again by
// the engine, which loads the names code and the lens driver so the service
// worker never does; its answer reaches connected sites as profilesChanged
// (dappEvents.js).

import { namesToRecheck, readVerifiedNames, verifiedNamesFor } from "../shared/verifiedNames.js";
import { engineCall } from "./engineHost.js";

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
