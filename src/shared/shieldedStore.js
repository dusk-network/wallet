// Shielded note storage (IndexedDB)
// - Persist a per-network, per-profile note map for shielded balance computation.
// - Persist a sync cursor (bookmark + block height) so subsequent syncs are incremental.
//
// We intentionally use IndexedDB because chrome.storage is size-limited.

import { bytesToHex, hexToBytes } from "./bytes.js";

const DB_NAME = "dusk_shielded_v1";
const DB_VERSION = 2;

const STORE_META = "meta";
const STORE_NOTES = "notes";
const STORE_SPENT = "spent";
const STORE_PENDING = "pending";

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

      // meta: one row per (networkKey, walletId, profileIndex)
      if (!db.objectStoreNames.contains(STORE_META)) {
        const meta = db.createObjectStore(STORE_META, { keyPath: "ownerKey" });
        meta.createIndex("byNetwork", "networkKey", { unique: false });
      }

      // notes: one row per note, keyed by `${ownerKey}::${noteKeyHex}` where ownerKey includes walletId
      if (!db.objectStoreNames.contains(STORE_NOTES)) {
        const notes = db.createObjectStore(STORE_NOTES, { keyPath: "id" });
        notes.createIndex("byOwner", "ownerKey", { unique: false });
      }

      // spent: one row per spent note (kept so we can "unspend" on reorg)
      if (!db.objectStoreNames.contains(STORE_SPENT)) {
        const spent = db.createObjectStore(STORE_SPENT, { keyPath: "id" });
        spent.createIndex("byOwner", "ownerKey", { unique: false });
      }

      // pending: nullifiers reserved by locally submitted phoenix txs
      // (prevents double-spend before the chain marks them as spent)
      if (!db.objectStoreNames.contains(STORE_PENDING)) {
        const pending = db.createObjectStore(STORE_PENDING, { keyPath: "id" });
        pending.createIndex("byOwner", "ownerKey", { unique: false });
        // Query pending nullifiers by tx hash for a given owner.
        // IndexedDB supports compound index keys.
        pending.createIndex("byOwnerTx", ["ownerKey", "txHash"], { unique: false });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("Failed to open IndexedDB"));
  });

  return dbPromise;
}

function ownerKey(networkKey, walletId, profileIndex) {
  // IMPORTANT: Shielded note caches must be wallet-specific.
  const wid = String(walletId || "").trim();
  return `${String(networkKey)}::${wid}::${Number(profileIndex)}`;
}

function noteId(ownerKeyStr, noteKeyHex) {
  return `${ownerKeyStr}::${String(noteKeyHex)}`;
}

function asBigIntString(v) {
  try {
    return v === undefined || v === null ? "" : BigInt(v).toString();
  } catch {
    return "";
  }
}

function parseBigIntString(s, fallback = 0n) {
  try {
    if (typeof s !== "string" || !s) return fallback;
    return BigInt(s);
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

export async function getShieldedMeta(networkKey, walletId, profileIndex = 0) {
  const db = await openDb();
  const key = ownerKey(networkKey, walletId, profileIndex);

  return await new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_META], "readonly");
    const store = tx.objectStore(STORE_META);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error || new Error("Failed to read meta"));
  });
}

export async function putShieldedMeta(networkKey, walletId, profileIndex, metaPatch) {
  const db = await openDb();
  const key = ownerKey(networkKey, walletId, profileIndex);

  const prev = (await getShieldedMeta(networkKey, walletId, profileIndex)) || {
    ownerKey: key,
    networkKey: String(networkKey),
    walletId: String(walletId || ""),
    profileIndex: Number(profileIndex),
  };

  const next = {
    ...prev,
    ...metaPatch,
    ownerKey: key,
    networkKey: String(networkKey),
    walletId: String(walletId || ""),
    profileIndex: Number(profileIndex),
    updatedAt: Date.now(),
  };

  await new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_META], "readwrite");
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error("Failed to write meta"));
    tx.objectStore(STORE_META).put(next);
  });

  return next;
}

export async function ensureShieldedMeta(networkKey, walletId, profileIndex = 0, defaults = {}) {
  const cur = await getShieldedMeta(networkKey, walletId, profileIndex);
  if (cur) return cur;

  // defaults:
  // - checkpointBookmark, checkpointBlock
  // - cursorBookmark, cursorBlock
  const created = {
    ownerKey: ownerKey(networkKey, walletId, profileIndex),
    networkKey: String(networkKey),
    walletId: String(walletId || ""),
    profileIndex: Number(profileIndex),
    checkpointBookmark: asBigIntString(defaults.checkpointBookmark ?? 0n),
    checkpointBlock: asBigIntString(defaults.checkpointBlock ?? 0n),
    cursorBookmark: asBigIntString(defaults.cursorBookmark ?? defaults.checkpointBookmark ?? 0n),
    cursorBlock: asBigIntString(defaults.cursorBlock ?? defaults.checkpointBlock ?? 0n),
    updatedAt: Date.now(),
  };

  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_META], "readwrite");
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error("Failed to create meta"));
    tx.objectStore(STORE_META).put(created);
  });
  return created;
}

