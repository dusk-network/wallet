// Engine page bridge for Firefox.
//
// Firefox MV3 does not support chrome.offscreen. We host the wallet engine
// inside a hidden extension page (engine.html) and communicate via runtime
// messages (same protocol as offscreen).

import { getSettings } from "../shared/settings.js";
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

const ENGINE_PAGE_PATH = "engine.html";

/**
 * Prevent multiple concurrent engine page creations.
 * @type {Promise<void> | null}
 */
let engineCreating = null;

/**
 * Cache the last config we pushed into the engine.
 * @type {{ nodeUrl: string, proverUrl?: string, archiverUrl?: string } | null}
 */
let lastEngineConfig = null;

let engineMsgSeq = 0;
let engineTabId = null;
const ext = getExtensionApi();
let engineReady = false;
let engineReadyPromise = null;
let engineReadyResolve = null;
let engineReadyError = null;

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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

async function ensureEnginePage() {
  if (engineCreating) {
    await engineCreating;
    return;
  }

  if (engineTabId != null) {
    try {
      await tabsGet(engineTabId);
      if (!engineReady) {
        await waitForEngineReady();
      }
      return;
    } catch {
      engineTabId = null;
    }
  }

  const existing = await findExistingEngineTab();
  if (existing?.id != null) {
    engineTabId = existing.id;
    engineReady = false;
    engineReadyError = null;
    engineReadyPromise = null;
    await hideEngineTab(engineTabId);
    await waitForEngineReady();
    return;
  }

  engineCreating = (async () => {
    const url = runtimeGetURL(ENGINE_PAGE_PATH);
    if (!url) {
      throw rpcError(ERROR_CODES.INTERNAL, "Engine page URL not available");
    }

    const tab = await tabsCreate({ url, active: false });
    engineTabId = tab?.id ?? null;
    engineReady = false;
    engineReadyError = null;
    engineReadyPromise = null;
    await hideEngineTab(engineTabId);
    await waitForEngineReady();
  })();

  try {
    await engineCreating;
  } finally {
    engineCreating = null;
  }
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
        if (resp?.ready) handleEngineReady(resp);
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

export async function engineCall(method, params, options = {}) {
  await ensureEnginePage();
  if (engineReadyError) {
    throw engineReadyError;
  }

  const id = `${Date.now()}_${++engineMsgSeq}`;
  const payload = { type: "DUSK_ENGINE_CALL", id, method, params };
  const timeoutMs = Number(options?.timeoutMs || 0);

  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const resp = await withTimeout(runtimeSendMessage(payload), timeoutMs);

      if (!resp) throw new Error("No response from engine page");
      if (resp.error) throw resp.error;
      return resp.result;
    } catch (e) {
      lastErr = e;
      const msg = e?.message ?? String(e);

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
