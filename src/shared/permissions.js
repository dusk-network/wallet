// dApp connections, per wallet: STORAGE_KEYS.PERMISSIONS_V2 holds
//   { [walletId]: { [origin]: { profileId, accountIndex, grants, connectedAt, updatedAt } } }
// by each wallet's ID (its first public account). A site connected to one
// wallet sees nothing of another unless it's connected there too.
//
// The connections from before (STORAGE_KEYS.PERMISSIONS, by origin) were the
// one wallet's: each moves under the wallet its profile is of once that wallet
// is unlocked (adoptLegacyPermissions). Until then, with no wallet unlocked
// since, they're what's connected.

import { storage, STORAGE_KEYS } from "./storage.js";
import { withStorageLock } from "./storageLock.js";

const V1 = STORAGE_KEYS.PERMISSIONS;
const V2 = STORAGE_KEYS.PERMISSIONS_V2;
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
// One lock for both, so a move from v1 and a change of v2 don't cross.
const mutate = (fn) => withStorageLock(V2, fn);

async function readAll() {
  const [legacy, byWallet] = await Promise.all([V1, V2].map(async (key) => (await storage.get(key))?.[key]));
  return { legacy: isObject(legacy) ? legacy : null, byWallet: isObject(byWallet) ? byWallet : {} };
}

function walletOf(walletId) {
  const id = String(walletId ?? "").trim();
  if (!id) throw new Error("walletId is required");
  return id;
}

/**
 * A wallet's connections, by origin. Without a wallet ID (none unlocked
 * since the update), the connections from before.
 * @param {string} walletId
 * @returns {Promise<Record<string, {profileId:string, accountIndex:number, grants:object, connectedAt:number, updatedAt:number}>>}
 */
export async function getPermissions(walletId) {
  const { legacy, byWallet } = await readAll();
  const id = String(walletId ?? "").trim();
  if (!id) return legacy ?? {};
  return isObject(byWallet[id]) ? byWallet[id] : {};
}

/**
 * @param {string} origin
 * @param {string} walletId
 */
export async function getPermissionForOrigin(origin, walletId) {
  const permissions = await getPermissions(walletId);
  return Object.hasOwn(permissions, origin) ? permissions[origin] : null;
}

/**
 * Whether `perm` is still a valid grant, and the profile its site sees: its
 * public account, its shielded receive address with `includeShielded`, and its
 * verified .dusk name when `names` has one for that account.
 *
 * @param {object} perm
 * @param {object} status - engine status
 * @param {boolean} [includeShielded]
 * @param {Map<string, string>} [names] - verified names by account (verifiedNames.js)
 * @returns {{ isValid: boolean, profile: { profileId: string, account: string, shieldedAddress?: string, name?: string } | null }}
 */
export function permissionProfileState(perm, status, includeShielded = false, names = null) {
  const accountIndex = perm?.accountIndex;
  const profileId = String(perm?.profileId ?? "");
  const prefix = `account:${accountIndex}:`;
  const updatedAt = Number(perm?.updatedAt);
  const validRecord =
    Number.isInteger(accountIndex) &&
    accountIndex >= 0 &&
    Number.isFinite(updatedAt) &&
    updatedAt > 0 &&
    profileId.startsWith(prefix) &&
    profileId.length > prefix.length;
  if (!validRecord) return { isValid: false, profile: null };
  if (!status?.isUnlocked) return { isValid: true, profile: null };

  const accounts = Array.isArray(status.accounts) ? status.accounts : [];
  const addresses = Array.isArray(status.addresses) ? status.addresses : [];
  const account = String(accounts[accountIndex] ?? "");
  if (!account || profileId !== `account:${accountIndex}:${account}`) {
    return { isValid: false, profile: null };
  }

  const name = names?.get(account);
  return {
    isValid: true,
    profile: {
      profileId,
      account,
      ...(includeShielded && addresses[accountIndex]
        ? { shieldedAddress: addresses[accountIndex] }
        : {}),
      ...(name ? { name } : {}),
    },
  };
}

async function writeWallet(byWallet, id, permissions) {
  const next = { ...byWallet };
  if (Object.keys(permissions).length) next[id] = permissions;
  else delete next[id];
  await storage.set({ [V2]: next });
}

/**
 * Connect `origin` to a profile of the wallet `walletId`.
 * @param {string} origin
 * @param {{ profileId?: string, accountIndex?: number, grants?: { publicAccount?: boolean, shieldedReceiveAddress?: boolean } }} grant
 * @param {string} walletId
 */