export function metaCursor(meta) {
  return {
    bookmark: parseBigIntString(meta?.cursorBookmark, 0n),
    block: parseBigIntString(meta?.cursorBlock, 0n),
  };
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

async function clearStoreByOwner(db, storeName, ownerKeyStr) {
  return await new Promise((resolve, reject) => {
    const tx = db.transaction([storeName], "readwrite");
    tx.oncomplete = () => resolve(true);
    tx.onerror = () =>
      reject(tx.error || new Error(`Failed to clear ${storeName}`));

    const store = tx.objectStore(storeName);
    const index = store.index("byOwner");
    const req = index.openCursor(IDBKeyRange.only(ownerKeyStr));
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };
  });
}

export async function clearNotes(networkKey, walletId, profileIndex = 0) {
  const db = await openDb();
  const ok = ownerKey(networkKey, walletId, profileIndex);

  // Clear all shielded caches for this owner (unspent, spent, pending).
  await clearStoreByOwner(db, STORE_PENDING, ok).catch(() => {});
  await clearStoreByOwner(db, STORE_SPENT, ok).catch(() => {});
  await clearStoreByOwner(db, STORE_NOTES, ok).catch(() => {});
}

export async function putNotesMap(networkKey, walletId, profileIndex, notesMap) {
  const db = await openDb();
  const ok = ownerKey(networkKey, walletId, profileIndex);

  // notesMap is Map<Uint8Array, Uint8Array>
  const entries = [];
  try {
    for (const [k, v] of notesMap.entries()) {
      const keyHex = bytesToHex(k);
      const valueBytes = v instanceof Uint8Array ? v : new Uint8Array(v);
      // Clone into a standalone buffer to avoid subtle view slicing issues.
      const buf = valueBytes.buffer.slice(
        valueBytes.byteOffset,
        valueBytes.byteOffset + valueBytes.byteLength
      );
      entries.push({ keyHex, buf });
    }
  } catch {
    // If notesMap isn't iterable, just return.
    return 0;
  }

  if (!entries.length) return 0;

  await new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NOTES], "readwrite");
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error("Failed to write notes"));

    const store = tx.objectStore(STORE_NOTES);
    for (const e of entries) {
      store.put({
        id: noteId(ok, e.keyHex),
        ownerKey: ok,
        networkKey: String(networkKey),
        walletId: String(walletId || ""),
        profileIndex: Number(profileIndex),
        noteKey: e.keyHex,
        noteValue: e.buf,
        updatedAt: Date.now(),
      });
    }
  });

  return entries.length;
}

export async function getNotesMap(networkKey, walletId, profileIndex = 0) {
  const db = await openDb();
  const ok = ownerKey(networkKey, walletId, profileIndex);

  const rows = await new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NOTES], "readonly");
    const store = tx.objectStore(STORE_NOTES);
    const index = store.index("byOwner");
    const req = index.getAll(IDBKeyRange.only(ok));
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error || new Error("Failed to read notes"));
  });

  const out = new Map();
  for (const r of rows) {
    try {
      const k = hexToBytes(r.noteKey);
      const v = r.noteValue instanceof ArrayBuffer ? new Uint8Array(r.noteValue) : new Uint8Array(r.noteValue || []);
      out.set(k, v);
    } catch {
      // ignore bad rows
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// helpers (spent/pending tracking)
// ---------------------------------------------------------------------------

function makeId(ownerKeyStr, nullifierHex) {
  return noteId(ownerKeyStr, nullifierHex);
}

async function getPendingRows(db, ok) {
  return await new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_PENDING], "readonly");
    const store = tx.objectStore(STORE_PENDING);
    const index = store.index("byOwner");
    const req = index.getAll(IDBKeyRange.only(ok));
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error || new Error("Failed to read pending"));
  });
}

async function getPendingRowsForTx(db, ok, txHash) {
  const hash = String(txHash || "");
  if (!hash) return [];

  return await new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_PENDING], "readonly");
    const store = tx.objectStore(STORE_PENDING);
    const index = store.index("byOwnerTx");
    const req = index.getAll(IDBKeyRange.only([ok, hash]));
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error || new Error("Failed to read pending tx rows"));
  });
}

/**
 * Returns a Map of spendable notes (unspent notes minus locally pending nullifiers).
 */
