// The wallet's contacts, kept encrypted (contactsCrypto.js): one record per
// wallet under STORAGE_KEYS.CONTACTS, at that wallet's place. Only the engine
// holds the key, and only while the wallet is unlocked, so the store asks it
// to open the records and to seal them again, through a `vault`:
//
//   open(records) -> { namespace, text }    the unlocked wallet's place, and
//                                           its record's text (null: none)
//   seal(text)    -> { namespace, record }
//
// Each change reads the book, changes it and seals it again, one at a time in
// every window and the background alike, so none writes back a copy that
// another change made old. A record that doesn't open fails the change, and
// nothing is written over it.
//
// Contacts kept in plain text before (STORAGE_KEYS.ADDRESS_BOOK) move into
// the unlocked wallet's record the first time it opens, and the plain copy
// goes. A wallet reset deletes every record and any plain copy, as does
// making a new wallet here: it starts with none.

import { storage, STORAGE_KEYS } from "./storage.js";
import { withStorageLock } from "./storageLock.js";

const RECORDS = STORAGE_KEYS.CONTACTS;
const PLAIN = STORAGE_KEYS.ADDRESS_BOOK;
const LIMIT = 200;

const one = (fn) => withStorageLock(RECORDS, fn);
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * A contact, in the shape the web wallet's contacts share: a name, the
 * address it sends to, and the .dusk name it was saved from with when that
 * name last pointed to the address.
 *
 * @typedef {Object} AddressBookEntry
 * @property {string} id
 * @property {string} name - the contact's name, as the user wrote it
 * @property {string} address - the public account or shielded address it sends to
 * @property {"account"|"address"|"unknown"=} type
 * @property {string=} duskName - the .dusk name it was saved from
 * @property {number=} checkedAt - when `duskName` last resolved to `address` (ms)
 * @property {number} createdAt
 * @property {number} updatedAt
 */

/**
 * @typedef {Object} ContactsVault
 * @property {(records: Record<string, object>) => Promise<{ namespace: string, text: string|null }>} open
 * @property {(text: string) => Promise<{ namespace: string, record: object }>} seal
 */

function createId() {
  try {
    return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  } catch {
    return `${Date.now()}-${Math.random()}`;
  }
}

function prune(book, limit = LIMIT) {
  const entries = Object.entries(book);
  if (entries.length <= limit) return book;
  // The oldest go first, by updatedAt.
  entries.sort((a, b) => (a[1].updatedAt ?? 0) - (b[1].updatedAt ?? 0));
  return Object.fromEntries(entries.slice(-limit));
}

const contactsOf = (value) =>
  Object.fromEntries(Object.entries(isObject(value) ? value : {}).filter(([, entry]) => isObject(entry)));

// The unlocked wallet's book, with the plain contacts from before moved in
// (its own win), the plain copy deleted once the record holding them is kept.
async function readBook(vault) {
  const items = (await storage.get([RECORDS, PLAIN])) ?? {};
  const records = isObject(items[RECORDS]) ? items[RECORDS] : {};
  const { namespace, text } = await vault.open(records);
  if (!namespace) throw new Error("Contacts are unavailable");
  const book = text == null ? {} : JSON.parse(text);
  if (!isObject(book)) throw new Error("Contacts are unavailable");
  if (!(PLAIN in items)) return { namespace, records, book };
  const moved = prune({ ...contactsOf(items[PLAIN]), ...book });
  const kept = await writeBook(vault, { namespace, records, book: moved });
  await storage.remove(PLAIN);
  return kept;
}

// Seal the book again, at the place it was read from.
async function writeBook(vault, { namespace, records, book }) {
  const sealed = await vault.seal(JSON.stringify(book));
  // Another wallet unlocked since the book was read: its place isn't this one.
  if (sealed?.namespace !== namespace) throw new Error("The wallet changed. Try again.");
  const next = { ...records, [namespace]: sealed.record };
  await storage.set({ [RECORDS]: next });
  return { namespace, records: next, book };
}

/**
 * The contacts of the wallet `vault` opens.
 * @param {ContactsVault} vault
 */
