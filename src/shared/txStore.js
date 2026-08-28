import { storage, STORAGE_KEYS } from "./storage.js";

let mutations = Promise.resolve();

function mutate(fn) {
  const result = mutations.then(fn, fn);
  mutations = result.catch(() => {});
  return result;
}

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
 * @property {"submitted"|"mempool"|"executed"|"failed"|"removed"|"unknown"} status
 * @property {string=} error
 * @property {"public"|"shielded"=} privacy
 * @property {string[]=} pendingNullifiers
 * @property {"pending"|"spent"|"recoverable"|"released"=} reservationStatus
 * @property {number=} reservationUpdatedAt
 * @property {string=} recoveryReason
 * @property {number=} lastCheckedAt
 * @property {number=} mempoolSeenAt
 * @property {number=} removedAt
 * @property {number=} executedAt
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

function prune(store, protectedHash = "", limit = 50) {
  const entries = Object.entries(store);
  if (entries.length <= limit) return store;

  const timestamp = (meta) => meta.submittedAt ?? meta.executedAt ?? meta.lastCheckedAt ?? 0;
  entries.sort((a, b) => {
    if (a[0] === protectedHash) return 1;
    if (b[0] === protectedHash) return -1;
    return timestamp(a[1]) - timestamp(b[1]);
  });
  return Object.fromEntries(entries.slice(-limit));
}

/**
 * Add submission metadata without overwriting an earlier lifecycle observation.
 * @param {string} hash
 * @param {TxMeta} meta
 */
export async function putTxMeta(hash, meta) {
  if (!hash) return;
  return mutate(async () => {
    const current = await getAll();
    const next = { ...meta, ...current[hash] };
    const terminal = next.status === "executed" || next.status === "failed";
    const shielded = next.privacy === "shielded" ||
      (Array.isArray(next.pendingNullifiers) && next.pendingNullifiers.length > 0);
    if (terminal && next.executedAt != null && shielded) {
      next.reservationStatus = "spent";
      next.reservationUpdatedAt = next.executedAt;
    }
    current[hash] = next;
    await setAll(prune(current, hash));
  });
}

/**
 * Patch tx metadata.
 * @param {string} hash
 * @param {Partial<TxMeta>} patch
 */
export async function patchTxMeta(hash, patch) {
  if (!hash) return;
  return mutate(async () => {
    const current = await getAll();
    const prev = current[hash] ?? {};
    const terminal = prev.status === "executed" || prev.status === "failed";
    const weaker = patch.status && patch.status !== "executed" && patch.status !== "failed";
    const nextPatch = patch.status === "executed" || patch.status === "failed"
      ? { ...patch, recoveryReason: undefined, removedAt: undefined }
      : patch;
    current[hash] = terminal && weaker
      ? { ...prev, lastCheckedAt: patch.lastCheckedAt ?? prev.lastCheckedAt }
      : { ...prev, ...nextPatch };
    await setAll(prune(current, hash));
  });
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
