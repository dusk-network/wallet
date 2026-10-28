// The wallet's contacts, as its pages ask for them. The background keeps
// them, encrypted with a key that only the unlocked wallet has
// (contactsStore.js), so every call but clearAddressBook fails with "Wallet
// locked" while it is locked.

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
 * @param {{ query?: string }} [opts]
 * @returns {Promise<AddressBookEntry[]>}
 */
export async function listAddressBook(opts = {}) {
  const items = await contacts("list", { query: String(opts?.query ?? "") });
  return Array.isArray(items) ? items : [];
}

/**
 * Save a contact. One saved from a .dusk name keeps the name and when it was
 * checked; one saved from an address alone has neither.
 * @param {{
 *   id?: string, name: string, address: string, type?: "account"|"address"|"unknown",
 *   duskName?: string|null, checkedAt?: number|null,
 * }} entry
 * @returns {Promise<AddressBookEntry>}
 */
export function upsertAddressBookEntry(entry) {
  return contacts("upsert", { entry });
}

/**
 * Mark a contact's .dusk name checked, on the contact as saved now and only
 * while it's the one that was checked (contactsStore.js).
 * @param {AddressBookEntry} entry - the contact as the check found it
 * @param {number} [checkedAt]
 * @returns {Promise<AddressBookEntry|null>} the contact, or null when it changed
 */
export function markAddressBookNameChecked(entry, checkedAt = Date.now()) {
  return contacts("markChecked", { entry, checkedAt });
}

/**
 * Delete a contact.
 * @param {string} id
 */
export async function removeAddressBookEntry(id) {
  if (!id) return;
  await contacts("remove", { id });
}

/** Delete every contact, locked or not. */
export async function clearAddressBook() {
  await contacts("clear");
}
