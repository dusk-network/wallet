// The wallet's contacts, as its pages ask for them. The background keeps
// them, encrypted with a key that only the unlocked wallet has
// (contactsStore.js), so every call fails with "Wallet locked" while it is
// locked.

import { send } from "../wallet/bus.js";

/** @typedef {import("./contactsStore.js").AddressBookEntry} AddressBookEntry */

async function contacts(op, params = {}) {
  const res = await send({ type: "DUSK_UI_CONTACTS", op, ...params });
  if (res?.error) throw new Error(res.error.message || "Contacts are unavailable");
  if (!res?.ok) throw new Error("Contacts are unavailable");
  return res.result;
}

/**
 * Contacts ordered by name (A-Z) then updatedAt (newest first).
 * @param {{ query?: string, walletId?: string }} [opts] - `walletId`: the
 *   wallet the page showed, whose contacts these must be
 * @returns {Promise<AddressBookEntry[]>}
 */
export async function listAddressBook(opts = {}) {
  const items = await contacts("list", { query: String(opts?.query ?? ""), ...forWallet(opts?.walletId) });
  return Array.isArray(items) ? items : [];
}

// A change is for the wallet its page showed (`walletId`, its first public
// account): with another wallet unlocked by then, it isn't made.
const forWallet = (walletId) => (walletId ? { walletId: String(walletId) } : {});

/**
 * Save a contact. One saved from a .dusk name keeps the name and when it was
 * checked; one saved from an address alone has neither.
 * @param {{
 *   id?: string, name: string, address: string, type?: "account"|"address"|"unknown",
 *   duskName?: string|null, checkedAt?: number|null,
 * }} entry
 * @param {{ walletId?: string }} [opts] - the wallet the page showed
 * @returns {Promise<AddressBookEntry>}
 */
export function upsertAddressBookEntry(entry, { walletId } = {}) {
  return contacts("upsert", { entry, ...forWallet(walletId) });
}

/**
 * Mark a contact's .dusk name checked, on the contact as saved now and only
 * while it's the one that was checked (contactsStore.js).
 * @param {AddressBookEntry} entry - the contact as the check found it
 * @param {number} [checkedAt]
 * @param {{ walletId?: string }} [opts] - the wallet the page showed
 * @returns {Promise<AddressBookEntry|null>} the contact, or null when it changed
 */
export function markAddressBookNameChecked(entry, checkedAt = Date.now(), { walletId } = {}) {
  return contacts("markChecked", { entry, checkedAt, ...forWallet(walletId) });
}

/**
 * Delete a contact.
 * @param {string} id
 * @param {{ walletId?: string }} [opts] - the wallet the page showed
 */
export async function removeAddressBookEntry(id, { walletId } = {}) {
  if (!id) return;
  await contacts("remove", { id, ...forWallet(walletId) });
}

/**
 * Delete every contact of one wallet, the one the page showed: the others'
 * stay. It needs that wallet unlocked.
 * @param {{ walletId: string }} opts
 */
export async function clearAddressBook({ walletId } = {}) {
  await contacts("clear", forWallet(walletId));
}
