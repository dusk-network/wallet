import { storage, STORAGE_KEYS } from "./storage.js";
import { withStorageLock } from "./storageLock.js";
import { NETWORK_PRESETS } from "./networkPresets.js";
import { detectPresetIdFromNodeUrl } from "./network.js";
import { MAX_ACCOUNT_COUNT } from "./constants.js";

/**
 * Auto-lock timeout options in minutes, 0 for off. One minute is too short
 * to finish a send, and more than 15 leaves the wallet open too long.
 */
export const AUTO_LOCK_OPTIONS = [
  { value: 5, label: "5 minutes" },
  { value: 15, label: "15 minutes" },
  { value: 0, label: "Off" },
];

/** Auto-lock's default: 15 minutes. */
export const DEFAULT_AUTO_LOCK_MINUTES = 15;

/**
 * A stored auto-lock timeout as the wallet uses it: off, at most 15 minutes,
 * and 5 for the 1 minute that was an option once. A shorter time a test
 * stores directly stays as it is; Settings can't choose one.
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeAutoLock(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_AUTO_LOCK_MINUTES;
  if (n <= 0) return 0;
  if (n === 1) return 5;
  return Math.min(n, 15);
}

/**
 * Custom gas from Settings, a gas limit and price used on every Review, or
 * null for the network's gas price and each transaction's own limit.
 * @param {unknown} value
 * @returns {{ limit: string, price: string } | null}
 */
export function normalizeCustomGas(value) {
  const limit = String(value?.limit ?? "").trim();
  const price = String(value?.price ?? "").trim();
  if (!/^\d+$/.test(limit) || !/^\d+$/.test(price) || BigInt(limit) <= 0n || BigInt(price) <= 0n) return null;
  return { limit, price };
}

export const DEFAULT_SETTINGS = {
  // Default to Mainnet.
  nodeUrl: "https://nodes.dusk.network",
  proverUrl: "https://provers.dusk.network",
  archiverUrl: "https://nodes.dusk.network",
  /** Auto-lock timeout in minutes (0 = disabled) */
  autoLockTimeoutMinutes: DEFAULT_AUTO_LOCK_MINUTES,
  /** A gas limit and price for every Review, or null for the network's price */
  customGas: null,
  /** Number of derived accounts (public + shielded keypairs) */
  accountCount: 2,
  /** Selected account index for the wallet UI */
  selectedAccountIndex: 0,
  /**
   * Direct NFT metadata/media fetching is temporarily disabled.
   *
   * Security rationale: arbitrary tokenURI fetches leak wallet activity to
   * attacker-controlled hosts. Re-enable only once metadata is served through
   * a trusted proxy/indexer or an audited allowlisted fetch path.
   */
  nftMetadataEnabled: false,
  /** IPFS gateway base used to resolve ipfs:// token URIs. */
  ipfsGateway: "https://ipfs.io/ipfs/",
  /** Show balances as •••• until the dashboard's eye button is pressed again. */
  hideBalances: false,
};

function normalizeBaseUrl(v) {
  const s = String(v ?? "").trim();
  if (!s) return "";

  // Normalize to a stable base URL (origin only).
  try {
    return new URL(s).origin;
  } catch {
    // If it's not a full URL (missing scheme), still normalize trailing slashes.
    return s.replace(/\/+$/, "");
  }
}

function normalizeIpfsGateway(v) {
  const s = String(v ?? "").trim();
  if (!s) return DEFAULT_SETTINGS.ipfsGateway;
  try {
    const u = new URL(s);
    const base = u.toString();
    if (base.includes("/ipfs/")) return base.endsWith("/") ? base : `${base}/`;
    return `${u.origin}/ipfs/`;
  } catch {
    return DEFAULT_SETTINGS.ipfsGateway;
  }
}

function inferEndpointsFromNodeUrl(nodeUrl) {
  const presetId = detectPresetIdFromNodeUrl(nodeUrl);
  const preset = NETWORK_PRESETS.find((p) => p.id === presetId) ?? null;

  if (preset && presetId !== "custom") {
    return {
      proverUrl: preset.proverUrl || nodeUrl,
      archiverUrl: preset.archiverUrl || nodeUrl,
    };
  }

  // Custom: assume all services share the same base URL.
  return { proverUrl: nodeUrl, archiverUrl: nodeUrl };
}

