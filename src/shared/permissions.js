import { storage, STORAGE_KEYS } from "./storage.js";
import { withStorageLock } from "./storageLock.js";

/**
 * @returns {Promise<Record<string, {accountIndex:number, connectedAt:number}>>}
 */
export async function getPermissions() {
  const items = await storage.get(STORAGE_KEYS.PERMISSIONS);
  return items[STORAGE_KEYS.PERMISSIONS] ?? {};
}

/**
 * @param {string} origin
 */
export async function getPermissionForOrigin(origin) {
  const permissions = await getPermissions();
  return permissions[origin] ?? null;
}

/**
 * @param {string} origin
 * @param {{ profileId?: string, accountIndex?: number, grants?: { publicAccount?: boolean, shieldedReceiveAddress?: boolean } }} grant
 */
export function approveOrigin(origin, grant = {}) {
  return withStorageLock(STORAGE_KEYS.PERMISSIONS, async () => {
    const permissions = await getPermissions();
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
    await storage.set({ [STORAGE_KEYS.PERMISSIONS]: permissions });
    return permissions[origin];
  });
}

/**
 * @param {string} origin
 */
export function revokeOrigin(origin) {
  return withStorageLock(STORAGE_KEYS.PERMISSIONS, async () => {
    const permissions = await getPermissions();
    delete permissions[origin];
    await storage.set({ [STORAGE_KEYS.PERMISSIONS]: permissions });
  });
}

export function clearPermissions() {
  return withStorageLock(
    STORAGE_KEYS.PERMISSIONS,
    () => storage.set({ [STORAGE_KEYS.PERMISSIONS]: {} })
  );
}
