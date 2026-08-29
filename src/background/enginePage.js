// Engine page bridge for Firefox.
//
// Firefox MV3 does not support chrome.offscreen. We host the wallet engine
// inside a hidden extension page (engine.html) and communicate via runtime
// messages (same protocol as offscreen).

import { ERROR_CODES, rpcError } from "../shared/errors.js";
import {
  getExtensionApi,
  runtimeGetURL,
  runtimeSendMessage,
  tabsCreate,
  tabsGet,
  tabsHide,
  tabsQuery,
} from "../platform/extensionApi.js";
import { createEngineBridge } from "./engineBridge.js";

const ENGINE_PAGE_PATH = "engine.html";

/**
 * Prevent multiple concurrent engine page creations.
 * @type {Promise<void> | null}
 */
let engineCreating = null;

let engineTabId = null;
let engineHostGeneration = 0;
const ext = getExtensionApi();
let engineReady = false;
let engineReadyPromise = null;
let engineReadyResolve = null;
let engineReadyError = null;

async function hideEngineTab(tabId) {
  if (tabId == null) return;
  try {
    if (ext?.tabs?.hide) {
      await tabsHide([tabId]);
    }
  } catch {
    // ignore
  }
}

async function findExistingEngineTab() {
  const url = runtimeGetURL(ENGINE_PAGE_PATH);
  if (!url) return null;
  try {
    const tabs = await tabsQuery({ url: [url] });
    if (Array.isArray(tabs) && tabs.length) return tabs[0];
  } catch {
    // ignore
  }
  return null;
}

async function ensureEnginePage(transportOnly = false) {
  if (engineTabId != null) {
    try {
      await tabsGet(engineTabId);
    } catch {
      engineTabId = null;
    }
  }

  if (engineTabId == null && !engineCreating) {
    engineCreating = (async () => {
      const existing = await findExistingEngineTab();
      if (existing?.id != null) {
        engineTabId = existing.id;
      } else {
        const url = runtimeGetURL(ENGINE_PAGE_PATH);
        if (!url) {
          throw rpcError(ERROR_CODES.INTERNAL, "Engine page URL not available");
        }
        const tab = await tabsCreate({ url, active: false });
        engineTabId = tab?.id ?? null;
      }

      engineReady = false;
      engineReadyError = null;
      engineReadyPromise = null;
      await hideEngineTab(engineTabId);
      engineHostGeneration += 1;
    })();
  }

  if (engineCreating) {
    try {
      await engineCreating;
    } finally {
      engineCreating = null;
    }
  }

  await (transportOnly ? waitForEngineTransport() : waitForEngineReady());
  return engineHostGeneration;
}

if (ext?.tabs?.onRemoved) {
  try {
    ext.tabs.onRemoved.addListener((tabId) => {
      if (tabId === engineTabId) {
        engineTabId = null;
        engineReady = false;
        engineReadyError = null;
        engineReadyPromise = null;
      }
    });
  } catch {
    // ignore
  }
}

async function waitForEngineTransport() {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await withTimeout(
        runtimeSendMessage({ type: "DUSK_ENGINE_PING" }),
        1000
      );
      if (response?.ok) return;
    } catch {
      // The tab may still be loading.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Engine page did not start in time");
}

function waitForEngineReady(timeoutMs = 120_000) {
  if (engineReady) return Promise.resolve();

  if (!engineReadyPromise) {
    engineReadyPromise = new Promise((resolve) => {
      engineReadyResolve = resolve;
    });
  }

  if (engineTabId != null) {
    withTimeout(runtimeSendMessage({ type: "DUSK_ENGINE_PING" }), 2000).then(
      (resp) => {
        if (resp?.ready || resp?.error) {
          handleEngineReady({
            type: "DUSK_ENGINE_READY",
            ok: Boolean(resp.ready) && !resp.error,
            error: resp.error ?? "",
          });
        }
      },
      () => {}
    );
  }

  if (!timeoutMs) return engineReadyPromise;

  return Promise.race([
    engineReadyPromise,
    new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error("Engine page did not become ready in time"));
      }, timeoutMs);
    }),
  ]);
}

export function handleEngineReady(message) {
  if (message?.type === "DUSK_ENGINE_READY" && engineReady) {
    engineHostGeneration += 1;
  }
  engineReady = true;
  if (message?.ok === false) {
    engineReadyError = new Error(
      message.error || "Engine preload failed"
    );
  }
  if (engineReadyResolve) {
    engineReadyResolve();
    engineReadyResolve = null;
  }
}

function withTimeout(promise, timeoutMs, label = "Engine call timed out") {
  if (!timeoutMs) return promise;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(label)), timeoutMs);
    }),
  ]);
}

const bridge = createEngineBridge({
  ensureHost: async (method) => {
    const transportOnly = method === "engine_status" || method === "engine_lock";
    const hostGeneration = await ensureEnginePage(transportOnly);
    if (engineReadyError && !transportOnly) throw engineReadyError;
    return hostGeneration;
  },
  noResponseMessage: "No response from engine page",
});

export const {
  engineCall,
  ensureEngineConfigured,
  getEngineStatus,
  getEngineStatusStrict,
  invalidateEngineConfig,
} = bridge;
