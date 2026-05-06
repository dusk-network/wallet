// Dapp provider push events (MetaMask/EIP-1193 style).
//
// This module manages long-lived `chrome.runtime.Port` connections from
// content scripts and broadcasts provider events like profilesChanged, chainChanged.

import { getSettings } from "../shared/settings.js";
import { getPermissions } from "../shared/permissions.js";
import { STORAGE_KEYS } from "../shared/storage.js";
import { chainIdFromNodeUrl } from "../shared/chain.js";
import { networkNameFromNodeUrl } from "../shared/network.js";
import { getEngineStatus } from "./engineHost.js";
import { getExtensionApi } from "../platform/extensionApi.js";

/**
 * @typedef {{ origin: string }} PortMeta
 */

/** @type {Map<chrome.runtime.Port, PortMeta>} */
const portMeta = new Map();

/** @type {Map<string, Set<chrome.runtime.Port>>} */
const portsByOrigin = new Map();

/**
 * Ports indexed by tab id.
 *
 * We use this to robustly associate a port with an origin even when
 * `port.sender.url` is missing. When the dApp makes an RPC request we
 * always know the origin (it is carried in the message), and we can bind
 * the port(s) for that tab to the same origin.
 *
 * @type {Map<number, Set<chrome.runtime.Port>>}
 */
const portsByTabId = new Map();
const ext = getExtensionApi();

// ---------------------------------------------------------------------------
// Chain / node change event de-duplication
// ---------------------------------------------------------------------------
//
// The wallet can update the selected nodeUrl from multiple extension contexts.
// For example, dusk_switchNetwork updates settings from the background, and
// that same storage write also triggers chrome.storage.onChanged.
//
// Without de-duplication, dApps may receive duplicate events (especially the
// Dusk-specific `duskNodeChanged`) for what is conceptually a single atomic
// network switch or account switch.
//
// To keep event semantics tight:
// - `chainChanged` is only emitted when chainId actually changes
// - `duskNodeChanged` is only emitted when nodeUrl actually changes
// - broadcasts are serialized to avoid races between rapid consecutive calls

let _lastBroadcastChainId = null;
let _lastBroadcastNodeUrl = null;
let _lastBroadcastNetworkName = null;

/** @type {Promise<void>} */
let _chainBroadcastQueue = Promise.resolve();

function getOriginFromSender(sender) {
  // In some Chrome versions/contexts, `port.sender.url` may be undefined even for
  // content-script ports. Prefer sender.url, then sender.tab.url.
  const candidates = [];
  if (sender?.url) candidates.push(sender.url);
  if (sender?.tab?.url) candidates.push(sender.tab.url);
  if (sender?.tab?.pendingUrl) candidates.push(sender.tab.pendingUrl);

  for (const u of candidates) {
    try {
      return new URL(u).origin;
    } catch {
      // ignore
    }
  }

  return "";
}

function isWebOrigin(origin) {
  return (
    typeof origin === "string" &&
    origin.length > 0 &&
    !origin.startsWith("chrome-extension://") &&
    !origin.startsWith("moz-extension://") &&
    !origin.startsWith("edge-extension://")
  );
}

/**
 * Initialize a port once we know its web origin.
 *
 * @param {chrome.runtime.Port} port
 * @param {string} origin
 */
async function initPortForOrigin(port, origin) {
  const state = await buildProviderState(origin);
  safePost(port, { type: "DUSK_PROVIDER_STATE", state });

  // If the site is already connected, emit connect.
  if (state.isConnected) {
    safePost(port, {
      type: "DUSK_PROVIDER_EVENT",
      name: "connect",
      data: { chainId: state.chainId },
    });
  }
}

function addPort(origin, port) {
  const set = portsByOrigin.get(origin) ?? new Set();
  set.add(port);
  portsByOrigin.set(origin, set);
}

function addPortToTab(tabId, port) {
  const set = portsByTabId.get(tabId) ?? new Set();
  set.add(port);
  portsByTabId.set(tabId, set);
}

