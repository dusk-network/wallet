// A deposit to DuskEVM, once it's there: the DuskEVM transaction that paid its
// recipient, as DuskEVM's explorer (its Blockscout API, from the network's
// file in @dusk-network/networks) lists the recipient's incoming calls: the
// L2 bridge's, of the deposit's amount, after the deposit. Asked only while a
// deposit is on its way, one request a recipient, less often the longer
// nothing changes (as the web wallet's deposit tracking); kept once found,
// until a wallet reset. A network without DuskEVM (Mainnet, for now) asks
// nothing.

import { bridgeTransfer } from "./bridge.js";
import { fetchWithTimeout } from "./networkStatus.js";
import { networkForNode } from "./nodeNetwork.js";
import { storage, STORAGE_KEYS } from "./storage.js";
import { withStorageLock } from "./storageLock.js";
import { getTxEpoch } from "./txStore.js";

/** How long after it went through a deposit is looked for on DuskEVM. */
export const ARRIVAL_WINDOW_MS = 7 * 24 * 60 * 60_000;
// The deposit's time is its block's or the wallet's clock: DuskEVM's may differ a little.
const CLOCK_SLACK_MS = 2 * 60_000;
// DUSK has 9 decimals on Dusk and 18 on DuskEVM.
const WEI_PER_LUX = 10n ** 9n;
// Arrivals kept: the newest.
const KEEP = 200;

const EVM_TX = /^0x[0-9a-fA-F]{64}$/;

/** @type {Map<string, { hash: string, at: number }>} by the deposit's hash */
let kept = new Map();
let loading = null;

const validArrival = (a) => EVM_TX.test(String(a?.hash ?? "")) && Number.isFinite(a?.at);

/** Reads the arrivals kept, once for this page. */
export function loadArrivals() {
  loading ??= storage
    .get(STORAGE_KEYS.BRIDGE_ARRIVALS)
    .then((items) => {
      for (const [hash, arrival] of Object.entries(items?.[STORAGE_KEYS.BRIDGE_ARRIVALS] ?? {})) {
        if (validArrival(arrival) && !kept.has(hash)) kept.set(hash, arrival);
      }
    })
    .catch(() => {});
  return loading;
}

/**
 * A deposit's arrival on DuskEVM, as found and kept, or null.
 * @param {string} hash - the deposit's transaction on Dusk
 * @returns {{ hash: string, at: number } | null}
 */
export const arrivalOf = (hash) => kept.get(String(hash ?? "").toLowerCase()) ?? null;

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

// What a deposit paid, in lux, as Activity shows it.
const depositLux = (tx) => [tx?.deposit, tx?.amount].map((v) => String(v ?? "")).find((v) => /^\d+$/.test(v) && BigInt(v) > 0n) ?? null;

// When a deposit went through: its block's time, else the wallet's.
const depositTime = (tx) => Number(tx?.timestamp ?? tx?.finalizedAt ?? tx?.executedAt ?? tx?.submittedAt) || 0;

/**
 * Whether an Activity row is a deposit to DuskEVM on its way: gone through on
 * Dusk this week, to a DuskEVM address, on a network with DuskEVM, and not
 * seen there yet.
 * @param {object} tx - an Activity row (activity.js activityRows)
 * @param {string} nodeUrl - the overview's network
 * @param {number} [now]
 */
export function awaitingArrival(tx, nodeUrl, now = Date.now()) {
  const network = String(tx?.nodeUrl || nodeUrl || "");
  if (!networkForNode(network)?.duskEvm || bridgeTransfer(tx, network) !== "to") return false;
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(tx?.bridgeTo ?? "")) || String(tx?.status ?? "").toLowerCase() !== "executed") return false;
  if (!depositLux(tx) || arrivalOf(tx?.hash)) return false;
  const at = depositTime(tx);
  return at > 0 && now - at < ARRIVAL_WINDOW_MS;
}

// The recipient's incoming calls on DuskEVM, newest first.
async function incomingCalls(duskEvm, recipient) {
  const url = `${duskEvm.blockscoutApiUrl.replace(/\/+$/, "")}/addresses/${recipient}/internal-transactions?filter=to`;
  const res = await fetchWithTimeout(url, { headers: { Accept: "application/json" } }, 8_000);
  if (!res.ok) throw new Error(`DuskEVM's explorer answered ${res.status}`);
  const body = await res.json();
  return Array.isArray(body?.items) ? body.items : [];
}

