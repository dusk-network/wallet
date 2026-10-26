// Transaction history kept on this device (IndexedDB): each public account's
// entries from the archive node and the heights they cover, per network, so
// Activity paints at once and a refresh only asks for what is new; the
// counterparties' name checks; and the shielded history, with the note
// tree's heights it hides its lookups among.
//
// IndexedDB rather than chrome.storage: a busy account's history outgrows
// chrome.storage's quota. Every extension page shares it, as the shielded
// note cache does.

const DB_NAME = "dusk_activity_v1";
const DB_VERSION = 1;

const STORE_META = "moonlight_meta";
const STORE_ENTRIES = "moonlight_entries";
const STORE_NAMES = "counterparty_names";
// Shielded history (phoenixHistory.js): the note tree's heights per network,
// and each profile's history, kept for good: Phoenix is off.
const STORE_POOLS = "phoenix_pools";
const STORE_SHIELDED = "phoenix_history";
// Nodes that answered without the archive, and when.
const STORE_REFUSALS = "archive_refusals";
const STORES = [STORE_META, STORE_ENTRIES, STORE_NAMES, STORE_POOLS, STORE_SHIELDED, STORE_REFUSALS];

/** @type {Promise<IDBDatabase> | null} */
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available in this environment"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: "ownerKey" });
      }
      if (!db.objectStoreNames.contains(STORE_ENTRIES)) {
        const entries = db.createObjectStore(STORE_ENTRIES, { keyPath: "id" });
        entries.createIndex("byOwnerHeight", ["ownerKey", "blockHeight"], { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_NAMES)) {
        db.createObjectStore(STORE_NAMES, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_POOLS)) {
        db.createObjectStore(STORE_POOLS, { keyPath: "network" });
      }
      if (!db.objectStoreNames.contains(STORE_SHIELDED)) {
        db.createObjectStore(STORE_SHIELDED, { keyPath: "ownerKey" });
      }
      if (!db.objectStoreNames.contains(STORE_REFUSALS)) {
        db.createObjectStore(STORE_REFUSALS, { keyPath: "url" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("Failed to open the activity store"));
  });
  // A store that failed to open is opened again by the next call.
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

const done = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error || new Error("Activity store transaction failed"));
  });

const result = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("Activity store read failed"));
  });

// The store's lifecycle: a count of wallet resets, kept beside the sync states.
const LIFECYCLE = "lifecycle";

/** A write refused because the wallet was reset since its work began. */
export class StaleActivityError extends Error {
  constructor() {
    super("The wallet was reset since this work began");
    this.name = "StaleActivityError";
  }
}

/**
 * How many times the store was cleared for a wallet reset. Work that reads
 * it before it starts, and hands it to its writes, can't write anything back
 * after a reset: each write checks it in its own transaction.
 * @returns {Promise<number>}
 */
export async function getActivityEpoch() {
  const db = await openDb();
  const tx = db.transaction([STORE_META], "readonly");
  return Number((await result(tx.objectStore(STORE_META).get(LIFECYCLE)))?.epoch) || 0;
}

/**
 * One write transaction over `stores` that runs `write(tx)` only while the
 * store's epoch is still `epoch` (no check when it is undefined).
 * @returns {Promise<void>}
 */
async function guardedWrite(stores, epoch, write) {
  const db = await openDb();
  const tx = db.transaction([...new Set([STORE_META, ...stores])], "readwrite");
  let stale = false;
  if (epoch === undefined) write(tx);
  else {
    const life = tx.objectStore(STORE_META).get(LIFECYCLE);
    life.onsuccess = () => {
      if ((Number(life.result?.epoch) || 0) !== epoch) {
        stale = true;
        tx.abort();
        return;
      }
      write(tx);
    };
  }
  try {
    await done(tx);
  } catch (error) {
    throw stale ? new StaleActivityError() : error;
  }
}

/**
 * The key one account's history is kept under on one network.
 * @param {string} networkKey
 * @param {string} account
 */
export function activityOwnerKey(networkKey, account) {
  return `${String(networkKey)}::${String(account)}`;
}

