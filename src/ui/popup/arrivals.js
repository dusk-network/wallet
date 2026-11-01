// Deposits to DuskEVM on their way, looked for from the popup on DuskEVM's
// RPC, by the bridge's event from the account's DuskEVM address, the
// account's equal deposits before it paid first, as its history on the
// archive says (@dusk-network/app-core/bridge). Those that arrived are kept
// (bridgeArrival.js); where each search stopped, DuskEVM's block times, and
// the calls of those equal deposits once their blocks are final, for this
// page only. The service worker loads none of this.

import { arrivalsOf, depositArrivals } from "@dusk-network/app-core/bridge";

import { archiveAt, historyArchiverUrl } from "../../shared/activityHistory.js";
import { awaitingArrival, depositLux, depositTime, keepArrivals, keptArrivals, loadArrivals } from "../../shared/bridgeArrival.js";
import { networkForNode } from "../../shared/nodeNetwork.js";
import { getTxEpoch } from "../../shared/txStore.js";

const blockTimes = new Map();
const scans = new Map();
const depositCalls = new Map();

/**
 * Looks on DuskEVM for the deposits in `rows` on their way, which `account`
 * of the wallet `walletId` sent, and keeps those that arrived, with that
 * wallet's: each takes a payment of its own, in the order they were sent.
 * @param {object[]} rows - Activity rows on the overview's network
 * @param {{ walletId: string, account: string, archiverUrl?: string, nodeUrl: string, now?: number }} opts
 * @returns {Promise<number>} how many arrived
 */
export async function checkArrivals(rows, { walletId, account, archiverUrl, nodeUrl, now = Date.now() }) {
  await loadArrivals(walletId);
  const network = networkForNode(String(nodeUrl ?? ""));
  const waiting = (rows ?? []).filter((row) => awaitingArrival(row, nodeUrl, now));
  if (!network?.duskEvm || !waiting.length) return 0;
  const epoch = await getTxEpoch().catch(() => undefined);
  const { arrivals } = await depositArrivals({
    archive: archiveAt(historyArchiverUrl({ archiverUrl, nodeUrl })),
    blockTimes,
    cache: depositCalls,
    deposits: waiting.map((row) => ({
      amount: depositLux(row),
      at: depositTime(row),
      hash: row.hash,
      height: row.blockHeight,
      scan: scans.get(row.hash),
      sender: account || null,
      to: row.bridge.to,
    })),
    network,
    now,
    taken: [...keptArrivals().values()].map(({ hash }) => hash),
    via: "rpc",
  });
  for (const [hash, arrival] of arrivals) if (arrival.scan) scans.set(hash, arrival.scan);
  const found = Object.fromEntries(arrivalsOf(arrivals));
  return Object.keys(found).length ? keepArrivals(found, epoch, walletId) : 0;
}
