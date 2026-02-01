// Wallet UI message bus.
//
// The popup/full UI talks to the wallet through a small "send(message)" API.
//
// - In the extension, this forwards to the background via chrome.runtime.
// - In Tauri (or plain web), this dispatches to a local in-process handler.
//
// IMPORTANT: we keep the local backend behind a dynamic import so the extension
// build can tree-shake it away.

import { isExtensionRuntime } from "../platform/runtime.js";
import { runtimeSendMessage } from "../platform/extensionApi.js";

// Set by Vite configs:
// - vite.config.js -> "extension"
// - vite.tauri.config.js -> "local"
const BACKEND =
  typeof __DUSK_BACKEND__ !== "undefined"
    ? __DUSK_BACKEND__
    : isExtensionRuntime()
      ? "extension"
      : "local";

/**
 * @param {any} message
 * @returns {Promise<any>}
 */
export async function send(message) {
  if (BACKEND === "extension") {
    // Preserve the current extension semantics: resolve with the response object
    // (including {error} fields) and do not throw on chrome.runtime.lastError.
    return runtimeSendMessage(message, { allowLastError: true });
  }

  const mod = await import("./localBus.js");
  return await mod.localSend(message);
}
