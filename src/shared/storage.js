// Storage facade used across all platforms.
//
// In the Chrome extension we use chrome.storage.local.
// In Tauri/web we fall back to localStorage.

import { kv } from "../platform/storage.js";

// Keep the existing name to avoid touching call sites.
export const storage = kv;

export const STORAGE_KEYS = {
  VAULT: "dusk_vault_v1", // encrypted mnemonic
  SETTINGS: "dusk_settings_v1",
  PERMISSIONS: "dusk_permissions_v1", // { [origin]: { accountIndex, connectedAt } }
  TXS: "dusk_txs_v1", // { [hash]: { origin, nodeUrl, kind, submittedAt, status, error? } }
  ACCOUNT_NAMES: "dusk_account_names_v1", // { [walletId]: { [profileIndex]: string } }
  ADDRESS_BOOK: "dusk_addressbook_v1", // { [id]: { id, name, address, type, createdAt, updatedAt } }
  ASSETS: "dusk_assets_v1", // { [walletId]: { [networkKey]: { [profileIndex]: { tokens: [], nfts: [] } } } }
  NETWORK_STATUS: "dusk_network_status_v1", // { nodeStatus, proverStatus, archiverStatus, lastChecked, errors }
};
