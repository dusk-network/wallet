import { storage, STORAGE_KEYS } from "./storage.js";
import { NETWORK_PRESETS } from "./networkPresets.js";
import { detectPresetIdFromNodeUrl } from "./network.js";
import { MAX_ACCOUNT_COUNT } from "./constants.js";

/**
 * Auto-lock timeout options in minutes.
 * 0 = disabled.
 */
export const AUTO_LOCK_OPTIONS = [
  { value: 0, label: "Off" },
  { value: 1, label: "1 minute" },
  { value: 5, label: "5 minutes" },
  { value: 15, label: "15 minutes" },
  { value: 30, label: "30 minutes" },
  { value: 60, label: "1 hour" },
];

export const DEFAULT_SETTINGS = {
  // Default to Testnet.
  nodeUrl: "https://testnet.nodes.dusk.network",
  proverUrl: "https://testnet.provers.dusk.network",
  archiverUrl: "https://testnet.nodes.dusk.network",
  /** Auto-lock timeout in minutes (0 = disabled) */
  autoLockTimeoutMinutes: 5,
  /** Number of derived accounts (public + shielded keypairs) */
  accountCount: 1,
  /** Selected account index for the wallet UI */
  selectedAccountIndex: 0,
  /** Whether the wallet may fetch remote NFT metadata/images (privacy toggle). */
  nftMetadataEnabled: true,
  /** IPFS gateway base used to resolve ipfs:// token URIs. */
  ipfsGateway: "https://ipfs.io/ipfs/",
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
  let accountCount = Number(merged.accountCount ?? 1);
  if (!Number.isFinite(accountCount) || accountCount < 1) accountCount = 1;
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
    nftMetadataEnabled: merged.nftMetadataEnabled !== false,
    ipfsGateway: normalizeIpfsGateway(merged.ipfsGateway),
  };
}

/**
 * @param {Partial<typeof DEFAULT_SETTINGS>} patch
 */
export async function setSettings(patch) {
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
    let n = Number(next.accountCount ?? 1);
    if (!Number.isFinite(n) || n < 1) n = 1;
    next.accountCount = Math.min(Math.floor(n), MAX_ACCOUNT_COUNT);
  }
  if ("selectedAccountIndex" in patch || "accountCount" in patch) {
    let n = Number(next.selectedAccountIndex ?? 0);
    if (!Number.isFinite(n) || n < 0) n = 0;
    const maxIdx = Math.max(0, Number(next.accountCount ?? 1) - 1);
    next.selectedAccountIndex = Math.min(Math.floor(n), maxIdx);
  }

  if ("nftMetadataEnabled" in patch) {
    next.nftMetadataEnabled = patch.nftMetadataEnabled !== false;
  }

  await storage.set({ [STORAGE_KEYS.SETTINGS]: next });
  return next;
}
