// Simple transaction notifications for the extension.
// Uses chrome.notifications (system popup) when available.

import { getSettings } from "../shared/settings.js";
import { explorerTxUrl } from "../shared/explorer.js";
import { chainIdForNode, networkTextOf } from "../shared/nodeNetwork.js";
import { getTxMeta } from "../shared/txStore.js";
import { shortAddress } from "../ui/lib/strings.js";
import { isPhone } from "../ui/lib/device.js";
import { openWalletTab } from "./walletTab.js";
import {
  getExtensionApi,
  notificationsCreate,
  runtimeGetURL,
  tabsCreate,
} from "../platform/extensionApi.js";

const ICON_PATH = "icons/dusk-128.png";

let handlersInstalled = false;
const ext = getExtensionApi();

// No system notices on a phone: Firefox for Android asks Android for leave to
// show them, over the payment or approval, again after a no. The wallet's own
// screens say how a send went; a notice is asked for there, if ever.
const notifies = () => Boolean(ext?.notifications) && !isPhone();

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
    if (!notifies()) return;

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
    if (!notifies()) return;
    if (!hash) return;

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
