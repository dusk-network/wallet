// Storage facade used across all platforms.
//
// In the Chrome extension we use chrome.storage.local.
// In Tauri/web we fall back to localStorage.

import { kv } from "../platform/storage.js";

// Keep the existing name to avoid touching call sites.
export const storage = kv;

export const STORAGE_KEYS = {
  VAULT: "dusk_vault_v1", // encrypted mnemonic
  UNLOCK_GUARD: "dusk_unlock_guard_v1", // { failures, nextAllowedAt }
  SETTINGS: "dusk_settings_v1",
  PERMISSIONS: "dusk_permissions_v1", // { [origin]: { accountIndex, connectedAt } }
  TXS: "dusk_txs_v1", // { [hash]: { origin, nodeUrl, kind, submittedAt, status, error? } }
  TXS_EPOCH: "dusk_txs_epoch_v1", // number: how many times TXS was cleared for a wallet reset
  ACCOUNT_NAMES: "dusk_account_names_v1", // { [walletId]: { [profileIndex]: string } }
  ADDRESS_BOOK: "dusk_addressbook_v1", // contacts in plain text, from before CONTACTS; moved there on unlock
  CONTACTS: "dusk_contacts_v2", // { [walletPlace]: { v, iv, data } }: each wallet's contacts, encrypted (contactsCrypto.js)
  ASSETS: "dusk_assets_v1", // { [walletId]: { [networkKey]: { [profileIndex]: { tokens: [], nfts: [] } } } }
  NETWORK_STATUS: "dusk_network_status_v1", // { nodeStatus, proverStatus, archiverStatus, lastChecked, errors }
  REWARD_RATES: "dusk_reward_rates_v1", // { [network]: { at, rate } }: native staking's estimate, read once a day (rewardRate.js)
  AUTO_LOCK_ACTIVITY: "dusk_auto_lock_activity_v1", // { lastActivityAt }
  VERIFIED_NAMES: "dusk_verified_names_v1", // { [network]: { [account]: { name: string|null, at } } }
  BRIDGE_ARRIVALS: "dusk_bridge_arrivals_v1", // { epoch, items: { [depositHash]: { hash, at } } }: deposits to DuskEVM seen there, under TXS_EPOCH (bridgeArrival.js)
  RESET_PENDING: "dusk_reset_pending_v1", // { at }: a wallet reset that hasn't cleared all the old wallet's data
};
