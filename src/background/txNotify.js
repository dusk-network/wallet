// Simple transaction notifications for the extension.
// Uses chrome.notifications (system popup) when available.

import { getSettings } from "../shared/settings.js";
import { explorerTxUrl } from "../shared/explorer.js";
import { chainIdForNode, networkTextOf } from "../shared/nodeNetwork.js";
import { getTxMeta } from "../shared/txStore.js";
import { shortAddress } from "../ui/lib/strings.js";
import { isPhone } from "../ui/lib/device.js";
import { askForNotices, mayNotify } from "../shared/phoneNotices.js";
import { openWalletTab } from "./walletTab.js";
import {
  getExtensionApi,
  notificationsClear,
  notificationsCreate,
  notificationsGetAll,
  runtimeGetURL,
  tabsCreate,
} from "../platform/extensionApi.js";

const ICON_PATH = "icons/dusk-128.png";

let handlersInstalled = false;
const ext = getExtensionApi();

const notifies = () => Boolean(ext?.notifications);

// On a phone, Firefox for Android asks Android for leave to show a notice as
// its first one is made, again after a no. So there the wallet makes none by
// itself: the person taps Tell me when it arrives on Sent, its first notice is
// that question (askPhoneNotices), and a payment's arrival shows only once that
// notice showed (phoneNotices.js). Nothing on a phone says a send went out:
// Sent does.
const ASK_NOTICE = "dusk_notices_asked";

/** Tell me when it arrives, tapped on a phone: Firefox asks Android, once. */
export function askPhoneNotices() {
  return askForNotices(async () => {
    await notificationsCreate(ASK_NOTICE, {
      type: "basic",
      iconUrl: runtimeGetURL(ICON_PATH),
      title: "Dusk Wallet",
      message: "You'll get a notice when your payment arrives.",
    });
    return "asked";
  });
}

// Whether the notice that asked still shows: then Android let Firefox show it.
// Turned down, Firefox takes it away at once. It goes, for the arrival's.
async function askedNoticeShows() {
  const shown = Boolean((await notificationsGetAll().catch(() => ({})))?.[ASK_NOTICE]);
  if (shown) await notificationsClear(ASK_NOTICE).catch(() => {});
  return shown;
}

const mayShow = () => (isPhone() ? mayNotify(askedNoticeShows) : Promise.resolve(true));

/** A send settled: on a phone, whether notices show is settled with it, once asked. */
export async function settlePhoneNotices() {
  if (notifies() && isPhone()) await mayNotify(askedNoticeShows);
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

    // Clicking the notification opens the explorer (when possible), otherwise
    // falls back to the wallet full view.
    ext.notifications.onClicked?.addListener(async (notificationId) => {
      try {
        const id = String(notificationId ?? "");
        if (!id.startsWith("dusk_tx_")) return;

        // id format: dusk_tx_<hash>_<status>_<timestamp>
        const parts = id.split("_");
        const hash = parts?.[2] ?? "";
        const status = parts?.[3] ?? "";

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
    const outcome = `${hash}:${ok ? "executed" : "failed"}`;
    if (told.has(outcome)) return;
    told.add(outcome);
    if (!(await mayShow())) return;

    const sent = await sentOn(hash, nodeUrl);
    const networkName = sent.nodeUrl ? networkTextOf(sent.nodeUrl) : "";
    const explorerUrl = explorerTxUrl(sent.nodeUrl, hash, sent.chainId);

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
    if (explorerUrl) {
      // @ts-ignore
      opts.buttons = [{ title: "View in Explorer" }, { title: "Open Wallet" }];
    } else {
      // @ts-ignore
      opts.buttons = [{ title: "Open Wallet" }];
    }

    const id = `dusk_tx_${hash}_${ok ? "executed" : "failed"}_${Date.now()}`;

    await notificationsCreate(id, opts);
  } catch {
    // ignore
  }
}
