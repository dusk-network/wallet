// Extension API adapter.
//
// Normalizes Chrome (callback-based) and Firefox (Promise-based) WebExtension
// APIs behind small helpers so we can keep the rest of the codebase consistent.

const raw =
  typeof globalThis !== "undefined"
    ? globalThis.browser ?? globalThis.chrome ?? null
    : null;

const isPromiseApi =
  typeof globalThis !== "undefined" &&
  raw != null &&
  raw === globalThis.browser;

function callApi(fn, args = [], thisArg, { allowLastError = false } = {}) {
  if (!fn) {
    return Promise.reject(new Error("Extension API unavailable"));
  }

  if (isPromiseApi) {
    try {
      return Promise.resolve(fn.apply(thisArg ?? raw, args));
    } catch (err) {
      return Promise.reject(err);
    }
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(result);
    };

    try {
      const result = fn.apply(thisArg ?? raw, [
        ...args,
        (cbResult) => {
          const err = raw?.runtime?.lastError;
          if (err && !allowLastError) {
            finish(err);
            return;
          }
          finish(null, cbResult);
        },
      ]);

      if (result && typeof result.then === "function") {
        result.then(
          (value) => finish(null, value),
          (err) => finish(err)
        );
      }
    } catch (err) {
      finish(err);
    }
  });
}

export function getExtensionApi() {
  return raw;
}

export function isExtensionApiAvailable() {
  return Boolean(raw?.runtime?.id);
}

export function runtimeGetURL(path) {
  try {
    return raw?.runtime?.getURL
      ? raw.runtime.getURL(String(path ?? ""))
      : "";
  } catch {
    return "";
  }
}

export function runtimeSendMessage(message, options) {
  return callApi(raw?.runtime?.sendMessage, [message], raw?.runtime, options);
}

export function runtimeGetContexts(options) {
  return callApi(raw?.runtime?.getContexts, [options], raw?.runtime);
}

export function runtimeConnect(options) {
  try {
    return raw?.runtime?.connect ? raw.runtime.connect(options) : null;
  } catch {
    return null;
  }
}

export function tabsCreate(options) {
  return callApi(raw?.tabs?.create, [options], raw?.tabs);
}

export function tabsQuery(options) {
  return callApi(raw?.tabs?.query, [options], raw?.tabs);
}

export function tabsGet(tabId) {
  return callApi(raw?.tabs?.get, [tabId], raw?.tabs);
}

export function tabsHide(tabIds) {
  return callApi(raw?.tabs?.hide, [tabIds], raw?.tabs);
}

export function windowsCreate(options) {
  return callApi(raw?.windows?.create, [options], raw?.windows);
}

export function alarmsClear(name) {
  if (!raw?.alarms?.clear) return Promise.resolve(false);
  return callApi(raw.alarms.clear, [name], raw.alarms);
}

export function notificationsCreate(id, options) {
  return callApi(raw?.notifications?.create, [id, options], raw?.notifications);
}

export function storageLocalGet(keys) {
  return callApi(raw?.storage?.local?.get, [keys ?? null], raw?.storage?.local);
}

export function storageLocalSet(items) {
  return callApi(raw?.storage?.local?.set, [items], raw?.storage?.local);
}

export function storageLocalRemove(keys) {
  return callApi(raw?.storage?.local?.remove, [keys], raw?.storage?.local);
}

export function storageLocalClear() {
  return callApi(raw?.storage?.local?.clear, [], raw?.storage?.local);
}

export function offscreenCreateDocument(options) {
  return callApi(raw?.offscreen?.createDocument, [options], raw?.offscreen);
}