export async function getSettings() {
  const items = await storage.get(STORAGE_KEYS.SETTINGS);
  const raw = items[STORAGE_KEYS.SETTINGS] ?? {};

  // Merge defaults first.
  const merged = { ...DEFAULT_SETTINGS, ...raw };

  // Normalize base URLs.
  const nodeUrl = normalizeBaseUrl(merged.nodeUrl);
  let proverUrl = normalizeBaseUrl(merged.proverUrl);
  let archiverUrl = normalizeBaseUrl(merged.archiverUrl);

  // If prover/archiver aren't explicitly set, infer them from the nodeUrl preset.
  if (!proverUrl) {
    proverUrl = inferEndpointsFromNodeUrl(nodeUrl).proverUrl;
  }
  if (!archiverUrl) {
    archiverUrl = inferEndpointsFromNodeUrl(nodeUrl).archiverUrl;
  }

  // Account settings
  let accountCount = Number(merged.accountCount ?? DEFAULT_SETTINGS.accountCount);
  if (!Number.isFinite(accountCount) || accountCount < DEFAULT_SETTINGS.accountCount) {
    accountCount = DEFAULT_SETTINGS.accountCount;
  }
  accountCount = Math.floor(accountCount);
  accountCount = Math.min(accountCount, MAX_ACCOUNT_COUNT);

  let selectedAccountIndex = Number(merged.selectedAccountIndex ?? 0);
  if (!Number.isFinite(selectedAccountIndex) || selectedAccountIndex < 0) {
    selectedAccountIndex = 0;
  }
  selectedAccountIndex = Math.min(Math.floor(selectedAccountIndex), Math.max(0, accountCount - 1));

  return {
    ...merged,
    nodeUrl,
    proverUrl,
    archiverUrl,
    accountCount,
    selectedAccountIndex,
    // Intentionally force this off for now. Older installs may still have
    // `true` in storage from before the security hardening pass.
    nftMetadataEnabled: false,
    ipfsGateway: normalizeIpfsGateway(merged.ipfsGateway),
    hideBalances: merged.hideBalances === true,
    autoLockTimeoutMinutes: normalizeAutoLock(merged.autoLockTimeoutMinutes),
    customGas: normalizeCustomGas(merged.customGas),
  };
}

/**
 * @param {Partial<typeof DEFAULT_SETTINGS>} patch
 */
async function setSettingsUnlocked(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };

  // Normalize whenever we write.
  if ("nodeUrl" in patch) {
    next.nodeUrl = normalizeBaseUrl(next.nodeUrl);
  }
  if ("proverUrl" in patch) {
    next.proverUrl = normalizeBaseUrl(next.proverUrl);
  }
  if ("archiverUrl" in patch) {
    next.archiverUrl = normalizeBaseUrl(next.archiverUrl);
  }
  if ("ipfsGateway" in patch) {
    next.ipfsGateway = normalizeIpfsGateway(next.ipfsGateway);
  }

  // If nodeUrl changed but prover/archiver weren't provided, infer them.
  if ("nodeUrl" in patch) {
    const inferred = inferEndpointsFromNodeUrl(next.nodeUrl);

    if (!("proverUrl" in patch) && (!next.proverUrl || next.proverUrl === current.proverUrl)) {
      next.proverUrl = normalizeBaseUrl(inferred.proverUrl);
    }
    if (
      !("archiverUrl" in patch) &&
      (!next.archiverUrl || next.archiverUrl === current.archiverUrl)
    ) {
      next.archiverUrl = normalizeBaseUrl(inferred.archiverUrl);
    }
  }

  // Clamp account settings on write as well (avoid persisting invalid values).
  if ("accountCount" in patch) {
    let n = Number(next.accountCount ?? DEFAULT_SETTINGS.accountCount);
    if (!Number.isFinite(n) || n < DEFAULT_SETTINGS.accountCount) {
      n = DEFAULT_SETTINGS.accountCount;
    }
    next.accountCount = Math.min(Math.floor(n), MAX_ACCOUNT_COUNT);
  }
  if ("selectedAccountIndex" in patch || "accountCount" in patch) {
    let n = Number(next.selectedAccountIndex ?? 0);
    if (!Number.isFinite(n) || n < 0) n = 0;
    const maxIdx = Math.max(0, Number(next.accountCount ?? 1) - 1);
    next.selectedAccountIndex = Math.min(Math.floor(n), maxIdx);
  }

  if ("nftMetadataEnabled" in patch) {
    next.nftMetadataEnabled = false;
  }

  await storage.set({ [STORAGE_KEYS.SETTINGS]: next });
  return next;
}

export function setSettings(patch) {
  return withStorageLock(STORAGE_KEYS.SETTINGS, () => setSettingsUnlocked(patch));
}
