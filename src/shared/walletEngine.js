import { mnemonicToSeedSync } from "bip39";
import {
  Bookkeeper,
  Bookmark,
  Contract,
  Network,
  ProfileGenerator,
  AddressSyncer,
  dataDrivers,
  useAsProtocolDriver,
} from "@dusk/w3sper";
import { bytesToHex, hexToBytes, sha256Hex, toBytes } from "./bytes.js";
import { MAX_ACCOUNT_COUNT, TX_KIND } from "./constants.js";
import { assetUrl } from "../platform/assets.js";
import { runtimeSendMessage } from "../platform/extensionApi.js";

import {
  clearNotes,
  countNotes,
  ensureShieldedMeta,
  getNotesMap,
  getSpendableNotesMap,
  getUnspentNullifiers,
  getSpentNullifiers,
  putPendingNullifiers,
  markNullifiersSpent,
  unspendNullifiers,
  metaCursor,
  putNotesMap,
  putShieldedMeta,
} from "./shieldedStore.js";

// Read the current Transfer Contract note-tree size (bookmark) from the node.
//
// IMPORTANT:
// The return type of `contract.call.*()` in w3sper is *not* consistent across
// methods/targets (some return numbers/bigints directly, others return byte
// buffers). The web wallet uses direct numeric returns for calls like
// `finalization_period()`, so `num_notes()` may return a `bigint` or `number`
// rather than an object with `arrayBuffer()`.
//
// This helper accepts several shapes to be robust across versions:
// - bigint / number
// - Bookmark-like objects with `asUint()`
// - Uint8Array / ArrayBuffer
// - Response-like objects with `arrayBuffer()`
async function readTransferContractBookmark(network) {
  try {
    const res = await network.contracts.transferContract.call.num_notes();

    if (typeof res === "bigint") return res;

    if (typeof res === "number" && Number.isFinite(res)) {
      // NOTE: If w3sper ever returns very large u64 values as `number`, this
      // would lose precision. In practice `num_notes()` should be a `bigint`.
      return BigInt(res);
    }

    // Some versions may return a Bookmark instance.
    if (res && typeof res.asUint === "function") {
      const v = res.asUint();
      if (typeof v === "bigint") return v;
      if (typeof v === "number" && Number.isFinite(v)) return BigInt(v);
    }

    // Raw bytes.
    if (res instanceof Uint8Array) {
      if (res.byteLength < 8) return null;
      return new DataView(res.buffer, res.byteOffset, res.byteLength).getBigUint64(0, true);
    }
    if (res instanceof ArrayBuffer) {
      const u8 = new Uint8Array(res);
      if (u8.byteLength < 8) return null;
      return new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getBigUint64(0, true);
    }

    // Response-like.
    if (res && typeof res.arrayBuffer === "function") {
      const buf = await res.arrayBuffer();
      const u8 = new Uint8Array(buf);
      if (u8.byteLength < 8) return null;
      return new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getBigUint64(0, true);
    }

    return null;
  } catch {
    return null;
  }
}

function toBigIntLike(v) {
  try {
    if (typeof v === "bigint") return v;
    if (typeof v === "number" && Number.isFinite(v)) return BigInt(v);
    if (typeof v === "string" && v.length) return BigInt(v);

    // Bookmark-like (and some other u64 wrappers in w3sper)
    if (v && typeof v.asUint === "function") {
      const u = v.asUint();
      if (typeof u === "bigint") return u;
      if (typeof u === "number" && Number.isFinite(u)) return BigInt(u);
      if (typeof u === "string" && u.length) return BigInt(u);
    }

    if (v instanceof Uint8Array) {
      if (v.byteLength < 8) return null;
      return new DataView(v.buffer, v.byteOffset, v.byteLength).getBigUint64(0, true);
    }
    if (v instanceof ArrayBuffer) {
      const u8 = new Uint8Array(v);
      if (u8.byteLength < 8) return null;
      return new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getBigUint64(0, true);
    }
  } catch {
    // ignore
  }
  return null;
}

function toProgress01(v) {
  // Convert common shapes (number/string/bigint) into a 0..1 float.
  // Returns null when unknown.
  try {
    if (typeof v === "number" && Number.isFinite(v)) {
      if (v > 1 && v <= 100) return v / 100;
      if (v > 100 && v <= 10000) return v / 10000;
      return v;
    }
    if (typeof v === "bigint") {
      const n = Number(v);
      if (!Number.isFinite(n)) return null;
      if (n > 1 && n <= 100) return n / 100;
      if (n > 100 && n <= 10000) return n / 10000;
      return n;
    }
    if (typeof v === "string") {
      const n = Number(v);
      if (!Number.isFinite(n)) return null;
      if (n > 1 && n <= 100) return n / 100;
      if (n > 100 && n <= 10000) return n / 10000;
      return n;
    }
  } catch {
    return null;
  }
  return null;
}


function ratioBigInt(num, den) {
  try {
    if (den <= 0n) return 1;
    if (num <= 0n) return 0;
    if (num >= den) return 1;
    const scaled = (num * 10_000n) / den; // 0..10000
    return Number(scaled) / 10_000;
  } catch {
    return 0;
  }
}

// ----------------------------------------------------------------------------
// Utilities
// ----------------------------------------------------------------------------

/**
 * Race a promise against a timeout.
 *
 * IMPORTANT: We intentionally do this even when the underlying implementation
 * accepts AbortSignals. Some environments (notably WebViews) may not reliably
 * error/abort a hanging WebSocket connect, which can block the whole UI.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} message
 * @param {() => void} [onTimeout]
 * @returns {Promise<T>}
 */
async function withTimeout(promise, ms, message, onTimeout) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        // ignore
      }
      reject(new Error(message || "Operation timed out"));
    }, ms);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Engine configuration is pushed in from background/offscreen via engine_config.
// We keep it in a small mutable object so we can reconfigure network routing
// without restarting the whole engine.
let engineConfig = {
  nodeUrl: "https://testnet.nodes.dusk.network",
  proverUrl: "https://testnet.provers.dusk.network",
  archiverUrl: "https://testnet.nodes.dusk.network",
  accountCount: 1,
  selectedAccountIndex: 0,
};

let engineDebugHook = null;