function removePort(origin, port) {
  const set = portsByOrigin.get(origin);
  if (!set) return;
  set.delete(port);
  if (set.size === 0) portsByOrigin.delete(origin);
}

function removePortFromTab(tabId, port) {
  const set = portsByTabId.get(tabId);
  if (!set) return;
  set.delete(port);
  if (set.size === 0) portsByTabId.delete(tabId);
}

function safePost(port, msg) {
  try {
    port.postMessage(msg);
  } catch {
    // ignore
  }
}

/**
 * Build the state snapshot for a given origin.
 *
 * @param {string} origin
 */
async function buildProviderState(origin) {
  const settings = await getSettings();
  const nodeUrl = settings?.nodeUrl ?? "";

  const chainId = chainIdFromNodeUrl(nodeUrl);
  const networkName = networkNameFromNodeUrl(nodeUrl);

  const perms = await getPermissions();
  const perm = perms?.[origin];
  const hasPermission = Boolean(perm);

  const status = await getEngineStatus();
  const profiles = hasPermission && status.isUnlocked ? profileSnapshotForPermission(perm, status) : [];

  return {
    chainId,
    networkName,
    nodeUrl,
    // "Connected" in the sense of site permission (not chain transport!).
    isConnected: hasPermission,
    profiles,
  };
}

function normalizeAccountIndex(value) {
  const idxRaw = Number(value ?? 0);
  return Number.isFinite(idxRaw) && idxRaw >= 0 ? Math.floor(idxRaw) : 0;
}

function hasShieldedGrant(perm) {
  return Boolean(perm?.grants?.shieldedReceiveAddress);
}

function profileSnapshotForPermission(perm, status) {
  if (!perm || !status?.isUnlocked) return [];
  const accounts = Array.isArray(status.accounts) ? status.accounts : [];
  const addresses = Array.isArray(status.addresses) ? status.addresses : [];
  const idx = normalizeAccountIndex(perm.accountIndex);
  const account = accounts[idx];
  if (!account) return [];

  const profile = {
    profileId: String(perm.profileId || `account:${idx}:${account}`),
    account,
  };
  if (hasShieldedGrant(perm) && addresses[idx]) {
    profile.shieldedAddress = addresses[idx];
  }
  return [profile];
}

/**
 * Register a content-script Port.
 *
 * @param {chrome.runtime.Port} port
 */
export function registerDappPort(port) {
  // NOTE: On some Chrome versions/contexts, `port.sender.url` can be missing
  // even for content-script ports. Fall back to a best-effort
  // HELLO message from the content script.
  const initial = getOriginFromSender(port.sender);
  const origin = isWebOrigin(initial) ? initial : "";

  const meta = { origin };
  portMeta.set(port, meta);

  // Index by tab id for robust binding.
  const tabId = port?.sender?.tab?.id;
  if (typeof tabId === "number") {
    addPortToTab(tabId, port);
  }

  if (meta.origin) {
    addPort(meta.origin, port);
    initPortForOrigin(port, meta.origin).catch(() => {});
  }

  port.onDisconnect.addListener(() => {
    portMeta.delete(port);
    if (meta.origin) removePort(meta.origin, port);
    if (typeof tabId === "number") removePortFromTab(tabId, port);
  });

  // Content scripts can optionally send a HELLO with an origin.
  port.onMessage.addListener((msg) => {
    if (msg?.type === "DUSK_DAPP_HELLO" && typeof msg.origin === "string") {
      // If sender.url couldn't be parsed, allow the explicit origin.
      const o = msg.origin;
      if (!isWebOrigin(o)) return;

      // Re-key.
      if (meta.origin && meta.origin !== o) {
        removePort(meta.origin, port);
      }
      if (meta.origin !== o) {
        meta.origin = o;
        addPort(o, port);
        initPortForOrigin(port, o).catch(() => {});
      }
    }
  });
}

