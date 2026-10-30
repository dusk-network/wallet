// Activity's rows for a test, as the popup makes them (activity.js
// activityRows, through @dusk-network/app-core/activity): from the wallet's
// own records of its sends, as its transaction store keeps them, and the
// chain's entries of the account's history, from the fields a test is about.

import { historyEntry } from "@dusk-network/app-core/history";

import { activityKey, activityRows } from "../../ui/popup/activity.js";
import { networkForNode } from "../nodeNetwork.js";

export const TESTNET = "https://testnet.nodes.dusk.network";
export const MAINNET = "https://nodes.dusk.network";
/** The account shown: none of the tests' counterparties. */
export const ACCOUNT =
  "oUgxBUWEPyFAekXW9T2UdJBcMF7xAuBfstrCX8ATXFk7MusqddFGoq2LN9euCbwVuXpSM5rGLKNUb6NVPFUVM5g4pA6CnXjNfNVBiy91NcH9eBVcdcG1eYUaKWQSYQ9t2um";

/**
 * The chain's entry of a transaction, as the account's history reads it: by
 * default a transfer sent, its details read.
 * @param {Record<string, unknown>} fields
 * @param {string} nodeUrl
 */
export const entryOf = (fields, nodeUrl = TESTNET) =>
  historyEntry(
    {
      blockHeight: 4_687_000,
      counterparty: null,
      detailsAt: 1,
      direction: "out",
      hash: "aa".repeat(32),
      kind: "transfer",
      memo: "",
      payer: true,
      success: true,
      timestamp: Date.UTC(2026, 9, 26, 13, 32),
      value: "0",
      ...fields,
    },
    { network: networkForNode(nodeUrl) }
  );

/**
 * The popup's rows, newest first.
 * @param {{ txs?: object[], entries?: object[], shielded?: object[], names?: Map<string, string|null> }} what
 *   `txs`: the wallet's records; `entries`: the fields of the chain's entries (entryOf)
 * @param {{ nodeUrl?: string }} [opts]
 */
export function rowsOf({ txs = [], entries = [], shielded = [], names = new Map() } = {}, { nodeUrl = TESTNET } = {}) {
  const ov = { accounts: [ACCOUNT], isUnlocked: true, nodeUrl, selectedAccountIndex: 0, txs };
  const state = { activity: { entries: entries.map((fields) => entryOf(fields, nodeUrl)), key: activityKey(ov), names, shielded } };
  return activityRows(ov, state);
}

/**
 * The row of one of the wallet's records: by default sent a moment ago, on
 * the node it names.
 * @param {Record<string, unknown>} tx
 * @param {{ nodeUrl?: string }} [opts]
 */
export const rowOf = (tx, { nodeUrl = String(tx.nodeUrl ?? TESTNET) } = {}) =>
  rowsOf({ txs: [{ hash: "ee".repeat(32), submittedAt: Date.now(), ...tx }] }, { nodeUrl })[0];