function engineNow() {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function engineSince(start) {
  const now = engineNow();
  return Math.max(0, now - start);
}

export function setEngineDebugHook(fn) {
  engineDebugHook = typeof fn === "function" ? fn : null;
}

function debugEngine(event, payload = {}) {
  if (!engineDebugHook) return;
  try {
    engineDebugHook({
      event: String(event || ""),
      ts: Date.now(),
      ...payload,
    });
  } catch {
    // ignore
  }
}

export function configure(patch = {}) {
  let changedNode = false;
  let changedProver = false;
  let changedArchiver = false;

  if (patch.nodeUrl && typeof patch.nodeUrl === "string") {
    const next = patch.nodeUrl;
    changedNode = next !== engineConfig.nodeUrl;
    engineConfig.nodeUrl = next;

    // IMPORTANT: allow switching networks/nodes at runtime.
    // If we already have a connected Network instance, we must drop it so the next
    // call reconnects to the new node URL.
    if (changedNode) {
      try {
        // w3sper's Network exposes connect(); disconnect() exists in newer versions.
        state.network?.disconnect?.();
      } catch {}
      try {
        // Some implementations may use close().
        state.network?.close?.();
      } catch {}

      state.networkConnectPromise = null;
      state.network = null;
      state.treasury = null;
      state.bookkeeper = null;
      state.treasuryAll = null;
      state.bookkeeperAll = null;
      state.treasuryAll = null;
      state.bookkeeperAll = null;

      // Network changed -> shielded state must be reloaded for the new network.
      try {
        state.shielded.epoch++;
      } catch {}
      state.shielded.syncPromise = null;
      state.shielded.status = {
        state: "idle",
        progress: 0,
        notes: 0,
        cursorBookmark: "0",
        cursorBlock: "0",
        lastError: "",
        updatedAt: Date.now(),
      };
    }
  }

  if (patch.proverUrl && typeof patch.proverUrl === "string") {
    const next = patch.proverUrl;
    changedProver = next !== engineConfig.proverUrl;
    engineConfig.proverUrl = next;
  }

  if (patch.archiverUrl && typeof patch.archiverUrl === "string") {
    const next = patch.archiverUrl;
    changedArchiver = next !== engineConfig.archiverUrl;
    engineConfig.archiverUrl = next;
  }

  // Account derivation config (persisted in settings). This is used on unlock
  // to restore the same derived accounts.
  if (patch.accountCount !== undefined) {
    const n = Number(patch.accountCount);
    if (Number.isFinite(n) && n >= 1) {
      engineConfig.accountCount = Math.min(Math.floor(n), MAX_ACCOUNT_COUNT);
    }
  }

  if (patch.selectedAccountIndex !== undefined) {
    const n = Number(patch.selectedAccountIndex);
    if (Number.isFinite(n) && n >= 0) {
      engineConfig.selectedAccountIndex = Math.floor(n);
    }
  }

  // Clamp selected index to the (possibly updated) accountCount.
  try {
    const maxIdx = Math.max(0, Number(engineConfig.accountCount ?? 1) - 1);
    engineConfig.selectedAccountIndex = Math.min(
      Math.max(0, Number(engineConfig.selectedAccountIndex ?? 0) || 0),
      maxIdx
    );
  } catch {
    // ignore
  }

  // Prover/archiver can change without switching the node URL (custom setups).
  // Ensure the current Network instance picks up the new routing.
  if (!changedNode && (changedProver || changedArchiver)) {
    try {
      // Force re-patching of endpoints on next ensureNetwork().
      if (state.network) state.network.__duskPatchedEndpoints = false;
    } catch {
      // ignore
    }
  }
}

function getNetworkKey() {
  // Use a stable string for per-network persistence keys.
  return String(engineConfig.nodeUrl || "").trim().replace(/\/+$/, "");
}

// --- Treasury (MVP) ---------------------------------------------------------
// This treasury implementation is intentionally minimal:
// - It supports public account-based operations: nonce/value + stake info.
// - It DOES NOT manage shielded notes yet. Those require a note cache/sync.
import { AccountSyncer } from "@dusk/w3sper";


class RemoteTreasury {
  #network;
  #profiles = [];
  #includePending = false;

  constructor(network, profiles = [], opts = {}) {
    this.#network = network;
    this.#profiles = profiles;
    this.#includePending = Boolean(opts?.includePending);
  }

  setProfiles(profiles) {
    this.#profiles = profiles;
  }

  /**
   * @param {any} identifier profile.account Key
   * @returns {Promise<{nonce:bigint,value:bigint}>}
   */
  async account(identifier) {
    const idx = +identifier;
    const profile = this.#profiles.at(idx);
    if (!profile) {
      throw new Error(`Unknown account index ${idx}`);
    }
    const syncer = new AccountSyncer(this.#network);
    const [balance] = await withTimeout(
      syncer.balances([profile]),
      10_000,
      "Balance request timed out"
    );
    return balance;
  }

  /**
   * Shielded note set for the given profile.
   *
   * We persist notes in IndexedDB (per network) and expose them
   * via the Treasury interface so Bookkeeper.balance(profile.address) can
   * compute shielded balances.
   */
  async address(_identifier) {
    // Shielded notes are stored per-network + per-profile in IndexedDB.
    // The identifier carries the profile index (ProfileGenerator encodes it),
    // so `+identifier` gives us the same index we use for account().
    try {
      const rawIdx = +_identifier;
      const idx = Number.isFinite(rawIdx) ? rawIdx : 0;
      const profile = this.#profiles.at(idx) || this.#profiles.at(0);
      if (!profile) return new Map();

      const netKey = getNetworkKey();
      const walletId = getWalletId();
      if (!walletId) return new Map();
      // For transaction building we must exclude locally pending nullifiers
      // to prevent double-spend. For balance display we include them so the
      // wallet doesn't show a misleading drop to zero while a tx is pending.
      return this.#includePending
        ? await getNotesMap(netKey, walletId, idx)
        : await getSpendableNotesMap(netKey, walletId, idx);
    } catch {
      return new Map();
    }
  }

  /**
   * @param {any} identifier
   */
  async stakeInfo(identifier) {
    const idx = +identifier;
    const profile = this.#profiles.at(idx);
    if (!profile) {
      throw new Error(`Unknown account index ${idx}`);
    }
    const syncer = new AccountSyncer(this.#network);
    const [stakeInfo] = await withTimeout(
      syncer.stakes([profile]),
      10_000,
      "Stake request timed out"
    );
    return stakeInfo;
  }
}

// --- Engine state -----------------------------------------------------------
const state = {
  unlocked: false,
  mnemonic: null,
  seed: null,
  walletId: "",
  profiles: [],
  currentIndex: 0,
  profileGenerator: null,
  network: null,
  networkConnectPromise: null,
  treasury: null,
  bookkeeper: null,
  treasuryAll: null,
  bookkeeperAll: null,
  protocolLoaded: false,
  drivers: {
    registry: null,
  },

  // Shielded sync/balance
  shielded: {
    // Incremented whenever we should cancel/ignore in-flight work.
    epoch: 0,
    syncPromise: null,
    starting: false,
    // Current live status exposed to UI.
    status: {
      state: "idle", // idle | syncing | done | error
      progress: 0,
      notes: 0,
      cursorBookmark: "0",
      cursorBlock: "0",
      lastError: "",
      updatedAt: 0,
    },
  },
};

function getWalletId() {
  // Empty when locked.
  return String(state.walletId || "").trim();
}

// ----------------------------------------------------------------------------
// Data-drivers (DRC20 / DRC721)
// ----------------------------------------------------------------------------

const DRIVER_KEYS = Object.freeze({
  DRC20: "drc20",
  DRC721: "drc721",
});

function ensureDriverRegistry() {
  if (state.drivers?.registry) return state.drivers.registry;

  const reg = new dataDrivers.DataDriverRegistry(fetch);
  reg.register(DRIVER_KEYS.DRC20, assetUrl("drivers/drc20_data_driver.wasm"));
  reg.register(DRIVER_KEYS.DRC721, assetUrl("drivers/drc721_data_driver.wasm"));

  state.drivers.registry = reg;
  return reg;
}

async function getDriver(key) {
  const reg = ensureDriverRegistry();
  return await reg.get(String(key));
}

function jsonWithBigInts(value) {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

export function isUnlocked() {
  return state.unlocked;
}

export function hasWallet() {
  // wallet existence is tracked via vault in storage;
  // engine just tells whether it's currently unlocked.
  return true;
}

export function lock() {
  state.unlocked = false;
  state.mnemonic = null;
  state.walletId = "";
  if (state.seed) {
    try {
      state.seed.fill(0);
    } catch {}
  }
  state.seed = null;
  state.profiles = [];
  state.profileGenerator = null;
  state.currentIndex = 0;

  // Cancel/clear shielded state.
  try {
    state.shielded.epoch++;
  } catch {}
  state.shielded.syncPromise = null;
  state.shielded.status = {
    state: "idle",
    progress: 0,
    notes: 0,
    cursorBookmark: "0",
    cursorBlock: "0",
    lastError: "",
    updatedAt: Date.now(),
  };
  // Reset derived helpers (they don't hold secrets, but can hold stale profile refs).
  state.treasury = null;
  state.bookkeeper = null;
  state.treasuryAll = null;
  state.bookkeeperAll = null;

  // We keep the Network instance around; it holds no secrets and can stay connected.
}

/**
 * Unlock engine with mnemonic (already decrypted from vault)
 * @param {string} mnemonic
 */
export async function unlockWithMnemonic(mnemonic) {
  const unlockStart = engineNow();
  debugEngine("unlock_start");
  try {
    await withTimeout(
      ensureProtocolDriverLoaded(),
      120_000,
      "Timed out loading protocol driver"
    );
    debugEngine("unlock_protocol_loaded", {
      totalMs: engineSince(unlockStart),
    });
  } catch (err) {
    debugEngine("unlock_protocol_error", {
      totalMs: engineSince(unlockStart),
      error: err?.message ?? String(err),
    });
    throw err;
  }

  // If the engine was already unlocked, wipe previous secret state first.
  // This prevents confusing cross-wallet caching effects.
  if (state.unlocked) {
    try {
      lock();
    } catch {
      // ignore
    }
    debugEngine("unlock_state_reset", {
      totalMs: engineSince(unlockStart),
    });
  }

  const normalizeStart = engineNow();
  mnemonic = mnemonic.trim().replace(/\s+/g, " ");
  debugEngine("unlock_mnemonic_normalized", {
    ms: engineSince(normalizeStart),
    totalMs: engineSince(unlockStart),
  });

  const seedStart = engineNow();
  const seed = Uint8Array.from(mnemonicToSeedSync(mnemonic));
  debugEngine("unlock_seed_ready", {
    ms: engineSince(seedStart),
    totalMs: engineSince(unlockStart),
  });

  // ProfileGenerator needs a seeder fn; return a copy each time.
  const profileGenStart = engineNow();
  const seeder = async () => seed.slice();
  const pg = new ProfileGenerator(seeder);
  debugEngine("unlock_profile_generator_ready", {
    ms: engineSince(profileGenStart),
    totalMs: engineSince(unlockStart),
  });

  // Generate default profile (index 0)
  const profileStart = engineNow();
  const p0 = await pg.default;
  debugEngine("unlock_profile_default_ready", {
    ms: engineSince(profileStart),
    totalMs: engineSince(unlockStart),
  });

  state.unlocked = true;
  state.mnemonic = mnemonic;
  state.seed = seed;
  state.walletId = p0?.account?.toString?.() ?? "";
  state.profileGenerator = pg;

  // Restore derived accounts (public + shielded) based on persisted settings.
  const targetCountRaw = Number(engineConfig.accountCount ?? 1);
  const targetCount =
    Number.isFinite(targetCountRaw) && targetCountRaw >= 1
      ? Math.floor(targetCountRaw)
      : 1;
  const cappedCount = Math.min(targetCount, MAX_ACCOUNT_COUNT);

  const profiles = [p0];
  for (let i = 1; i < cappedCount; i++) {
    // ProfileGenerator.next() skips default and generates sequential indices.
    profiles.push(await pg.next());
  }

  state.profiles = profiles;

  const selRaw = Number(engineConfig.selectedAccountIndex ?? 0);
  const sel =
    Number.isFinite(selRaw) && selRaw >= 0 ? Math.floor(selRaw) : 0;
  state.currentIndex = Math.min(sel, Math.max(0, profiles.length - 1));
  debugEngine("unlock_state_set", {
    totalMs: engineSince(unlockStart),
  });

  // Prepare shielded meta for this wallet+network so UI can show sync state.
  // NOTE: this does not connect to the network.
  // Shielded meta initialization should never block unlock. It can be slow or
  // hang in some environments (IndexedDB). Run it in the background with a
  // hard timeout and surface errors via status.
  const shieldedStart = engineNow();
  debugEngine("shielded_meta_init_start", {
    totalMs: engineSince(unlockStart),
  });
  withTimeout(
    ensureShieldedMetaForCurrent(),
    10_000,
    "Shielded metadata initialization timed out"
  )
    .then(() => {
      debugEngine("shielded_meta_init_ok", {
        ms: engineSince(shieldedStart),
        totalMs: engineSince(unlockStart),
      });
    })
    .catch((err) => {
      debugEngine("shielded_meta_init_error", {
        ms: engineSince(shieldedStart),
        totalMs: engineSince(unlockStart),
        error: err?.message ?? String(err),
      });
      setShieldedStatus({
        state: "error",
        lastError: err?.message ?? String(err),
      });
    })
    .finally(() => {
      broadcastShieldedStatus("shielded_meta_ready");
    });

  return p0;
}

export function getCurrentProfile() {
  const p = state.profiles[state.currentIndex];
  if (!p) throw new Error("Wallet not unlocked");
  return p;
}

export function getSelectedAccountIndex() {
  return Number(state.currentIndex) || 0;
}

function normalizeProfileIndex(v, fallback = 0) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

async function ensureProfileIndex(idx) {
  if (!state.unlocked) throw new Error("Wallet locked");
  const i = normalizeProfileIndex(idx, state.currentIndex || 0);
  if (i >= MAX_ACCOUNT_COUNT) {
    throw new Error(`Only ${MAX_ACCOUNT_COUNT} accounts are supported right now`);
  }
  if (state.profiles[i]) return state.profiles[i];
  if (!state.profileGenerator) throw new Error("No profile generator (wallet not unlocked?)");

  // Derive missing profiles sequentially.
  while (state.profiles.length <= i) {
    state.profiles.push(await state.profileGenerator.next());
  }
  return state.profiles[i];
}

export async function selectAccountIndex({ index } = {}) {
  if (!state.unlocked) throw new Error("Wallet locked");
  const idx = normalizeProfileIndex(index, 0);
  if (idx >= MAX_ACCOUNT_COUNT) {
    throw new Error(`Only ${MAX_ACCOUNT_COUNT} accounts are supported right now`);
  }
  await ensureProfileIndex(idx);
  state.currentIndex = idx;
  return {
    selectedAccountIndex: state.currentIndex,
    accounts: getAccounts(),
    addresses: getAddresses(),
  };
}

export async function addAccount() {
  if (!state.unlocked) throw new Error("Wallet locked");
  if (!state.profileGenerator) throw new Error("No profile generator (wallet not unlocked?)");
  if (state.profiles.length >= MAX_ACCOUNT_COUNT) {
    throw new Error(`Only ${MAX_ACCOUNT_COUNT} accounts are supported right now`);
  }
  const p = await state.profileGenerator.next();
  state.profiles.push(p);
  state.currentIndex = state.profiles.length - 1;
  return {
    selectedAccountIndex: state.currentIndex,
    accounts: getAccounts(),
    addresses: getAddresses(),
  };
}

export function getAccounts() {
  // Return public account identifiers (base58)
  return state.profiles.map((p) => p.account.toString());
}

export function getAddresses() {
  return state.profiles.map((p) => p.address.toString());
}

async function ensureProtocolDriverLoaded() {
  if (state.protocolLoaded) return;

  // Load wasm bytes packaged with the extension, or from web/tauri assets.
  const loadStart = engineNow();
  const wasmUrl = assetUrl("wallet_core-1.3.0.wasm");
  debugEngine("protocol_driver_load_start", { wasmUrl });
  const fetchStart = engineNow();
  const buffer = await fetch(wasmUrl).then((r) => r.arrayBuffer());
  debugEngine("protocol_driver_fetch_done", {
    ms: engineSince(fetchStart),
    totalMs: engineSince(loadStart),
    bytes: buffer?.byteLength ?? 0,
  });
  const useStart = engineNow();
  useAsProtocolDriver(new Uint8Array(buffer));
  debugEngine("protocol_driver_use_done", {
    ms: engineSince(useStart),
    totalMs: engineSince(loadStart),
  });
  state.protocolLoaded = true;
  debugEngine("protocol_driver_loaded", {
    totalMs: engineSince(loadStart),
  });
}

// Exposed for extension engine preloading.
export async function preloadProtocolDriver() {
  await ensureProtocolDriverLoaded();
}

export async function ensureNetwork() {
  const url = new URL(engineConfig.nodeUrl);

  // Always load the protocol driver first. Even if the network is already
  // connected, Bookkeeper operations (shielded balance, tx building, etc.)
  // rely on it being available.
  await ensureProtocolDriverLoaded();

  // Lazily create the Network instance.
  state.network = state.network ?? new Network(url);

  // Patch network methods that need to hit different services (prover/archiver)
  // than the base node URL. Public endpoints often run these on separate hosts.
  patchNetworkEndpoints(state.network);

  // Connect only if we aren't already connected.
  if (!state.network.connected) {
    // Avoid concurrent connects (w3sper prints warnings and can end up in a bad state).
    if (!state.networkConnectPromise) {
      state.networkConnectPromise = (async () => {
        try {
          // NOTE: Some WebViews do not reliably abort a hanging WebSocket connect.
          // We therefore always enforce a timeout via Promise.race.
          const controller = new AbortController();

          const abortAndTearDown = () => {
            try {
              controller.abort();
            } catch {
              // ignore
            }
            try {
              state.network?.disconnect?.();
            } catch {
              // ignore
            }
            try {
              state.network?.close?.();
            } catch {
              // ignore
            }
          };

          // Some versions of w3sper accept an options bag with a signal, others do not.
          let connectPromise;
          try {
            connectPromise = state.network.connect({ signal: controller.signal });
          } catch {
            connectPromise = state.network.connect();
          }

          await withTimeout(
            connectPromise,
            10_000,
            `Timed out connecting to node ${url.toString()}`,
            abortAndTearDown
          );

          // Some w3sper versions may mutate internal callables during connect().
          patchNetworkEndpoints(state.network);
        } catch (err) {
          // Drop the cached network/bookkeeper objects so a retry starts from a
          // clean state.
          try {
            state.network?.disconnect?.();
          } catch {
            // ignore
          }
          try {
            state.network?.close?.();
          } catch {
            // ignore
          }
          state.network = null;
          state.treasury = null;
          state.bookkeeper = null;
          state.treasuryAll = null;
          state.bookkeeperAll = null;

          throw new Error(formatWsError(err, url.toString()));
        } finally {
          state.networkConnectPromise = null;
        }
      })();
    }

    await state.networkConnectPromise;
  }

  // IMPORTANT:
  // If the engine stays alive (offscreen doc) and the user imports/creates a
  // new wallet, the network can remain connected. We must still ensure the
  // treasury/bookkeeper are bound to the current profiles, otherwise we end
  // up showing the old wallet's balances.
  state.treasury = state.treasury ?? new RemoteTreasury(state.network, state.profiles, {
    includePending: false,
  });
  state.treasuryAll = state.treasuryAll ?? new RemoteTreasury(state.network, state.profiles, {
    includePending: true,
  });

  state.treasury.setProfiles(state.profiles);
  state.treasuryAll.setProfiles(state.profiles);

  state.bookkeeper = state.bookkeeper ?? new Bookkeeper(state.treasury);
  state.bookkeeperAll = state.bookkeeperAll ?? new Bookkeeper(state.treasuryAll);

  return state.network;
}

function patchNetworkEndpoints(network) {
  try {
    if (!network || typeof network !== "object") return;

    const nodeBase = String(engineConfig.nodeUrl || "").trim();
    const proverBase = String(engineConfig.proverUrl || "").trim() || nodeBase;
    if (!proverBase) return;

    const mkProveUrl = (base) => {
      try {
        return new URL("/on/prover/prove", base).toString();
      } catch {
        return "";
      }
    };

    const primary = mkProveUrl(proverBase);
    if (!primary) return;

    const fallback = nodeBase && proverBase !== nodeBase ? mkProveUrl(nodeBase) : "";
    const proveUrls = [primary, fallback].filter(Boolean);
    const proveKey = proveUrls.join("|");

    // Avoid re-patching if nothing changed.
    if (network.__duskPatchedEndpoints && network.__duskProveKey === proveKey) {
      return;
    }

    // Keep a reference to the original prove implementation for debugging.
    if (!network.__duskOrigProve && typeof network.prove === "function") {
      try {
        network.__duskOrigProve = network.prove.bind(network);
      } catch {
        network.__duskOrigProve = network.prove;
      }
    }

    const PROVE_TIMEOUT_MS = 180_000;
    const MAX_RETRIES = 1;

    const hostOf = (u) => {
      try {
        return new URL(u).host;
      } catch {
        return String(u);
      }
    };

    const hint = () => "Shielded transactions need a prover. Check Options → Prover URL.";

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    async function doProve(url, circuits) {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), PROVE_TIMEOUT_MS);

      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: circuits,
          signal: controller.signal,
        });

        if (!res.ok) {
          let detail = "";
          try {
            detail = String(await res.text()).trim();
          } catch {
            detail = "";
          }
          if (detail && detail.length > 280) detail = detail.slice(0, 280) + "…";

          const err = new Error(
            `Prover error (${res.status}) from ${hostOf(url)}${detail ? `: ${detail}` : ""}`
          );
          err.__duskHttpStatus = res.status;
          throw err;
        }

        return await res.arrayBuffer();
      } finally {
        clearTimeout(t);
      }
    }

    function shouldRetry(e) {
      const st = e && typeof e === "object" ? e.__duskHttpStatus : 0;
      if (typeof st === "number" && st >= 500) return true;
      const name = e?.name;
      if (name === "AbortError") return true;
      // Network errors are usually surfaced as TypeError in browsers.
      if (name === "TypeError") return true;
      return false;
    }

    // Override prove() so Phoenix/shielded tx building hits the prover host.
    // If the prover host is flaky, we retry once and then fall back to node URL.
    network.prove = async (circuits) => {
      let lastErr = null;

      for (let i = 0; i < proveUrls.length; i++) {
        const url = proveUrls[i];

        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
          try {
            return await doProve(url, circuits);
          } catch (e) {
            lastErr = e;

            // Retry once on transient errors (timeouts, network, 5xx)
            if (attempt < MAX_RETRIES && shouldRetry(e)) {
              await sleep(300 + Math.random() * 350);
              continue;
            }
            break;
          }
        }
      }

      const primaryHost = hostOf(primary);

      if (lastErr?.name === "AbortError") {
        throw new Error(
          `Prover timed out after ${Math.round(PROVE_TIMEOUT_MS / 1000)}s (${primaryHost}). ${hint()}`
        );
      }

      if (lastErr?.name === "TypeError" || /failed to fetch/i.test(String(lastErr?.message ?? ""))) {
        throw new Error(
          `Could not reach prover (${primaryHost}). The prover may be down or dropped the connection. ${hint()}`
        );
      }

      // Preserve useful HTTP errors produced by doProve()
      if (
        lastErr &&
        typeof lastErr?.message === "string" &&
        lastErr.message.startsWith("Prover error")
      ) {
        throw lastErr;
      }

      throw new Error(`Prover request failed (${primaryHost}). ${hint()}`);
    };

    network.__duskProveKey = proveKey;
    network.__duskPatchedEndpoints = true;
  } catch {
    // Never block normal wallet operation if patching fails.
  }
}

