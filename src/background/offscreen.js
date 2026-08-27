// Offscreen engine bridge.
// Splits out the offscreen-document lifecycle + message retries from background/index.

import { ERROR_CODES, rpcError } from "../shared/errors.js";
import {
  getExtensionApi,
  offscreenCreateDocument,
  runtimeGetContexts,
  runtimeGetURL,
} from "../platform/extensionApi.js";
import { createEngineBridge } from "./engineBridge.js";

const OFFSCREEN_PATH = "offscreen.html";

/**
 * Prevent multiple concurrent createDocument() calls.
 * @type {Promise<void> | null}
 */
let offscreenCreating = null;

const ext = getExtensionApi();

async function hasOffscreenDocument() {
  const offscreenUrl = runtimeGetURL(OFFSCREEN_PATH);

  // Chrome 114+ has runtime.getContexts() which can detect OFFSCREEN_DOCUMENT.
  try {
    const contexts = await runtimeGetContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [offscreenUrl],
    });
    return Array.isArray(contexts) && contexts.length > 0;
  } catch {
    // ignore and fall back
  }

  // Fallback for older Chrome versions: use Service Worker Clients API.
  // (Not perfect, but works in practice)
  try {
    const matchedClients = await clients.matchAll({
      type: "window",
      includeUncontrolled: true,
    });
    return matchedClients.some((c) => c.url === offscreenUrl);
  } catch {
    return false;
  }
}

async function ensureOffscreenDocument() {
  if (!ext?.offscreen?.createDocument) {
    throw rpcError(
      ERROR_CODES.UNSUPPORTED,
      "chrome.offscreen API is not available. Use Chrome/Chromium 109+ (MV3)."
    );
  }

  if (await hasOffscreenDocument()) return;

  if (offscreenCreating) {
    await offscreenCreating;
    return;
  }

  offscreenCreating = (async () => {
    await offscreenCreateDocument({
      url: OFFSCREEN_PATH,
      reasons: ["BLOBS"],
      justification:
        "Run Dusk wallet engine that requires Blob URLs (URL.createObjectURL) for sandbox worker.",
    });
  })();

  try {
    await offscreenCreating;
  } finally {
    offscreenCreating = null;
  }
}

const bridge = createEngineBridge({
  ensureHost: ensureOffscreenDocument,
  noResponseMessage: "No response from offscreen engine",
});

export const {
  engineCall,
  ensureEngineConfigured,
  getEngineStatus,
  invalidateEngineConfig,
} = bridge;
