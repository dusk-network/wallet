import { storage, STORAGE_KEYS } from "./storage.js";
import { withStorageLock } from "./storageLock.js";

// Every change reads the whole book and writes it back: one at a time, in
// every window and the background alike, so none writes back a copy that
// another change made old.
const mutate = (fn) => withStorageLock(STORAGE_KEYS.ADDRESS_BOOK, fn);

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

function createId() {
  try {
    return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  } catch {
    return `${Date.now()}-${Math.random()}`;
  }
}

async function getAll() {
  const items = await storage.get(STORAGE_KEYS.ADDRESS_BOOK);
  return /** @type {Record<string, AddressBookEntry>} */ (
    items?.[STORAGE_KEYS.ADDRESS_BOOK] ?? {}
  );
}

async function setAll(next) {
  await storage.set({ [STORAGE_KEYS.ADDRESS_BOOK]: next });
}

function prune(store, limit = 200) {
  const entries = Object.entries(store);
  if (entries.length <= limit) return store;
  // Prune by oldest updatedAt.
  entries.sort((a, b) => (a[1].updatedAt ?? 0) - (b[1].updatedAt ?? 0));
  const keep = entries.slice(-limit);
  return Object.fromEntries(keep);
}

/**
 * List contacts ordered by name (A-Z) then updatedAt (newest first).
 * @param {{ query?: string }} [opts]
 * @returns {Promise<AddressBookEntry[]>}
 */
export async function listAddressBook(opts = {}) {
  const q = String(opts.query ?? "")
    .trim()
    .toLowerCase();

  const all = await getAll();
  let out = Object.values(all);

  if (q) {
    out = out.filter((e) => {
      const name = String(e?.name ?? "").toLowerCase();
      const addr = String(e?.address ?? "").toLowerCase();
      const duskName = String(e?.duskName ?? "").toLowerCase();
      return name.includes(q) || addr.includes(q) || duskName.includes(q);
    });
  }

  out.sort((a, b) => {
    const an = String(a?.name ?? "").toLowerCase();
    const bn = String(b?.name ?? "").toLowerCase();
    if (an < bn) return -1;
    if (an > bn) return 1;
    return (b?.updatedAt ?? 0) - (a?.updatedAt ?? 0);
  });

  return out;
}

/**
 * Get a single entry.
 * @param {string} id
 * @returns {Promise<AddressBookEntry|null>}
 */
export async function getAddressBookEntry(id) {
  if (!id) return null;
  const all = await getAll();
  return all[id] ?? null;
}

/**
 * Upsert an entry. A contact saved from a .dusk name keeps the name and when
 * it was checked; one saved from an address alone has neither.
 * @param {{
 *   id?: string, name: string, address: string, type?: "account"|"address"|"unknown",
 *   duskName?: string|null, checkedAt?: number|null,
 * }} entry
 * @returns {Promise<AddressBookEntry>}
 */
export async function upsertAddressBookEntry(entry) {
  const id = entry?.id || createId();
  return mutate(async () => {
    const now = Date.now();
    const all = await getAll();
    const prev = all[id];

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

    all[id] = next;
    await setAll(prune(all));
    return next;
  });
}

/**
 * Mark a contact's .dusk name checked, on the contact as saved now and only
 * while it's the one that was checked: the same name, address and .dusk
 * name. A contact edited or deleted during the check stays as it is, and
 * nothing else changes, its place in the list included.
 * @param {AddressBookEntry} checked - the contact as the check found it
 * @param {number} [checkedAt]
 * @returns {Promise<AddressBookEntry|null>} the contact, or null when it changed
 */
export async function markAddressBookNameChecked(checked, checkedAt = Date.now()) {
  const id = checked?.id;
  if (!id || !checked?.duskName) return null;
  return mutate(async () => {
    const all = await getAll();
    const prev = all[id];
    if (!prev || prev.name !== checked.name || prev.address !== checked.address || prev.duskName !== checked.duskName) {
      return null;
    }
    all[id] = { ...prev, checkedAt };
    await setAll(all);
    return all[id];
  });
}

/**
 * Remove an entry.
 * @param {string} id
 */
export async function removeAddressBookEntry(id) {
  if (!id) return;
  await mutate(async () => {
    const all = await getAll();
    if (!all[id]) return;
    delete all[id];
    await setAll(all);
  });
}

export async function clearAddressBook() {
  await mutate(() => setAll({}));
}
