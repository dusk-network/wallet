// The balances read last for each profile on each node, kept on this device:
// the public and shielded balances and what's staked, with when they were
// read, never a key or a phrase. Where one can't be read now, as when the
// wallet opens with no signal or the node doesn't answer, Home shows the one
// kept, said to be maybe out of date, rather than a dash. A reset forgets them
// all, and removing a wallet its own (walletReset.js).

import { storage, STORAGE_KEYS } from "./storage.js";

const KEY = STORAGE_KEYS.KEPT_BALANCES;

// One profile's on one node.
const placeOf = ({ nodeUrl, account }) => `${String(nodeUrl ?? "")}\n${String(account ?? "")}`;

async function readAll() {
  const all = (await storage.get(KEY))?.[KEY];
  return all && typeof all === "object" && !Array.isArray(all) ? all : {};
}

// Writes one after another: each reads what the one before wrote.
let writes = Promise.resolve();

/**
 * Keeps what was read now of a profile's balances on a node, over what was
 * kept: a part not read now (null) keeps its last reading. Written only
 * when what's kept changes.
 * @param {{ nodeUrl: string, account: string }} place
 * @param {{ balance?: object | null, shieldedBalance?: object | null, staked?: object | null }} read
 */
export function keepBalances(place, { balance = null, shieldedBalance = null, staked = null }) {
  if (!place?.nodeUrl || !place?.account) return Promise.resolve();
  const next = writes.then(async () => {
    const all = await readAll();
    const key = placeOf(place);
    const was = all[key] ?? {};
    const now = Date.now();
    const kept = { ...was };
    // A part read now, with when: written as it changes, and once a minute
    // at most while it doesn't, so when it was read stays near enough.
    const take = (name, value) => {
      if (!value || typeof value !== "object") return;
      if (JSON.stringify(value) === JSON.stringify(was[name]) && now - Number(was[`${name}At`] ?? 0) < 60_000) return;
      kept[name] = value;
      kept[`${name}At`] = now;
    };
    take("balance", balance);
    take("shieldedBalance", shieldedBalance);
    take("staked", staked);
    if (JSON.stringify(kept) === JSON.stringify(was)) return;
    all[key] = kept;
    await storage.set({ [KEY]: all });
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
  return (await readAll())[placeOf(place)] ?? null;
}

/**
 * The parts of an overview that couldn't be read now, filled in from what's
 * kept, each said to be maybe out of date (`balanceStale`, `shieldedStale`,
 * `stakeStale`) with when it was read (`balanceReadAt`). What was read now
 * is kept for next time.
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
  if (!read.shieldedBalance && kept.shieldedBalance) Object.assign(out, { shieldedBalance: kept.shieldedBalance, shieldedStale: true });
  if (!stakeRead && kept.staked) Object.assign(out, { staked: kept.staked, stakeStale: true });
  return out;
}

/**
 * Forgets what's kept: every profile's, or those of `accounts` alone (a wallet removed).
 * @param {string[]} [accounts]
 */
export async function forgetKeptBalances(accounts) {
  await writes;
  if (!accounts) {
    await storage.remove(KEY);
    return;
  }
  const all = await readAll();
  const gone = new Set(accounts.map(String));
  let changed = false;
  for (const key of Object.keys(all)) {
    if (gone.has(key.split("\n")[1])) {
      delete all[key];
      changed = true;
    }
  }
  if (changed) await storage.set({ [KEY]: all });
}