function formatWsError(err, nodeUrl) {
  const name = err?.name || "Error";
  const msg = err?.message;

  // Try to extract target websocket info
  const t = err?.target;
  const wsUrl = typeof t?.url === "string" ? t.url : null;
  const rs = typeof t?.readyState === "number" ? t.readyState : null;

  if (typeof msg === "string" && msg.length) {
    return `${name}: ${msg}`;
  }

  if (wsUrl) {
    return `WebSocket connection failed to ${wsUrl} (readyState=${rs ?? "?"})`;
  }

  // Last resort
  return `Failed to connect to node ${nodeUrl} (unknown websocket error)`;
}

export async function getPublicBalance({ profileIndex } = {}) {
  if (!state.unlocked) throw new Error("Wallet locked");
  await ensureNetwork();
  const profile = await ensureProfileIndex(profileIndex ?? state.currentIndex);
  return await withTimeout(
    state.bookkeeper.balance(profile.account),
    12_000,
    "Balance request timed out"
  );
}

export async function getMinimumStake() {
  if (!state.unlocked) throw new Error("Wallet locked");
  await ensureNetwork();
  // Protocol-driver backed; returned in Lux as bigint.
  return await state.bookkeeper.minimumStake;
}

export async function getStakeInfo({ profileIndex } = {}) {
  if (!state.unlocked) throw new Error("Wallet locked");
  await ensureNetwork();
  const idx = normalizeProfileIndex(profileIndex, state.currentIndex || 0);
  const profile = await ensureProfileIndex(idx);
  return await withTimeout(
    state.bookkeeper.stakeInfo(profile.account),
    12_000,
    "Stake request timed out"
  );
}

