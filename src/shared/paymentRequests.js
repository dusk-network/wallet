// The requests a wallet made in Receive, kept on this device per wallet (by
// its wallet ID), with the payment that paid each once one did, so it stays
// paid once that payment is too far back to read again. What came in for
// them is app-core's to say (matchRequests), as in the web wallet. At most
// MAX_REQUESTS, the oldest settled going first, then the oldest. A wallet
// reset drops them (walletReset.js).
import { storage, STORAGE_KEYS } from "./storage.js";
import { withStorageLock } from "./storageLock.js";

const KEY = STORAGE_KEYS.PAYMENT_REQUESTS;

/** A small list. */
export const MAX_REQUESTS = 50;

/**
 * A request as it's kept: `lux` as a decimal string, null for any amount,
 * `network` the network key it's for, and `paid` the payment that paid it.
 * @typedef {import("@dusk-network/app-core/requests").KeptRequest & { network: string }} PaymentRequest
 */

const isRequest = (kept) =>
  Boolean(kept) &&
  typeof kept === "object" &&
  typeof kept.id === "string" &&
  typeof kept.to === "string" &&
  typeof kept.memo === "string" &&
  typeof kept.network === "string" &&
  typeof kept.at === "number" &&
  (kept.lux === null || (typeof kept.lux === "string" && /^\d+$/.test(kept.lux)));

async function readAll() {
  const all = (await storage.get(KEY))?.[KEY];
  return all && typeof all === "object" && !Array.isArray(all) ? all : {};
}

/**
 * The wallet's requests, newest first.
 * @param {string} walletId
 * @returns {Promise<PaymentRequest[]>}
 */
export async function listRequests(walletId) {
  const list = (await readAll())[String(walletId ?? "")];
  return Array.isArray(list) ? list.filter(isRequest) : [];
}

// What goes as the list is full: the oldest settled, then the oldest.
function trimmed(list) {
  const kept = [...list];
  while (kept.length > MAX_REQUESTS) {
    const settled = kept.findLastIndex(({ paid }) => paid);
    kept.splice(settled < 0 ? kept.length - 1 : settled, 1);
  }
  return kept;
}

// Changes one wallet's list, as `edit` says; the same list back writes nothing.
function change(walletId, edit) {
  const id = String(walletId ?? "");
  if (!id) return Promise.resolve([]);
  return withStorageLock(KEY, async () => {
    const all = await readAll();
    const list = Array.isArray(all[id]) ? all[id].filter(isRequest) : [];
    const next = edit(list);
    if (next !== list) await storage.set({ [KEY]: { ...all, [id]: trimmed(next) } });
    return next;
  });
}

/**
 * Keeps a request as it leaves the wallet: the same one still open stays as
 * it is, with the time it was first asked.
 * @param {string} walletId
 * @param {{ lux: bigint | null, memo: string, network: string, to: string }} asked
 */
export function rememberRequest(walletId, { lux, memo, network, to }) {
  const text = lux === null ? null : String(lux);
  return change(walletId, (list) =>
    list.some((kept) => !kept.paid && kept.to === to && kept.lux === text && kept.memo === memo && kept.network === network)
      ? list
      : [{ at: Date.now(), id: crypto.randomUUID(), lux: text, memo, network, to }, ...list]
  );
}

/**
 * Takes a request off the list.
 * @param {string} walletId
 * @param {string} id
 */
export const forgetRequest = (walletId, id) => change(walletId, (list) => (list.some((kept) => kept.id === id) ? list.filter((kept) => kept.id !== id) : list));

/**
 * Keeps what paid each request matchRequests calls paid.
 * @param {string} walletId
 * @param {Map<string, import("@dusk-network/app-core/requests").RequestMatch>} matches
 */
export function keepRequestsPaid(walletId, matches) {
  const paid = (kept) => {
    const match = matches.get(kept.id);
    return match?.state === "paid" && !kept.paid && match.hash && match.at ? { at: match.at, hash: match.hash } : null;
  };
  return change(walletId, (list) => (list.some(paid) ? list.map((kept) => (paid(kept) ? { ...kept, paid: paid(kept) } : kept)) : list));
}

/**
 * Drops every wallet's requests but those of `walletId`, a wallet restored in
 * place of the old one; with none, all.
 * @param {string | null | undefined} walletId
 */
export async function keepOnlyRequestsOf(walletId) {
  const id = String(walletId ?? "").trim();
  const own = id ? (await readAll())[id] : null;
  if (Array.isArray(own)) await storage.set({ [KEY]: { [id]: own } });
  else await storage.remove(KEY);
}

/**
 * Drops one wallet's requests, as it's removed.
 * @param {string} walletId
 */
export async function forgetWalletRequests(walletId) {
  const id = String(walletId ?? "");
  await withStorageLock(KEY, async () => {
    const all = await readAll();
    if (!(id in all)) return;
    delete all[id];
    await storage.set({ [KEY]: all });
  });
}
