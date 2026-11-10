// A record per site, per wallet, for Settings' Connected sites: when it last used
// its connection, what it asked for and how that was answered, and how long it
// was set to stay connected. It stays once the site is disconnected, until it's
// forgotten or the wallet removed or reset.
//
// STORAGE_KEYS.SITE_RECORDS holds
//   { [walletId]: { [origin]: { lastUsedAt?, lastsMs?, asked?: [{ at, what, method?, answer }] } } }
//
// It keeps what a request was, never what was in it: no amount, recipient, memo,
// message, contract or hash. Those of a send are in Activity, which names its
// site. A contract call keeps its function's name, as the site gave it, cut short.
//
// Bounded: a site's newest requests, and past that the oldest of what no one
// answered goes first (what the site cancelled, what wasn't answered in time
// or couldn't be shown),
// then the oldest refusal, then the oldest approval. A site can't push out
// what it was refused or allowed by asking again and again, and cancelling at
// once. The same goes for a wallet's sites: a site with neither goes first,
// then one that was only refused.

import { getPermissionForOrigin } from "./permissions.js";
import { storage, STORAGE_KEYS } from "./storage.js";
import { withStorageLock } from "./storageLock.js";
import { TX_KIND } from "./constants.js";

/** Requests kept of a site. */
export const SITE_ASKED_KEPT = 30;
/** Sites kept of a wallet. */
export const SITES_KEPT = 50;

const KEY = STORAGE_KEYS.SITE_RECORDS;
const METHOD_CHARS = 64;
// A site's connection counts as used at most this often, to spare the storage.
const USE_EVERY_MS = 60_000;

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

// How long an answer stays as more come: the person's own longest, an approval longest of all.
const KEEP_RANK = Object.freeze({ approved: 2, failed: 2, unconfirmed: 2, rejected: 1, closed: 1 });
const rankOf = (entry) => KEEP_RANK[entry?.answer] ?? 0;
const sitesOf = (all, id) => (isObject(all[id]) ? all[id] : {});
const siteOf = (sites, origin) => (isObject(sites[origin]) ? sites[origin] : {});

async function readAll() {
  const all = (await storage.get(KEY))?.[KEY];
  return isObject(all) ? all : {};
}

// One at a time and in the order they're asked: what's cleared stays cleared of
// whatever was noted before it was.
const mutate = (change) =>
  withStorageLock(KEY, async () => {
    const all = await readAll();
    const next = await change(all);
    if (next === all) return;
    if (Object.keys(next).length) await storage.set({ [KEY]: next });
    else await storage.remove(KEY);
  });

/**
 * When a site was last heard of: its last use or its newest request.
 * @param {{ lastUsedAt?: number, asked?: Array<{ at: number }> } | undefined} record
 * @returns {number}
 */
export const siteLastSeen = (record) => Math.max(Number(record?.lastUsedAt) || 0, Number(record?.asked?.[0]?.at) || 0);

// A wallet's sites within what's kept.
function bounded(sites) {
  const entries = Object.entries(sites);
  if (entries.length <= SITES_KEPT) return sites;
  const answered = (site) => Math.max(0, ...(Array.isArray(site.asked) ? site.asked.map(rankOf) : []));
  entries.sort(([, a], [, b]) => answered(b) - answered(a) || siteLastSeen(b) - siteLastSeen(a));
  return Object.fromEntries(entries.slice(0, SITES_KEPT));
}

// What a request is, for its record, and nothing else of it.
function requestRecord(kind, params) {
  switch (kind) {
    case "connect":
      return { what: params?.shieldedReceiveAddress ? "shielded_address" : "connect" };
    case "send_tx": {
      const txKind = String(params?.kind ?? "").toLowerCase();
      if (txKind !== TX_KIND.CONTRACT_CALL) return { what: Object.values(TX_KIND).includes(txKind) ? txKind : "other" };
      const method = Array.from(String(params?.fnName ?? "").trim()).slice(0, METHOD_CHARS).join("");
      return { what: txKind, ...(method ? { method } : {}) };
    }
    case "watch_asset":
      return { what: String(params?.type ?? "").toUpperCase() === "DRC721" ? "watch_nft" : "watch_token" };
    case "switch_network":
    case "sign_message":
    case "sign_auth":
    case "sign_typed_data":
      return { what: kind };
    default:
      return { what: "other" };
  }
}

/**
 * Keeps how a site's request was answered. `walletId` may still be on its way: the
 * note takes its place in line as it's made.
 * @param {string | Promise<string>} walletId - the wallet it was for
 * @param {string} origin
 * @param {{ kind: string, params?: object, answer: "approved"|"failed"|"unconfirmed"|"rejected"|"closed"|"expired"|"cancelled"|"not_shown", at?: number }} request
 */