/**
 * Encode a DRC20 contract input using the canonical DRC20 data-driver.
 *
 * @param {{ fnName: string, args?: any }} params
 * @returns {Promise<Uint8Array>}
 */
export async function encodeDrc20Input(params = {}) {
  const fnName = String(params?.fnName ?? "").trim();
  if (!fnName) throw new Error("fnName is required");
  const driver = await getDriver(DRIVER_KEYS.DRC20);
  const json = params?.args === undefined || params?.args === null ? "null" : jsonWithBigInts(params.args);
  return driver.encodeInputFn(fnName, json);
}

/**
 * Decode DRC20 contract input args using the canonical DRC20 data-driver.
 *
 * @param {{ fnName: string, fnArgs: any }} params
 * @returns {Promise<any>}
 */
export async function decodeDrc20Input(params = {}) {
  const fnName = String(params?.fnName ?? "").trim();
  if (!fnName) throw new Error("fnName is required");
  const bytes = toBytes(params?.fnArgs);
  const driver = await getDriver(DRIVER_KEYS.DRC20);
  return driver.decodeInputFn(fnName, bytes);
}

/**
 * Encode a DRC721 contract input using the canonical DRC721 data-driver.
 *
 * @param {{ fnName: string, args?: any }} params
 * @returns {Promise<Uint8Array>}
 */
export async function encodeDrc721Input(params = {}) {
  const fnName = String(params?.fnName ?? "").trim();
  if (!fnName) throw new Error("fnName is required");
  const driver = await getDriver(DRIVER_KEYS.DRC721);
  const json = params?.args === undefined || params?.args === null ? "null" : jsonWithBigInts(params.args);
  return driver.encodeInputFn(fnName, json);
}

/**
 * Decode DRC721 contract input args using the canonical DRC721 data-driver.
 *
 * @param {{ fnName: string, fnArgs: any }} params
 * @returns {Promise<any>}
 */
export async function decodeDrc721Input(params = {}) {
  const fnName = String(params?.fnName ?? "").trim();
  if (!fnName) throw new Error("fnName is required");
  const bytes = toBytes(params?.fnArgs);
  const driver = await getDriver(DRIVER_KEYS.DRC721);
  return driver.decodeInputFn(fnName, bytes);
}

/**
 * @param {{ contractId: any }} params
 * @returns {Promise<{ name: string, symbol: string, decimals: number }>}
 */
export async function getDrc20Metadata(params = {}) {
  if (!state.unlocked) throw new Error("Wallet locked");
  const contractIdBytes = toContractIdBytes(params?.contractId);

  const network = await ensureNetwork();
  const driver = await getDriver(DRIVER_KEYS.DRC20);
  const c = new Contract({ contractId: contractIdBytes, driver, network });

  const [name, symbol, decimals] = await Promise.all([
    c.call.name(),
    c.call.symbol(),
    c.call.decimals(),
  ]);

  return Object.freeze({
    name: String(name ?? ""),
    symbol: String(symbol ?? ""),
    decimals: Number(decimals ?? 0) || 0,
  });
}

/**
 * @param {{ contractId: any, profileIndex?: number }} params
 * @returns {Promise<string>} u64 decimal string
 */
export async function getDrc20Balance(params = {}) {
  if (!state.unlocked) throw new Error("Wallet locked");
  const contractIdBytes = toContractIdBytes(params?.contractId);

  const idx = normalizeProfileIndex(params?.profileIndex, state.currentIndex || 0);
  const profile = await ensureProfileIndex(idx);

  const network = await ensureNetwork();
  const driver = await getDriver(DRIVER_KEYS.DRC20);
  const c = new Contract({ contractId: contractIdBytes, driver, network });

  const out = await c.call.balance_of({
    account: { External: profile.account.toString() },
  });

  // Data-driver returns bigints as strings.
  return String(out ?? "0");
}

/**
 * @param {{ contractId: any }} params
 * @returns {Promise<{ name: string, symbol: string, baseUri: string }>}
 */
export async function getDrc721Metadata(params = {}) {
  if (!state.unlocked) throw new Error("Wallet locked");
  const contractIdBytes = toContractIdBytes(params?.contractId);

  const network = await ensureNetwork();
  const driver = await getDriver(DRIVER_KEYS.DRC721);
  const c = new Contract({ contractId: contractIdBytes, driver, network });

  const [name, symbol, baseUri] = await Promise.all([
    c.call.name(),
    c.call.symbol(),
    c.call.base_uri(),
  ]);

  return Object.freeze({
    name: String(name ?? ""),
    symbol: String(symbol ?? ""),
    baseUri: String(baseUri ?? ""),
  });
}

/**
 * @param {{ contractId: any, tokenId: any }} params
 * @returns {Promise<any>} Account enum JSON from the data-driver
 */
export async function getDrc721OwnerOf(params = {}) {
  if (!state.unlocked) throw new Error("Wallet locked");
  const contractIdBytes = toContractIdBytes(params?.contractId);
  const token_id = String(params?.tokenId ?? "").trim();
  if (!token_id) throw new Error("tokenId is required");

  const network = await ensureNetwork();
  const driver = await getDriver(DRIVER_KEYS.DRC721);
  const c = new Contract({ contractId: contractIdBytes, driver, network });

  return await c.call.owner_of({ token_id });
}

/**
 * @param {{ contractId: any, tokenId: any }} params
 * @returns {Promise<string>}
 */
export async function getDrc721TokenUri(params = {}) {
  if (!state.unlocked) throw new Error("Wallet locked");
  const contractIdBytes = toContractIdBytes(params?.contractId);
  const token_id = String(params?.tokenId ?? "").trim();
  if (!token_id) throw new Error("tokenId is required");

  const network = await ensureNetwork();
  const driver = await getDriver(DRIVER_KEYS.DRC721);
  const c = new Contract({ contractId: contractIdBytes, driver, network });

  const out = await c.call.token_uri({ token_id });
  return String(out ?? "");
}

/**
 * Fetch current gas price stats from the Rusk node's mempool.
 * @param {Object} [opts]
 * @param {number} [opts.maxTransactions=100] - Max mempool txs to sample.
 * @returns {Promise<{average: string, max: string, median: string, min: string}>}
 *          All values are stringified u64 (Lux, i.e. 1e-9 DUSK).
 *          Returns { average: "1", max: "1", median: "1", min: "1" } when mempool is empty.
 */
