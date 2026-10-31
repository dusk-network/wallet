// A deposit to DuskEVM, once it's there: the DuskEVM transaction that paid it,
// and when, as the popup finds it on DuskEVM (ui/popup/arrivals.js). Looked
// for only while a deposit is on its way, less often the longer nothing
// changes (as the web wallet's deposit tracking); kept once found, until a
// wallet reset. A network without DuskEVM (Mainnet, for now) asks nothing.
//
// What's kept is kept per wallet, by its wallet ID, and tagged with the
// transaction store's reset count it was found under (txStore.js); every page
// reads it again as it draws: after a reset, in this page or another, no page
// shows the old wallet's arrivals, and a check that began before it keeps
// nothing. Another wallet's are never read.

import { networkForNode } from "./nodeNetwork.js";
import { storage, STORAGE_KEYS } from "./storage.js";
import { withStorageLock } from "./storageLock.js";
import { getTxEpoch } from "./txStore.js";

/** How long after it went through a deposit is looked for on DuskEVM. */
export const ARRIVAL_WINDOW_MS = 7 * 24 * 60 * 60_000;
// Arrivals kept: the newest.
const KEEP = 200;

const EVM_TX = /^0x[0-9a-fA-F]{64}$/;

const V1 = STORAGE_KEYS.BRIDGE_ARRIVALS;
const V2 = STORAGE_KEYS.BRIDGE_ARRIVALS_V2;

/** @type {Map<string, { hash: string, at: number }>} by the deposit's hash: this wallet's, as last read */
let kept = new Map();
// The wallet `kept` is of, and the read under way for it.
let keptFor = "";
let loading = null;
let loadingFor = "";
// Bumped as this page keeps or clears arrivals: a read begun before is out of date.
let version = 0;

const validArrival = (a) => EVM_TX.test(String(a?.hash ?? "")) && Number.isFinite(a?.at);
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

async function readStored() {
  return (await storage.get(V2))?.[V2] ?? null;
}

// The wallet's arrivals kept under `epoch`, by the deposit's hash: none of another.
async function readKept(epoch, walletId) {
  const stored = await readStored();
  const items = stored?.epoch === epoch && isObject(stored.wallets?.[walletId]) ? stored.wallets[walletId] : {};
  return Object.entries(items).filter(([, arrival]) => validArrival(arrival));
}

/**
 * Reads the arrivals kept for the wallet `walletId` (its first public
 * account): again each time, so a reset anywhere drops them here too.
 * @param {string} walletId
 */
export function loadArrivals(walletId) {
  const id = String(walletId ?? "");
  if (id !== keptFor) {
    // Another wallet: none of the last one's show while its own are read.
    version += 1;
    kept = new Map();
    keptFor = id;
  }
  if (!id) return Promise.resolve();
  if (loading && loadingFor === id) return loading;
  const begun = version;
  loadingFor = id;
  const read = getTxEpoch()
    .then((epoch) => readKept(epoch, id))
    .then((entries) => {
      if (version === begun && keptFor === id) kept = new Map(entries);
    })
    .catch(() => {})
    .finally(() => {
      if (loading === read) loading = null;
    });
  loading = read;
  return read;
}

/**
 * The deposits' arrivals on DuskEVM, as found and kept, by the deposit's
 * transaction on Dusk: activityRows's `arrivals`.
 * @returns {Map<string, { hash: string, at: number }>}
 */
export const keptArrivals = () => kept;

/**
 * An arrival's transaction on DuskEVM's explorer, or null.
 * @param {string} nodeUrl
 * @param {string} evmHash
 * @returns {string | null}
 */
export function arrivalUrl(nodeUrl, evmHash) {
  const base = networkForNode(String(nodeUrl ?? ""))?.duskEvm?.explorerUrl;
  return base && EVM_TX.test(String(evmHash ?? "")) ? `${base.replace(/\/+$/, "")}/tx/${evmHash}` : null;
}

/** What a deposit paid, in lux, as its call says; null for nothing. */
export const depositLux = (row) => {
  const lux = row?.bridge?.amount ?? row?.value ?? 0n;
  return lux > 0n ? lux : null;
};

/**
 * When a deposit went through: its Dusk block's time, as the archive or the
 * node gave it; 0 until one did. Never the wallet's clock, which may be off.
 */
export const depositTime = (row) => Number(row?.entry?.timestamp ?? row?.sent?.finalizedAt) || 0;