/**
 * Ensure that any dApp port(s) opened from the same tab as an RPC request are
 * bound to the request origin.
 *
 * This makes provider push events reliable even when `port.sender.url` is
 * missing and the initial HELLO message is dropped or delayed for some reason.
 *
 * @param {chrome.runtime.MessageSender} sender
 * @param {string} origin
 */
export function bindPortsForSenderOrigin(sender, origin) {
  if (!isWebOrigin(origin)) return;
  const tabId = sender?.tab?.id;
  if (typeof tabId !== "number") return;

  const set = portsByTabId.get(tabId);
  if (!set || set.size === 0) return;

  for (const port of set) {
    const meta = portMeta.get(port);
    if (!meta) continue;

    if (meta.origin === origin) {
      continue;
    }

    // Re-key from a previous origin.
    if (meta.origin) {
      removePort(meta.origin, port);
    }

    meta.origin = origin;
    addPort(origin, port);
    initPortForOrigin(port, origin).catch(() => {});
  }
}

/**
 * Broadcast a provider event to all ports for a given origin.
 *
 * @param {string} origin
 * @param {string} name
 * @param {any} data
 */
export function broadcastToOrigin(origin, name, data) {
  const set = portsByOrigin.get(origin);
  if (!set) return;
  for (const port of set) {
    safePost(port, { type: "DUSK_PROVIDER_EVENT", name, data });
  }
}

/**
 * Broadcast a provider event to all connected ports.
 *
 * @param {string} name
 * @param {any} data
 */
export function broadcastToAll(name, data) {
  for (const set of portsByOrigin.values()) {
    for (const port of set) {
      safePost(port, { type: "DUSK_PROVIDER_EVENT", name, data });
    }
  }
}

/**
 * Recompute and broadcast profile visibility for all open dapp ports.
 * This should be called when wallet locks/unlocks or permissions change.
 */
export async function broadcastProfilesChangedAll() {
  const perms = await getPermissions();
  const status = await getEngineStatus();

  for (const [origin, set] of portsByOrigin.entries()) {
    const perm = perms?.[origin];
    const visible = profileSnapshotForPermission(perm, status);
    for (const port of set) {
      safePost(port, { type: "DUSK_PROVIDER_EVENT", name: "profilesChanged", data: visible });
    }
  }
}

/**
 * Broadcast profilesChanged for a single origin.
 *
 * @param {string} origin
 */
export async function broadcastProfilesChangedForOrigin(origin) {
  const perms = await getPermissions();
  const status = await getEngineStatus();
  const perm = perms?.[origin];
  broadcastToOrigin(origin, "profilesChanged", profileSnapshotForPermission(perm, status));
}

/**
 * Broadcast chainChanged (and a Dusk-specific nodeChanged) to all ports.
 */
export async function broadcastChainChangedAll() {
  // Serialize broadcasts so rapid consecutive calls don't race and double-emit.
  _chainBroadcastQueue = _chainBroadcastQueue
    .then(async () => {
      const settings = await getSettings();
      const nodeUrl = String(settings?.nodeUrl ?? "");
      const chainId = chainIdFromNodeUrl(nodeUrl);
      const networkName = networkNameFromNodeUrl(nodeUrl);

      const chainChanged = chainId !== _lastBroadcastChainId;
      const nodeChanged = nodeUrl !== _lastBroadcastNodeUrl;

      // Nothing to do.
      if (!chainChanged && !nodeChanged) return;

      // Update last-known snapshot up front. If another call queues behind this
      // one, it will compare against the new values and avoid duplicates.
      _lastBroadcastChainId = chainId;
      _lastBroadcastNodeUrl = nodeUrl;
      _lastBroadcastNetworkName = networkName;

      // Emit MetaMask-style chainChanged only when the chainId actually changes.
      if (chainChanged) {
        broadcastToAll("chainChanged", chainId);
      }

      // Emit Dusk-specific node change only when the nodeUrl changes.
      if (nodeChanged) {
        broadcastToAll("duskNodeChanged", { chainId, nodeUrl, networkName });
      }
    })
    .catch(() => {});

  await _chainBroadcastQueue;
}

