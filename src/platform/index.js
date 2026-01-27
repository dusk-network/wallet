import { getRuntimeKind, isExtensionRuntime, isTauriRuntime } from "./runtime.js";
import { kv } from "./storage.js";
import { assetUrl } from "./assets.js";

const kind = getRuntimeKind();

/**
 * Open a URL in a new tab or window.
 * Handles chrome.tabs.create for extensions, falls back to window.open.
 * @param {string} url
 * @returns {Promise<boolean>} true if opened successfully
 */
export async function openUrl(url) {
  if (!url) return false;
  try {
    if (typeof chrome !== "undefined" && chrome?.tabs?.create) {
      await chrome.tabs.create({ url });
      return true;
    }
  } catch {
    // ignore
  }
  try {
    window.open(url, "_blank", "noopener,noreferrer");
    return true;
  } catch {
    // ignore
  }
  return false;
}

// Capabilities help the UI decide which features to show.
// For now: dApp injection/connection only exists in the extension.
export const platform = {
  kind,
  isExtension: isExtensionRuntime(),
  isTauri: isTauriRuntime(),

  capabilities: Object.freeze({
    dapp: kind === "extension",
  }),

  kv,
  assetUrl,
};
