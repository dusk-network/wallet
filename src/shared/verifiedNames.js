// The last check of each of the wallet's accounts' .dusk names, per network:
// its verified primary name, or none, and when. Name lookups (duskNames.js)
// keep their answers here, in the popup and in the engine, and the background
// and the approval pop-ups read them without loading the names code or the
// lens driver. A site or an approval gets a name only within ten minutes of
// its check.

import { isExtensionRuntime } from "../platform/runtime.js";
import { chainIdForNode, listedNetwork, networkOf, nodeHost } from "./nodeNetwork.js";
import { storage, STORAGE_KEYS } from "./storage.js";
import { withStorageLock } from "./storageLock.js";

/** How long after its check a name still goes to sites and approvals. */
export const VERIFIED_NAME_TTL_MS = 10 * 60_000;

// A check this recent isn't repeated; name lookups reuse an answer as long.
const RECHECK_MS = 60_000;

/**
 * The Dusk Domains network of a node, by the chain ID it gave
 * (nodeNetwork.js), or null where names are off: a network without Dusk
 * Domains, or one that isn't known.
 * @param {string} nodeUrl
 * @param {number | null} [chainId] - the node's, where the caller has it
 * @returns {"mainnet"|"testnet"|null}
 */
export function duskNamesNetwork(nodeUrl, chainId = chainIdForNode(String(nodeUrl ?? ""))) {
  const net = networkOf(chainId);
  return net?.duskDomains && (net.name === "mainnet" || net.name === "testnet") ? net.name : null;
}

/**
 * Where a node's name checks are kept: a network's own node's by that network,
 * any other's by its host, as it can answer what it likes: back on the network's
 * own node, nothing it said is taken for that node's word. Null where names are off.
 * @param {string} nodeUrl
 * @param {number | null} [chainId] - the node's, where the caller has it
 * @returns {string | null}
 */
export function duskNamesScope(nodeUrl, chainId) {
  const network = duskNamesNetwork(nodeUrl, chainId);
  if (!network) return null;
  return listedNetwork(nodeUrl) ? network : nodeHost(nodeUrl) || null;
}

const age = (entry, now) => now - Number(entry?.at);

/**
 * Every check kept: { [scope]: { [account]: { name, at } } }, by duskNamesScope,
 * `name` being null for an account without a name. Never throws.
 * @returns {Promise<Record<string, Record<string, { name: string|null, at: number }>>>}
 */
export async function readVerifiedNames() {
  try {
    const all = (await storage.get(STORAGE_KEYS.VERIFIED_NAMES))?.[STORAGE_KEYS.VERIFIED_NAMES];
    return all && typeof all === "object" ? all : {};
  } catch {
    return {};
  }
}

/**
 * The names in `all` checked on the node's network, by that node if it's one the
 * wallet doesn't know, within the last ten minutes, by account.
 * @param {object} all - from readVerifiedNames
 * @param {string} nodeUrl
 * @param {number} [now]
 * @returns {Map<string, string>}
 */
export function verifiedNamesFor(all, nodeUrl, now = Date.now()) {
  const scope = duskNamesScope(nodeUrl);
  const names = new Map();
  for (const [account, entry] of Object.entries((scope && all?.[scope]) || {})) {
    const name = entry?.name;
    const since = age(entry, now);
    if (typeof name === "string" && name.endsWith(".dusk") && since >= 0 && since < VERIFIED_NAME_TTL_MS) {
      names.set(account, name);
    }
  }
  return names;
}

/**
 * Those of `accounts` whose name wasn't checked on the node's network in the
 * last minute; none where names are off.
 * @param {object} all - from readVerifiedNames
 * @param {string} nodeUrl
 * @param {string[]} accounts
 * @param {number} [now]
 * @returns {string[]}
 */
export function namesToRecheck(all, nodeUrl, accounts, now = Date.now()) {
  const scope = duskNamesScope(nodeUrl);
  if (!scope) return [];
  return accounts.filter((account) => {
    const since = age(all?.[scope]?.[account], now);
    return !(since >= 0 && since < RECHECK_MS);
  });
}

/**
 * Keep a check of an account's name, `name` null when it has none, and drop
 * checks older than ten minutes. Only the extension keeps them: no site gets
 * names anywhere else. Never throws.
 * @param {string} nodeUrl - the node the check read through
 * @param {string} account
 * @param {string|null} name
 * @returns {Promise<void>}
 */
export async function rememberVerifiedName(nodeUrl, account, name) {
  const scope = duskNamesScope(nodeUrl);
  if (!scope || !account || !isExtensionRuntime()) return;
  try {
    await withStorageLock(STORAGE_KEYS.VERIFIED_NAMES, async () => {
      const now = Date.now();
      const next = {};
      for (const [net, entries] of Object.entries(await readVerifiedNames())) {
        for (const [acct, entry] of Object.entries(entries ?? {})) {
          const since = age(entry, now);
          if (since >= 0 && since < VERIFIED_NAME_TTL_MS) (next[net] ??= {})[acct] = entry;
        }
      }
      (next[scope] ??= {})[account] = { name: name ?? null, at: now };
      await storage.set({ [STORAGE_KEYS.VERIFIED_NAMES]: next });
    });
  } catch {
    // A check that can't be kept is made again later.
  }
}
