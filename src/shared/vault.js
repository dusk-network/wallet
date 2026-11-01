import { storage, STORAGE_KEYS } from "./storage.js";
import { isTauriRuntime } from "../platform/runtime.js";
import { withStorageLock } from "./storageLock.js";
import { bytesToHex, sha256Hex } from "./bytes.js";
import { nextWalletNumber } from "./wallets.js";
import {
  base64ToBytes,
  bytesToBase64,
  decryptMnemonicWithKey,
  deriveVaultKey,
  deserializeEncryptInfo,
  encryptMnemonicWithKey,
  newKeySalt,
  serializeEncryptInfo,
  utf8ToBytes,
} from "./crypto.js";

// The vault: every recovery phrase on this device, under one password.
//
// - Extension/web: STORAGE_KEYS.VAULT_V2 holds
//     { version: 2, wallets: [{ id, n, data, iv, salt, iterations }] }
//   Each wallet's phrase is sealed as the first vault sealed its one
//   (crypto.js: PBKDF2-SHA-256, 900,000 iterations, AES-GCM-256), with an IV
//   of its own, so v1's record moves over as it is, its salt with it. A wallet
//   added reuses the salt and iterations of one already here, so an unlock
//   derives the key once for all of them; a new password gives them all one
//   new salt. `id` names the wallet to the engine and the switcher; `n` is its
//   number, "Wallet 2", which stays when another wallet goes.
// - Tauri: a Stronghold snapshot, encrypted with the password, keeps a key per
//   wallet ("wallet:<id>") and their list ("wallets").
//
// The move from v1 (STORAGE_KEYS.VAULT, one phrase) runs on unlock, with the
// password that opens it: v2 is written with v1's record in it, read back and
// opened with the password, and only then does v1 go. Cut short at any step,
// v1 or v2 still holds the phrase, and the next unlock finishes the move. A
// wrong password moves nothing.
//
// Nothing the password doesn't open is changed or removed, but by Reset: a
// phrase sealed under another password stays as it is, and opens with that one.

const VAULT_VERSION = 2;
const STRONGHOLD_SNAPSHOT_FILE = "dusk-wallet.hold";
const STRONGHOLD_CLIENT_PATH = "dusk-wallet";
// v1's one phrase in the snapshot, and v2's list and a key per wallet.
const STRONGHOLD_STORE_KEY_MNEMONIC = "mnemonic";
const STRONGHOLD_STORE_KEY_WALLETS = "wallets";
const strongholdWalletKey = (id) => `wallet:${id}`;
// The wallet v1's one phrase becomes, named the same each time its move is tried.
const STRONGHOLD_V1_WALLET_ID = "v1-desktop";

const UNLOCK_BACKOFF_BASE_MS = 1_000;
const UNLOCK_BACKOFF_MAX_MS = 60_000;

const NO_VAULT = "No wallet vault found. Import a mnemonic first.";
const NOT_SAVED = "The wallet vault couldn't be saved. Try again.";
const NOT_CHECKED = "The wallet vault couldn't be checked. Lock the wallet and unlock it again.";
const UNSUPPORTED = "Unsupported vault format. Confirm you have your recovery phrase, then use Settings → Reset wallet and import it again.";

/** The one sentence an import of a phrase that's already here gets. */
export const DUPLICATE_PHRASE = "This recovery phrase is already in your wallet.";

// Every read-modify-write of the vault and its unlock guard, one at a time in
// every page and the background alike.
const vaultLock = (fn) => withStorageLock(STORAGE_KEYS.VAULT_V2, fn);

function normalizeUnlockGuard(value) {
  const failures = Number(value?.failures ?? 0);
  const nextAllowedAt = Number(value?.nextAllowedAt ?? 0);

  return {
    failures: Number.isFinite(failures) && failures > 0 ? Math.floor(failures) : 0,
    nextAllowedAt:
      Number.isFinite(nextAllowedAt) && nextAllowedAt > 0 ? Math.floor(nextAllowedAt) : 0,
  };
}

