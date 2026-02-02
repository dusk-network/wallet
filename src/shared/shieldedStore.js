// Shielded note storage (IndexedDB)
// - Persist a per-network, per-profile note map for shielded balance computation.
// - Persist a sync cursor (bookmark + block height) so subsequent syncs are incremental.
//
// We intentionally use IndexedDB because chrome.storage is size-limited.

import { bytesToHex, hexToBytes } from "./bytes.js";
import { storage } from "./storage.js";
import { isExtensionRuntime, isTauriRuntime } from "../platform/runtime.js";

const DB_NAME = "dusk_shielded_v1";
const DB_VERSION = 2;

const STORE_META = "meta";
const STORE_NOTES = "notes";
const STORE_SPENT = "spent";
const STORE_PENDING = "pending";

const KV_PREFIX = "dusk_shielded_kv_v1";
const KV_META = "meta";
const KV_NOTES = "notes";
const KV_SPENT = "spent";
const KV_PENDING = "pending";

const BACKEND = {
  IDB: "idb",
  KV: "kv",
  MEM: "mem",
};

/** @type {Promise<IDBDatabase> | null} */
let dbPromise = null;
let backend = null;
let backendPromise = null;
let backendError = null;

const memoryStore = {
  [KV_META]: new Map(),
  [KV_NOTES]: new Map(),
  [KV_SPENT]: new Map(),
  [KV_PENDING]: new Map(),
};

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  if (!base64) return new Uint8Array();
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function kvKey(prefix, ownerKeyStr) {
  return `${KV_PREFIX}::${prefix}::${ownerKeyStr}`;
}

async function kvGet(prefix, ownerKeyStr, fallback) {
  if (backend === BACKEND.MEM) {
    return memoryStore[prefix].get(ownerKeyStr) ?? fallback;
  }

  const key = kvKey(prefix, ownerKeyStr);
  try {
    const out = await storage.get(key);
    const val = out[key];
    return val === undefined ? fallback : val;
  } catch (err) {
    backend = BACKEND.MEM;
    backendError = err;
    console.warn(
      "Shielded KV storage unavailable; falling back to memory:",
      err?.message ?? String(err)
    );
    return memoryStore[prefix].get(ownerKeyStr) ?? fallback;
  }
}

async function kvSet(prefix, ownerKeyStr, value) {
  if (backend === BACKEND.MEM) {
    memoryStore[prefix].set(ownerKeyStr, value);
    return;
  }

  const key = kvKey(prefix, ownerKeyStr);
  try {
    await storage.set({ [key]: value });
  } catch (err) {
    backend = BACKEND.MEM;
    backendError = err;
    console.warn(
      "Shielded KV storage unavailable; falling back to memory:",
      err?.message ?? String(err)
    );
    memoryStore[prefix].set(ownerKeyStr, value);
  }
}

async function kvRemove(prefix, ownerKeyStr) {
  if (backend === BACKEND.MEM) {
    memoryStore[prefix].delete(ownerKeyStr);
    return;
  }

  const key = kvKey(prefix, ownerKeyStr);
  try {
    await storage.remove(key);
  } catch (err) {
    backend = BACKEND.MEM;
    backendError = err;
    console.warn(
      "Shielded KV storage unavailable; falling back to memory:",
      err?.message ?? String(err)
    );
    memoryStore[prefix].delete(ownerKeyStr);
  }
}

async function resolveBackend() {
  if (backend) return backend;
  if (backendPromise) return backendPromise;

  backendPromise = (async () => {
    if (isTauriRuntime()) {
      backend = BACKEND.KV;
      return backend;
    }

    if (typeof indexedDB !== "undefined") {
      try {
        await openDb();
        backend = BACKEND.IDB;
        return backend;
      } catch (err) {
        // IndexedDB should exist in extensions; fallback only for Tauri/web.
        if (isExtensionRuntime()) {
          throw err;
        }
        backend = BACKEND.KV;
        console.warn(
          "IndexedDB unavailable; falling back to KV shielded storage:",
          err?.message ?? String(err)
        );
        return backend;
      }
    }

    backend = BACKEND.KV;
    return backend;
  })();

  return backendPromise;
}

