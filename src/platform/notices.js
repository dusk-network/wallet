// Arrival notices in the app on Android (apps/tauri, android/NoticesPlugin.kt):
// Android's question for leave to show them, a payment's notice, the sends
// Android looks for once the app leaves the screen (android/ArrivalJob.kt),
// and the transaction a notice's tap opened the app on. Where there's no app,
// there are none, and each answer says so.

import { isTauriRuntime } from "./runtime.js";

async function ask(action, args = {}) {
  if (!isTauriRuntime()) return { allowed: false };
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const answer = await invoke("notices", { action, args });
    return answer && typeof answer === "object" ? answer : { allowed: false };
  } catch {
    return { allowed: false };
  }
}

/** Whether a notice would show. */
export const appNoticesAllowed = async () => (await ask("status")).allowed === true;

/** Android's question, for the person who tapped Tell me when it arrives: "on" or "off". */
export const askAppNotices = async () => ((await ask("ask")).allowed === true ? "on" : "off");

/**
 * A notice on the phone, once for its transaction; tapping it opens the
 * wallet on that transaction.
 * @param {{ title: string, body: string, hash?: string }} notice
 */
export const showAppNotice = async ({ title, body, hash = "" }) =>
  (await ask("notify", { title: String(title ?? ""), body: String(body ?? ""), hash: String(hash ?? "") })).allowed === true;

/**
 * A send for Android to look for once the app leaves the screen, and the
 * notice it shows when it's in a block, for either outcome.
 * @param {{ hash: string, nodeUrl: string, title: string, failTitle: string, body: string }} send
 */
export const watchAppArrival = async ({ hash, nodeUrl, title, failTitle, body }) =>
  (await ask("watch", { hash: String(hash ?? ""), nodeUrl: String(nodeUrl ?? ""), title: String(title ?? ""), failTitle: String(failTitle ?? ""), body: String(body ?? "") })).allowed === true;

/**
 * A send whose outcome the wallet heard: Android doesn't look for it any more.
 * @param {string} hash
 */
export const settleAppArrival = async (hash) => {
  await ask("settled", { hash: String(hash ?? "") });
};

/** The transaction a notice's tap opened the app on, once: "" for none. */
export const openedFromNotice = async () => {
  const hash = (await ask("opened")).hash;
  return typeof hash === "string" ? hash : "";
};
