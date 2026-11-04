import { getExtensionApi } from "../../platform/extensionApi.js";
import { storage, STORAGE_KEYS } from "../../shared/storage.js";
import { send } from "../../wallet/bus.js";

/**
 * An update can leave the worker of the version before running under the new
 * pages: Chrome keeps it when the new version loads at browser start, and the
 * wallet then can't unlock. A reload starts the right one, once per version,
 * so a worker that stays old can't keep closing the page.
 *
 * @returns {Promise<boolean>} whether the extension is reloading
 */
export async function reloadOldWorker({ api = getExtensionApi(), ask = send, kv = storage } = {}) {
  if (!api?.runtime?.reload) return false;

  const version = api.runtime.getManifest().version;
  const reply = await ask({ type: "DUSK_UI_WORKER_VERSION" });
  // A worker from before this question doesn't know it. No answer says nothing.
  const old = reply?.error === "Unknown message" || (reply?.ok === true && reply.version !== version);

  if (!old) return false;

  const key = STORAGE_KEYS.WORKER_RELOAD;

  if ((await kv.get(key))?.[key] === version) return false;

  await kv.set({ [key]: version });
  api.runtime.reload();

  return true;
}
