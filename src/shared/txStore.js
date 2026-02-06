import { storage, STORAGE_KEYS } from "./storage.js";

/**
 * @typedef {Object} TxMeta
 * @property {string} origin
 * @property {string} nodeUrl
 * @property {string} kind
 * @property {number=} profileIndex
 * @property {string=} to
 * @property {string=} amount
 * @property {string=} deposit
 * @property {string=} contractId
 * @property {string=} fnName
 * @property {string=} gasLimit
 * @property {string=} gasPrice
 * @property {any=} asset Optional UI hint for Activity labeling (e.g. DRC20/DRC721 summary).
 * @property {number} submittedAt
 * @property {"submitted"|"executed"|"failed"} status
 * @property {string=} error
 */

async function getAll() {
  const items = await storage.get(STORAGE_KEYS.TXS);
  return /** @type {Record<string, TxMeta>} */ (
    items?.[STORAGE_KEYS.TXS] ?? {}
  );
}

async function setAll(next) {
  await storage.set({ [STORAGE_KEYS.TXS]: next });
}

function prune(store, limit = 50) {
  const entries = Object.entries(store);
  if (entries.length <= limit) return store;

  entries.sort((a, b) => (a[1].submittedAt ?? 0) - (b[1].submittedAt ?? 0));
  const keep = entries.slice(-limit);
  return Object.fromEntries(keep);
}

/**
 * Upsert tx metadata.
 * @param {string} hash
 * @param {TxMeta} meta
 */
export async function putTxMeta(hash, meta) {
  if (!hash) return;
  const current = await getAll();
  current[hash] = meta;
  await setAll(prune(current));
}

/**
 * Patch tx metadata.
 * @param {string} hash
 * @param {Partial<TxMeta>} patch
 */
export async function patchTxMeta(hash, patch) {
  if (!hash) return;
  const current = await getAll();
  const prev = current[hash];
  if (!prev) return;
  current[hash] = { ...prev, ...patch };
  await setAll(prune(current));
}

/**
 * @param {string} hash
 * @returns {Promise<TxMeta|null>}
 */
export async function getTxMeta(hash) {
  if (!hash) return null;
  const current = await getAll();
  return current[hash] ?? null;
}

/**
 * List transaction metadata ordered by newest first.
 *
 * NOTE: The store is pruned to a small fixed size (see `prune()`), so this
 * is safe to call frequently from UI rendering.
 *
 * @param {{ nodeUrl?: string, limit?: number }} [opts]
 * @returns {Promise<Array<{hash: string} & TxMeta>>}
 */
export async function listTxs(opts = {}) {
  const nodeUrl = typeof opts.nodeUrl === "string" && opts.nodeUrl.length ? opts.nodeUrl : null;
  const limit = Number.isFinite(Number(opts.limit)) ? Math.max(0, Number(opts.limit)) : null;

  const current = await getAll();
  let entries = Object.entries(current).map(([hash, meta]) => ({ hash, ...meta }));

  if (nodeUrl) {
    entries = entries.filter((e) => String(e.nodeUrl ?? "") === nodeUrl);
  }

  entries.sort((a, b) => (b.submittedAt ?? 0) - (a.submittedAt ?? 0));

  if (typeof limit === "number") {
    return entries.slice(0, limit);
  }
  return entries;
}

/**
 * @param {string} hash
 */
export async function removeTxMeta(hash) {
  if (!hash) return;
  const current = await getAll();
  if (!current[hash]) return;
  delete current[hash];
  await setAll(current);
}