async function getUnlockGuard() {
  const items = await storage.get({
    [STORAGE_KEYS.UNLOCK_GUARD]: { failures: 0, nextAllowedAt: 0 },
  });
  return normalizeUnlockGuard(items[STORAGE_KEYS.UNLOCK_GUARD]);
}

async function setUnlockGuard(value) {
  const next = normalizeUnlockGuard(value);
  if (!next.failures && !next.nextAllowedAt) {
    await storage.remove(STORAGE_KEYS.UNLOCK_GUARD);
    return;
  }
  await storage.set({ [STORAGE_KEYS.UNLOCK_GUARD]: next });
}

async function checkUnlockRateLimit() {
  const unlockGuard = await getUnlockGuard();
  const now = Date.now();
  if (unlockGuard.nextAllowedAt && now < unlockGuard.nextAllowedAt) {
    const waitMs = unlockGuard.nextAllowedAt - now;
    const waitSec = Math.max(1, Math.ceil(waitMs / 1000));
    throw new Error(`Too many attempts. Try again in ${waitSec}s.`);
  }
}

async function recordUnlockFailure() {
  const unlockGuard = await getUnlockGuard();
  unlockGuard.failures += 1;
  const delay = Math.min(
    UNLOCK_BACKOFF_MAX_MS,
    UNLOCK_BACKOFF_BASE_MS * 2 ** (unlockGuard.failures - 1)
  );
  unlockGuard.nextAllowedAt = Date.now() + delay;
  await setUnlockGuard(unlockGuard);
}

async function resetUnlockFailures() {
  await storage.remove(STORAGE_KEYS.UNLOCK_GUARD);
}

// A wrong password: counted, so the next try waits.
async function incorrectPassword() {
  await recordUnlockFailure();
  return new Error("Incorrect password");
}

// Two spellings of one recovery phrase are the same phrase.
function samePhrase(a, b) {
  const norm = (m) => String(m ?? "").normalize("NFKD").trim().split(/\s+/).join(" ");
  return norm(a) === norm(b);
}

const newWalletId = () => bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
const nextNumber = nextWalletNumber;
const byNumber = (a, b) => a.n - b.n;
const publicOf = ({ id, n }) => ({ id, n });

// ---------------------------------------------------------------------------
// Extension/web: sealed phrases in platform storage
// ---------------------------------------------------------------------------

/** A phrase sealed as v1 seals it: what v1's vault is, and each v2 wallet holds. */
function isSealed(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof value.data === "string" &&
      typeof value.iv === "string" &&
      typeof value.salt === "string" &&
      value.iterations
  );
}

function isVaultV2(value) {
  return Boolean(value && typeof value === "object" && value.version === VAULT_VERSION && Array.isArray(value.wallets));
}

const isWallet = (w) => isSealed(w) && typeof w.id === "string" && w.id.length > 0 && Number.isInteger(w.n) && w.n > 0;

// The same record, whatever order its fields come back in: Chrome's storage
// hands objects back with their keys sorted.
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]))
    : value;
const sameRecord = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const sealedOf = ({ data, iv, salt, iterations }) => ({ data, iv, salt, iterations });

// The keys one password makes during one unlock or change of the vault: a
// PBKDF2 per salt and iteration count, however many phrases share them.
function keyring(password) {
  const keys = new Map();
  return (salt, iterations) => {
    const id = `${salt}:${iterations}`;
    if (!keys.has(id)) {
      const key = Promise.resolve().then(() => deriveVaultKey(password, base64ToBytes(String(salt)), iterations));
      // A salt that isn't one fails each phrase that has it, on its own.
      key.catch(() => {});
      keys.set(id, key);
    }
    return keys.get(id);
  };
}

// A salt of its own, for a new vault's phrase or a new password's.
function freshSalt() {
  const { salt, iterations } = newKeySalt();
  return { salt: bytesToBase64(salt), iterations };
}

