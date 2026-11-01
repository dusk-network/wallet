// The wallets on this device as the switcher shows them, by their vault ID
// (vault.js): each one's name, when it was given one, and what it showed last
// time it was unlocked: its wallet ID (its first public account, which its
// labels, contacts, tokens, notes, history and sites are kept by) and its
// profiles' public accounts. With them, the wallet unlocked last, which the
// next unlock opens. Nothing here is secret: the phrases are in the vault.
//
// STORAGE_KEYS.WALLETS: { active: key, wallets: { [key]: { walletId, accounts, name? } } }

import { storage, STORAGE_KEYS } from "./storage.js";
import { withStorageLock } from "./storageLock.js";

const KEY = STORAGE_KEYS.WALLETS;
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** A wallet's name as given: one line, at most 32 characters; "" for none. */
export function normalizeWalletName(name) {
  return String(name ?? "").trim().replace(/\s+/g, " ").slice(0, 32);
}

/** What a wallet is called: its name, or "Wallet 2" by its number. */
export function walletLabel(wallet) {
  return normalizeWalletName(wallet?.name) || `Wallet ${Number(wallet?.n) || 1}`;
}

/**
 * The number the next wallet gets: one past the highest here.
 * @param {Array<{ n?: number }>} wallets
 */
export function nextWalletNumber(wallets) {
  return Math.max(0, ...(Array.isArray(wallets) ? wallets : []).map((w) => Number(w?.n) || 0)) + 1;
}

/** @returns {Promise<{ active: string, wallets: Record<string, { walletId?: string, accounts?: string[], name?: string }> }>} */
export async function getWalletDirectory() {
  const stored = (await storage.get(KEY))?.[KEY];
  return {
    active: typeof stored?.active === "string" ? stored.active : "",
    wallets: isObject(stored?.wallets) ? stored.wallets : {},
  };
}

function change(fn) {
  return withStorageLock(KEY, async () => {
    const next = fn(await getWalletDirectory());
    await storage.set({ [KEY]: next });
    return next;
  });
}

/**
 * Keep what a wallet shows while unlocked, and make it the one the next
 * unlock opens.
 * @param {string} key - its vault ID
 * @param {{ walletId: string, accounts: string[] }} shown
 */
export function noteActiveWallet(key, { walletId, accounts }) {
  const id = String(key ?? "");
  if (!id) return Promise.resolve(null);
  return change((dir) => ({
    active: id,
    wallets: {
      ...dir.wallets,
      [id]: {
        ...(isObject(dir.wallets[id]) ? dir.wallets[id] : {}),
        walletId: String(walletId ?? ""),
        accounts: (Array.isArray(accounts) ? accounts : []).map(String),
      },
    },
  }));
}

/**
 * Name a wallet, or give it its number back with "".
 * @param {string} key
 * @param {string} name
 */
export function setWalletName(key, name) {
  const id = String(key ?? "");
  const next = normalizeWalletName(name);
  return change((dir) => {
    const { name: _old, ...rest } = isObject(dir.wallets[id]) ? dir.wallets[id] : {};
    return { ...dir, wallets: { ...dir.wallets, [id]: next ? { ...rest, name: next } : rest } };
  });
}

/** Forget a removed wallet. */
export function forgetWallet(key) {
  const id = String(key ?? "");
  return change((dir) => {
    const { [id]: _gone, ...wallets } = dir.wallets;
    return { active: dir.active === id ? "" : dir.active, wallets };
  });
}

/** Forget every wallet, for a reset. */
export function clearWallets() {
  return withStorageLock(KEY, () => storage.remove(KEY));
}

/**
 * The wallet ID of the wallet the next unlock opens, as it was last
 * unlocked; "" before any was.
 */
export async function activeWalletId() {
  const dir = await getWalletDirectory();
  return String(dir.wallets[dir.active]?.walletId ?? "");
}