export async function getSpendableNotesMap(networkKey, walletId, profileIndex = 0) {
  const db = await openDb();
  const ok = ownerKey(networkKey, walletId, profileIndex);

  const [rows, pendingRows] = await Promise.all([
    new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_NOTES], "readonly");
      const store = tx.objectStore(STORE_NOTES);
      const index = store.index("byOwner");
      const req = index.getAll(IDBKeyRange.only(ok));
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error || new Error("Failed to read notes"));
    }),
    getPendingRows(db, ok).catch(() => []),
  ]);

  const pending = new Set();
  for (const r of pendingRows) {
    const h = String(r?.nullifier ?? r?.noteKey ?? "");
    if (h) pending.add(h);
  }

  const out = new Map();
  for (const r of rows) {
    try {
      const keyHex = String(r.noteKey || "");
      if (keyHex && pending.has(keyHex)) continue;
      const k = hexToBytes(keyHex);
      const v = r.noteValue instanceof ArrayBuffer ? new Uint8Array(r.noteValue) : new Uint8Array(r.noteValue || []);
      out.set(k, v);
    } catch {
      // ignore bad rows
    }
  }

  return out;
}

/**
 * List all currently cached unspent nullifiers for this owner.
 * @returns {Promise<Uint8Array[]>}
 */
export async function getUnspentNullifiers(networkKey, walletId, profileIndex = 0) {
  const db = await openDb();
  const ok = ownerKey(networkKey, walletId, profileIndex);

  const rows = await new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NOTES], "readonly");
    const store = tx.objectStore(STORE_NOTES);
    const index = store.index("byOwner");
    const req = index.getAll(IDBKeyRange.only(ok));
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error || new Error("Failed to read notes"));
  });

  const out = [];
  for (const r of rows) {
    try {
      out.push(hexToBytes(r.noteKey));
    } catch {
      // ignore
    }
  }
  return out;
}

/**
 * List all cached spent nullifiers for this owner.
 * @returns {Promise<Uint8Array[]>}
 */
export async function getSpentNullifiers(networkKey, walletId, profileIndex = 0) {
  const db = await openDb();
  const ok = ownerKey(networkKey, walletId, profileIndex);

  const rows = await new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_SPENT], "readonly");
    const store = tx.objectStore(STORE_SPENT);
    const index = store.index("byOwner");
    const req = index.getAll(IDBKeyRange.only(ok));
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error || new Error("Failed to read spent"));
  });

  const out = [];
  for (const r of rows) {
    try {
      out.push(hexToBytes(r.nullifier));
    } catch {
      // ignore
    }
  }
  return out;
}

/**
 * Store locally pending nullifiers for a submitted phoenix tx.
 * These are filtered out from spendable notes until they become spent on chain.
 */
export async function putPendingNullifiers(networkKey, walletId, profileIndex, nullifiers, txHash) {
  const db = await openDb();
  const ok = ownerKey(networkKey, walletId, profileIndex);
  const hash = String(txHash || "");
  if (!hash) return 0;

  const rows = [];
  for (const n of nullifiers || []) {
    try {
      const u8 = n instanceof Uint8Array ? n : new Uint8Array(n);
      const hex = bytesToHex(u8);
      if (!hex) continue;
      rows.push({
        id: makeId(ok, hex),
        ownerKey: ok,
        networkKey: String(networkKey),
        walletId: String(walletId || ""),
        profileIndex: Number(profileIndex),
        nullifier: hex,
        txHash: hash,
        reservationStatus: "pending",
        createdAt: Date.now(),
        reservationUpdatedAt: Date.now(),
      });
    } catch {
      // ignore
    }
  }

  if (!rows.length) return 0;

  await new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_PENDING], "readwrite");
    tx.oncomplete = () => resolve(true);
    tx.onerror = () =>
      reject(tx.error || new Error("Failed to write pending"));

    const store = tx.objectStore(STORE_PENDING);
    for (const r of rows) store.put(r);
  });

  return rows.length;
}

/**
 * Return pending nullifiers reserved by a specific submitted tx.
 * @returns {Promise<string[]>}
 */
export async function getPendingNullifiersForTx(networkKey, walletId, profileIndex, txHash) {
  const db = await openDb();
  const ok = ownerKey(networkKey, walletId, profileIndex);
  const rows = await getPendingRowsForTx(db, ok, txHash);
  return rows.map((r) => String(r?.nullifier ?? "")).filter(Boolean);
}

/**
 * Mark tx-scoped pending rows as recoverable without making them spendable.
 */