async function useKvBackend() {
  // Prefer KV on Tauri if IndexedDB is missing or fails to open.
  if (backend === BACKEND.KV || backend === BACKEND.MEM) return true;
  const b = await resolveBackend();
  return b === BACKEND.KV || b === BACKEND.MEM;
}

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
    req.onerror = () => {
      dbPromise = null;
      reject(req.error || new Error("Failed to open IndexedDB"));
    };
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
  const key = ownerKey(networkKey, walletId, profileIndex);

  if (await useKvBackend()) {
    return await kvGet(KV_META, key, null);
  }

  const db = await openDb();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_META], "readonly");
    const store = tx.objectStore(STORE_META);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error || new Error("Failed to read meta"));
  });
}

export async function putShieldedMeta(networkKey, walletId, profileIndex, metaPatch) {
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

  if (await useKvBackend()) {
    await kvSet(KV_META, key, next);
    return next;
  }

  const db = await openDb();
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

  if (await useKvBackend()) {
    await kvSet(KV_META, created.ownerKey, created);
  } else {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_META], "readwrite");
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error || new Error("Failed to create meta"));
      tx.objectStore(STORE_META).put(created);
    });
  }
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
    const store = tx.objectStore(storeName);
    const index = store.index("byOwner");
    const req = index.openCursor(IDBKeyRange.only(ownerKeyStr));
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error(`Failed to clear ${storeName}`));
  });
}

export async function clearNotes(networkKey, walletId, profileIndex = 0) {
  const ok = ownerKey(networkKey, walletId, profileIndex);

  // Clear all shielded caches for this owner (unspent, spent, pending).
  if (await useKvBackend()) {
    await kvRemove(KV_PENDING, ok).catch(() => {});
    await kvRemove(KV_SPENT, ok).catch(() => {});
    await kvRemove(KV_NOTES, ok).catch(() => {});
    return;
  }

  const db = await openDb();
  await clearStoreByOwner(db, STORE_PENDING, ok).catch(() => {});
  await clearStoreByOwner(db, STORE_SPENT, ok).catch(() => {});
  await clearStoreByOwner(db, STORE_NOTES, ok).catch(() => {});
}