// `mnemonic` sealed with the keyring's password, under the salt and
// iterations of `like` (a phrase here, or freshSalt()) and an IV of its own.
async function seal(mnemonic, keys, like) {
  const key = await keys(like.salt, like.iterations);
  return serializeEncryptInfo(
    await encryptMnemonicWithKey(mnemonic, key, { salt: base64ToBytes(like.salt), iterations: like.iterations })
  );
}

// The phrase `sealed` holds, or null when the keyring's password doesn't open it.
async function openSealed(sealed, keys) {
  try {
    return await decryptMnemonicWithKey(deserializeEncryptInfo(sealed), await keys(sealed.salt, sealed.iterations));
  } catch {
    return null;
  }
}

// The wallet v1's phrase becomes: named by v1's random salt, so a move tried
// again names it the same.
async function v1WalletId(v1) {
  return `v1-${(await sha256Hex(utf8ToBytes(String(v1.salt)))).slice(0, 32)}`;
}

async function readStored() {
  const items = await storage.get([STORAGE_KEYS.VAULT, STORAGE_KEYS.VAULT_V2]);
  return { v1: items?.[STORAGE_KEYS.VAULT] ?? null, v2: items?.[STORAGE_KEYS.VAULT_V2] ?? null };
}

async function readV2() {
  return (await storage.get(STORAGE_KEYS.VAULT_V2))?.[STORAGE_KEYS.VAULT_V2] ?? null;
}

// Write `next` as v2, read it back, and check it: the wallets in `changed`
// open with their keyring to their phrase, every other wallet is as it was,
// and those in `gone` are gone. Otherwise, a read back that failed included,
// v2 is put back as it was (`previous`, null for none), and it throws.
async function writeV2(next, { previous, changed = [], gone = [] }) {
  await storage.set({ [STORAGE_KEYS.VAULT_V2]: next });
  const ok = await (async () => {
    const back = await readV2();
    if (!isVaultV2(back) || back.wallets.length !== next.wallets.length) return false;
    for (const id of gone) if (back.wallets.some((w) => w.id === id)) return false;
    for (const want of next.wallets) {
      const got = back.wallets.find((w) => w.id === want.id);
      if (!got || !sameRecord(got, want)) return false;
    }
    for (const { id, mnemonic, keys } of changed) {
      const got = back.wallets.find((w) => w.id === id);
      if (!got || (await openSealed(got, keys)) !== mnemonic) return false;
    }
    return true;
  })().catch(() => false);
  if (ok) return;
  await (previous ? storage.set({ [STORAGE_KEYS.VAULT_V2]: previous }) : storage.remove(STORAGE_KEYS.VAULT_V2)).catch(() => {});
  throw new Error(NOT_SAVED);
}

// v1's phrase into v2, then v1 gone: v1's record copied over as it is, unless
// v2 opens to the phrase already (a move cut short after its write, or the
// same phrase), then v2 read back and opened with the password, and only then
// v1 removed. Returns the wallet that holds the phrase.
async function moveV1(v1, mnemonic, keys, opened) {
  const v2 = await readV2();
  if (v2 !== null && !isVaultV2(v2)) throw new Error(UNSUPPORTED);
  const wallets = v2?.wallets ?? [];
  const same = opened.find((w) => samePhrase(w.mnemonic, mnemonic));
  if (same) {
    const back = (await readV2())?.wallets?.find((w) => w.id === same.id);
    if (!back || !samePhrase(await openSealed(back, keys), mnemonic)) throw new Error("The wallet vault couldn't be moved");
    await storage.remove(STORAGE_KEYS.VAULT);
    return publicOf(same);
  }
  const id = await v1WalletId(v1);
  // A copy of v1 that doesn't open is no copy: v1's record takes its place.
  const broken = wallets.find((w) => w.id === id);
  const holder = { id, n: broken?.n ?? nextNumber([...wallets, ...opened]), ...sealedOf(v1) };
  const next = { version: VAULT_VERSION, wallets: broken ? wallets.map((w) => (w.id === id ? holder : w)) : [...wallets, holder] };
  await writeV2(next, { previous: v2, changed: [{ id, mnemonic, keys }] });
  await storage.remove(STORAGE_KEYS.VAULT);
  return publicOf(holder);
}