export async function markPendingNullifiersRecoverable(networkKey, walletId, profileIndex, txHash, reason = "unknown") {
  const db = await openDb();
  const ok = ownerKey(networkKey, walletId, profileIndex);
  const rows = await getPendingRowsForTx(db, ok, txHash);
  if (!rows.length) return 0;

  await new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_PENDING], "readwrite");
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error("Failed to mark pending recoverable"));

    const store = tx.objectStore(STORE_PENDING);
    const now = Date.now();
    for (const row of rows) {
      store.put({
        ...row,
        reservationStatus: "recoverable",
        recoveryReason: String(reason || "unknown"),
        reservationUpdatedAt: now,
      });
    }
  });

  return rows.length;
}

/**
 * Explicitly release tx-scoped pending rows. This restores spendability and
 * must only be called by a deliberate recovery path, never by timeout alone.
 */
export async function clearPendingNullifiersForTx(networkKey, walletId, profileIndex, txHash) {
  const db = await openDb();
  const ok = ownerKey(networkKey, walletId, profileIndex);
  const rows = await getPendingRowsForTx(db, ok, txHash);
  if (!rows.length) return 0;

  await new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_PENDING], "readwrite");
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error("Failed to clear pending tx rows"));

    const store = tx.objectStore(STORE_PENDING);
    for (const row of rows) store.delete(row.id);
  });

  return rows.length;
}

/**
 * Move notes from unspent -> spent for the provided nullifiers, and clear any
 * pending reservation for them.
 */
export async function markNullifiersSpent(networkKey, walletId, profileIndex, nullifiers) {
  const db = await openDb();
  const ok = ownerKey(networkKey, walletId, profileIndex);

  const hexes = [];
  for (const n of nullifiers || []) {
    try {
      const u8 = n instanceof Uint8Array ? n : new Uint8Array(n);
      const hex = bytesToHex(u8);
      if (hex) hexes.push(hex);
    } catch {
      // ignore
    }
  }
  if (!hexes.length) return 0;

  await new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NOTES, STORE_SPENT, STORE_PENDING], "readwrite");
    tx.oncomplete = () => resolve(true);
    tx.onerror = () =>
      reject(tx.error || new Error("Failed to mark spent"));

    const notes = tx.objectStore(STORE_NOTES);
    const spent = tx.objectStore(STORE_SPENT);
    const pending = tx.objectStore(STORE_PENDING);

    for (const hex of hexes) {
      const id = makeId(ok, hex);
      const req = notes.get(id);
      req.onsuccess = () => {
        const row = req.result;
        if (row) {
          spent.put({
            id,
            ownerKey: ok,
            networkKey: String(networkKey),
            walletId: String(walletId || ""),
            profileIndex: Number(profileIndex),
            nullifier: hex,
            noteKey: row.noteKey,
            noteValue: row.noteValue,
            spentAt: Date.now(),
          });
          notes.delete(id);
        }
        // Always clear pending reservation if present.
        pending.delete(id);
      };
      req.onerror = () => {
        // still clear pending best-effort
        try {
          pending.delete(id);
        } catch {}
      };
    }
  });

  return hexes.length;
}

/**
 * Move notes from spent -> unspent.
 */
export async function unspendNullifiers(networkKey, walletId, profileIndex, nullifiers) {
  const db = await openDb();
  const ok = ownerKey(networkKey, walletId, profileIndex);

  const hexes = [];
  for (const n of nullifiers || []) {
    try {
      const u8 = n instanceof Uint8Array ? n : new Uint8Array(n);
      const hex = bytesToHex(u8);
      if (hex) hexes.push(hex);
    } catch {
      // ignore
    }
  }
  if (!hexes.length) return 0;

  await new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_SPENT, STORE_NOTES], "readwrite");
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error("Failed to unspend"));

    const spent = tx.objectStore(STORE_SPENT);
    const notes = tx.objectStore(STORE_NOTES);

    for (const hex of hexes) {
      const id = makeId(ok, hex);
      const req = spent.get(id);
      req.onsuccess = () => {
        const row = req.result;
        if (row) {
          notes.put({
            id,
            ownerKey: ok,
            networkKey: String(networkKey),
            walletId: String(walletId || ""),
            profileIndex: Number(profileIndex),
            noteKey: row.noteKey ?? hex,
            noteValue: row.noteValue,
            updatedAt: Date.now(),
          });
          spent.delete(id);
        }
      };
    }
  });

  return hexes.length;
}

export async function countNotes(networkKey, walletId, profileIndex = 0) {
  const db = await openDb();
  const ok = ownerKey(networkKey, walletId, profileIndex);

  const n = await new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NOTES], "readonly");
    const store = tx.objectStore(STORE_NOTES);
    const index = store.index("byOwner");
    const req = index.count(IDBKeyRange.only(ok));
    req.onsuccess = () => resolve(Number(req.result || 0));
    req.onerror = () => reject(req.error || new Error("Failed to count notes"));
  });

  return n;
}