export function noteSiteRequest(walletId, origin, { kind, params, answer, at = Date.now() }) {
  return mutate(async (all) => {
    const id = String((await walletId) ?? "");
    if (!id || !origin) return all;
    const sites = sitesOf(all, id);
    const site = siteOf(sites, origin);
    const asked = [{ at, ...requestRecord(kind, params), answer }, ...(Array.isArray(site.asked) ? site.asked : [])];
    while (asked.length > SITE_ASKED_KEPT) {
      const least = Math.min(...asked.map(rankOf));
      asked.splice(asked.findLastIndex((entry) => rankOf(entry) === least), 1);
    }
    return { ...all, [id]: bounded({ ...sites, [origin]: { ...site, asked } }) };
  });
}

/**
 * Says how a site's approved send went, on its record: "failed" when nothing
 * went out, "unconfirmed" when it may not have. The approval is the site's
 * newest one since `since`: a site has one waiting at a time.
 * @param {string} walletId
 * @param {string} origin
 * @param {{ since: number, answer: "failed"|"unconfirmed" }} outcome
 */
export function noteSiteSendFailed(walletId, origin, { since, answer }) {
  const id = String(walletId ?? "");
  return mutate((all) => {
    const site = siteOf(sitesOf(all, id), origin);
    const asked = Array.isArray(site.asked) ? site.asked : [];
    const at = asked.findIndex((entry) => entry?.answer === "approved" && Number(entry.at) >= since);
    if (!id || at < 0) return all;
    const next = asked.map((entry, i) => (i === at ? { ...entry, answer } : entry));
    return { ...all, [id]: { ...sitesOf(all, id), [origin]: { ...site, asked: next } } };
  });
}

const usedAt = new Map();

/**
 * Notes that a site used its connection, if it has one, at most once a minute.
 * @param {string} walletId
 * @param {string} origin
 * @param {number} [now]
 */
export async function noteSiteUse(walletId, origin, now = Date.now()) {
  const id = String(walletId ?? "");
  const key = `${id} ${origin}`;
  if (!id || !origin || now - (usedAt.get(key) ?? -Infinity) < USE_EVERY_MS) return;
  if (!(await getPermissionForOrigin(origin, id))) return;
  usedAt.set(key, now);
  await mutate((all) => {
    const sites = sitesOf(all, id);
    return { ...all, [id]: bounded({ ...sites, [origin]: { ...siteOf(sites, origin), lastUsedAt: now } }) };
  });
}

/**
 * Keeps how long a site was set to stay connected, for its next connection too.
 * @param {string} walletId
 * @param {string} origin
 * @param {number} lastsMs
 */
export function noteSiteLasts(walletId, origin, lastsMs) {
  const id = String(walletId ?? "");
  return mutate((all) => {
    const sites = sitesOf(all, id);
    return { ...all, [id]: bounded({ ...sites, [origin]: { ...siteOf(sites, origin), lastsMs } }) };
  });
}

/**
 * How long a site's next connection lasts: as it was set for this site, else `fallback`.
 * @param {string} walletId
 * @param {string} origin
 * @param {number} [fallback]
 * @returns {Promise<number>}
 */
export async function siteLastsMs(walletId, origin, fallback = 0) {
  const set = sitesOf(await readAll(), String(walletId ?? ""))[origin]?.lastsMs;
  return Number.isFinite(set) ? set : fallback;
}

/**
 * The records of these wallets, by wallet and origin.
 * @param {string[]} walletIds
 * @returns {Promise<Record<string, Record<string, { lastUsedAt?: number, lastsMs?: number, asked?: object[] }>>>}
 */
export async function getSiteRecords(walletIds) {
  const all = await readAll();
  return Object.fromEntries(walletIds.map((id) => [id, sitesOf(all, id)]));
}

/**
 * Forgets one site's record.
 * @param {string} walletId
 * @param {string} origin
 */
export function forgetSiteRecord(walletId, origin) {
  const id = String(walletId ?? "");
  return mutate((all) => {
    const { [origin]: _gone, ...left } = sitesOf(all, id);
    const { [id]: _wallet, ...others } = all;
    return Object.keys(left).length ? { ...others, [id]: left } : others;
  });
}

/**
 * Forgets a removed wallet's records.
 * @param {string} walletId
 */
export function forgetWalletSiteRecords(walletId) {
  const id = String(walletId ?? "");
  return mutate(({ [id]: _gone, ...others }) => others);
}

/** Forgets every record: a reset. */
export function clearSiteRecords() {
  return mutate(() => ({}));
}
