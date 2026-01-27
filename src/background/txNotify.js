// Simple transaction notifications for the extension.
// Uses chrome.notifications (system popup) when available.

import { getSettings } from "../shared/settings.js";
import { networkNameFromNodeUrl } from "../shared/network.js";
import { explorerTxUrl } from "../shared/explorer.js";
import { getTxMeta } from "../shared/txStore.js";
import { shortHash } from "../ui/lib/strings.js";

const ICON_PATH = "icons/dusk-128.png";

let handlersInstalled = false;

export function registerTxNotificationHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;

  try {
    if (!chrome?.notifications) return;

    // Clicking the notification opens the explorer (when possible), otherwise
    // falls back to the wallet full view.
    chrome.notifications.onClicked.addListener(async (notificationId) => {
      try {
        const id = String(notificationId ?? "");
        if (!id.startsWith("dusk_tx_")) return;

        // id format: dusk_tx_<hash>_<status>_<timestamp>
        const parts = id.split("_");
        const hash = parts?.[2] ?? "";
        const status = parts?.[3] ?? "";

        if (hash && (status === "executed" || status === "failed")) {
          const meta = await getTxMeta(hash);
          const nodeUrl = meta?.nodeUrl ?? (await getSettings())?.nodeUrl ?? "";
          const url = explorerTxUrl(nodeUrl, hash);
          if (url) {
            chrome.tabs.create({ url });
            return;
          }
        }

        const walletUrl = chrome.runtime.getURL(
          `full.html?route=activity${hash ? `&tx=${encodeURIComponent(hash)}` : ""}`
        );
        chrome.tabs.create({ url: walletUrl });
      } catch {
        // ignore
      }
    });

    // Optional buttons: 0 => explorer, 1 => open wallet.
    chrome.notifications.onButtonClicked.addListener(
      async (notificationId, buttonIndex) => {
        try {
          const id = String(notificationId ?? "");
          if (!id.startsWith("dusk_tx_")) return;

          // id format: dusk_tx_<hash>_<status>_<timestamp>
          const parts = id.split("_");
          const hash = parts?.[2] ?? "";
          const status = parts?.[3] ?? "";

          const meta = await getTxMeta(hash);
          const nodeUrl = meta?.nodeUrl ?? (await getSettings())?.nodeUrl ?? "";

          if (buttonIndex === 0 && (status === "executed" || status === "failed")) {
            const url = explorerTxUrl(nodeUrl, hash);
            if (url) {
              chrome.tabs.create({ url });
              return;
            }
          }

          // Fallback: open wallet (activity) so the user can see the tx.
          const walletUrl = chrome.runtime.getURL(
            `full.html?route=activity${hash ? `&tx=${encodeURIComponent(hash)}` : ""}`
          );
          chrome.tabs.create({ url: walletUrl });
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
    if (!chrome?.notifications) return;

    const resolvedNodeUrl =
      nodeUrl ?? (await getSettings())?.nodeUrl ?? "";

    const networkName = networkNameFromNodeUrl(resolvedNodeUrl);

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

    const id = `dusk_tx_${hash}_submitted_${Date.now()}`;

    chrome.notifications.create(id, opts, () => {
      // ignore
    });
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
    if (!chrome?.notifications) return;
    if (!hash) return;

    const resolvedNodeUrl =
      nodeUrl ?? (await getSettings())?.nodeUrl ?? "";

    const networkName = networkNameFromNodeUrl(resolvedNodeUrl);
    const explorerUrl = explorerTxUrl(resolvedNodeUrl, hash);

    const msgLines = [];
    const sh = shortHash(hash);
    if (sh) msgLines.push(`Tx: ${sh}`);
    if (networkName) msgLines.push(`Network: ${networkName}`);
    if (!ok && error) msgLines.push(`Error: ${String(error).slice(0, 120)}`);

    /** @type {chrome.notifications.NotificationOptions<true>} */
    const opts = {
      type: "basic",
      iconUrl: chrome.runtime.getURL(ICON_PATH),
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

    chrome.notifications.create(id, opts, () => {
      // ignore
    });
  } catch {
    // ignore
  }
}