/**
 * Handle a permissions object update by emitting connect/disconnect for diffs.
 *
 * @param {Record<string, any>} oldPerms
 * @param {Record<string, any>} newPerms
 */
export async function handlePermissionsDiff(oldPerms, newPerms) {
  const oldP = oldPerms ?? {};
  const newP = newPerms ?? {};

  const removed = [];
  const added = [];
  const changed = [];

  for (const origin of Object.keys(oldP)) {
    if (!newP[origin]) removed.push(origin);
  }
  for (const origin of Object.keys(newP)) {
    if (!oldP[origin]) added.push(origin);
  }
  for (const origin of Object.keys(newP)) {
    if (!oldP[origin]) continue;
    if (permissionProfileKey(oldP[origin]) !== permissionProfileKey(newP[origin])) {
      changed.push(origin);
    }
  }

  // First emit connect/disconnect, then refresh profiles.
  if (added.length || removed.length) {
    const settings = await getSettings();
    const chainId = chainIdFromNodeUrl(settings?.nodeUrl ?? "");

    for (const origin of added) {
      broadcastToOrigin(origin, "connect", { chainId });
    }

    for (const origin of removed) {
      // EIP-1193 disconnect payload is usually an error-ish object.
      broadcastToOrigin(origin, "disconnect", { code: 4900, message: "Disconnected" });
    }
  }

  // Always refresh profiles for any origin diff, so sites see [] when revoked
  // and profile fields when granted.
  if (added.length || removed.length) {
    await broadcastProfilesChangedAll();
  }

  // Profile selection or grant changes should emit profilesChanged.
  for (const origin of changed) {
    await broadcastProfilesChangedForOrigin(origin);
  }
}

function permissionProfileKey(perm) {
  if (!perm) return "";
  return JSON.stringify({
    profileId: perm.profileId ?? "",
    accountIndex: normalizeAccountIndex(perm.accountIndex),
    publicAccount: Boolean(perm.grants?.publicAccount),
    shieldedReceiveAddress: Boolean(perm.grants?.shieldedReceiveAddress),
  });
}

/**
 * Optional: handle SETTINGS changes to broadcast chainChanged.
 *
 * @param {any} oldSettings
 * @param {any} newSettings
 */
export async function handleSettingsDiff(oldSettings, newSettings) {
  const oldUrl = String(oldSettings?.nodeUrl ?? "");
  const newUrl = String(newSettings?.nodeUrl ?? "");
  if (oldUrl !== newUrl) {
    await broadcastChainChangedAll();
  }
}

/**
 * Wire a storage.onChanged listener to keep provider state in sync even when
 * other extension contexts mutate storage directly.
 */
export function registerStorageChangeForwarder() {
  if (!ext?.storage?.onChanged) return;

  ext?.storage?.onChanged?.addListener((changes, areaName) => {
    if (areaName !== "local") return;

    // Permissions updates
    if (changes[STORAGE_KEYS.PERMISSIONS]) {
      const oldPerms = changes[STORAGE_KEYS.PERMISSIONS].oldValue ?? {};
      const newPerms = changes[STORAGE_KEYS.PERMISSIONS].newValue ?? {};
      handlePermissionsDiff(oldPerms, newPerms).catch(() => {});
    }

    // Settings updates (nodeUrl)
    if (changes[STORAGE_KEYS.SETTINGS]) {
      const oldS = changes[STORAGE_KEYS.SETTINGS].oldValue ?? {};
      const newS = changes[STORAGE_KEYS.SETTINGS].newValue ?? {};
      handleSettingsDiff(oldS, newS).catch(() => {});
    }

    // Vault removed => profiles become unavailable everywhere
    if (changes[STORAGE_KEYS.VAULT]) {
      const oldV = changes[STORAGE_KEYS.VAULT].oldValue;
      const newV = changes[STORAGE_KEYS.VAULT].newValue;
      if (oldV && !newV) {
        // Vault deleted: effectively locked for dApps.
        broadcastProfilesChangedAll().catch(() => {});
      }
    }
  });
}
