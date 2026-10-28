// What a wallet reset clears besides the vault and the site permissions: the
// wallet's transactions, its shielded notes, its history, its deposits' arrivals
// on DuskEVM and its contacts.
//
// A reset is noted before the vault goes. If any of these can't be cleared,
// the reset fails and stays noted, and no new wallet is made until another
// reset, or the next one's creation, clears them all: a new wallet never sees
// the old one's data.
//
// A restore after a forgotten password notes the wallet it makes, and stays
// noted until that wallet's vault is: one cut short in between leaves no
// vault, and the next wallet made here keeps those contacts only if it's
// the same wallet.

import { clearActivityStore } from "./activityStore.js";
import { clearArrivals } from "./bridgeArrival.js";
import { clearContacts, keepOnlyContactsOf } from "./contactsStore.js";
import { clearShieldedStore } from "./shieldedStore.js";
import { storage, STORAGE_KEYS } from "./storage.js";
import { clearTxs } from "./txStore.js";

/**
 * Note that a reset began, before anything is cleared: for a restore, with
 * the wallet it makes (`keepContactsOf`, its ID).
 * @param {{ keepContactsOf?: string }} [opts]
 */
export async function beginReset({ keepContactsOf } = {}) {
  await storage.set({ [STORAGE_KEYS.RESET_PENDING]: { at: Date.now(), ...(keepContactsOf ? { keepContactsOf } : {}) } });
}

/**
 * Clear the old wallet's data, every store tried. Throws when a store
 * couldn't be cleared, and the reset stays pending. A wallet restored in
 * place of the old one (`keepContactsOf`, its ID) keeps its own contacts.
 * @param {{ keepContactsOf?: string | null }} [opts]
 */
export async function clearWalletData({ keepContactsOf } = {}) {
  const contacts = keepContactsOf ? keepOnlyContactsOf(keepContactsOf) : clearContacts();
  const results = await Promise.allSettled([clearTxs(), clearShieldedStore(), clearActivityStore(), clearArrivals(), contacts]);
  if (results.some((r) => r.status === "rejected")) {
    throw new Error("The old wallet's data couldn't be cleared. Try again.");
  }
}

/** End a reset: once all is cleared, or once a new wallet's vault is made. */
export async function endReset() {
  await storage.remove(STORAGE_KEYS.RESET_PENDING);
}

/**
 * Clear the old wallet's data, then end the reset.
 * @param {{ keepContactsOf?: string }} [opts]
 */
export async function finishReset(opts = {}) {
  await clearWalletData(opts);
  await endReset();
}

/**
 * Before a new wallet is made: finish a reset that couldn't clear
 * everything, keeping the contacts of the wallet a restore was making. Throws
 * while it still can't. The reset stays noted until the new wallet's vault is
 * made (endReset), so the caller learns whether there was one, and which
 * wallet a restore was making: its contacts stay only if it's the one made.
 * @returns {Promise<{ pending: boolean, keepContactsOf: string | null }>}
 */
export async function finishPendingReset() {
  const pending = (await storage.get(STORAGE_KEYS.RESET_PENDING))?.[STORAGE_KEYS.RESET_PENDING];
  if (!pending) return { pending: false, keepContactsOf: null };
  const keepContactsOf = typeof pending.keepContactsOf === "string" && pending.keepContactsOf ? pending.keepContactsOf : null;
  await clearWalletData({ keepContactsOf });
  return { pending: true, keepContactsOf };
}
