// The wallet sites are connected to now, by its wallet ID (its first public
// account): the one unlocked, or, while locked, the one the next unlock opens.
// "" before any wallet was unlocked since the update: the connections from
// before then count (permissions.js).

import { activeWalletId } from "../shared/wallets.js";
import { getEngineStatus } from "./engineHost.js";

/**
 * @param {object} [status] - the engine's status, when the caller has it
 * @returns {Promise<string>}
 */
export async function siteWalletId(status) {
  const current = status ?? (await getEngineStatus());
  if (current?.isUnlocked) return String(current.accounts?.[0] ?? "");
  return await activeWalletId().catch(() => "");
}