export async function putNotesMap(networkKey, walletId, profileIndex, notesMap) {
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

  if (await useKvBackend()) {
    const existing = (await kvGet(KV_NOTES, ok, {})) || {};
    for (const e of entries) {
      const bytes = e.buf instanceof ArrayBuffer ? new Uint8Array(e.buf) : new Uint8Array(e.buf || []);
      existing[e.keyHex] = bytesToBase64(bytes);
    }
    await kvSet(KV_NOTES, ok, existing);
    return entries.length;
  }

  const db = await openDb();
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
  const ok = ownerKey(networkKey, walletId, profileIndex);

  if (await useKvBackend()) {
    const data = (await kvGet(KV_NOTES, ok, {})) || {};
    const out = new Map();
    for (const [hex, b64] of Object.entries(data)) {
      try {
        const k = hexToBytes(hex);
        const v = base64ToBytes(b64);
        out.set(k, v);
      } catch {
        // ignore bad rows
      }
    }
    return out;
  }

  const db = await openDb();
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

/**
 * Returns a Map of spendable notes (unspent notes minus locally pending nullifiers).
 */
export async function getSpendableNotesMap(networkKey, walletId, profileIndex = 0) {
  const ok = ownerKey(networkKey, walletId, profileIndex);

  if (await useKvBackend()) {
    const notes = (await kvGet(KV_NOTES, ok, {})) || {};
    const pending = (await kvGet(KV_PENDING, ok, {})) || {};
    const pendingSet = new Set(Object.keys(pending));

    const out = new Map();
    for (const [hex, b64] of Object.entries(notes)) {
      if (pendingSet.has(hex)) continue;
      try {
        const k = hexToBytes(hex);
        const v = base64ToBytes(b64);
        out.set(k, v);
      } catch {
        // ignore
      }
    }
    return out;
  }

  const db = await openDb();
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
  const ok = ownerKey(networkKey, walletId, profileIndex);

  if (await useKvBackend()) {
    const notes = (await kvGet(KV_NOTES, ok, {})) || {};
    const out = [];
    for (const hex of Object.keys(notes)) {
      try {
        out.push(hexToBytes(hex));
      } catch {
        // ignore
      }
    }
    return out;
  }

  const db = await openDb();
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
  const ok = ownerKey(networkKey, walletId, profileIndex);

  if (await useKvBackend()) {
    const spent = (await kvGet(KV_SPENT, ok, {})) || {};
    const out = [];
    for (const hex of Object.keys(spent)) {
      try {
        out.push(hexToBytes(hex));
      } catch {
        // ignore
      }
    }
    return out;
  }

  const db = await openDb();
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
        createdAt: Date.now(),
      });
    } catch {
      // ignore
    }
  }

  if (!rows.length) return 0;

  if (await useKvBackend()) {
    const pending = (await kvGet(KV_PENDING, ok, {})) || {};
    for (const r of rows) {
      pending[r.nullifier] = {
        txHash: r.txHash,
        createdAt: r.createdAt,
      };
    }
    await kvSet(KV_PENDING, ok, pending);
    return rows.length;
  }

  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_PENDING], "readwrite");
    const store = tx.objectStore(STORE_PENDING);
    for (const r of rows) store.put(r);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error("Failed to write pending"));
  });

  return rows.length;
}

/**
 * Move notes from unspent -> spent for the provided nullifiers, and clear any
 * pending reservation for them.
 */
export async function markNullifiersSpent(networkKey, walletId, profileIndex, nullifiers) {
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

  if (await useKvBackend()) {
    const notes = (await kvGet(KV_NOTES, ok, {})) || {};
    const spent = (await kvGet(KV_SPENT, ok, {})) || {};
    const pending = (await kvGet(KV_PENDING, ok, {})) || {};

    for (const hex of hexes) {
      if (notes[hex] !== undefined) {
        spent[hex] = {
          nullifier: hex,
          noteKey: hex,
          noteValue: notes[hex],
          spentAt: Date.now(),
        };
        delete notes[hex];
      }
      delete pending[hex];
    }

    await kvSet(KV_NOTES, ok, notes);
    await kvSet(KV_SPENT, ok, spent);
    await kvSet(KV_PENDING, ok, pending);
    return hexes.length;
  }

  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NOTES, STORE_SPENT, STORE_PENDING], "readwrite");
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

    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error("Failed to mark spent"));
  });

  return hexes.length;
}

/**
 * Move notes from spent -> unspent.
 */
export async function unspendNullifiers(networkKey, walletId, profileIndex, nullifiers) {
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

  if (await useKvBackend()) {
    const notes = (await kvGet(KV_NOTES, ok, {})) || {};
    const spent = (await kvGet(KV_SPENT, ok, {})) || {};

    for (const hex of hexes) {
      const row = spent[hex];
      if (row) {
        notes[hex] = row.noteValue ?? notes[hex];
        delete spent[hex];
      }
    }

    await kvSet(KV_NOTES, ok, notes);
    await kvSet(KV_SPENT, ok, spent);
    return hexes.length;
  }

  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_SPENT, STORE_NOTES], "readwrite");
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

    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error("Failed to unspend"));
  });

  return hexes.length;
}

export async function countNotes(networkKey, walletId, profileIndex = 0) {
  const ok = ownerKey(networkKey, walletId, profileIndex);

  if (await useKvBackend()) {
    const notes = (await kvGet(KV_NOTES, ok, {})) || {};
    return Object.keys(notes).length;
  }

  const db = await openDb();
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