/**
 * Whether an Activity row is a deposit to DuskEVM on its way: gone through on
 * Dusk this week, its block's time known, to a DuskEVM address, on a network
 * with DuskEVM, and not seen there yet.
 * @param {object} row - an Activity row (activity.js activityRows)
 * @param {string} nodeUrl - the overview's network
 * @param {number} [now]
 */
export function awaitingArrival(row, nodeUrl, now = Date.now()) {
  if (!networkForNode(String(nodeUrl ?? ""))?.duskEvm || row?.bridge?.step !== "deposit" || !row.bridge.to) return false;
  if (row.status !== "executed" || !depositLux(row) || kept.has(String(row.hash))) return false;
  const at = depositTime(row);
  return at > 0 && now - at < ARRIVAL_WINDOW_MS;
}

// The kept arrivals, every wallet's, under `epoch`, with `wallet`'s set to
// `items` (gone for none).
async function writeWallet(epoch, walletId, items) {
  const stored = await readStored();
  const wallets = stored?.epoch === epoch && isObject(stored.wallets) ? { ...stored.wallets } : {};
  if (Object.keys(items).length) wallets[walletId] = items;
  else delete wallets[walletId];
  await storage.set({ [V2]: { epoch, wallets } });
}

/**
 * Keeps the arrivals found for the wallet `walletId`, by the deposit's hash,
 * with the reset count the check began under (`epoch`), unless a wallet reset
 * came since: checked again right before the write, in the lock a reset's
 * clear takes too. One that comes between that check and the write leaves
 * arrivals under the old count, which nothing reads.
 * @param {Record<string, { hash: string, at: number }>} found
 * @param {number | undefined} epoch
 * @param {string} walletId
 * @returns {Promise<number>} how many of them are kept
 */
export async function keepArrivals(found, epoch, walletId) {
  const id = String(walletId ?? "");
  if (epoch === undefined || !id) return 0;
  await withStorageLock(V2, async () => {
    const newest = Object.entries({ ...Object.fromEntries(await readKept(epoch, id)), ...found })
      .sort(([, a], [, b]) => b.at - a.at)
      .slice(0, KEEP);
    if ((await getTxEpoch()) !== epoch) return;
    await writeWallet(epoch, id, Object.fromEntries(newest));
    version += 1;
    if (keptFor === id) for (const [hash, arrival] of Object.entries(found)) kept.set(hash, arrival);
  }).catch(() => {});
  return keptFor === id ? Object.keys(found).filter((hash) => kept.has(hash)).length : 0;
}

/**
 * The arrivals kept before each wallet's were kept apart, made the wallet's
 * own: the one wallet's there was then, unlocked now. Under the reset count
 * they were found under, or none.
 * @param {string} walletId
 */
export async function adoptLegacyArrivals(walletId) {
  const id = String(walletId ?? "");
  if (!id) return;
  await withStorageLock(V2, async () => {
    const legacy = (await storage.get(V1))?.[V1];
    if (!legacy) return;
    const epoch = await getTxEpoch();
    if (legacy.epoch === epoch && isObject(legacy.items)) {
      const items = Object.fromEntries(Object.entries(legacy.items).filter(([, arrival]) => validArrival(arrival)));
      await writeWallet(epoch, id, { ...items, ...Object.fromEntries(await readKept(epoch, id)) });
    }
    await storage.remove(V1);
    version += 1;
  });
}

/** Forgets one wallet's arrivals: a removed wallet's. In the lock a check's write takes. */
export async function forgetWalletArrivals(walletId) {
  const id = String(walletId ?? "");
  if (!id) return;
  await withStorageLock(V2, async () => {
    const stored = await readStored();
    if (!stored || !isObject(stored.wallets?.[id])) return;
    await writeWallet(stored.epoch, id, {});
    version += 1;
    if (keptFor === id) kept = new Map();
  });
}

/** Forgets every arrival kept, every wallet's: a wallet reset. In the lock a check's write takes. */
export async function clearArrivals() {
  await withStorageLock(V2, async () => {
    version += 1;
    kept = new Map();
    await storage.remove([V1, V2]);
  });
}

/**
 * How long until the next look: 5 seconds, doubling every 6 looks that found
 * nothing, at most 5 minutes, as the web wallet's deposit tracking.
 * @param {number} unchanged - looks in a row that found nothing
 */
export function arrivalCheckDelay(unchanged) {
  return Math.min(300_000, 5_000 * 2 ** Math.min(6, Math.floor(Math.max(0, unchanged) / 6)));
}
