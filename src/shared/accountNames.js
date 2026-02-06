import { MAX_ACCOUNT_COUNT } from "./constants.js";
import { storage, STORAGE_KEYS } from "./storage.js";

function normalizeWalletId(walletId) {
  const id = String(walletId ?? "").trim();
  if (!id) throw new Error("walletId is required");
  return id;
}

function normalizeProfileIndex(profileIndex) {
  const n = Number(profileIndex);
  if (!Number.isFinite(n) || n < 0) throw new Error("profileIndex must be a non-negative number");
  return Math.floor(n);
}

function normalizeName(name) {
  const s = String(name ?? "").trim().replace(/\s+/g, " ");
  if (!s) return "";
  // Keep names compact and predictable for UI layouts.
  return s.length > 32 ? s.slice(0, 32) : s;
}

async function getAll() {
  const res = await storage.get({ [STORAGE_KEYS.ACCOUNT_NAMES]: {} });
  const all = res?.[STORAGE_KEYS.ACCOUNT_NAMES];
  return all && typeof all === "object" ? all : {};
}

async function setAll(next) {
  await storage.set({ [STORAGE_KEYS.ACCOUNT_NAMES]: next });
}

/**
 * Get the stored name mapping for a wallet.
 *
 * @param {string} walletId Typically the first public account (profile 0).
 * @returns {Promise<Record<string, string>>} Map of profileIndex -> name
 */
export async function getAccountNames(walletId) {
  const id = normalizeWalletId(walletId);
  const all = await getAll();
  const m = all?.[id];
  return m && typeof m === "object" ? m : {};
}

/**
 * @param {string} walletId
 * @param {number} profileIndex
 * @returns {Promise<string>}
 */
export async function getAccountName(walletId, profileIndex) {
  const id = normalizeWalletId(walletId);
  const idx = normalizeProfileIndex(profileIndex);
  const names = await getAccountNames(id);
  return String(names?.[String(idx)] ?? "").trim();
}

/**
 * Set or clear a profile name.
 *
 * - Empty/whitespace name => clears the name for that profile.
 * - Names are truncated to 32 chars.
 *
 * @param {string} walletId
 * @param {number} profileIndex
 * @param {string} name
 * @returns {Promise<Record<string, string>>} Updated map for this walletId.
 */
export async function setAccountName(walletId, profileIndex, name) {
  const id = normalizeWalletId(walletId);
  const idx = normalizeProfileIndex(profileIndex);

  if (idx >= MAX_ACCOUNT_COUNT) {
    throw new Error(`Only ${MAX_ACCOUNT_COUNT} accounts are supported right now`);
  }

  const nextName = normalizeName(name);

  const all = await getAll();
  const prevMap = all?.[id];
  const map = prevMap && typeof prevMap === "object" ? { ...prevMap } : {};

  if (!nextName) {
    delete map[String(idx)];
  } else {
    map[String(idx)] = nextName;
  }

  const nextAll = { ...all };
  if (Object.keys(map).length) nextAll[id] = map;
  else delete nextAll[id];

  await setAll(nextAll);
  return map;
}

