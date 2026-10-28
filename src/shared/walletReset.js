// What a wallet reset clears besides the vault and the site permissions: the
// wallet's transactions, its shielded notes, its history and its contacts.
//
// A reset is noted before the vault goes. If any of these can't be cleared,
// the reset fails and stays noted, and no new wallet is made until another
// reset, or the next one's creation, clears them all: a new wallet never sees
// the old one's data.

import { clearActivityStore } from "./activityStore.js";
import { clearContacts, keepOnlyContactsOf } from "./contactsStore.js";
import { clearShieldedStore } from "./shieldedStore.js";
import { storage, STORAGE_KEYS } from "./storage.js";
import { clearTxs } from "./txStore.js";

/** Note that a reset began, before anything is cleared. */
export async function beginReset() {
  await storage.set({ [STORAGE_KEYS.RESET_PENDING]: { at: Date.now() } });
}

/**
 * Clear the old wallet's data, every store tried, then end the reset. Throws
 * when a store couldn't be cleared, and the reset stays pending. A wallet
 * restored in place of the old one (`keepContactsOf`, its ID) keeps its own
 * contacts.
 * @param {{ keepContactsOf?: string }} [opts]
 */
export async function finishReset({ keepContactsOf } = {}) {
  const contacts = keepContactsOf ? keepOnlyContactsOf(keepContactsOf) : clearContacts();
  const results = await Promise.allSettled([clearTxs(), clearShieldedStore(), clearActivityStore(), contacts]);
  if (results.some((r) => r.status === "rejected")) {
    throw new Error("The old wallet's data couldn't be cleared. Try again.");
  }
  await storage.remove(STORAGE_KEYS.RESET_PENDING);
}

/** Finish a reset that couldn't clear everything, before a new wallet is made. Throws while it still can't. */
export async function finishPendingReset() {
  const items = await storage.get(STORAGE_KEYS.RESET_PENDING);
  if (items?.[STORAGE_KEYS.RESET_PENDING]) await finishReset();
}