// Every wallet the password opens, with v1's moved in when it opens: the
// unlock's work, and what each change of the vault checks the password with.
// `opened` is empty for a password that opens nothing; `v1Left` says v1 opened
// but couldn't be moved this time, and stays. `keys` are the password's, for
// a change to seal with.
async function openVault(password) {
  const { v1, v2 } = await readStored();
  if (!v1 && !v2) throw new Error(NO_VAULT);
  // A vault this version can't read stays as it is; v1's phrase beside it
  // still opens, and stays too.
  if (!isVaultV2(v2) && !isSealed(v1)) throw new Error(UNSUPPORTED);
  await checkUnlockRateLimit();

  const keys = keyring(password);
  const wallets = (isVaultV2(v2) ? v2.wallets : []).filter(isWallet);
  const opened = (
    await Promise.all(wallets.map(async (w) => ({ ...publicOf(w), mnemonic: await openSealed(w, keys) })))
  ).filter((w) => w.mnemonic !== null);
  const fromV1 = isSealed(v1) ? await openSealed(v1, keys) : null;
  let v1Left = false;
  if (fromV1 !== null) {
    let moved;
    try {
      moved = await moveV1(v1, fromV1, keys, opened);
    } catch {
      // v1 stays, and opens this time as it did before: the next unlock moves it.
      v1Left = true;
      moved = { id: await v1WalletId(v1), n: nextNumber([...wallets, ...opened]) };
    }
    if (!opened.some((w) => w.id === moved.id || samePhrase(w.mnemonic, fromV1))) opened.push({ ...moved, mnemonic: fromV1 });
  }
  opened.sort(byNumber);
  return { record: await readV2(), opened, v1Left, keys };
}

// ---------------------------------------------------------------------------
// Tauri: Stronghold
// ---------------------------------------------------------------------------

function isBadFileKeyError(err) {
  const msg = String(err?.message ?? err ?? "");
  return msg.includes("BadFileKey") || msg.includes("invalid file");
}

async function tauriVaultExists() {
  const { exists, BaseDirectory } = await import("@tauri-apps/plugin-fs");
  return await exists(STRONGHOLD_SNAPSHOT_FILE, {
    baseDir: BaseDirectory.AppData,
  });
}

async function tauriDeleteVaultSnapshot() {
  const { remove, BaseDirectory } = await import("@tauri-apps/plugin-fs");
  try {
    await remove(STRONGHOLD_SNAPSHOT_FILE, { baseDir: BaseDirectory.AppData });
  } catch (err) {
    const msg = String(err?.message ?? err ?? "");
    // Ignore "file not found" but surface permission / other errors.
    if (msg.includes("NotFound") || msg.includes("does not exist") || msg.includes("os error 2")) {
      return;
    }
    throw err;
  }
}

async function tauriGetStrongholdPath() {
  const { appDataDir, join } = await import("@tauri-apps/api/path");
  return await join(await appDataDir(), STRONGHOLD_SNAPSHOT_FILE);
}

async function tauriLoadStronghold(password) {
  const { Stronghold } = await import("@tauri-apps/plugin-stronghold");
  const path = await tauriGetStrongholdPath();
  return await Stronghold.load(path, password);
}

async function tauriGetOrCreateClient(stronghold) {
  try {
    return await stronghold.loadClient(STRONGHOLD_CLIENT_PATH);
  } catch {
    return await stronghold.createClient(STRONGHOLD_CLIENT_PATH);
  }
}

const textOf = (bytes) => (bytes ? new TextDecoder().decode(new Uint8Array(bytes)) : null);
const bytesOf = (text) => Array.from(new TextEncoder().encode(text));

