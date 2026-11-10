// Arrival notices in the app on Android (apps/tauri, android/NoticesPlugin.kt):
// Android's question for leave to show them, and a payment's notice. Where
// there's no app, there are none, and each answer says so.

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
 * A notice on the phone; tapping it opens the wallet.
 * @param {{ title: string, body: string }} notice
 */
export const showAppNotice = async ({ title, body }) => (await ask("notify", { title: String(title ?? ""), body: String(body ?? "") })).allowed === true;
