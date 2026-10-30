// A public account's transaction history, synced from the archive node by
// @dusk-network/app-core/history and kept on this device (activityStore.js)
// as it was kept before: a deposit to DuskEVM keeps the DuskEVM address it
// paid as `bridgeTo`, and a call to Dusk Domains that may reserve or register
// a .dusk name keeps `reservation` and `registeredName` (knownCalls.js). The
// shielded history is phoenixHistory.js's.

import { createArchive, createHistory, historyArchiveUrl } from "@dusk-network/app-core/history";

import * as store from "./activityStore.js";
import { isDuskDomains, nameReservationOf, registeredNameOf } from "./knownCalls.js";
import { chainIdForNode, networkForNode } from "./nodeNetwork.js";

/**
 * The archive to read a network's history from: the configured archiver, or
 * the node when the archiver is on another network, by their chain IDs (an
 * install whose settings kept Mainnet's archiver beside a Testnet node).
 * @param {{ nodeUrl?: string, archiverUrl?: string }} urls
 */
export const historyArchiverUrl = ({ nodeUrl, archiverUrl } = {}) =>
  historyArchiveUrl({ nodeUrl, archiveUrl: archiverUrl, chainIdOf: chainIdForNode });

/** The archive at `url`. A node that answered without one is asked nothing for an hour, by any page. */
export const archiveAt = (url) => createArchive({ url, refusals: { get: store.getArchiveRefusal, put: store.putArchiveRefusal } });

/**
 * The network a history belongs to: Mainnet and Testnet by name, whichever
 * node of theirs it's read from, any other node by its origin.
 * @param {string} nodeUrl
 */
export function activityNetworkKey(nodeUrl) {
  const name = networkForNode(String(nodeUrl ?? ""))?.name;
  if (name === "mainnet" || name === "testnet") return name;
  try {
    return new URL(String(nodeUrl)).origin;
  } catch {
    return String(nodeUrl ?? "");
  }
}

// A row kept with a deposit's `bridgeTo` alone reads as that deposit.
const toEntry = (row) =>
  row.bridge !== undefined || row.bridgeTo === undefined
    ? row
    : { ...row, bridge: row.bridgeTo && { amount: row.value, kind: "deposit", to: row.bridgeTo } };
// What a call to the bridge did is kept with `bridgeTo`: the DuskEVM address a deposit paid, else null.
const toRow = (found) => (found.bridge === undefined ? found : { ...found, bridgeTo: found.bridge?.kind === "deposit" ? found.bridge.to : null });

// A call to Dusk Domains by a function not known yet, or a name's reservation or registration.
const mayName = (entry, nodeUrl) =>
  [entry.contractId, entry.counterparty].some((id) => isDuskDomains(id, nodeUrl)) && [undefined, "commit", "register"].includes(entry.fnName);

/**
 * One account's history on one network. What it keeps is refused once the
 * wallet was reset since `epoch` (getActivityEpoch, or its promise), with a
 * StaleActivityError; another chain under the node forgets this account's
 * history alone.
 * @param {{ nodeUrl: string, archiverUrl?: string, account: string, epoch?: number | Promise<number | undefined> }} opts
 */
export function activityHistory({ nodeUrl, archiverUrl, account, epoch }) {
  const ownerKey = store.activityOwnerKey(activityNetworkKey(nodeUrl), account);
  return createHistory({
    archive: archiveAt(historyArchiverUrl({ nodeUrl, archiverUrl })),
    account,
    network: networkForNode(nodeUrl),
    store: {
      getState: () => store.getActivityMeta(ownerKey),
      commit: async (entries, update) => store.commitActivityStep(ownerKey, entries, update, await epoch),
      patch: async (details) => store.patchActivityEntries(ownerKey, new Map([...details].map(([hash, found]) => [hash, toRow(found)])), await epoch),
      list: async (options) => (await store.listActivityEntries(ownerKey, options)).map(toEntry),
      clear: async () => store.clearActivity(ownerKey, await epoch),
    },
    // A .dusk name's reservation and registration, read once from their calls.
    callFacts: {
      wants: (entry) =>
        mayName(entry, nodeUrl) &&
        (!entry.detailsAt ||
          (entry.fnName === "register" && entry.registeredName === undefined) ||
          (entry.fnName !== undefined && entry.reservation === undefined)),
      read: (call) => {
        const registeredName = registeredNameOf({ ...call, nodeUrl });
        const reservation = nameReservationOf({ ...call, nodeUrl, account });
        return { ...(registeredName === undefined ? {} : { registeredName }), ...(reservation === undefined ? {} : { reservation }) };
      },
    },
  });
}

let warnedUnavailable = false;

/** Says once per page that the archive is unavailable. */
export function noteActivityUnavailable(error) {
  if (warnedUnavailable) return;
  warnedUnavailable = true;
  try {
    console.warn("Activity history is unavailable; showing this wallet's own transactions.", error?.message ?? error);
  } catch {
    // ignore
  }
}
