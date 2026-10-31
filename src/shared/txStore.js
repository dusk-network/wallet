import { storage, STORAGE_KEYS } from "./storage.js";
import { withStorageLock } from "./storageLock.js";

const mutate = (fn) => withStorageLock(STORAGE_KEYS.TXS, fn);

// How many times a wallet reset cleared the store. A send or watcher reads it
// when its work begins (getTxEpoch) and passes it with its writes: after a
// reset since, they are dropped, so nothing of the old wallet comes back.
const readEpoch = async () => Number((await storage.get(STORAGE_KEYS.TXS_EPOCH))?.[STORAGE_KEYS.TXS_EPOCH]) || 0;
const stale = async (epoch) => epoch !== undefined && (await readEpoch()) !== epoch;

/** The store's reset count, for a writer to pass with its writes. */
export async function getTxEpoch() {
  return readEpoch();
}

/**
 * @typedef {Object} TxMeta
 * @property {string=} walletId The wallet that sent it: its first public account. Each wallet lists its own.
 * @property {string} origin
 * @property {string} nodeUrl
 * @property {string} kind
 * @property {number=} profileIndex
 * @property {string=} to
 * @property {string=} toName The .dusk name the recipient was typed as, for Activity.
 * @property {string=} amount
 * @property {string=} deposit
 * @property {string=} contractId
 * @property {string=} fnName
 * @property {string=} bridgeTo The DuskEVM address a deposit to DuskEVM pays, read from its call.
 * @property {string=} registeredName The .dusk name a registration registers, read from its call.
 * @property {string=} reservation A .dusk name's reservation, as its call makes it or a registration reveals it.
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
 * @property {string=} gasSpent
 * @property {string=} feePaid
 * @property {string=} blockHash
 * @property {string=} blockHeight
 * @property {string=} blockTimestamp
 * @property {number=} finalizedAt
 * @property {boolean=} settled Kept only for what the chain's row of it lacks (settleSends).
 */

// A record forgotten once the chain's history said all of it (forgetTxs)
// keeps its place as this, so a watcher's late write brings back no part of
// it: none without its network, profile and kind. Pruned before any record.
const isForgotten = (meta) => meta?.forgotten === true;

async function getAll() {
  const items = await storage.get(STORAGE_KEYS.TXS);
  return /** @type {Record<string, TxMeta>} */ (
    items?.[STORAGE_KEYS.TXS] ?? {}
  );
}

async function setAll(next) {
  await storage.set({ [STORAGE_KEYS.TXS]: next });
}

// Each wallet keeps its newest `limit` (records of none, forgotten ones among
// them, count as one wallet's).
function prune(store, protectedHash = "", limit = 50) {
  const wallets = new Map();
  for (const entry of Object.entries(store)) {
    const wallet = String(entry[1]?.walletId ?? "");
    if (!wallets.has(wallet)) wallets.set(wallet, []);
    wallets.get(wallet).push(entry);
  }
  if ([...wallets.values()].every((entries) => entries.length <= limit)) return store;

  const timestamp = (meta) => meta.submittedAt ?? meta.executedAt ?? meta.lastCheckedAt ?? 0;
  const kept = [];
  for (const entries of wallets.values()) {
    entries.sort((a, b) => {
      if (a[0] === protectedHash) return 1;
      if (b[0] === protectedHash) return -1;
      return timestamp(a[1]) - timestamp(b[1]);
    });
    kept.push(...entries.slice(-limit));
  }
  return Object.fromEntries(kept);
}

/**
 * Add submission metadata without overwriting an earlier lifecycle observation.
 * @param {string} hash
 * @param {TxMeta} meta
 * @param {{ epoch?: number }} [opts] - `epoch`: getTxEpoch when the work began
 */
