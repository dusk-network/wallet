// Each wallet's last payment from its own pages, on each node: its
// transaction's ID, when it was made and where it stands, kept apart from its
// record in Activity's store, which goes once the chain's history has it
// (activity.js settleSends). The tab the wallet runs in in Firefox says where
// it stands within the hour (engine/keepOpenPage.js); a reset forgets them
// all, and removing a wallet its own (walletReset.js). Never an amount or a
// recipient.

import { storage, STORAGE_KEYS } from "./storage.js";

const KEY = STORAGE_KEYS.LAST_SENDS;

const placeOf = (walletId, nodeUrl) => `${String(walletId ?? "")}\n${String(nodeUrl ?? "")}`;

async function readAll() {
  const all = (await storage.get(KEY))?.[KEY];
  return all && typeof all === "object" && !Array.isArray(all) ? all : {};
}

// Writes one after another: each reads what the one before wrote.
let writes = Promise.resolve();

function change(edit) {
  const next = writes.then(async () => {
    const all = await readAll();
    if (edit(all) === false) return;
    await storage.set({ [KEY]: all });
  });
  writes = next.catch(() => {});
  return next;
}

/**
 * Keeps a payment as its wallet's last on its node, from now.
 * @param {{ walletId: string, nodeUrl: string, hash: string, state: string }} sent
 */
export function keepLastSend({ walletId, nodeUrl, hash, state }) {
  if (!walletId || !nodeUrl || !hash) return Promise.resolve();
  return change((all) => {
    all[placeOf(walletId, nodeUrl)] = { hash: String(hash), at: Date.now(), state: String(state) };
  });
}

/**
 * Where a kept last payment stands now, by its transaction's ID.
 * @param {string} hash
 * @param {string} state
 */
export function noteLastSendState(hash, state) {
  if (!hash || !state) return Promise.resolve();
  return change((all) => {
    const place = Object.keys(all).find((key) => all[key]?.hash === hash);
    if (!place || all[place].state === state) return false;
    all[place] = { ...all[place], state: String(state) };
  });
}

/**
 * A wallet's last payment on a node, or null.
 * @param {{ walletId: string, nodeUrl: string }} of
 * @returns {Promise<{ hash: string, at: number, state: string } | null>}
 */
export async function lastSendOf({ walletId, nodeUrl }) {
  await writes;
  return (await readAll())[placeOf(walletId, nodeUrl)] ?? null;
}

/**
 * Forgets what's kept: every wallet's, or one wallet's alone (a wallet removed).
 * @param {string} [walletId]
 */
export async function forgetLastSends(walletId) {
  await writes;
  if (walletId === undefined) {
    await storage.remove(KEY);
    return;
  }
  await change((all) => {
    const before = Object.keys(all).length;
    for (const key of Object.keys(all)) if (key.split("\n")[0] === String(walletId)) delete all[key];
    return Object.keys(all).length !== before;
  });
}
