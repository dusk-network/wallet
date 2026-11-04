// Deposits to DuskEVM on their way, looked for from the popup on DuskEVM's
// RPC, by the bridge's event from the account's DuskEVM address, the
// account's equal deposits before it paid first, as its history on the
// archive says; and transfers out to another chain, by the DUSK token's
// transfer on that chain's RPC (@dusk-network/app-core/bridge). Those that
// arrived are kept (bridgeArrival.js); where each search stopped, DuskEVM's
// block times, and the calls of those equal deposits once their blocks are
// final, for this page only. The service worker loads none of this.

import { arrivalsOf, depositArrivals, serviceArrivals } from "@dusk-network/app-core/bridge";

import { archiveAt, historyArchiverUrl } from "../../shared/activityHistory.js";
import { awaitingArrival, depositLux, depositTime, keepArrivals, keptArrivals, loadArrivals } from "../../shared/bridgeArrival.js";
import { networkForNode } from "../../shared/nodeNetwork.js";
import { getTxEpoch } from "../../shared/txStore.js";

const blockTimes = new Map();
const scans = new Map();
const depositCalls = new Map();

/**
 * Looks for the deposits and the transfers out in `rows` on their way, which
 * `account` of the wallet `walletId` sent, and keeps those that arrived, with
 * that wallet's: each takes a payment of its own, in the order they were sent.
 * @param {object[]} rows - Activity rows on the overview's network
 * @param {{ walletId: string, account: string, archiverUrl?: string, nodeUrl: string, now?: number }} opts
 * @returns {Promise<number>} how many arrived
 */
export async function checkArrivals(rows, { walletId, account, archiverUrl, nodeUrl, now = Date.now() }) {
  await loadArrivals(walletId);
  const network = networkForNode(String(nodeUrl ?? ""));
  const waiting = (rows ?? []).filter((row) => awaitingArrival(row, nodeUrl, now));
  const deposits = waiting.filter((row) => row.bridge);
  const out = waiting.filter((row) => row.route);
  if (!network || !waiting.length) return 0;
  const epoch = await getTxEpoch().catch(() => undefined);
  const archive = archiveAt(historyArchiverUrl({ archiverUrl, nodeUrl }));
  const taken = [...keptArrivals().values()].map(({ hash }) => hash);
  const looks = await Promise.all([
    deposits.length
      ? depositArrivals({
          archive,
          blockTimes,
          cache: depositCalls,
          deposits: deposits.map((row) => ({
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
          taken,
          via: "rpc",
        })
      : null,
    out.length
      ? serviceArrivals({
          archive,
          network,
          now,
          taken,
          transfers: out.map((row) => ({ hash: row.hash, route: row.route.id, scan: scans.get(row.hash) })),
          // The popup may open only long after it was sent.
          waitMs: Infinity,
        }).catch(() => null)
      : null,
  ]);
  const found = {};
  for (const look of looks) {
    for (const [hash, arrival] of look?.arrivals ?? []) if (arrival.scan) scans.set(hash, arrival.scan);
    Object.assign(found, Object.fromEntries(arrivalsOf(look?.arrivals ?? new Map())));
  }
  return Object.keys(found).length ? keepArrivals(found, epoch, walletId) : 0;
}