async function strongholdList(store) {
  try {
    const list = JSON.parse(textOf(await store.get(STRONGHOLD_STORE_KEY_WALLETS)) ?? "[]");
    return Array.isArray(list) ? list.filter((w) => typeof w?.id === "string" && Number.isInteger(w?.n)) : [];
  } catch {
    return [];
  }
}

// One session with the snapshot: loaded with the password, `fn` run with its
// store, then unloaded. Stronghold keeps one instance per snapshot, and
// unloading ends it, so sessions run one after another. A snapshot that
// doesn't load with the password is almost always a wrong password.
// `check` is for a load again with the password that just loaded it: a
// failure then isn't a wrong password.
async function strongholdSession(password, fn, { create = false, check = false } = {}) {
  let stronghold;
  try {
    stronghold = await tauriLoadStronghold(password);
  } catch (err) {
    if (create && isBadFileKeyError(err)) {
      throw new Error(
        "A wallet already exists for this app, but the password does not match. Go to Settings → Reset wallet vault to replace it."
      );
    }
    if (create || check) throw err;
    throw await incorrectPassword();
  }
  try {
    let client;
    if (create) client = await tauriGetOrCreateClient(stronghold);
    else {
      try {
        client = await stronghold.loadClient(STRONGHOLD_CLIENT_PATH);
      } catch {
        // No client means no vault has been created yet.
        throw new Error(NO_VAULT);
      }
    }
    return await fn(client.getStore(), stronghold);
  } finally {
    try {
      await stronghold.unload();
    } catch {
      // ignore
    }
  }
}

// The wallets the snapshot holds, read as they're kept.
async function strongholdWallets(store) {
  const out = [];
  for (const w of await strongholdList(store)) {
    const mnemonic = textOf(await store.get(strongholdWalletKey(w.id)));
    if (mnemonic !== null) out.push({ id: w.id, n: w.n, mnemonic });
  }
  return out.sort(byNumber);
}

const listBytes = (wallets) => bytesOf(JSON.stringify(wallets.map(publicOf)));

// Whether the snapshot, loaded again with the password, holds just `wallets`.
async function strongholdHolds(password, wallets) {
  return strongholdSession(
    password,
    async (store) => {
      const back = await strongholdWallets(store);
      return back.length === wallets.length && wallets.every((h) => back.some((w) => w.id === h.id && w.mnemonic === h.mnemonic));
    },
    { check: true }
  ).catch(() => false);
}

// The snapshot as saved, loaded again with the password: it holds `wallets`,
// or it throws.
async function strongholdCheck(password, wallets) {
  if (!(await strongholdHolds(password, wallets))) throw new Error(NOT_SAVED);
}

// A change of the snapshot's wallets from `before` to `after`: `change` makes
// it in the store, then it's saved and checked. A change that didn't save as
// it should is undone: `before` put back (its keys and list, without the keys
// in `drop`), saved, and checked; when even that isn't sure, the next unlock
// reads what the snapshot holds.
async function strongholdChange(password, { before, after, drop = [] }, change) {
  const saved = await strongholdSession(
    password,
    async (store, stronghold) => {
      await change(store);
      await stronghold.save();
    },
    { check: true }
  ).then(() => strongholdHolds(password, after), () => false);
  if (saved) return;
  const putBack =
    (await strongholdHolds(password, before)) ||
    (await strongholdSession(
      password,
      async (store, stronghold) => {
        for (const id of drop) await store.remove(strongholdWalletKey(id));
        for (const w of before) await store.insert(strongholdWalletKey(w.id), bytesOf(w.mnemonic));
        await store.insert(STRONGHOLD_STORE_KEY_WALLETS, listBytes(before));
        await stronghold.save();
      },
      { check: true }
    ).then(() => strongholdHolds(password, before), () => false));
  throw new Error(putBack ? NOT_SAVED : NOT_CHECKED);
}