/** @returns {Promise<object|null>} the sync state of an account, or null before its first sync */
export async function getActivityMeta(ownerKey) {
  const db = await openDb();
  const tx = db.transaction([STORE_META], "readonly");
  return (await result(tx.objectStore(STORE_META).get(ownerKey))) ?? null;
}

/**
 * Keep a sync step: its entries and the new sync state, which `update` makes
 * from the state kept now, in one transaction, so two pages syncing the same
 * account never lose each other's coverage.
 *
 * @param {string} ownerKey
 * @param {object[]} entries - each with a `hash` and a `blockHeight`
 * @param {(meta: object|null) => object} update
 * @param {number} [epoch] - getActivityEpoch when the work began
 * @returns {Promise<object>} the state kept
 */
export async function commitActivityStep(ownerKey, entries, update, epoch) {
  let next = null;
  await guardedWrite([STORE_META, STORE_ENTRIES], epoch, (tx) => {
    const metaStore = tx.objectStore(STORE_META);
    const entryStore = tx.objectStore(STORE_ENTRIES);
    const req = metaStore.get(ownerKey);
    req.onsuccess = () => {
      next = { ...update(req.result ?? null), ownerKey };
      metaStore.put(next);
    };
    for (const entry of entries) {
      // An entry read again (the finality overlap) is the same row: it keeps
      // the details already added to it.
      const id = `${ownerKey}::${entry.hash}`;
      const get = entryStore.get(id);
      get.onsuccess = () => entryStore.put({ ...(get.result ?? {}), ...entry, ownerKey, id });
    }
  });
  return next;
}

/**
 * Add details (time, outcome, fee, call) to kept entries, by hash. Entries
 * that are not kept are left alone.
 * @param {string} ownerKey
 * @param {Map<string, object>} details
 * @param {number} [epoch] - getActivityEpoch when the work began
 */
export async function patchActivityEntries(ownerKey, details, epoch) {
  if (!details?.size) return;
  await guardedWrite([STORE_ENTRIES], epoch, (tx) => {
    const store = tx.objectStore(STORE_ENTRIES);
    for (const [hash, patch] of details) {
      const req = store.get(`${ownerKey}::${hash}`);
      req.onsuccess = () => {
        if (req.result) store.put({ ...req.result, ...patch });
      };
    }
  });
}

/**
 * Kept entries, newest first: at most `limit` of them, below `before` when
 * given.
 * @param {string} ownerKey
 * @param {{ limit?: number, before?: number }} [opts]
 * @returns {Promise<object[]>}
 */
export async function listActivityEntries(ownerKey, { limit = 200, before } = {}) {
  const db = await openDb();
  const tx = db.transaction([STORE_ENTRIES], "readonly");
  const index = tx.objectStore(STORE_ENTRIES).index("byOwnerHeight");
  const upper = Number.isFinite(before) ? [ownerKey, before] : [ownerKey, Infinity];
  const range = IDBKeyRange.bound([ownerKey, -Infinity], upper, false, Number.isFinite(before));
  const out = [];
  await new Promise((resolve, reject) => {
    const req = index.openCursor(range, "prev");
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor || out.length >= limit) return resolve();
      out.push(cursor.value);
      cursor.continue();
    };
    req.onerror = () => reject(req.error || new Error("Activity store read failed"));
  });
  return out;
}

/**
 * Forget an account's kept history on one network: entries and sync state.
 * @param {string} ownerKey
 * @param {number} [epoch] - getActivityEpoch when the work began
 */
export async function clearActivity(ownerKey, epoch) {
  await guardedWrite([STORE_META, STORE_ENTRIES], epoch, (tx) => {
    tx.objectStore(STORE_META).delete(ownerKey);
    const index = tx.objectStore(STORE_ENTRIES).index("byOwnerHeight");
    const req = index.openCursor(IDBKeyRange.bound([ownerKey, -Infinity], [ownerKey, Infinity]));
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };
  });
}

/**
 * Kept name checks of counterparties, by account: `{ name, at }`, `name` null
 * for an account without one.
 * @param {string} network
 * @param {string[]} accounts
 * @returns {Promise<Map<string, { name: string|null, at: number }>>}
 */
