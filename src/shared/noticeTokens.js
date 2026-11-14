// The tokens of the app's arrival notices on Android, by transaction: made as
// a send's notice is asked for (wallet/localBus.js) and checked as a notice's
// tap opens the app (DUSK_UI_TX_NOTICED). Any app can open the wallet as a
// tap would: a tap is a notice's only with the token made for it, and each is
// taken once. Kept apart from the transactions' records, which history's
// sync forgets once a send is in it, though its notice may be tapped later;
// each with the wallet its send is from, whose removal forgets it, and every
// one goes with a reset (walletReset.js). The newest 50 are kept. And each
// wallet's token for its notices of money coming in, which Android's job
// posts (android/ArrivalJob.kt): made once, kept apart from the 50, and
// checked, never taken, as each of those notices carries it.

import { storage, STORAGE_KEYS } from "./storage.js";
import { withStorageLock } from "./storageLock.js";

const KEY = STORAGE_KEYS.NOTICE_TOKENS;
const KEPT = 50;
const TOKEN = /^[0-9a-f]{32}$/;
// A wallet's token for money coming in is kept by this key and the wallet.
const INCOMING = "in:";

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
    const entries = Object.entries({ ...all, [hash]: { token, wallet: String(wallet ?? ""), at: Date.now() } });
    const newest = entries
      .filter(([key]) => !key.startsWith(INCOMING))
      .sort(([, a], [, b]) => (Number(b?.at) || 0) - (Number(a?.at) || 0))
      .slice(0, KEPT);
    await storage.set({ [KEY]: Object.fromEntries([...entries.filter(([key]) => key.startsWith(INCOMING)), ...newest]) });
    return token;
  });
}

/**
 * The token of `wallet`'s notices for money coming in: the one made for it,
 * else a new one.
 * @param {string} wallet - its first public account
 * @returns {Promise<string>}
 */
export function incomingNoticeToken(wallet) {
  const key = `${INCOMING}${wallet}`;
  return withStorageLock(KEY, async () => {
    const all = await read();
    if (TOKEN.test(String(all[key]?.token ?? ""))) return all[key].token;
    const token = randomToken();
    await storage.set({ [KEY]: { ...all, [key]: { token, wallet: String(wallet ?? ""), at: Date.now() } } });
    return token;
  });
}

/**
 * Whether `token` is `wallet`'s for its notices of money coming in.
 * @param {string} wallet
 * @param {string} token
 * @returns {Promise<boolean>}
 */
export async function isIncomingNoticeToken(wallet, token) {
  if (!wallet || !TOKEN.test(String(token ?? ""))) return false;
  return (await read())[`${INCOMING}${wallet}`]?.token === token;
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
