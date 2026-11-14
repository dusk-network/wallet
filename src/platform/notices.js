// Arrival notices in the app on Android (apps/tauri, android/NoticesPlugin.kt):
// Android's question for leave to show them, a payment's notice, the sends
// Android looks for once the app leaves the screen (android/ArrivalJob.kt),
// the accounts it looks at for money coming in, and the transaction a
// notice's tap opened the app on. Where there's no app, there are none, and
// each answer says so.

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
 * wallet on that transaction, which the tap shows by its send's `token`. A
 * locked phone that hides what notices say shows `publicBody` for `body`.
 * @param {{ title: string, body: string, publicBody?: string, hash?: string, token?: string }} notice
 */
export const showAppNotice = async ({ title, body, publicBody = "", hash = "", token = "" }) =>
  (
    await ask("notify", {
      title: String(title ?? ""),
      body: String(body ?? ""),
      publicBody: String(publicBody ?? ""),
      hash: String(hash ?? ""),
      token: String(token ?? ""),
    })
  ).allowed === true;

/**
 * A send for Android to look for once the app leaves the screen, and the
 * notice it shows when it's in a block, for either outcome (`publicBody` on
 * a locked phone that hides what notices say); `wallet`, the wallet it's
 * from, whose removal forgets it; `token`, its notice's, which the notice's
 * tap brings back.
 * @param {{ hash: string, nodeUrl: string, title: string, failTitle: string, body: string, publicBody?: string, wallet?: string, token?: string }} send
 */
export const watchAppArrival = async ({ hash, nodeUrl, title, failTitle, body, publicBody = "", wallet = "", token = "" }) =>
  (
    await ask("watch", {
      hash: String(hash ?? ""),
      nodeUrl: String(nodeUrl ?? ""),
      title: String(title ?? ""),
      failTitle: String(failTitle ?? ""),
      body: String(body ?? ""),
      publicBody: String(publicBody ?? ""),
      wallet: String(wallet ?? ""),
      token: String(token ?? ""),
    })
  ).allowed === true;

/**
 * The accounts Android looks at for money coming in, about every 15 minutes
 * while the app is away (android/ArrivalJob.kt's Incoming), with the notice's
 * words and what it may name: public data only. Null for none: it stops
 * looking.
 * @param {{ accounts: { account: string, name: string }[], names: Record<string, string>, archiveUrl: string, network: string, title: string, publicTitle: string, wallet: string, token: string, decimal: string, group: string } | null} setup
 */
export const watchAppIncoming = async (setup) => {
  await ask("incoming", { setup: setup ? JSON.stringify(setup) : "" });
};

/**
 * A wallet removed: Android looks for none of its sends any more, and tells
 * none it was looking for. "" for every wallet's, on a reset or a restore.
 * Never fails.
 * @param {string} [wallet]
 */
export const forgetAppArrivals = async (wallet = "") => {
  await ask("forget", { wallet: String(wallet ?? "") });
};

/**
 * A send whose outcome the wallet heard: Android doesn't look for it any more.
 * @param {string} hash
 */
export const settleAppArrival = async (hash) => {
  await ask("settled", { hash: String(hash ?? "") });
};

/**
 * The transaction a notice's tap opened the app on, once, with what its
 * notice knew of it: `status` "executed" or "failed", or "" where it didn't
 * say, and its block; the `token` the tap carried; and for money that came
 * in, the `account` it came to. Any app can open the wallet with these: none
 * of it is the notice's till the token is checked against its send's, or
 * the wallet's for money coming in (DUSK_UI_TX_NOTICED); `ours`, Android
 * checked it as one of the app's notices carried it. `hash` "" for none.
 * @returns {Promise<{ hash: string, token: string, status: "" | "executed" | "failed", blockHeight: string, account: string, ours: boolean }>}
 */
export const openedFromNotice = async () => {
  const { hash, outcome, block, token, account, ours } = await ask("opened");
  return {
    hash: typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash) ? hash : "",
    token: typeof token === "string" && /^[0-9a-f]{32}$/.test(token) ? token : "",
    status: outcome === "executed" || outcome === "failed" ? outcome : "",
    blockHeight: /^[1-9]\d*$/.test(String(block ?? "")) ? String(block) : "",
    account: typeof account === "string" && /^[1-9A-HJ-NP-Za-km-z]{40,200}$/.test(account) ? account : "",
    ours: ours === true,
  };
};
