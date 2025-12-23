// Simple transaction notifications for the extension.
// Uses chrome.notifications (system popup) when available.

import { getSettings } from "../shared/settings.js";
import { networkNameFromNodeUrl } from "../shared/network.js";

const ICON_PATH = "icons/dusk-128.png";

let handlersInstalled = false;

function shortHash(hash) {
  const h = String(hash ?? "");
  if (!h) return "";
  if (h.length <= 18) return h;
  return h.slice(0, 10) + "…" + h.slice(-8);
}

export function registerTxNotificationHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;

  try {
    if (!chrome?.notifications) return;

    // Clicking the notification opens the wallet full view.
    chrome.notifications.onClicked.addListener((notificationId) => {
      try {
        if (!String(notificationId).startsWith("dusk_tx_")) return;
        const url = chrome.runtime.getURL("full.html");
        chrome.tabs.create({ url });
      } catch {
        // ignore
      }
    });
  } catch {
    // ignore
  }
}

/**
 * Show a system notification for a submitted transaction.
 *
 * @param {{hash?: string, origin?: string, title?: string}} args
 */
export async function notifyTxSubmitted({ hash, origin, title } = {}) {
  try {
    if (!chrome?.notifications) return;

    const settings = await getSettings();
    const networkName = networkNameFromNodeUrl(settings?.nodeUrl ?? "");

    const msgLines = [];
    const sh = shortHash(hash);
    if (sh) msgLines.push(`Tx: ${sh}`);
    if (networkName) msgLines.push(`Network: ${networkName}`);

    /** @type {chrome.notifications.NotificationOptions<true>} */
    const opts = {
      type: "basic",
      iconUrl: chrome.runtime.getURL(ICON_PATH),
      title: title || "Transaction submitted",
      message: msgLines.length ? msgLines.join("\n") : "Transaction submitted",
    };

    if (origin) {
      // Shows smaller grey text below the main message on some platforms.
      // @ts-ignore - contextMessage exists for basic notifications in Chrome.
      opts.contextMessage = `From: ${origin}`;
    }

    const id = `dusk_tx_${Date.now()}_${Math.random().toString(16).slice(2)}`;

    chrome.notifications.create(id, opts, () => {
      // ignore
    });
  } catch {
    // ignore
  }
}