// A Blockscout time ("2026-10-27T05:52:13.000000Z") in milliseconds.
const timeOf = (text) => Date.parse(String(text ?? "").replace(/(\.\d{3})\d+/, "$1"));

/**
 * Looks on DuskEVM for the deposits in `rows` on their way, one request a
 * recipient, and keeps those that arrived: each takes the L2 bridge's first
 * payment of its amount to its recipient from after it, in order, one
 * payment for one deposit.
 * @param {object[]} rows - Activity rows on the overview's network
 * @param {{ nodeUrl: string, now?: number }} opts
 * @returns {Promise<number>} how many arrived
 */
export async function checkArrivals(rows, { nodeUrl, now = Date.now() }) {
  await loadArrivals();
  const duskEvm = networkForNode(String(nodeUrl ?? ""))?.duskEvm;
  const waiting = (rows ?? []).filter((tx) => awaitingArrival(tx, nodeUrl, now));
  if (!duskEvm || !waiting.length) return 0;
  const epoch = await getTxEpoch().catch(() => undefined);
  const bridge = duskEvm.predeploys.l2StandardBridge.toLowerCase();
  const taken = new Set([...kept.values()].map((a) => a.hash.toLowerCase()));
  const byRecipient = new Map();
  for (const tx of waiting) {
    const to = String(tx.bridgeTo).toLowerCase();
    byRecipient.set(to, [...(byRecipient.get(to) ?? []), tx]);
  }

  const found = {};
  for (const [recipient, deposits] of byRecipient) {
    const calls = await incomingCalls(duskEvm, recipient).catch(() => null);
    if (!calls) continue;
    const payments = calls
      .filter((c) => c?.success !== false && String(c?.from?.hash ?? "").toLowerCase() === bridge && EVM_TX.test(String(c?.transaction_hash ?? "")))
      .map((c) => ({ hash: String(c.transaction_hash), value: String(c.value ?? ""), at: timeOf(c.timestamp) }))
      .filter((p) => Number.isFinite(p.at))
      .sort((a, b) => a.at - b.at);
    for (const tx of [...deposits].sort((a, b) => depositTime(a) - depositTime(b))) {
      const wei = (BigInt(depositLux(tx)) * WEI_PER_LUX).toString();
      const paid = payments.find((p) => !taken.has(p.hash.toLowerCase()) && p.value === wei && p.at >= depositTime(tx) - CLOCK_SLACK_MS);
      if (!paid) continue;
      taken.add(paid.hash.toLowerCase());
      found[String(tx.hash).toLowerCase()] = { hash: paid.hash, at: paid.at };
    }
  }
  if (!Object.keys(found).length) return 0;
  await keep(found, epoch);
  return Object.keys(found).filter((hash) => kept.has(hash)).length;
}

// Keeps what arrived, unless a wallet reset came since the check began.
async function keep(found, epoch) {
  await withStorageLock(STORAGE_KEYS.BRIDGE_ARRIVALS, async () => {
    if (epoch === undefined || (await getTxEpoch()) !== epoch) return;
    for (const [hash, arrival] of Object.entries(found)) kept.set(hash, arrival);
    const all = { ...((await storage.get(STORAGE_KEYS.BRIDGE_ARRIVALS))?.[STORAGE_KEYS.BRIDGE_ARRIVALS] ?? {}), ...found };
    const newest = Object.entries(all)
      .filter(([, a]) => validArrival(a))
      .sort(([, a], [, b]) => b.at - a.at)
      .slice(0, KEEP);
    await storage.set({ [STORAGE_KEYS.BRIDGE_ARRIVALS]: Object.fromEntries(newest) });
  }).catch(() => {});
}

/** Forgets every arrival kept: a wallet reset. */
export async function clearArrivals() {
  kept = new Map();
  await storage.remove(STORAGE_KEYS.BRIDGE_ARRIVALS);
}

/**
 * How long until the next look: 5 seconds, doubling every 6 looks that found
 * nothing, at most 5 minutes, as the web wallet's deposit tracking.
 * @param {number} unchanged - looks in a row that found nothing
 */
export function arrivalCheckDelay(unchanged) {
  return Math.min(300_000, 5_000 * 2 ** Math.min(6, Math.floor(Math.max(0, unchanged) / 6)));
}
