// Offscreen engine bridge.
// Splits out the offscreen-document lifecycle + message retries from background/index.

import { getSettings } from "../shared/settings.js";
import { ERROR_CODES, rpcError } from "../shared/errors.js";
import {
  getExtensionApi,
  offscreenCreateDocument,
  runtimeGetContexts,
  runtimeGetURL,
  runtimeSendMessage,
} from "../platform/extensionApi.js";

const OFFSCREEN_PATH = "offscreen.html";

/**
 * Prevent multiple concurrent createDocument() calls.
 * @type {Promise<void> | null}
 */
let offscreenCreating = null;

/**
 * Cache the last config we pushed into the engine.
 * @type {{ nodeUrl: string, proverUrl?: string, archiverUrl?: string } | null}
 */
let lastEngineConfig = null;

let engineMsgSeq = 0;
const ext = getExtensionApi();

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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

export async function engineCall(method, params) {
  await ensureOffscreenDocument();

  const id = `${Date.now()}_${++engineMsgSeq}`;
  const payload = { type: "DUSK_ENGINE_CALL", id, method, params };

  // Right after createDocument(), the offscreen page can be in the middle of loading.
  // A short retry loop makes this much less flaky.
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const resp = await runtimeSendMessage(payload);

      if (!resp) throw new Error("No response from offscreen engine");
      if (resp.error) throw resp.error;
      return resp.result;
    } catch (e) {
      lastErr = e;
      const msg = e?.message ?? String(e);

      // Common transient errors while the offscreen doc is starting.
      const transient =
        msg.includes("Receiving end does not exist") ||
        msg.includes("Could not establish connection") ||
        msg.includes("The message port closed") ||
        msg.includes("Promised response from onMessage listener went out of scope");

      const canRetry =
        transient && attempt < 4 && String(method) !== "dusk_sendTransaction";

      if (canRetry) {
        await delay(50 * (attempt + 1));
        continue;
      }

      throw e;
    }
  }

  throw lastErr ?? new Error("Engine call failed");
}

export function invalidateEngineConfig() {
  lastEngineConfig = null;
}

export async function ensureEngineConfigured() {
  const settings = await getSettings();
  const nodeUrl = settings?.nodeUrl;
  if (!nodeUrl) return;

  const proverUrl = settings?.proverUrl;
  const archiverUrl = settings?.archiverUrl;

  const next = { nodeUrl, proverUrl, archiverUrl };

  if (
    !lastEngineConfig ||
    lastEngineConfig.nodeUrl !== next.nodeUrl ||
    lastEngineConfig.proverUrl !== next.proverUrl ||
    lastEngineConfig.archiverUrl !== next.archiverUrl
  ) {
    lastEngineConfig = next;
    await engineCall("engine_config", next);
  }
}

export async function getEngineStatus() {
  try {
    const status = await engineCall("engine_status");
    return {
      isUnlocked: Boolean(status?.isUnlocked),
      accounts: Array.isArray(status?.accounts) ? status.accounts : [],
    };
  } catch {
    return { isUnlocked: false, accounts: [] };
  }
}
