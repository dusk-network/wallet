import { storage, STORAGE_KEYS } from "./storage.js";
import { isTauriRuntime } from "../platform/runtime.js";
import {
  decryptMnemonic,
  deserializeEncryptInfo,
  encryptMnemonic,
  serializeEncryptInfo,
} from "./crypto.js";

// Tauri-only secret storage (Stronghold)
//
// - Extension/Web: encrypted vault blob stored via storage adapter
// - Tauri: mnemonic stored in a Stronghold snapshot (encrypted at rest)

const STRONGHOLD_SNAPSHOT_FILE = "dusk-wallet.hold";
const STRONGHOLD_CLIENT_PATH = "dusk-wallet";
const STRONGHOLD_STORE_KEY_MNEMONIC = "mnemonic";

const UNLOCK_BACKOFF_BASE_MS = 1_000;
const UNLOCK_BACKOFF_MAX_MS = 60_000;

const unlockGuard = {
  failures: 0,
  nextAllowedAt: 0,
};

function checkUnlockRateLimit() {
  const now = Date.now();
  if (unlockGuard.nextAllowedAt && now < unlockGuard.nextAllowedAt) {
    const waitMs = unlockGuard.nextAllowedAt - now;
    const waitSec = Math.max(1, Math.ceil(waitMs / 1000));
    throw new Error(`Too many attempts. Try again in ${waitSec}s.`);
  }
}

function recordUnlockFailure() {
  unlockGuard.failures += 1;
  const delay = Math.min(
    UNLOCK_BACKOFF_MAX_MS,
    UNLOCK_BACKOFF_BASE_MS * 2 ** (unlockGuard.failures - 1)
  );
  unlockGuard.nextAllowedAt = Date.now() + delay;
}

function resetUnlockFailures() {
  unlockGuard.failures = 0;
  unlockGuard.nextAllowedAt = 0;
}

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

async function tauriLoadClient(stronghold) {
  return await stronghold.loadClient(STRONGHOLD_CLIENT_PATH);
}

async function tauriGetOrCreateClient(stronghold) {
  try {
    return await stronghold.loadClient(STRONGHOLD_CLIENT_PATH);
  } catch {
    return await stronghold.createClient(STRONGHOLD_CLIENT_PATH);
  }
}

/**
 * Load vault metadata.
 *
 * - Extension/Web: returns the encrypted vault blob (JSON-like object)
 * - Tauri: returns a small sentinel object `{ kind: "stronghold" }`
 */
export async function loadVault() {
  const items = await storage.get(STORAGE_KEYS.VAULT);
  const v = items[STORAGE_KEYS.VAULT] ?? null;

  // In Tauri we store secrets in Stronghold but keep a tiny, non-sensitive
  // sentinel in the key-value store so the UI can detect that a vault exists
  // without needing filesystem access.
  if (isTauriRuntime()) {
    if (v && typeof v === "object" && v.kind === "stronghold") return v;

    // Fallback for older runs that created the snapshot but did not set the
    // sentinel key yet.
    const exists = await tauriVaultExists().catch(() => false);
    return exists ? { kind: "stronghold" } : null;
  }

  return v;
}

/**
 * @param {string} mnemonic
 * @param {string} password
 */
export async function createVault(mnemonic, password) {
  const m = String(mnemonic ?? "").trim();
  const p = String(password ?? "");

  if (isTauriRuntime()) {
    // Store mnemonic in Stronghold (encrypted at rest by Stronghold).
    //
    // If a snapshot already exists, the password must match, otherwise Stronghold
    // will throw with a BadFileKey error.
    let stronghold;
    try {
      stronghold = await tauriLoadStronghold(p);
    } catch (err) {
      // This can happen if the user previously created a wallet with a
      // different password (or the snapshot got corrupted).
      if (isBadFileKeyError(err)) {
        throw new Error(
          "A wallet already exists for this app, but the password does not match. Go to Settings → Reset wallet vault to replace it."
        );
      }
      throw err;
    }
    try {
      const client = await tauriGetOrCreateClient(stronghold);
      const store = client.getStore();
      const bytes = Array.from(new TextEncoder().encode(m));
      await store.insert(STRONGHOLD_STORE_KEY_MNEMONIC, bytes);
      await stronghold.save();

      // Persist a non-sensitive sentinel so the UI can detect that a vault exists
      // without needing to touch the filesystem.
      await storage.set({ [STORAGE_KEYS.VAULT]: { kind: "stronghold" } });
      return true;
    } finally {
      try {
        await stronghold.unload();
      } catch {
        // ignore
      }
    }
  }

  const enc = await encryptMnemonic(m, p);
  const serial = serializeEncryptInfo(enc);
  await storage.set({ [STORAGE_KEYS.VAULT]: serial });
  return true;
}

/**
 * @param {string} password
 * @returns {Promise<string>} mnemonic
 */
export async function unlockVault(password) {
  const p = String(password ?? "");

  if (isTauriRuntime()) {
    const exists = await tauriVaultExists().catch(() => false);
    if (!exists) {
      throw new Error("No wallet vault found. Import a mnemonic first.");
    }

    checkUnlockRateLimit();

    let stronghold;
    try {
      stronghold = await tauriLoadStronghold(p);
    } catch {
      // If a snapshot exists but loading fails, it's almost always a wrong password.
      recordUnlockFailure();
      throw new Error("Incorrect password");
    }

    try {
      let client;
      try {
        client = await tauriLoadClient(stronghold);
      } catch {
        // No client means no vault has been created yet.
        throw new Error("No wallet vault found. Import a mnemonic first.");
      }
      const store = client.getStore();
      const bytes = await store.get(STRONGHOLD_STORE_KEY_MNEMONIC);
      if (!bytes) {
        throw new Error("No wallet vault found. Import a mnemonic first.");
      }
      // store.get returns number[]
      const mnemonic = new TextDecoder().decode(new Uint8Array(bytes));
      resetUnlockFailures();
      return mnemonic;
    } finally {
      try {
        await stronghold.unload();
      } catch {
        // ignore
      }
    }
  }

  const vault = await loadVault();
  if (!vault) {
    throw new Error("No wallet vault found. Import a mnemonic first.");
  }

  // Unsupported vault formats are removed.
  if (!vault || typeof vault !== "object" || !vault.iterations) {
    await clearVault();
    throw new Error("Unsupported vault format. Please import your mnemonic again.");
  }

  const enc = deserializeEncryptInfo(vault);
  checkUnlockRateLimit();

  try {
    const mnemonic = await decryptMnemonic(enc, p);
    resetUnlockFailures();
    return mnemonic;
  } catch {
    recordUnlockFailure();
    throw new Error("Incorrect password");
  }
}

export async function clearVault() {
  if (isTauriRuntime()) {
    await tauriDeleteVaultSnapshot();
    // Also clear any previous storage key, if present from a web run.
    await storage.remove(STORAGE_KEYS.VAULT);
    return;
  }

  await storage.remove(STORAGE_KEYS.VAULT);
}
