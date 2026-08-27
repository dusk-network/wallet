import { runtimeSendMessage } from "../platform/extensionApi.js";
import { getSettings } from "../shared/settings.js";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function isTransientMessageError(error) {
  const message = error?.message ?? String(error);
  return (
    message.includes("Receiving end does not exist") ||
    message.includes("Could not establish connection") ||
    message.includes("The message port closed") ||
    message.includes("Promised response from onMessage listener went out of scope")
  );
}

export function createEngineBridge({ ensureHost, noResponseMessage }) {
  let lastConfig = null;
  let messageSequence = 0;

  async function engineCall(method, params, options = {}) {
    await ensureHost();

    const payload = {
      type: "DUSK_ENGINE_CALL",
      id: `${Date.now()}_${++messageSequence}`,
      method,
      params,
    };
    const timeoutMs = Number(options?.timeoutMs || 0);
    let lastError = null;

    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const response = await withTimeout(runtimeSendMessage(payload), timeoutMs);
        if (!response) throw new Error(noResponseMessage);
        if (response.error) throw response.error;
        return response.result;
      } catch (error) {
        lastError = error;
        const canRetry =
          isTransientMessageError(error) &&
          attempt < 4 &&
          String(method) !== "dusk_sendTransaction";
        if (!canRetry) throw error;
        await delay(50 * (attempt + 1));
      }
    }

    throw lastError ?? new Error("Engine call failed");
  }

  function invalidateEngineConfig() {
    lastConfig = null;
  }

  async function ensureEngineConfigured() {
    const settings = await getSettings();
    if (!settings?.nodeUrl) return;

    const next = {
      nodeUrl: settings.nodeUrl,
      proverUrl: settings.proverUrl,
      archiverUrl: settings.archiverUrl,
      accountCount: settings.accountCount,
      selectedAccountIndex: settings.selectedAccountIndex,
    };
    const changed = !lastConfig || Object.keys(next).some((key) => lastConfig[key] !== next[key]);
    if (!changed) return;

    lastConfig = next;
    await engineCall("engine_config", next);
  }

  async function getEngineStatus() {
    try {
      const status = await engineCall("engine_status");
      return {
        isUnlocked: Boolean(status?.isUnlocked),
        accounts: Array.isArray(status?.accounts) ? status.accounts : [],
        addresses: Array.isArray(status?.addresses) ? status.addresses : [],
        selectedAccountIndex: Number(status?.selectedAccountIndex ?? 0) || 0,
      };
    } catch {
      return { isUnlocked: false, accounts: [], addresses: [], selectedAccountIndex: 0 };
    }
  }

  return {
    engineCall,
    ensureEngineConfigured,
    getEngineStatus,
    invalidateEngineConfig,
  };
}