// Every wallet the snapshot holds, with v1's one phrase moved to a key of its
// own: saved, loaded again, and only then v1's key removed. `v1Left` says it
// couldn't be moved this time; it opens as before, and the next unlock moves it.
async function tauriOpen(password) {
  const exists = await tauriVaultExists().catch(() => false);
  if (!exists) throw new Error(NO_VAULT);
  await checkUnlockRateLimit();
  const { held, legacy } = await strongholdSession(password, async (store) => ({
    held: await strongholdWallets(store),
    legacy: textOf(await store.get(STRONGHOLD_STORE_KEY_MNEMONIC)),
  }));
  if (legacy === null) {
    if (!held.length) throw new Error(NO_VAULT);
    return { wallets: held, v1Left: false };
  }
  let holder = held.find((w) => samePhrase(w.mnemonic, legacy));
  // Named for the move, or, when another phrase has that name (downgraded and
  // set up again), another "v1-" one.
  const id = held.some((w) => w.id === STRONGHOLD_V1_WALLET_ID) ? `v1-${newWalletId()}` : STRONGHOLD_V1_WALLET_ID;
  const wallets = holder ? held : [...held, (holder = { id, n: nextNumber(held), mnemonic: legacy })];
  try {
    if (wallets !== held) {
      await strongholdSession(password, async (store, stronghold) => {
        await store.insert(strongholdWalletKey(holder.id), bytesOf(legacy));
        await store.insert(STRONGHOLD_STORE_KEY_WALLETS, listBytes(wallets));
        await stronghold.save();
      });
    }
    await strongholdSession(password, async (store, stronghold) => {
      const back = await strongholdWallets(store);
      if (!back.some((w) => w.id === holder.id && samePhrase(w.mnemonic, legacy))) throw new Error("not moved");
      await store.remove(STRONGHOLD_STORE_KEY_MNEMONIC);
      await stronghold.save();
    });
    return { wallets: wallets.sort(byNumber), v1Left: false };
  } catch {
    return { wallets: wallets.sort(byNumber), v1Left: true };
  }
}

// ---------------------------------------------------------------------------
// The vault's operations
// ---------------------------------------------------------------------------

/**
 * Load vault metadata.
 *
 * - Extension/Web: the v2 vault, or v1's before it moved; null for none
 * - Tauri: returns a small sentinel object `{ kind: "stronghold" }`
 */
export async function loadVault() {
  // In Tauri we store secrets in Stronghold but keep a tiny, non-sensitive
  // sentinel in the key-value store so the UI can detect that a vault exists
  // without needing filesystem access.
  if (isTauriRuntime()) {
    const items = await storage.get(STORAGE_KEYS.VAULT);
    const v = items[STORAGE_KEYS.VAULT] ?? null;
    if (v && typeof v === "object" && v.kind === "stronghold") return v;

    // Fallback for older runs that created the snapshot but did not set the
    // sentinel key yet.
    const exists = await tauriVaultExists().catch(() => false);
    return exists ? { kind: "stronghold" } : null;
  }

  const { v1, v2 } = await readStored();
  return v2 ?? v1;
}

/**
 * How many wallets the vault holds, whichever password opens each: v2's, and
 * v1's phrase while its move is still to come. Null in the desktop app, whose
 * snapshot opens whole with its one password.
 * @returns {Promise<number|null>}
 */
export async function countVaultWallets() {
  if (isTauriRuntime()) return null;
  const { v1, v2 } = await readStored();
  const wallets = isVaultV2(v2) ? v2.wallets.filter(isWallet) : [];
  if (!isSealed(v1)) return wallets.length;
  const moved = await v1WalletId(v1);
  return wallets.length + (wallets.some((w) => w.id === moved) ? 0 : 1);
}

/**
 * A new vault with one wallet, where there is none.
 * @param {string} mnemonic
 * @param {string} password
 * @returns {Promise<{ id: string, n: number }>}
 */
