import { storage, STORAGE_KEYS } from "./storage.js";

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
 * @param {number} accountIndex
 */
export async function approveOrigin(origin, accountIndex = 0) {
  const permissions = await getPermissions();
  permissions[origin] = { accountIndex, connectedAt: Date.now() };
  await storage.set({ [STORAGE_KEYS.PERMISSIONS]: permissions });
  return permissions[origin];
}

/**
 * @param {string} origin
 */
export async function revokeOrigin(origin) {
  const permissions = await getPermissions();
  delete permissions[origin];
  await storage.set({ [STORAGE_KEYS.PERMISSIONS]: permissions });
}

export async function clearPermissions() {
  await storage.set({ [STORAGE_KEYS.PERMISSIONS]: {} });
}