export async function getCounterpartyNames(network, accounts) {
  const out = new Map();
  if (!accounts.length) return out;
  const db = await openDb();
  const tx = db.transaction([STORE_NAMES], "readonly");
  const store = tx.objectStore(STORE_NAMES);
  await Promise.all(
    accounts.map(async (account) => {
      const row = await result(store.get(`${network}::${account}`));
      if (row) out.set(account, { name: row.name ?? null, at: Number(row.at) || 0 });
    })
  );
  return out;
}

/**
 * Keep name checks of counterparties.
 * @param {string} network
 * @param {Map<string, string|null>} names - by account
 * @param {{ at?: number, epoch?: number }} [opts] - `epoch`: getActivityEpoch when the lookups began
 */
export async function putCounterpartyNames(network, names, { at = Date.now(), epoch } = {}) {
  if (!names.size) return;
  await guardedWrite([STORE_NAMES], epoch, (tx) => {
    const store = tx.objectStore(STORE_NAMES);
    for (const [account, name] of names) {
      store.put({ id: `${network}::${account}`, network, account, name: name ?? null, at });
    }
  });
}

/**
 * The note tree's distinct heights on a network, kept from the shielded sync
 * or one read of the tree: `{ network, heights, notes }`, or null.
 * @param {string} network
 */
export async function getNoteHeightPool(network) {
  const db = await openDb();
  const tx = db.transaction([STORE_POOLS], "readonly");
  return (await result(tx.objectStore(STORE_POOLS).get(network))) ?? null;
}

/**
 * Keep a network's note-tree heights.
 * @param {string} network
 * @param {number[]} heights
 * @param {number} notes - how many leaves they come from
 * @param {number} [epoch] - getActivityEpoch when the work began
 */
export async function putNoteHeightPool(network, heights, notes, epoch) {
  await guardedWrite([STORE_POOLS], epoch, (tx) => {
    tx.objectStore(STORE_POOLS).put({ network, heights, notes, at: Date.now() });
  });
}

/** A profile's kept shielded history: `{ ownerKey, fingerprint, entries, decoys }`, or null. */
export async function getShieldedHistoryRecord(ownerKey) {
  const db = await openDb();
  const tx = db.transaction([STORE_SHIELDED], "readonly");
  return (await result(tx.objectStore(STORE_SHIELDED).get(ownerKey))) ?? null;
}

/**
 * Keep a profile's shielded history, with the decoy heights it was asked among.
 * @param {number} [epoch] - getActivityEpoch when the work began
 */
export async function putShieldedHistoryRecord(ownerKey, record, epoch) {
  await guardedWrite([STORE_SHIELDED], epoch, (tx) => {
    tx.objectStore(STORE_SHIELDED).put({ ...record, ownerKey, at: Date.now() });
  });
}

/** When `url` last answered without the archive, or null. */
export async function getArchiveRefusal(url) {
  const db = await openDb();
  const tx = db.transaction([STORE_REFUSALS], "readonly");
  const row = await result(tx.objectStore(STORE_REFUSALS).get(String(url)));
  return Number.isFinite(row?.at) ? row.at : null;
}

/** Note that `url` answered without the archive. */
export async function putArchiveRefusal(url, at = Date.now()) {
  const db = await openDb();
  const tx = db.transaction([STORE_REFUSALS], "readwrite");
  tx.objectStore(STORE_REFUSALS).put({ url: String(url), at });
  await done(tx);
}

/**
 * Forget everything kept here, for a wallet reset, and count the reset: work
 * that began before it writes nothing after it (getActivityEpoch).
 */
export async function clearActivityStore() {
  const db = await openDb();
  const tx = db.transaction(STORES, "readwrite");
  const meta = tx.objectStore(STORE_META);
  const life = meta.get(LIFECYCLE);
  life.onsuccess = () => {
    const epoch = (Number(life.result?.epoch) || 0) + 1;
    for (const name of STORES) tx.objectStore(name).clear();
    meta.put({ ownerKey: LIFECYCLE, epoch });
  };
  await done(tx);
}
