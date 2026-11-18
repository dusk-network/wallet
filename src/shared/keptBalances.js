// The balances read last for each profile on each node, kept on this device:
// the public and shielded balances and what's staked, with when they were
// read, never a key or a phrase. Where one can't be read now, as when the
// wallet opens with no signal or the node doesn't answer, Home shows the one
// kept, said to be maybe out of date, rather than a dash; Staking its figures
// the same way (`staking`: its stake's owner status and the minimum stake;
// `sozu`: Sozu's status, with what the profile holds there).
// A reset forgets them all, and removing a wallet its own (walletReset.js).

import { storage, STORAGE_KEYS } from "./storage.js";
import { withStorageLock } from "./storageLock.js";

const KEY = STORAGE_KEYS.KEPT_BALANCES;

// Each part under the key of whoever writes it: the overview's (balance,
// shieldedBalance, staked: the wallet's own context) under KEY, Staking's
// and Sozu's (the page's) under keys of their own, so that one's read, then
// write, never takes away what another wrote meanwhile (round 40's review:
// the popup and the wallet each queued their own writes to the one object,
// and the one written last dropped the other's figures).
const KEY_OF = { balance: KEY, shieldedBalance: KEY, staked: KEY, staking: `${KEY}_staking`, sozu: `${KEY}_sozu` };
const KEYS = [...new Set(Object.values(KEY_OF))];

// Each key's map read, changed and written under its lock, which every page
// and the wallet's own context take alike: none reads the map another is
// writing, to write its own over it (round 40's second review: two windows'
// Staking each wrote back the map it read, and the one written last dropped
// the other's account).
const underLock = (key, fn) => withStorageLock(key, fn);

// One profile's on one node.
const placeOf = ({ nodeUrl, account }) => `${String(nodeUrl ?? "")}\n${String(account ?? "")}`;

async function readAll(key = KEY) {
  const all = (await storage.get(key))?.[key];
  return all && typeof all === "object" && !Array.isArray(all) ? all : {};
}

// Writes one after another: each reads what the one before wrote.
let writes = Promise.resolve();

/**
 * Keeps what was read now of a profile's balances on a node, over what was
 * kept: a part not read now (null) keeps its last reading. Written only
 * when what's kept changes.
 * @param {{ nodeUrl: string, account: string }} place
 * @param {{ balance?: object | null, shieldedBalance?: object | null, staked?: object | null, staking?: object | null, sozu?: object | null }} read
 */
export function keepBalances(place, read) {
  if (!place?.nodeUrl || !place?.account) return Promise.resolve();
  const next = writes.then(async () => {
    const at = placeOf(place);
    const now = Date.now();
    for (const key of KEYS) {
      // The parts read now that are kept under this key.
      const parts = Object.keys(KEY_OF).filter((name) => KEY_OF[name] === key && read?.[name] && typeof read[name] === "object");
      if (!parts.length) continue;
      await underLock(key, async () => {
        const all = await readAll(key);
        const was = all[at] ?? {};
        const kept = { ...was };
        // A part read now, with when: written as it changes, and once a minute
        // at most while it doesn't, so when it was read stays near enough.
        for (const name of parts) {
          if (JSON.stringify(read[name]) === JSON.stringify(was[name]) && now - Number(was[`${name}At`] ?? 0) < 60_000) continue;
          kept[name] = read[name];
          kept[`${name}At`] = now;
        }
        if (JSON.stringify(kept) === JSON.stringify(was)) return;
        all[at] = kept;
        await storage.set({ [key]: all });
      });
    }
  });
  writes = next.catch(() => {});
  return next;
}

/**
 * What's kept of a profile's balances on a node, each with when it was read
 * (`balanceAt`, …): null where nothing is.
 * @param {{ nodeUrl: string, account: string }} place
 */
export async function keptBalancesOf(place) {
  if (!place?.nodeUrl || !place?.account) return null;
  await writes;
  const at = placeOf(place);
  const parts = (await Promise.all(KEYS.map(async (key) => (await readAll(key))[at]))).filter((part) => part && typeof part === "object");
  return parts.length ? Object.assign({}, ...parts) : null;
}

/**
 * The parts of an overview that couldn't be read now, filled in from what's
 * kept, each said to be maybe out of date (`balanceStale`, `shieldedStale`,
 * `stakeStale`) with when it was read (`balanceReadAt`, `shieldedReadAt`,
 * `stakeReadAt`), for the note to say. What was read now is kept for next
 * time.
 * @param {{ nodeUrl: string, account: string }} place
 * @param {{ balance?: object | null, shieldedBalance?: object | null, staked?: object | null }} read
 * @param {{ stakeRead?: boolean }} [opts] - `stakeRead`: false where the stake was asked for and couldn't be read
 * @returns {Promise<object>} what to add to the overview
 */
export async function withKeptBalances(place, read, { stakeRead = true } = {}) {
  keepBalances(place, { balance: read.balance, shieldedBalance: read.shieldedBalance, staked: stakeRead ? read.staked : null }).catch(() => {});
  const kept = await keptBalancesOf(place).catch(() => null);
  if (!kept) return {};
  const out = {};
  if (!read.balance && kept.balance) Object.assign(out, { balance: kept.balance, balanceStale: true, balanceReadAt: kept.balanceAt });
  if (!read.shieldedBalance && kept.shieldedBalance) Object.assign(out, { shieldedBalance: kept.shieldedBalance, shieldedStale: true, shieldedReadAt: kept.shieldedBalanceAt });
  if (!stakeRead && kept.staked) Object.assign(out, { staked: kept.staked, stakeStale: true, stakeReadAt: kept.stakedAt });
  return out;
}

/**
 * Forgets what's kept: every profile's, or those of `accounts` alone (a wallet removed).
 * @param {string[]} [accounts]
 */
export async function forgetKeptBalances(accounts) {
  await writes;
  if (!accounts) {
    await Promise.all(KEYS.map((key) => underLock(key, () => storage.remove(key))));
    return;
  }
  const gone = new Set(accounts.map(String));
  for (const key of KEYS) {
    await underLock(key, async () => {
      const all = await readAll(key);
      let changed = false;
      for (const at of Object.keys(all)) {
        if (gone.has(at.split("\n")[1])) {
          delete all[at];
          changed = true;
        }
      }
      if (changed) await storage.set({ [key]: all });
    });
  }
}
