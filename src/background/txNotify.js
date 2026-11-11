// Simple transaction notifications for the extension.
// Uses chrome.notifications (system popup) when available.

import { getSettings } from "../shared/settings.js";
import { explorerTxUrl } from "../shared/explorer.js";
import { chainIdForNode, networkTextOf } from "../shared/nodeNetwork.js";
import { getTxMeta } from "../shared/txStore.js";
import { shortAddress } from "../ui/lib/strings.js";
import { isPhone } from "../ui/lib/device.js";
import { IS_FIREFOX } from "../platform/targets.js";
import { arrivalNotice, askForNotices, askForNoticesAgain, mayNotify, noticeAnswered, noticesState, questionGone } from "../shared/phoneNotices.js";
import { openWalletTab } from "./walletTab.js";
import {
  getExtensionApi,
  notificationsClear,
  notificationsCreate,
  runtimeGetURL,
  storageSessionGet,
  storageSessionRemove,
  storageSessionSet,
  tabsCreate,
} from "../platform/extensionApi.js";

const ICON_PATH = "icons/dusk-128.png";

let handlersInstalled = false;
const ext = getExtensionApi();

const notifies = () => Boolean(ext?.notifications);

// On a phone, Firefox for Android asks Android for leave to show a notice as
// its first one is made, again after a no. So there the wallet makes none by
// itself: the person taps Tell me when it arrives on Sent, its first notice is
// that question (askPhoneNotices), and what Firefox then does with it says
// whether a payment's arrival shows (registerTxNotificationHandlers,
// phoneNotices.js). Nothing on a phone says a send went out: Sent does.
const ASK_NOTICE = "dusk_notices_asked";

// Firefox's question: the notice that asks Android, saying what comes of it.
const askNotice = () =>
  notificationsCreate(ASK_NOTICE, {
    type: "basic",
    iconUrl: runtimeGetURL(ICON_PATH),
    title: "Dusk Wallet",
    message: "You'll get a notice when your payment arrives, while the wallet stays open.",
  });

/**
 * Tell me when it arrives, tapped on a phone: Firefox asks Android, once; with
 * `again`, after a no, the person's Ask again.
 * @param {{ again?: boolean }} [opts]
 */
export function askPhoneNotices({ again = false } = {}) {
  return again ? askForNoticesAgain(askNotice) : askForNotices(askNotice);
}

// Arrivals that came while Firefox's question was on screen, kept for its
// answer in the browser's session: the background that heard them may be
// gone by then, and a new one hear the answer.
const LATER = "dusk_notices_later";

async function keptForLater() {
  const later = (await storageSessionGet(LATER).catch(() => ({})))?.[LATER];
  return Array.isArray(later) ? later : [];
}

async function takeLater() {
  const later = await keptForLater();
  await storageSessionRemove(LATER).catch(() => {});
  return later;
}

const keepForLater = async (arrival) => storageSessionSet({ [LATER]: [...(await keptForLater()), arrival] });

const mayShow = (arrival) => (isPhone() ? mayNotify(undefined, () => keepForLater(arrival)) : Promise.resolve(true));

// Firefox's answer kept: what waited for it shows with a yes, and goes with a no.
function answered(answer) {
  noticeAnswered(answer, takeLater)
    .then((later) => {
      if (answer === "on") for (const arrival of later) notifyTxExecuted(arrival).catch(() => {});
    })
    .catch(() => {});
}

// Each send's outcome is said once, however many ways the wallet learns it.
const told = new Set();

// The node and network a transaction was sent on, as its record keeps them
// (txRecord.js), for its notice and explorer link after a switch and a
// worker restart too; else the wallet's node, as its settings name it.
async function sentOn(hash, nodeUrl) {
  // The settings first, always: they name the wallet's node's network, in a worker just woken too.
  const settings = await getSettings();
  const meta = hash ? await getTxMeta(hash).catch(() => null) : null;
  const url = String(nodeUrl || meta?.nodeUrl || settings?.nodeUrl || "");
  return { nodeUrl: url, chainId: Number.isInteger(meta?.chainId) ? meta.chainId : chainIdForNode(url) };
}

export function registerTxNotificationHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;

  try {
    if (!notifies()) return;

    // On a phone, Firefox's word on the notice that asked (askPhoneNotices):
    // it showed, so Android let it; or it went without showing, as Firefox
    // takes it away after a no. Gone once shown, it was swiped away.
    ext.notifications.onShown?.addListener((id) => {
      if (id === ASK_NOTICE) answered("on");
    });
    ext.notifications.onClosed?.addListener((id) => {
      if (id === ASK_NOTICE) answered("off");
    });
    // Firefox started anew: a question asked in the one before went with it.
    ext.runtime?.onStartup?.addListener(() => {
      questionGone().catch(() => {});
    });

    // Clicking the notification opens the explorer (when possible), otherwise
    // falls back to the wallet full view. On a phone it opens the transaction
    // in the wallet, where its notice said only what came of it.
    ext.notifications.onClicked?.addListener(async (notificationId) => {
      try {
        const id = String(notificationId ?? "");
        if (!id.startsWith("dusk_tx_")) return;

        // id format: dusk_tx_<hash>_<status>_<timestamp>
        const parts = id.split("_");
        const hash = parts?.[2] ?? "";
        const status = parts?.[3] ?? "";

        if (hash && isPhone()) {
          openWalletTab(`full.html?route=tx&hash=${encodeURIComponent(hash)}`).catch(() => {});
          return;
        }

        if (hash && (status === "executed" || status === "failed")) {
          const { nodeUrl, chainId } = await sentOn(hash);
          const url = explorerTxUrl(nodeUrl, hash, chainId);
          if (url) {
            tabsCreate({ url }).catch(() => {});
            return;
          }
        }

        openWalletTab(`full.html?route=home${hash ? `&tx=${encodeURIComponent(hash)}` : ""}`).catch(() => {});
      } catch {
        // ignore
      }
    });

    // Optional buttons: 0 => explorer, 1 => open wallet.
    ext.notifications.onButtonClicked?.addListener(
      async (notificationId, buttonIndex) => {
        try {
          const id = String(notificationId ?? "");
          if (!id.startsWith("dusk_tx_")) return;

          // id format: dusk_tx_<hash>_<status>_<timestamp>
          const parts = id.split("_");
          const hash = parts?.[2] ?? "";
          const status = parts?.[3] ?? "";

          const { nodeUrl, chainId } = await sentOn(hash);

          if (buttonIndex === 0 && (status === "executed" || status === "failed")) {
            const url = explorerTxUrl(nodeUrl, hash, chainId);
            if (url) {
              tabsCreate({ url }).catch(() => {});
              return;
            }
          }

          // Fallback: open wallet dashboard so the user can see the tx.
          openWalletTab(`full.html?route=home${hash ? `&tx=${encodeURIComponent(hash)}` : ""}`).catch(() => {});
        } catch {
          // ignore
        }
      },
    );
  } catch {
    // ignore
  }
}

