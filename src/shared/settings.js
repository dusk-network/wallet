import { storage, STORAGE_KEYS } from "./storage.js";

export const DEFAULT_SETTINGS = {
  // Must be http(s) base URL understood by w3sper's Rues.
  nodeUrl: "https://testnet.nodes.dusk.network",
};

export async function getSettings() {
  const items = await storage.get(STORAGE_KEYS.SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(items[STORAGE_KEYS.SETTINGS] ?? {}) };
}

/**
 * @param {Partial<typeof DEFAULT_SETTINGS>} patch
 */
export async function setSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await storage.set({ [STORAGE_KEYS.SETTINGS]: next });
  return next;
}
