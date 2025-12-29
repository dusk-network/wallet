// Shielded note storage (IndexedDB)
// - Persist a per-network, per-profile note map for shielded balance computation.
// - Persist a sync cursor (bookmark + block height) so subsequent syncs are incremental.
//
// We intentionally use IndexedDB because chrome.storage is size-limited.

import { bytesToHex, hexToBytes } from "./bytes.js";

const DB_NAME = "dusk_shielded_v1";
const DB_VERSION = 1;

const STORE_META = "meta";
const STORE_NOTES = "notes";

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

export async function clearNotes(networkKey, walletId, profileIndex = 0) {
  const db = await openDb();
  const ok = ownerKey(networkKey, walletId, profileIndex);

  await new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NOTES], "readwrite");
    const store = tx.objectStore(STORE_NOTES);
    const index = store.index("byOwner");
    const req = index.openCursor(IDBKeyRange.only(ok));
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error("Failed to clear notes"));
  });
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
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error("Failed to write notes"));
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