/**
 * Show a system notification for a submitted transaction.
 *
 * @param {{hash?: string, origin?: string, title?: string, nodeUrl?: string}} args
 */
export async function notifyTxSubmitted({ hash, origin, title, nodeUrl } = {}) {
  try {
    if (!notifies() || isPhone()) return;

    const sent = await sentOn(hash, nodeUrl);
    const networkName = sent.nodeUrl ? networkTextOf(sent.nodeUrl) : "";

    const msgLines = [];
    const sh = shortAddress(hash);
    if (sh) msgLines.push(`Tx: ${sh}`);
    if (networkName) msgLines.push(`Network: ${networkName}`);

    /** @type {chrome.notifications.NotificationOptions<true>} */
    const opts = {
      type: "basic",
      iconUrl: runtimeGetURL(ICON_PATH),
      title: title || "Transaction submitted",
      message: msgLines.length ? msgLines.join("\n") : "Transaction submitted",
    };

    if (origin) {
      // Shows smaller grey text below the main message on some platforms.
      // @ts-ignore - contextMessage exists for basic notifications in Chrome.
      opts.contextMessage = `From: ${origin}`;
    }

    const id = `dusk_tx_${hash}_submitted_${Date.now()}`;

    await notificationsCreate(id, opts);
  } catch {
    // ignore
  }
}

/**
 * Show a system notification for an executed transaction.
 *
 * @param {{hash?: string, origin?: string, ok?: boolean, error?: string, nodeUrl?: string}} args
 */
export async function notifyTxExecuted({
  hash,
  origin,
  ok = true,
  error,
  nodeUrl,
} = {}) {
  try {
    if (!notifies() || !hash) return;
    // Told as it shows: learned another way meanwhile, it waits its turn and finds it told.
    const outcome = `${hash}:${ok ? "executed" : "failed"}`;
    if (told.has(outcome) || !(await mayShow({ hash, origin, ok, error, nodeUrl })) || told.has(outcome)) return;
    told.add(outcome);

    const sent = await sentOn(hash, nodeUrl);
    const networkName = sent.nodeUrl ? networkTextOf(sent.nodeUrl) : "";
    const explorerUrl = explorerTxUrl(sent.nodeUrl, hash, sent.chainId);
    const id = `dusk_tx_${hash}_${ok ? "executed" : "failed"}_${Date.now()}`;

    // A phone's lock screen shows what came of it, never the amount or whom
    // it was for; its tap opens the transaction in the wallet.
    if (isPhone()) {
      const { title, network } = arrivalNotice({ kind: (await getTxMeta(hash).catch(() => null))?.kind, ok, nodeUrl: sent.nodeUrl });
      await notificationsCreate(id, { type: "basic", iconUrl: runtimeGetURL(ICON_PATH), title, message: network ? `Dusk Wallet · ${network}` : "Dusk Wallet" });
      // The arrival takes the place of the notice that asked, once that showed.
      if ((await noticesState()) === "on") await notificationsClear(ASK_NOTICE).catch(() => {});
      return;
    }

    const msgLines = [];
    const sh = shortAddress(hash);
    if (sh) msgLines.push(`Tx: ${sh}`);
    if (networkName) msgLines.push(`Network: ${networkName}`);
    if (!ok && error) msgLines.push(`Error: ${String(error).slice(0, 120)}`);

    /** @type {chrome.notifications.NotificationOptions<true>} */
    const opts = {
      type: "basic",
      iconUrl: runtimeGetURL(ICON_PATH),
      title: ok ? "Transaction executed" : "Transaction failed",
      message: msgLines.length ? msgLines.join("\n") : ok ? "Transaction executed" : "Transaction failed",
    };

    if (origin) {
      // @ts-ignore
      opts.contextMessage = `From: ${origin}`;
    }

    // Buttons are optional, but if we have an explorer URL it's a huge UX win.
    // Firefox has none, and refuses a notice that asks for them: there the
    // notice itself opens the explorer.
    if (!IS_FIREFOX) {
      // @ts-ignore
      opts.buttons = explorerUrl ? [{ title: "View in Explorer" }, { title: "Open Wallet" }] : [{ title: "Open Wallet" }];
    }

    await notificationsCreate(id, opts);
  } catch {
    // ignore
  }
}