export function contactsStore(vault) {
  return {
    /**
     * Contacts ordered by name (A-Z) then updatedAt (newest first).
     * @param {{ query?: string }} [opts]
     * @returns {Promise<AddressBookEntry[]>}
     */
    async list(opts = {}) {
      const q = String(opts?.query ?? "")
        .trim()
        .toLowerCase();
      const { book } = await one(() => readBook(vault));
      let out = Object.values(book);
      if (q) {
        out = out.filter((e) =>
          [e?.name, e?.address, e?.duskName].some((v) => String(v ?? "").toLowerCase().includes(q))
        );
      }
      return out.sort((a, b) => {
        const an = String(a?.name ?? "").toLowerCase();
        const bn = String(b?.name ?? "").toLowerCase();
        if (an < bn) return -1;
        if (an > bn) return 1;
        return (b?.updatedAt ?? 0) - (a?.updatedAt ?? 0);
      });
    },

    /**
     * One contact.
     * @param {string} id
     * @returns {Promise<AddressBookEntry|null>}
     */
    async get(id) {
      if (!id) return null;
      const { book } = await one(() => readBook(vault));
      return book[id] ?? null;
    },

    /**
     * Save a contact. One saved from a .dusk name keeps the name and when it
     * was checked; one saved from an address alone has neither.
     * @param {{
     *   id?: string, name: string, address: string, type?: "account"|"address"|"unknown",
     *   duskName?: string|null, checkedAt?: number|null,
     * }} entry
     * @returns {Promise<AddressBookEntry>}
     */
    async upsert(entry) {
      const id = entry?.id || createId();
      return one(async () => {
        const now = Date.now();
        const read = await readBook(vault);
        const prev = read.book[id];
        const duskName = String(entry?.duskName ?? "").trim().toLowerCase();
        const checkedAt = Number(entry?.checkedAt);
        const next = {
          id,
          name: String(entry?.name ?? "").trim(),
          address: String(entry?.address ?? "").trim(),
          type: entry?.type ?? prev?.type ?? "unknown",
          ...(duskName ? { duskName, checkedAt: Number.isFinite(checkedAt) && checkedAt > 0 ? checkedAt : now } : {}),
          createdAt: prev?.createdAt ?? now,
          updatedAt: now,
        };
        await writeBook(vault, { ...read, book: prune({ ...read.book, [id]: next }) });
        return next;
      });
    },

    /**
     * Mark a contact's .dusk name checked, on the contact as saved now and
     * only while it's the one that was checked: the same name, address and
     * .dusk name. A contact edited or deleted during the check stays as it
     * is, and nothing else changes, its place in the list included.
     * @param {AddressBookEntry} checked - the contact as the check found it
     * @param {number} [checkedAt]
     * @returns {Promise<AddressBookEntry|null>} the contact, or null when it changed
     */
    async markChecked(checked, checkedAt = Date.now()) {
      const id = checked?.id;
      if (!id || !checked?.duskName) return null;
      return one(async () => {
        const read = await readBook(vault);
        const prev = read.book[id];
        if (!prev || prev.name !== checked.name || prev.address !== checked.address || prev.duskName !== checked.duskName) {
          return null;
        }
        const next = { ...prev, checkedAt };
        await writeBook(vault, { ...read, book: { ...read.book, [id]: next } });
        return next;
      });
    },

    /**
     * Delete a contact.
     * @param {string} id
     */
    async remove(id) {
      if (!id) return;
      await one(async () => {
        const read = await readBook(vault);
        if (!read.book[id]) return;
        const { [id]: _gone, ...rest } = read.book;
        await writeBook(vault, { ...read, book: rest });
      });
    },
  };
}

/**
 * Move the plain contacts kept before they were encrypted into the unlocked
 * wallet's record, and delete the plain copy. Nothing to move, nothing done.
 * @param {ContactsVault} vault
 */
export async function moveLegacyContacts(vault) {
  const items = (await storage.get(PLAIN)) ?? {};
  if (!(PLAIN in items)) return;
  await one(() => readBook(vault));
}

/**
 * Delete every contact kept here: each wallet's record, and any plain copy
 * from before they were encrypted. It needs no key, so it works while the
 * wallet is locked.
 */
export function clearContacts() {
  return one(() => storage.remove([RECORDS, PLAIN]));
}