export function createVault(mnemonic, password) {
  return vaultLock(async () => {
    const m = String(mnemonic ?? "").trim();
    const p = String(password ?? "");
    const wallet = { id: newWalletId(), n: 1 };

    if (isTauriRuntime()) {
      // If a snapshot already exists, the password must match, otherwise Stronghold
      // will throw with a BadFileKey error.
      await strongholdSession(p, async (store, stronghold) => {
        if ((await strongholdList(store)).length || (await store.get(STRONGHOLD_STORE_KEY_MNEMONIC))) {
          throw new Error("A wallet vault already exists. Reset it first.");
        }
        await store.insert(strongholdWalletKey(wallet.id), bytesOf(m));
        await store.insert(STRONGHOLD_STORE_KEY_WALLETS, listBytes([wallet]));
        await stronghold.save();
      }, { create: true });
      await strongholdCheck(p, [{ ...wallet, mnemonic: m }]);
      // Persist a non-sensitive sentinel so the UI can detect that a vault exists
      // without needing to touch the filesystem.
      await storage.set({ [STORAGE_KEYS.VAULT]: { kind: "stronghold" } });
      await resetUnlockFailures();
      return wallet;
    }

    const { v1, v2 } = await readStored();
    if (v1 || v2) throw new Error("A wallet vault already exists. Reset it first.");
    const keys = keyring(p);
    await writeV2(
      { version: VAULT_VERSION, wallets: [{ ...wallet, ...(await seal(m, keys, freshSalt())) }] },
      { previous: null, changed: [{ id: wallet.id, mnemonic: m, keys }] }
    );
    await resetUnlockFailures();
    return wallet;
  });
}

/**
 * Every wallet the password opens, moving v1's vault over first.
 * @param {string} password
 * @returns {Promise<{ wallets: Array<{ id: string, n: number, mnemonic: string }> }>}
 */
export function unlockVault(password) {
  return vaultLock(async () => {
    const p = String(password ?? "");
    if (isTauriRuntime()) {
      const { wallets } = await tauriOpen(p);
      await resetUnlockFailures();
      return { wallets };
    }
    const { opened } = await openVault(p);
    if (!opened.length) throw await incorrectPassword();
    await resetUnlockFailures();
    return { wallets: opened };
  });
}

// The vault opened with the password for a change: refused for a wrong one,
// one that doesn't open every wallet in `held` (the IDs of those unlocked
// with one password) included, and while v1 is still to move (a write just
// failed; the next try moves it).
async function openForChange(password, held = []) {
  const ofEvery = (opened) => held.every((id) => opened.some((w) => w.id === id));
  if (isTauriRuntime()) {
    const { wallets, v1Left } = await tauriOpen(password);
    if (!ofEvery(wallets)) throw await incorrectPassword();
    await resetUnlockFailures();
    if (v1Left) throw new Error(NOT_SAVED);
    return { record: null, opened: wallets };
  }
  const { record, opened, v1Left, keys } = await openVault(password);
  if (!opened.length || !ofEvery(opened)) throw await incorrectPassword();
  await resetUnlockFailures();
  if (record !== null && !isVaultV2(record)) throw new Error(UNSUPPORTED);
  if (v1Left || !isVaultV2(record)) throw new Error(NOT_SAVED);
  return { record, opened, keys };
}

/**
 * Another wallet in the vault, sealed under the password that opens it: one
 * whose phrase is here already is refused (DUPLICATE_PHRASE).
 * @param {string} mnemonic
 * @param {string} password
 * @param {{ held?: string[] }} [opts] - the IDs of the wallets unlocked now:
 *   the password must open each of them
 * @returns {Promise<{ id: string, n: number }>}
 */
