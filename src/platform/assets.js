import { isExtensionRuntime } from "./runtime.js";

/**
 * Return a URL that can be used with fetch() to load a bundled static asset.
 *
 * - In the extension, we must use chrome.runtime.getURL
 * - In Tauri/web, assets in /public are served from the web root
 *
 * @param {string} path
 */
export function assetUrl(path) {
  const p = String(path || "").replace(/^\/+/, "");

  if (isExtensionRuntime()) {
    try {
      if (chrome?.runtime?.getURL) return chrome.runtime.getURL(p);
    } catch {
      // ignore
    }
  }

  // Web / Tauri: Vite serves `public/` at the root.
  try {
    if (typeof window !== "undefined" && window.location) {
      return new URL(`/${p}`, window.location.origin).toString();
    }
  } catch {
    // ignore
  }

  // Last resort
  return `/${p}`;
}
