import { storage, STORAGE_KEYS } from "./storage.js";
import { NETWORK_PRESETS } from "./networkPresets.js";
import { detectPresetIdFromNodeUrl } from "./network.js";

export const DEFAULT_SETTINGS = {
  // Default to Testnet.
  nodeUrl: "https://testnet.nodes.dusk.network",
  proverUrl: "https://testnet.provers.dusk.network",
  archiverUrl: "https://testnet.nodes.dusk.network",
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

  return {
    ...merged,
    nodeUrl,
    proverUrl,
    archiverUrl,
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

  await storage.set({ [STORAGE_KEYS.SETTINGS]: next });
  return next;
}