export function approveOrigin(origin, grant = {}, walletId) {
  const id = walletOf(walletId);
  return mutate(async () => {
    const { byWallet } = await readAll();
    const permissions = isObject(byWallet[id]) ? { ...byWallet[id] } : {};
    const prev = permissions[origin] ?? null;
    const accountIndex = Math.max(0, Math.floor(Number(grant?.accountIndex ?? 0) || 0));
    const profileId = String(grant?.profileId ?? `profile:${accountIndex}`);
    const sameProfile = prev?.profileId === profileId;
    const previousShieldedGrant = Boolean(prev?.grants?.shieldedReceiveAddress);
    const requestedShieldedGrant = Boolean(grant?.grants?.shieldedReceiveAddress);

    permissions[origin] = {
      profileId,
      accountIndex,
      grants: {
        publicAccount: true,
        shieldedReceiveAddress: sameProfile
          ? previousShieldedGrant || requestedShieldedGrant
          : requestedShieldedGrant,
      },
      connectedAt: Number(prev?.connectedAt) || Date.now(),
      updatedAt: Date.now(),
    };
    await writeWallet(byWallet, id, permissions);
    return permissions[origin];
  });
}

/**
 * Disconnect `origin` from the wallet `walletId`; "" (no wallet unlocked since
 * the update) from the connections from before.
 * @param {string} origin
 * @param {string} walletId
 */
export function revokeOrigin(origin, walletId) {
  const id = String(walletId ?? "").trim();
  return mutate(async () => {
    const { legacy, byWallet } = await readAll();
    if (!id) {
      if (!legacy || !Object.hasOwn(legacy, origin)) return;
      const { [origin]: _old, ...left } = legacy;
      if (Object.keys(left).length) await storage.set({ [V1]: left });
      else await storage.remove(V1);
      return;
    }
    const { [origin]: _gone, ...rest } = isObject(byWallet[id]) ? byWallet[id] : {};
    await writeWallet(byWallet, id, rest);
  });
}

/**
 * Disconnect `origin` from every wallet, the connections from before
 * included: a site that disconnects itself is connected to none after.
 * @param {string} origin
 */
export function revokeOriginEverywhere(origin) {
  return mutate(async () => {
    const { legacy, byWallet } = await readAll();
    const next = {};
    for (const [id, permissions] of Object.entries(byWallet)) {
      const { [origin]: _gone, ...rest } = isObject(permissions) ? permissions : {};
      if (Object.keys(rest).length) next[id] = rest;
    }
    await storage.set({ [V2]: next });
    if (legacy && Object.hasOwn(legacy, origin)) {
      const { [origin]: _old, ...left } = legacy;
      if (Object.keys(left).length) await storage.set({ [V1]: left });
      else await storage.remove(V1);
    }
  });
}

/**
 * Disconnect every site from the wallet `walletId`; "" (no wallet unlocked
 * since the update) disconnects the connections from before.
 * @param {string} walletId
 */
export function clearPermissions(walletId) {
  const id = String(walletId ?? "").trim();
  return mutate(async () => {
    if (!id) {
      await storage.remove(V1);
      return;
    }
    const { byWallet } = await readAll();
    await writeWallet(byWallet, id, {});
  });
}

/** Disconnect every site from every wallet, the connections from before included: a reset. */
export function clearAllPermissions() {
  return mutate(() => storage.remove([V1, V2]));
}

/**
 * The connections from before that are of this wallet's profiles (`accounts`,
 * by index), moved under it: none written over, and each gone from before
 * once it's moved. Those of no profile here stay for the wallet they're of.
 * @param {string} walletId
 * @param {string[]} accounts - the wallet's public accounts, by profile index
 * @returns {Promise<number>} how many moved
 */
export function adoptLegacyPermissions(walletId, accounts) {
  const id = String(walletId ?? "").trim();
  if (!id || !Array.isArray(accounts) || !accounts.length) return Promise.resolve(0);
  return mutate(async () => {
    const { legacy, byWallet } = await readAll();
    if (!legacy) return 0;
    const own = Object.entries(legacy).filter(([, perm]) => {
      const index = perm?.accountIndex;
      return Number.isInteger(index) && accounts[index] && perm?.profileId === `account:${index}:${accounts[index]}`;
    });
    if (!own.length) return 0;
    const permissions = { ...(isObject(byWallet[id]) ? byWallet[id] : {}) };
    for (const [origin, perm] of own) if (!Object.hasOwn(permissions, origin)) permissions[origin] = perm;
    await writeWallet(byWallet, id, permissions);
    const left = Object.fromEntries(Object.entries(legacy).filter(([origin]) => !own.some(([o]) => o === origin)));
    if (Object.keys(left).length) await storage.set({ [V1]: left });
    else await storage.remove(V1);
    return own.length;
  });
}