export async function putTxMeta(hash, meta, { epoch } = {}) {
  if (!hash) return;
  return mutate(async () => {
    if (await stale(epoch)) return;
    const current = await getAll();
    if (isForgotten(current[hash])) return;
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
 * @param {{ epoch?: number }} [opts] - `epoch`: getTxEpoch when the work began
 */
export async function patchTxMeta(hash, patch, { epoch } = {}) {
  if (!hash) return;
  return mutate(async () => {
    if (await stale(epoch)) return;
    const current = await getAll();
    if (isForgotten(current[hash])) return;
    const prev = current[hash] ?? {};
    const terminal = prev.status === "executed" || prev.status === "failed";
    const weaker = patch.status && patch.status !== "executed" && patch.status !== "failed";
    const clearsRemoval = patch.status && patch.status !== "unknown" && patch.status !== "removed";
    const nextPatch = clearsRemoval
      ? { ...patch, recoveryReason: undefined, removedAt: undefined }
      : patch;
    current[hash] = terminal && weaker
      ? { ...prev, lastCheckedAt: patch.lastCheckedAt ?? prev.lastCheckedAt }
      : { ...prev, ...nextPatch };
    await setAll(prune(current, hash));
  });
}

/**
 * Forget these transactions' metadata: the chain's history says all of them.
 * Each stays forgotten: a later write to it is dropped.
 * @param {string[]} hashes
 * @param {{ epoch?: number }} [opts] - `epoch`: getTxEpoch when the work began
 */
export async function forgetTxs(hashes, { epoch } = {}) {
  if (!hashes.length) return;
  return mutate(async () => {
    if (await stale(epoch)) return;
    const current = await getAll();
    for (const hash of hashes) current[hash] = { forgotten: true };
    await setAll(prune(current));
  });
}

/**
 * The records from before each wallet's were kept apart, made its own: the one
 * wallet's there was then, unlocked now.
 * @param {string} walletId
 * @returns {Promise<number>} how many
 */
export async function adoptLegacyTxs(walletId) {
  const id = String(walletId ?? "").trim();
  if (!id) return 0;
  return mutate(async () => {
    const current = await getAll();
    const legacy = Object.entries(current).filter(([, meta]) => !meta?.walletId && !isForgotten(meta) && meta?.submittedAt != null);
    if (!legacy.length) return 0;
    for (const [hash, meta] of legacy) current[hash] = { ...meta, walletId: id };
    await setAll(current);
    return legacy.length;
  });
}

/**
 * Forget one wallet's transactions: a removed wallet's. Others' stay, and so
 * does the reset count, so their sends keep writing.
 * @param {string} walletId
 */
export async function forgetWalletTxs(walletId) {
  const id = String(walletId ?? "").trim();
  if (!id) return;
  return mutate(async () => {
    const current = await getAll();
    await setAll(Object.fromEntries(Object.entries(current).filter(([, meta]) => meta?.walletId !== id)));
  });
}

/** Forget every transaction's metadata, for a wallet reset, and count the reset. */
export async function clearTxs() {
  return mutate(async () => {
    await storage.set({ [STORAGE_KEYS.TXS_EPOCH]: (await readEpoch()) + 1 });
    await storage.remove(STORAGE_KEYS.TXS);
  });
}

/**
 * @param {string} hash
 * @returns {Promise<TxMeta|null>}
 */
export async function getTxMeta(hash) {
  if (!hash) return null;
  const meta = (await getAll())[hash];
  return meta && !isForgotten(meta) ? meta : null;
}

/**
 * List transaction metadata ordered by newest first.
 *
 * NOTE: The store is pruned to a small fixed size (see `prune()`), so this
 * is safe to call frequently from UI rendering.
 *
 * @param {{ nodeUrl?: string, walletId?: string, limit?: number }} [opts] -
 *   `walletId`: that wallet's only (a locked wallet's "" lists none)
 * @returns {Promise<Array<{hash: string} & TxMeta>>}
 */
export async function listTxs(opts = {}) {
  const nodeUrl = typeof opts.nodeUrl === "string" && opts.nodeUrl.length ? opts.nodeUrl : null;
  const limit = Number.isFinite(Number(opts.limit)) ? Math.max(0, Number(opts.limit)) : null;

  const current = await getAll();
  let entries = Object.entries(current)
    .filter(([, meta]) => !isForgotten(meta))
    .map(([hash, meta]) => ({ hash, ...meta }));

  if (nodeUrl) {
    entries = entries.filter((e) => String(e.nodeUrl ?? "") === nodeUrl);
  }
  if (typeof opts.walletId === "string") {
    entries = entries.filter((e) => Boolean(opts.walletId) && e.walletId === opts.walletId);
  }

  entries.sort((a, b) => (b.submittedAt ?? 0) - (a.submittedAt ?? 0));

  if (typeof limit === "number") {
    return entries.slice(0, limit);
  }
  return entries;
}
