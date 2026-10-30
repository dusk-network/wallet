// A deposit to DuskEVM, once it's there: the DuskEVM transaction that paid it,
// and when, as the popup finds it on DuskEVM (ui/popup/arrivals.js). Looked
// for only while a deposit is on its way, less often the longer nothing
// changes (as the web wallet's deposit tracking); kept once found, until a
// wallet reset. A network without DuskEVM (Mainnet, for now) asks nothing.
//
// What's kept is tagged with the transaction store's reset count it was found
// under (txStore.js), and every page reads it again as it draws: after a
// reset, in this page or another, no page shows the old wallet's arrivals,
// and a check that began before it keeps nothing.

import { networkForNode } from "./nodeNetwork.js";
import { storage, STORAGE_KEYS } from "./storage.js";
import { withStorageLock } from "./storageLock.js";
import { getTxEpoch } from "./txStore.js";

/** How long after it went through a deposit is looked for on DuskEVM. */
export const ARRIVAL_WINDOW_MS = 7 * 24 * 60 * 60_000;
// Arrivals kept: the newest.
const KEEP = 200;

const EVM_TX = /^0x[0-9a-fA-F]{64}$/;

/** @type {Map<string, { hash: string, at: number }>} by the deposit's hash: this wallet's, as last read */
let kept = new Map();
let loading = null;
// Bumped as this page keeps or clears arrivals: a read begun before is out of date.
let version = 0;

const validArrival = (a) => EVM_TX.test(String(a?.hash ?? "")) && Number.isFinite(a?.at);

// The arrivals kept under `epoch`, by the deposit's hash: none of another.
async function readKept(epoch) {
  const stored = (await storage.get(STORAGE_KEYS.BRIDGE_ARRIVALS))?.[STORAGE_KEYS.BRIDGE_ARRIVALS];
  const items = stored?.epoch === epoch && stored.items && typeof stored.items === "object" ? stored.items : {};
  return Object.entries(items).filter(([, arrival]) => validArrival(arrival));
}

/** Reads the arrivals kept for this wallet: again each time, so a reset anywhere drops them here too. */
export function loadArrivals() {
  const begun = version;
  loading ??= getTxEpoch()
    .then(readKept)
    .then((entries) => {
      if (version === begun) kept = new Map(entries);
    })
    .catch(() => {})
    .finally(() => {
      loading = null;
    });
  return loading;
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

/**
 * Keeps the arrivals found, by the deposit's hash, with the reset count the
 * check began under (`epoch`), unless a wallet reset came since: checked
 * again right before the write, in the lock a reset's clear takes too. One
 * that comes between that check and the write leaves arrivals under the old
 * count, which nothing reads.
 * @param {Record<string, { hash: string, at: number }>} found
 * @param {number | undefined} epoch
 * @returns {Promise<number>} how many of them are kept
 */
export async function keepArrivals(found, epoch) {
  if (epoch === undefined) return 0;
  await withStorageLock(STORAGE_KEYS.BRIDGE_ARRIVALS, async () => {
    const newest = Object.entries({ ...Object.fromEntries(await readKept(epoch)), ...found })
      .sort(([, a], [, b]) => b.at - a.at)
      .slice(0, KEEP);
    if ((await getTxEpoch()) !== epoch) return;
    await storage.set({ [STORAGE_KEYS.BRIDGE_ARRIVALS]: { epoch, items: Object.fromEntries(newest) } });
    version += 1;
    for (const [hash, arrival] of Object.entries(found)) kept.set(hash, arrival);
  }).catch(() => {});
  return Object.keys(found).filter((hash) => kept.has(hash)).length;
}

/** Forgets every arrival kept: a wallet reset. In the lock a check's write takes. */
export async function clearArrivals() {
  await withStorageLock(STORAGE_KEYS.BRIDGE_ARRIVALS, async () => {
    version += 1;
    kept = new Map();
    await storage.remove(STORAGE_KEYS.BRIDGE_ARRIVALS);
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