export function addVaultWallet(mnemonic, password, { held = [] } = {}) {
  return vaultLock(async () => {
    const m = String(mnemonic ?? "").trim();
    const p = String(password ?? "");
    const { record, opened, keys } = await openForChange(p, held);
    if (opened.some((w) => samePhrase(w.mnemonic, m))) throw new Error(DUPLICATE_PHRASE);
    const wallet = { id: newWalletId(), n: nextNumber([...(record?.wallets ?? []), ...opened]) };

    if (isTauriRuntime()) {
      const after = [...opened, { ...wallet, mnemonic: m }];
      await strongholdChange(p, { before: opened, after, drop: [wallet.id] }, async (store) => {
        await store.insert(strongholdWalletKey(wallet.id), bytesOf(m));
        await store.insert(STRONGHOLD_STORE_KEY_WALLETS, listBytes(after));
      });
      return wallet;
    }

    // Sealed with the salt of a wallet here that the password opens: its key,
    // derived as the vault opened, seals it, and opens them all next time.
    const like = record.wallets.find((w) => opened.some((o) => o.id === w.id)) ?? freshSalt();
    await writeV2(
      { version: VAULT_VERSION, wallets: [...record.wallets, { ...wallet, ...(await seal(m, keys, like)) }] },
      { previous: record, changed: [{ id: wallet.id, mnemonic: m, keys }] }
    );
    return wallet;
  });
}

/**
 * Remove one wallet: the password must open it, and the others stay as they
 * are. The only wallet here isn't removed (Reset removes it).
 * @param {string} id
 * @param {string} password
 */
export function removeVaultWallet(id, password) {
  return vaultLock(async () => {
    const key = String(id ?? "");
    const p = String(password ?? "");
    const { record, opened } = await openForChange(p);
    // The password must open the wallet it removes.
    if (!opened.some((w) => w.id === key)) {
      if ((record?.wallets ?? []).some((w) => w.id === key)) throw await incorrectPassword();
      throw new Error("That wallet isn't here.");
    }

    if (isTauriRuntime()) {
      if (opened.length < 2) throw new Error("This is the only wallet here. Reset removes it.");
      const rest = opened.filter((w) => w.id !== key);
      await strongholdChange(p, { before: opened, after: rest }, async (store) => {
        await store.insert(STRONGHOLD_STORE_KEY_WALLETS, listBytes(rest));
        await store.remove(strongholdWalletKey(key));
      });
      return true;
    }

    if (record.wallets.filter(isWallet).length < 2) throw new Error("This is the only wallet here. Reset removes it.");
    await writeV2(
      { version: VAULT_VERSION, wallets: record.wallets.filter((w) => w.id !== key) },
      { previous: record, gone: [key] }
    );
    return true;
  });
}

/**
 * A new password: every phrase the old one opens sealed again under it. A
 * phrase it doesn't open stays as it is.
 * @param {string} password
 * @param {string} newPassword
 * @param {{ held?: string[] }} [opts] - the IDs of the wallets unlocked now:
 *   the password must open each of them
 */
export function changeVaultPassword(password, newPassword, { held = [] } = {}) {
  return vaultLock(async () => {
    const p = String(password ?? "");
    const np = String(newPassword ?? "");
    if (!np) throw new Error("Enter a new password.");
    // Stronghold can't seal its snapshot under another password in place.
    if (isTauriRuntime()) throw new Error("Changing the password isn't available in this app yet.");

    const { record, opened } = await openForChange(p, held);
    const phrases = new Map(opened.map((w) => [w.id, w.mnemonic]));
    // One new salt for all of them: the new password's key, derived once.
    const keys = keyring(np);
    const like = freshSalt();
    const wallets = await Promise.all(
      record.wallets.map(async (w) => (phrases.has(w.id) ? { ...publicOf(w), ...(await seal(phrases.get(w.id), keys, like)) } : w))
    );
    await writeV2(
      { version: VAULT_VERSION, wallets },
      {
        previous: record,
        changed: [...phrases].map(([id, mnemonic]) => ({ id, mnemonic, keys })),
      }
    );
    return true;
  });
}

/** Remove every wallet's phrase: the vault, v1's too, and the unlock guard. */
export function clearVault() {
  return vaultLock(async () => {
    if (isTauriRuntime()) {
      await tauriDeleteVaultSnapshot();
    }
    await storage.remove([STORAGE_KEYS.VAULT, STORAGE_KEYS.VAULT_V2, STORAGE_KEYS.UNLOCK_GUARD]);
  });
}
