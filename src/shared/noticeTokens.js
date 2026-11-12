// The tokens of the app's arrival notices on Android, by transaction: made as
// a send's notice is asked for (wallet/localBus.js) and checked as a notice's
// tap opens the app (DUSK_UI_TX_NOTICED). Any app can open the wallet as a
// tap would: a tap is a notice's only with the token made for it, and each is
// taken once. Kept apart from the transactions' records, which history's
// sync forgets once a send is in it, though its notice may be tapped later;
// each with the wallet its send is from, whose removal forgets it, and every
// one goes with a reset (walletReset.js). The newest 50 are kept.

import { storage, STORAGE_KEYS } from "./storage.js";
import { withStorageLock } from "./storageLock.js";

const KEY = STORAGE_KEYS.NOTICE_TOKENS;
const KEPT = 50;
const TOKEN = /^[0-9a-f]{32}$/;

async function read() {
  const all = (await storage.get(KEY))?.[KEY];
  return all && typeof all === "object" && !Array.isArray(all) ? all : {};
}

const randomToken = () => [...globalThis.crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * The token of `hash`'s notice: the one made for it, else a new one, kept
 * with `wallet`, the wallet its send is from.
 * @param {string} hash
 * @param {string} [wallet]
 * @returns {Promise<string>}
 */
export function noticeTokenFor(hash, wallet = "") {
  return withStorageLock(KEY, async () => {
    const all = await read();
    if (TOKEN.test(String(all[hash]?.token ?? ""))) return all[hash].token;
    const token = randomToken();
    const newest = Object.entries({ ...all, [hash]: { token, wallet: String(wallet ?? ""), at: Date.now() } })
      .sort(([, a], [, b]) => (Number(b?.at) || 0) - (Number(a?.at) || 0))
      .slice(0, KEPT);
    await storage.set({ [KEY]: Object.fromEntries(newest) });
    return token;
  });
}

/**
 * Whether `token` is the one made for `hash`'s notice. Taken, it goes: a
 * notice's tap is taken once.
 * @param {string} hash
 * @param {string} token
 * @returns {Promise<boolean>}
 */
export function takeNoticeToken(hash, token) {
  if (!TOKEN.test(String(token ?? ""))) return Promise.resolve(false);
  return withStorageLock(KEY, async () => {
    const all = await read();
    if (all[hash]?.token !== token) return false;
    const rest = { ...all };
    delete rest[hash];
    await storage.set({ [KEY]: rest });
    return true;
  });
}

/**
 * A wallet removed (`wallet`, its first public account): its notices' tokens
 * go; every one's with a reset ("").
 * @param {string} [wallet]
 */
export function forgetNoticeTokens(wallet = "") {
  return withStorageLock(KEY, async () => {
    if (!wallet) return storage.remove(KEY);
    const all = await read();
    await storage.set({ [KEY]: Object.fromEntries(Object.entries(all).filter(([, kept]) => kept?.wallet !== wallet)) });
  });
}