export async function getGasPrice({ maxTransactions = 100 } = {}) {
  await ensureNetwork();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    // Rusk endpoint: POST /on/blocks/gas-price with body "<max_transactions>".
    // w3sper exposes it via network.blocks.call["gas-price"]().
    let n = Number(maxTransactions ?? 100);
    if (!Number.isFinite(n) || n <= 0) n = 100;
    const res = await state.network.blocks.call["gas-price"](String(Math.floor(n)), {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    const data = await res.json();
    // Rusk returns { average: u64, max: u64, median: u64, min: u64 }
    return {
      average: String(data.average ?? 1),
      max: String(data.max ?? 1),
      median: String(data.median ?? 1),
      min: String(data.min ?? 1),
    };
  } catch (e) {
    if (e?.name === "AbortError") {
      throw new Error("Gas price request timed out");
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

// --- Cached gas price ---
// Cache gas prices to avoid hammering the node on every tx.
const gasPriceCache = {
  data: null,
  nodeUrl: "",
  fetchedAt: 0,
};
const GAS_PRICE_CACHE_TTL_MS = 30_000; // 30 seconds

/**
 * Get gas price with caching. Returns cached value if fresh, otherwise fetches.
 * Falls back to { average: "1", ... } on error to avoid blocking transactions.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.forceRefresh=false] - Bypass cache and fetch fresh data.
 * @returns {Promise<{average: string, max: string, median: string, min: string}>}
 */
export async function getCachedGasPrice({ forceRefresh = false } = {}) {
  const nodeUrl = String(engineConfig.nodeUrl || "").trim();
  const now = Date.now();

  // Return cached if still fresh and same node
  if (
    !forceRefresh &&
    gasPriceCache.data &&
    gasPriceCache.nodeUrl === nodeUrl &&
    now - gasPriceCache.fetchedAt < GAS_PRICE_CACHE_TTL_MS
  ) {
    return gasPriceCache.data;
  }

  try {
    const data = await getGasPrice();
    gasPriceCache.data = data;
    gasPriceCache.nodeUrl = nodeUrl;
    gasPriceCache.fetchedAt = now;
    return data;
  } catch {
    // On error, return cached if available, otherwise safe fallback
    if (gasPriceCache.data) return gasPriceCache.data;
    return { average: "1", max: "1", median: "1", min: "1" };
  }
}

// ---------------------------------------------------------------------------
// Shielded
// ---------------------------------------------------------------------------

function setShieldedStatus(patch = {}) {
  state.shielded.status = {
    ...state.shielded.status,
    ...patch,
    updatedAt: Date.now(),
  };
  return state.shielded.status;
}

function broadcastShieldedStatus(reason = "") {
  // Best-effort UI push for extension pages (popup/full view).
  try {
    runtimeSendMessage(
      {
      type: "DUSK_UI_SHIELDED_STATUS",
      reason,
      status: getShieldedStatus(),
      walletId: getWalletId(),
      networkKey: getNetworkKey(),
      profileIndex: state.currentIndex || 0,
      },
      { allowLastError: true }
    ).catch(() => {});
  } catch {
    // ignore
  }
}

function toU8(val) {
  if (val instanceof Uint8Array) return val;
  if (val instanceof ArrayBuffer) return new Uint8Array(val);
  if (ArrayBuffer.isView(val)) {
    return new Uint8Array(val.buffer, val.byteOffset, val.byteLength);
  }
  // last resort
  try {
    return new Uint8Array(val);
  } catch {
    return new Uint8Array();
  }
}

function normalizeNullifierList(list) {
  const out = [];
  for (const v of list || []) {
    const u = toU8(v);
    if (u && u.length) out.push(u);
  }
  return out;
}

/**
 * Reconcile spent/unspent state for cached shielded notes.
 *
 * This is separate from note scanning:
 * - note scanning discovers owned notes
 * - spent reconciliation checks which cached nullifiers are now spent on chain
 *   (and can also "unspend" on reorg).
 */
async function reconcileSpentNotes(syncer, { netKey, walletId, profileIndex }) {
  try {
    const idx = Number(profileIndex) || 0;

    const unspent = await getUnspentNullifiers(netKey, walletId, idx).catch(() => []);
    if (unspent.length) {
      const spentBufs = await syncer.spent(unspent);
      const spent = normalizeNullifierList(spentBufs);
      if (spent.length) {
        await markNullifiersSpent(netKey, walletId, idx, spent);
      }
    }

    const spentCached = await getSpentNullifiers(netKey, walletId, idx).catch(() => []);
    if (spentCached.length) {
      const stillSpentBufs = await syncer.spent(spentCached);
      const stillSpent = normalizeNullifierList(stillSpentBufs);
      const stillSet = new Set(stillSpent.map((u8) => bytesToHex(u8)));

      const toRestore = [];
      for (const n of spentCached) {
        const hex = bytesToHex(n);
        if (!stillSet.has(hex)) toRestore.push(n);
      }
      if (toRestore.length) {
        await unspendNullifiers(netKey, walletId, idx, toRestore);
      }
    }
  } catch {
    // best-effort; we don't want spent reconciliation to break the whole sync
  }
}

export function getShieldedStatus() {
  // Return a plain clone so callers can't mutate engine state.
  return { ...state.shielded.status };
}

async function ensureShieldedMetaForIndex(profileIndex) {
  const netKey = getNetworkKey();
  const walletId = getWalletId();
  if (!walletId) throw new Error("No walletId (wallet locked?)");
  const idx = normalizeProfileIndex(profileIndex, state.currentIndex || 0);
  let meta;
  try {
    meta = await ensureShieldedMeta(netKey, walletId, idx, {
      checkpointBookmark: 0n,
      checkpointBlock: 0n,
      cursorBookmark: 0n,
      cursorBlock: 0n,
    });
  } catch (err) {
    // Surface meta init failures explicitly; they otherwise get swallowed by callers.
    setShieldedStatus({
      state: "error",
      lastError: err?.message ?? String(err),
    });
    throw err;
  }

  const cursor = metaCursor(meta);
  let n = 0;
  try {
    n = await countNotes(netKey, walletId, idx);
  } catch {
    n = 0;
  }

  setShieldedStatus({
    cursorBookmark: cursor.bookmark.toString(),
    cursorBlock: cursor.block.toString(),
    notes: n,
  });

  return meta;
}

async function ensureShieldedMetaForCurrent() {
  return await ensureShieldedMetaForIndex(state.currentIndex || 0);
}

export async function setShieldedCheckpointNow({ profileIndex = 0 } = {}) {
  if (!state.unlocked) throw new Error("Wallet locked");
  await ensureNetwork();

  const netKey = getNetworkKey();
  const walletId = getWalletId();
  if (!walletId) throw new Error("No walletId (wallet locked?)");
  const idx = Number(profileIndex) || 0;

  // num_notes() returns the current size of the note tree.
  // In w3sper this may be returned as a bigint/number directly.
  const bookmark = await readTransferContractBookmark(state.network);
  if (typeof bookmark !== "bigint") {
    throw new Error("Failed to read transfer contract num_notes() bookmark");
  }
  const block = await state.network.blockHeight;

  // Starting from a checkpoint implies ignoring any historical shielded notes.
  // This is ideal for newly created wallets.
  await clearNotes(netKey, walletId, idx);

  await putShieldedMeta(netKey, walletId, idx, {
    checkpointBookmark: bookmark.toString(),
    checkpointBlock: block.toString(),
    cursorBookmark: bookmark.toString(),
    cursorBlock: block.toString(),
  });

  setShieldedStatus({
    state: "idle",
    progress: 0,
    notes: 0,
    cursorBookmark: bookmark.toString(),
    cursorBlock: block.toString(),
    lastError: "",
  });

  return { bookmark: bookmark.toString(), block: block.toString() };
}

export async function startShieldedSync({ force = false } = {}) {
  if (!state.unlocked) throw new Error("Wallet locked");

  // Prevent races where both the popup and the full view trigger an overview
  // refresh at the same time. Without this, both calls can pass the "not
  // syncing" check before `syncPromise` is assigned, starting 2 sync loops.
  if (!force) {
    if (state.shielded.syncPromise) {
      return { started: false, status: getShieldedStatus() };
    }
    if (state.shielded.starting) {
      return { started: false, status: getShieldedStatus() };
    }
  }

  state.shielded.starting = true;
  try {
    try {
      await ensureShieldedMetaForCurrent();
    } catch {
      broadcastShieldedStatus("error");
      return { started: false, status: getShieldedStatus() };
    }

    const walletId = getWalletId();
    if (!walletId) throw new Error("No walletId (wallet locked?)");

    const netKey = getNetworkKey();
    const idx = state.currentIndex || 0;

    const meta = await ensureShieldedMeta(netKey, walletId, idx);
    const cursor = metaCursor(meta);

    // If a sync started while we were awaiting meta, don't start another.
    if (state.shielded.syncPromise && !force) {
      return { started: false, status: getShieldedStatus() };
    }

    // Fast-path: if we are already caught up (cursor bookmark >= current
    // transfer-contract bookmark), do NOT flip the UI back into a "syncing 0%"
    // state. This fixes a UX issue where the background overview handler calls
    // `dusk_syncShielded` frequently.
    if (!force) {
      try {
        await ensureNetwork();
        const tipBookmark = await readTransferContractBookmark(state.network);

        if (typeof tipBookmark === "bigint" && cursor.bookmark >= tipBookmark) {
          // Even if we are caught up on discovery, we still want to reconcile
          // spent/unspent state (e.g. after submitting a phoenix tx that spends
          // our notes, the cursor may remain at tip but nullifiers will change).
          try {
            const syncer = new AddressSyncer(state.network);
            await reconcileSpentNotes(syncer, { netKey, walletId, profileIndex: idx });
          } catch {
            // ignore
          }

          const n = await countNotes(netKey, walletId, idx);
          setShieldedStatus({
            state: "done",
            progress: 1,
            notes: n,
            cursorBookmark: cursor.bookmark.toString(),
            cursorBlock: cursor.block.toString(),
            lastError: "",
          });
          broadcastShieldedStatus("up_to_date");
          state.shielded.syncPromise = null;
          return { started: false, status: getShieldedStatus() };
        }
      } catch {
        // ignore; we'll attempt a normal sync below
      }
    }

    // Cancel/ignore any in-flight sync (force) and start a new one.
    state.shielded.epoch++;
    const epoch = state.shielded.epoch;

    // Snapshot the start cursor so we can compute progress even if the
    // `synciteration` event doesn't provide it.
    const startBookmark = cursor.bookmark;
    const startBlock = cursor.block;

    // Snapshot the current tip bookmark; we'll sync up to this point and then
    // stop (new notes after this will be picked up by the next sync).
    let targetBookmark = null;
    try {
      if (state.network?.connected) {
        targetBookmark = await readTransferContractBookmark(state.network);
      }
    } catch {
      targetBookmark = null;
    }

    setShieldedStatus({
      state: "syncing",
      progress: 0,
      cursorBookmark: startBookmark.toString(),
      cursorBlock: startBlock.toString(),
      lastError: "",
    });

    const run = async () => {
      await ensureNetwork();
      const syncer = new AddressSyncer(state.network);

      let shouldStop = false;

      const onIter = (ev) => {
        if (epoch !== state.shielded.epoch) return;
        const d = ev?.detail || {};

        const evProg = toProgress01(d.progress);
        const curB = toBigIntLike(d.bookmarks?.current);
        const curH = toBigIntLike(d.blocks?.current);

        // Compute progress from bookmarks if needed.
        let prog = evProg;
        if (
          (prog === null || prog <= 0) &&
          typeof targetBookmark === "bigint" &&
          targetBookmark > startBookmark &&
          typeof curB === "bigint"
        ) {
          prog = ratioBigInt(curB - startBookmark, targetBookmark - startBookmark);
        }

        if (prog === null) prog = 0;

        // If we've reached the snapshot target, request stop.
        if (typeof targetBookmark === "bigint" && typeof curB === "bigint" && curB >= targetBookmark) {
          shouldStop = true;
        }

        setShieldedStatus({
          state: "syncing",
          progress: Math.max(0, Math.min(1, prog)),
          cursorBookmark: typeof curB === "bigint" ? curB.toString() : state.shielded.status.cursorBookmark,
          cursorBlock: typeof curH === "bigint" ? curH.toString() : state.shielded.status.cursorBlock,
        });
      };

      syncer.addEventListener("synciteration", onIter);

      try {
        // Refresh target bookmark after we have a connected network (in case it
        // was null during the pre-connect snapshot).
        if (targetBookmark === null) {
          targetBookmark = await readTransferContractBookmark(state.network);
        }

        const from = Bookmark.from(startBookmark);

        // w3sper's AddressSyncer.notes() can be either a ReadableStream or an
        // async iterable depending on runtime/version.
        const controller = new AbortController();

        let notesStream;
        try {
          notesStream = await syncer.notes(state.profiles, { from, signal: controller.signal });
        } catch {
          notesStream = await syncer.notes(state.profiles, { from });
        }

        const processChunk = async (value) => {
          const owned = value?.[0];
          const syncInfo = value?.[1];

          // owned is an array of Maps (one per profile)
          if (Array.isArray(owned)) {
            for (let i = 0; i < owned.length; i++) {
              const m = owned[i];
              if (m && typeof m.size === "number" && m.size > 0) {
                await putNotesMap(netKey, walletId, i, m);
              }
            }
          }

          const b = toBigIntLike(syncInfo?.bookmark);
          const h = toBigIntLike(syncInfo?.blockHeight);

          if (typeof b === "bigint" && typeof h === "bigint") {
            await putShieldedMeta(netKey, walletId, idx, {
              cursorBookmark: b.toString(),
              cursorBlock: h.toString(),
            });

            // Update progress even if the event-based `detail.progress` isn't provided.
            if (typeof targetBookmark === "bigint" && targetBookmark > startBookmark) {
              const p = ratioBigInt(b - startBookmark, targetBookmark - startBookmark);
              setShieldedStatus({ progress: Math.max(state.shielded.status.progress || 0, p) });
            }

            setShieldedStatus({
              cursorBookmark: b.toString(),
              cursorBlock: h.toString(),
            });

            if (typeof targetBookmark === "bigint" && b >= targetBookmark) {
              shouldStop = true;
            }
          }
        };

        const isStale = () => epoch !== state.shielded.epoch;

        // Prefer the reader API if available (ReadableStream).
        if (notesStream && typeof notesStream.getReader === "function") {
          const reader = notesStream.getReader();
          try {
            while (true) {
              if (isStale()) {
                try {
                  controller.abort();
                } catch {}
                try {
                  await reader.cancel();
                } catch {}
                return;
              }

              const { done, value } = await reader.read();
              if (done) break;
              await processChunk(value);

              if (shouldStop) {
                try {
                  controller.abort();
                } catch {}
                try {
                  await reader.cancel();
                } catch {}
                break;
              }
            }
          } finally {
            try {
              reader.releaseLock?.();
            } catch {}
          }
        } else if (notesStream && typeof notesStream?.[Symbol.asyncIterator] === "function") {
          for await (const value of notesStream) {
            if (isStale()) {
              try {
                controller.abort();
              } catch {}
              break;
            }
            await processChunk(value);

            if (shouldStop) {
              try {
                controller.abort();
              } catch {}
              break;
            }
          }
        } else {
          throw new Error("AddressSyncer.notes() did not return a stream");
        }

        // After discovery, reconcile spent/unspent state.
        await reconcileSpentNotes(syncer, { netKey, walletId, profileIndex: idx });

        const n = await countNotes(netKey, walletId, idx);
        setShieldedStatus({
          state: "done",
          progress: 1,
          notes: n,
          lastError: "",
        });
        broadcastShieldedStatus("done");
      } catch (e) {
        setShieldedStatus({
          state: "error",
          lastError: e?.message ? String(e.message) : String(e),
        });
        broadcastShieldedStatus("error");
      } finally {
        try {
          syncer.removeEventListener("synciteration", onIter);
        } catch {}
        if (epoch === state.shielded.epoch) {
          state.shielded.syncPromise = null;
        }
      }
    };

    // Fire-and-forget.
    state.shielded.syncPromise = run();

    return { started: true, status: getShieldedStatus() };
  } finally {
    state.shielded.starting = false;
  }
}

export async function getShieldedBalance() {
  if (!state.unlocked) throw new Error("Wallet locked");
  await ensureNetwork();
  await ensureShieldedMetaForCurrent();

  const profile = getCurrentProfile();
  return await withTimeout(
    (async () => {
      // We return both:
      // - value: total (includes locally pending nullifiers)
      // - spendable: available (excludes locally pending nullifiers)
      const total = await state.bookkeeperAll.balance(profile.address);
      const available = await state.bookkeeper.balance(profile.address);

      const value = total?.value ?? total;
      const spendable = available?.value ?? available;
      return { value, spendable };
    })(),
    15_000,
    "Shielded balance request timed out"
  );
}

function normalizeGas(gas) {
  if (!gas || typeof gas !== "object") return undefined;
  const out = {};
  if (gas.limit !== undefined && gas.limit !== null && gas.limit !== "") {
    out.limit = typeof gas.limit === "bigint" ? gas.limit : BigInt(gas.limit);
  }
  if (gas.price !== undefined && gas.price !== null && gas.price !== "") {
    out.price = typeof gas.price === "bigint" ? gas.price : BigInt(gas.price);
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Transfer funds.
 *
 * @param {{to:string, amount:string|bigint, memo?:string, gas?:{limit?:string|bigint, price?:string|bigint}}} params
 */
export async function transfer(params) {
  if (!state.unlocked) throw new Error("Wallet locked");
  const { to, memo } = params;

  const amount = typeof params.amount === "bigint" ? params.amount : BigInt(params.amount);
  const profileIndex = params?.profileIndex;

  const toType = ProfileGenerator.typeOf(to);
  if (toType !== "account" && toType !== "address") {
    throw new Error("Invalid recipient: expected a Dusk account or shielded address");
  }

  const network = await ensureNetwork();
  const idx = normalizeProfileIndex(profileIndex, state.currentIndex || 0);
  const profile = await ensureProfileIndex(idx);

  // Shielded transfers spend from the local note cache.
  // We avoid blocking the UX on a full sync here (MetaMask-style).
  // If the cache is empty, we kick off a background sync and fail fast with
  // a clear message.
  if (toType === "address") {
    await ensureShieldedMetaForIndex(idx);

    try {
      const netKey = getNetworkKey();
      const walletId = getWalletId();

      if (walletId) {
        const n = await countNotes(netKey, walletId, idx);
        if (!n) {
          // Fire-and-forget: start scanning for owned notes, but don't block.
          startShieldedSync({ force: false }).catch(() => {});
          throw new Error(
            "Shielded wallet is still syncing. Please wait for shielded sync to complete before sending."
          );
        }
      }
    } catch (e) {
      // If we explicitly raised the "still syncing" message, surface it.
      const msg = e?.message ? String(e.message) : String(e);
      if (msg.includes("Shielded wallet is still syncing")) {
        throw e;
      }
      // Otherwise ignore and attempt to build the tx with current cache.
    }
  }

  let tx = state.bookkeeper.as(profile).transfer(amount).to(to);

  if (typeof memo === "string" && memo.length > 0) {
    tx = tx.memo(memo);
  }

  const gas = normalizeGas(params.gas);
  if (gas) tx = tx.gas(gas);

  // Default to obfuscated transfers for privacy.
  if (toType === "address" && typeof tx?.obfuscated === "function") {
    try {
      tx.obfuscated();
    } catch {
      // ignore
    }
  }

  const result = await network.execute(tx);

  // If this is a shielded spend, reserve the nullifiers locally to prevent
  // double-spend before we observe them as spent on chain.
  try {
    if (Array.isArray(result?.nullifiers) && result.nullifiers.length) {
      const netKey = getNetworkKey();
      const walletId = getWalletId();
      if (walletId) {
        await putPendingNullifiers(netKey, walletId, idx, result.nullifiers, result.hash);
      }
    }
  } catch {
    // best-effort
  }

  // network.execute returns the tx object returned by tx.build, frozen
  return { hash: result.hash, nonce: result.nonce, nullifiers: result.nullifiers };
}

// ----------------------------------------------------------------------------
// dusk_sendTransaction
// ----------------------------------------------------------------------------

function toU64(value, { name } = { name: "value" }) {
  if (value === undefined || value === null || value === "") return 0n;
  try {
    const v = typeof value === "bigint" ? value : BigInt(value);
    if (v < 0n) throw new Error("negative");
    return v;
  } catch {
    throw new Error(`Invalid ${name}: must be a u64 decimal string`);
  }
}

function toContractIdBytes(contractId) {
  if (typeof contractId === "string") {
    const b = hexToBytes(contractId);
    if (b.length !== 32) throw new Error("contractId must be 32 bytes");
    return b;
  }
  if (contractId instanceof Uint8Array) {
    if (contractId.length !== 32) throw new Error("contractId must be 32 bytes");
    return contractId;
  }
  if (Array.isArray(contractId)) {
    const b = new Uint8Array(contractId);
    if (b.length !== 32) throw new Error("contractId must be 32 bytes");
    return b;
  }
  throw new Error("Invalid contractId (expected 32-byte hex string or number[32])");
}

/**
 * Send a transaction from the currently selected account.
 *
 * Supported kinds:
 * - { kind: 'transfer', to, amount, memo?, gas? }
 * - { kind: 'shield', amount, gas? }
 * - { kind: 'unshield', amount, gas? }
 * - { kind: 'stake', amount, gas? }
 * - { kind: 'unstake', amount?, gas? } // omit/0 amount => full unstake
 * - { kind: 'withdraw_reward', amount?, gas? } // omit/0 amount => withdraw all
 * - { kind: 'contract_call', contractId, fnName, fnArgs, to?, amount?, deposit?, gas? }
 */
export async function sendTransaction(params) {
  if (!state.unlocked) throw new Error("Wallet locked");
  if (!params || typeof params !== "object") {
    throw new Error("Invalid params: object required");
  }

  const kind = String(params.kind || "").toLowerCase();
  if (!kind) throw new Error("Invalid params: kind is required");

  // Common
  const network = await ensureNetwork();
  const idx = normalizeProfileIndex(params?.profileIndex, state.currentIndex || 0);
  const profile = await ensureProfileIndex(idx);

  if (kind === TX_KIND.TRANSFER) {
    // Reuse existing transfer logic for now.
    return await transfer(params);
  }

  if (kind === TX_KIND.SHIELD) {
    if ("to" in params && params.to) {
      throw new Error("Shield does not accept a 'to' field (it always targets your shielded address)");
    }
    if ("memo" in params && params.memo) {
      throw new Error("Shield cannot include a memo payload");
    }

    const amount = toU64(params.amount, { name: "amount" });
    if (amount <= 0n) throw new Error("amount must be > 0");

    let tx = state.bookkeeper.as(profile).shield(amount);
    const gas = normalizeGas(params.gas);
    if (gas) tx = tx.gas(gas);

    const result = await network.execute(tx);
    return { hash: result.hash, nonce: result.nonce };
  }

  if (kind === TX_KIND.UNSHIELD) {
    if ("to" in params && params.to) {
      throw new Error("Unshield does not accept a 'to' field (it always targets your public account)");
    }
    if ("memo" in params && params.memo) {
      throw new Error("Unshield cannot include a memo payload");
    }

    const amount = toU64(params.amount, { name: "amount" });
    if (amount <= 0n) throw new Error("amount must be > 0");

    // Spending shielded notes requires the local note cache. If the cache is
    // empty, kick off a background sync and fail fast with a clear message.
    await ensureShieldedMetaForCurrent();
    try {
      const netKey = getNetworkKey();
      const walletId = getWalletId();
      const idx = state.currentIndex || 0;
      if (walletId) {
        const n = await countNotes(netKey, walletId, idx);
        if (!n) {
          startShieldedSync({ force: false }).catch(() => {});
          throw new Error(
            "Shielded wallet is still syncing. Please wait for shielded sync to complete before unshielding."
          );
        }
      }
    } catch (e) {
      const msg = e?.message ? String(e.message) : String(e);
      if (msg.includes("Shielded wallet is still syncing")) throw e;
    }

    let tx = state.bookkeeper.as(profile).unshield(amount);
    const gas = normalizeGas(params.gas);
    if (gas) tx = tx.gas(gas);

    const result = await network.execute(tx);

    // Reserve nullifiers locally to prevent double-spend before we observe them
    // as spent on chain.
    try {
      if (Array.isArray(result?.nullifiers) && result.nullifiers.length) {
        const netKey = getNetworkKey();
        const walletId = getWalletId();
        const idx = state.currentIndex || 0;
        if (walletId) {
          await putPendingNullifiers(netKey, walletId, idx, result.nullifiers, result.hash);
        }
      }
    } catch {
      // best-effort
    }

    return { hash: result.hash, nullifiers: result.nullifiers };
  }

  if (kind === TX_KIND.STAKE) {
    if ("to" in params && params.to) {
      throw new Error("Stake does not accept a 'to' field");
    }
    if ("memo" in params && params.memo) {
      throw new Error("Stake cannot include a memo payload");
    }

    const amount = toU64(params.amount, { name: "amount" });
    if (amount <= 0n) throw new Error("amount must be > 0");

    // If a stake already exists, interpret `stake` as a topup (wallet UX).
    let hasStake = false;
    try {
      const info = await state.bookkeeper.stakeInfo(profile.account);
      hasStake = Boolean(info?.amount);
    } catch {
      hasStake = false;
    }

    let tx = hasStake ? state.bookkeeper.as(profile).topup(amount) : state.bookkeeper.as(profile).stake(amount);
    const gas = normalizeGas(params.gas);
    if (gas) tx = tx.gas(gas);

    const result = await network.execute(tx);
    return { hash: result.hash, nonce: result.nonce };
  }

  if (kind === TX_KIND.UNSTAKE) {
    if ("to" in params && params.to) {
      throw new Error("Unstake does not accept a 'to' field");
    }
    if ("memo" in params && params.memo) {
      throw new Error("Unstake cannot include a memo payload");
    }

    // If amount is omitted/0, unstake everything (w3sper treats non-bigint as "full").
    const raw = params.amount;
    const wantsFull = raw === undefined || raw === null || raw === "" || raw === 0 || raw === "0" || raw === 0n;
    const amount = wantsFull ? undefined : toU64(raw, { name: "amount" });
    if (amount !== undefined && amount <= 0n) throw new Error("amount must be > 0");

    let tx = wantsFull ? state.bookkeeper.as(profile).unstake() : state.bookkeeper.as(profile).unstake(amount);
    const gas = normalizeGas(params.gas);
    if (gas) tx = tx.gas(gas);

    const result = await network.execute(tx);
    return { hash: result.hash, nonce: result.nonce };
  }

  if (kind === TX_KIND.WITHDRAW_REWARD) {
    if ("to" in params && params.to) {
      throw new Error("Withdraw reward does not accept a 'to' field");
    }
    if ("memo" in params && params.memo) {
      throw new Error("Withdraw reward cannot include a memo payload");
    }

    let reward = 0n;
    try {
      const info = await state.bookkeeper.stakeInfo(profile.account);
      reward = typeof info?.reward === "bigint" ? info.reward : 0n;
    } catch {
      reward = 0n;
    }

    let amount = toU64(params.amount, { name: "amount" });
    // UX: allow empty/0 to mean "withdraw all".
    if (amount <= 0n) amount = reward;
    if (amount <= 0n) throw new Error("No rewards available to withdraw");

    let tx = state.bookkeeper.as(profile).withdraw(amount);
    const gas = normalizeGas(params.gas);
    if (gas) tx = tx.gas(gas);

    const result = await network.execute(tx);
    return { hash: result.hash, nonce: result.nonce };
  }

  if (kind === TX_KIND.CONTRACT_CALL) {
    if ("memo" in params && params.memo) {
      throw new Error("Contract calls cannot include a memo payload");
    }

    const privacy = String(params.privacy ?? "public").trim().toLowerCase();
    const isShielded = privacy === "shielded";
    if (privacy !== "public" && privacy !== "shielded") {
      throw new Error("Invalid privacy: expected \"public\" or \"shielded\"");
    }

    const contractIdBytes = toContractIdBytes(params.contractId);
    const fnName = String(params.fnName ?? "").trim();
    if (!fnName) throw new Error("fnName is required");
    if (fnName.length > 64) throw new Error("fnName too long (max 64 chars)");

    const fnArgsBytes = toBytes(params.fnArgs);
    if (fnArgsBytes.length > 64 * 1024) {
      throw new Error("fnArgs too large (max 64KB)");
    }

    // Contract calls target a contract id (not an account/address). Internally we
    // still route the call via a transfer tx, so we choose a deterministic
    // self-recipient based on the requested privacy.
    const to = params.to
      ? String(params.to)
      : isShielded
      ? profile.address.toString()
      : profile.account.toString();

    const toType = ProfileGenerator.typeOf(to);
    if (isShielded && toType !== "address") {
      throw new Error("Shielded contract_call requires a shielded recipient (base58 address)");
    }
    if (!isShielded && toType !== "account") {
      throw new Error("Public contract_call requires a public recipient (base58 account)");
    }

    // Shielded contract calls spend from the local note cache (Phoenix tx).
    // If the cache is empty, fail fast and trigger a background sync.
    if (isShielded) {
      await ensureShieldedMetaForIndex(idx);
      try {
        const netKey = getNetworkKey();
        const walletId = getWalletId();

        if (walletId) {
          const n = await countNotes(netKey, walletId, idx);
          if (!n) {
            startShieldedSync({ force: false }).catch(() => {});
            throw new Error(
              "Shielded wallet is still syncing. Please wait for shielded sync to complete before calling contracts privately."
            );
          }
        }
      } catch (e) {
        const msg = e?.message ? String(e.message) : String(e);
        if (msg.includes("Shielded wallet is still syncing")) throw e;
      }
    }

    const amount = toU64(params.amount, { name: "amount" });
    const deposit = toU64(params.deposit, { name: "deposit" });

    // NOTE: W3sper / protocol-driver uses 'payload' either as memo OR contract call data.
    const payload = Object.freeze({
      fnName,
      fnArgs: fnArgsBytes,
      contractId: Array.from(contractIdBytes),
    });

    let tx = state.bookkeeper.as(profile).transfer(amount).to(to).payload(payload);

    if (deposit > 0n) {
      tx = tx.deposit(deposit);
    }

    const gas = normalizeGas(params.gas);
    if (gas) tx = tx.gas(gas);

    // Default to obfuscated phoenix contract calls for privacy.
    if (isShielded && typeof tx?.obfuscated === "function") {
      try {
        tx.obfuscated();
      } catch {
        // ignore
      }
    }

    const result = await network.execute(tx);
    return { hash: result.hash, nonce: result.nonce };
  }

  throw new Error(`Unsupported transaction kind: ${params.kind}`);
}

// ----------------------------------------------------------------------------
// Signing (dusk_signMessage / dusk_signAuth)
// ----------------------------------------------------------------------------

function u64le(v) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(v), true);
  return out;
}

function concatBytes(chunks) {
  const parts = chunks.filter(Boolean);
  const total = parts.reduce((n, b) => n + b.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const b of parts) {
    out.set(b, o);
    o += b.byteLength;
  }
  return out;
}

function extractMoonlightSignature(txBytes) {
  const buf = txBytes instanceof Uint8Array ? txBytes : new Uint8Array(txBytes || []);
  if (buf.length < 1 + 8) throw new Error("Invalid signed buffer");
  const variant = buf[0];
  if (variant !== 1) {
    // dusk_core::transfer::Transaction enum: 1 => Moonlight
    throw new Error("Expected a Moonlight signature payload");
  }
  let off = 1;
  const payloadLen = Number(new DataView(buf.buffer, buf.byteOffset + off, 8).getBigUint64(0, true));
  off += 8;
  if (payloadLen < 0 || off + payloadLen > buf.length) throw new Error("Invalid Moonlight payload length");
  off += payloadLen;
  const sig = buf.slice(off);
  if (sig.length < 32) throw new Error("Invalid Moonlight signature length");
  return sig;
}

async function signMemoAsMoonlight(profile, memoText) {
  await ensureProtocolDriverLoaded();

  const memoBytes = new TextEncoder().encode(String(memoText ?? ""));
  if (memoBytes.length > 512) {
    throw new Error(`Signing message too large (max 512 bytes, got ${memoBytes.length})`);
  }

  // Build a deterministic Moonlight tx locally and extract its signature.
  // We intentionally use "dummy" fields so the produced signature cannot be
  // replayed as a valid on-chain transfer:
  // - nonce=0 (invalid, because on-chain nonces start at 1)
  // - chainId=0 (local)
  // - value=0, deposit=0
  // - gas limit/price kept tiny but non-zero (w3sper defaults otherwise)
  const bk =
    state.bookkeeper ??
    new Bookkeeper({
      // Should never be called because we set nonce/chain explicitly.
      account: async () => ({ nonce: 0n, value: 0n }),
      address: async () => new Map(),
      stakeInfo: async () => ({}),
    });

  let tx = bk.as(profile).transfer(0n).memo(memoText).to(profile.account.toString());
  if (typeof tx?.chain === "function") tx = tx.chain(0);
  if (typeof tx?.nonce === "function") tx = tx.nonce(-1n); // build() adds +1 => 0
  tx = tx.gas({ limit: 1n, price: 1n });

  const built = await tx.build();
  const txBytes = built?.buffer;
  const sigBytes = extractMoonlightSignature(txBytes);

  // Return the canonical signature-message bytes (what is actually signed).
  const signingPayload = concatBytes([
    Uint8Array.from([0]), // chain_id
    profile.account.valueOf(),
    u64le(0n), // value
    u64le(0n), // deposit
    u64le(1n), // gas_limit
    u64le(1n), // gas_price
    u64le(0n), // nonce
    memoBytes, // TransactionData::Memo bytes
  ]);

  return {
    account: profile.account.toString(),
    memo: memoText,
    signature: `0x${bytesToHex(sigBytes)}`,
    payload: `0x${bytesToHex(signingPayload)}`,
  };
}

/**
 * Sign an arbitrary message (bytes) for off-chain use.
 *
 * NOTE:
 * The wallet signs a domain-separated envelope that includes a SHA-256 hash of
 * the provided message bytes (not the full message), so large messages do not
 * inflate the on-chain memo format size.
 *
 * @param {{ origin: string, chainId: string, message: any }} params
 * @returns {Promise<{account:string, origin:string, chainId:string, messageHash:string, messageLen:number, signature:string, payload:string}>}
 */
export async function signMessage(params) {
  if (!state.unlocked) throw new Error("Wallet locked");
  if (!params || typeof params !== "object") throw new Error("Invalid params: object required");

  const origin = String(params.origin ?? "").trim();
  const chainId = String(params.chainId ?? "").trim();
  if (!origin) throw new Error("origin is required");
  if (!chainId) throw new Error("chainId is required");

  const messageBytes = toBytes(params.message);
  const messageLen = messageBytes.length;
  const messageHash = await sha256Hex(messageBytes);

  const profile = await ensureProfileIndex(params.profileIndex ?? state.currentIndex);
  const memo = [
    "Dusk Connect SignMessage v1",
    `Origin: ${origin}`,
    `Chain ID: ${chainId}`,
    `Account: ${profile.account.toString()}`,
    `Message Hash: 0x${messageHash}`,
    `Message Len: ${messageLen}`,
  ].join("\n");

  const signed = await signMemoAsMoonlight(profile, memo);
  return Object.freeze({
    account: signed.account,
    origin,
    chainId,
    messageHash: `0x${messageHash}`,
    messageLen,
    signature: signed.signature,
    payload: signed.payload,
  });
}

/**
 * Sign a canonical login/auth envelope.
 *
 * @param {{ origin: string, chainId: string, nonce: string, statement?: string, expiresAt?: string }} params
 * @returns {Promise<{account:string, origin:string, chainId:string, nonce:string, issuedAt:string, expiresAt:string, message:string, signature:string, payload:string}>}
 */
export async function signAuth(params) {
  if (!state.unlocked) throw new Error("Wallet locked");
  if (!params || typeof params !== "object") throw new Error("Invalid params: object required");

  const origin = String(params.origin ?? "").trim();
  const chainId = String(params.chainId ?? "").trim();
  const nonce = String(params.nonce ?? "").trim();
  const statement = params.statement != null ? String(params.statement).trim() : "";

  if (!origin) throw new Error("origin is required");
  if (!chainId) throw new Error("chainId is required");
  if (!nonce) throw new Error("nonce is required");
  if (nonce.length > 128) throw new Error("nonce too long");
  if (statement.length > 280) throw new Error("statement too long (max 280 chars)");

  const issuedAt = new Date().toISOString();
  let expiresAt = "";
  if (params.expiresAt != null && String(params.expiresAt).trim()) {
    const t = Date.parse(String(params.expiresAt));
    if (!Number.isFinite(t)) throw new Error("expiresAt must be an ISO timestamp");
    expiresAt = new Date(t).toISOString();
  } else {
    expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  }

  const profile = await ensureProfileIndex(params.profileIndex ?? state.currentIndex);
  const lines = [
    "Dusk Connect SignAuth v1",
    `Account: ${profile.account.toString()}`,
    statement ? `Statement: ${statement}` : null,
    `URI: ${origin}`,
    `Chain ID: ${chainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Expiration Time: ${expiresAt}`,
  ].filter(Boolean);
  const message = lines.join("\n");

  const signed = await signMemoAsMoonlight(profile, message);
  return Object.freeze({
    account: signed.account,
    origin,
    chainId,
    nonce,
    issuedAt,
    expiresAt,
    message,
    signature: signed.signature,
    payload: signed.payload,
  });
}

/**
 * Wait until a transaction becomes EXECUTED according to the node.
 *
 * @param {string} hash
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<any>} The executed event payload.
 */
export async function waitTxExecuted(hash, opts = {}) {
  if (!hash || typeof hash !== "string") {
    throw new Error("hash is required");
  }

  const timeoutMs = Number(opts.timeoutMs ?? 120_000);
  const network = await ensureNetwork();

  // w3sper provides a tx watcher interface.
  const txs = network?.transactions;
  const withId = txs?.withId?.bind(txs);
  if (!withId) {
    throw new Error("Transaction watcher not available on this Network instance");
  }

  const handle = withId(hash);
  const once = handle?.once;
  const executed = once?.executed?.bind(once);
  if (!executed) {
    throw new Error("Transaction executed watcher not available");
  }

  return await withTimeout(
    Promise.resolve(executed()),
    timeoutMs,
    `Timed out waiting for transaction execution (${hash.slice(0, 12)}…)`
  );
}
