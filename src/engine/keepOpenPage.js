// The tab the wallet runs in, in Firefox (engine.html, "Keep open · Dusk
// Wallet"): on a phone it stays in the tab list, and once the wallet's own tab
// is closed it's the one left. It always offers the way back, Open the wallet,
// and says where the wallet's last payment within the hour stands, as the
// wallet's background reads it (DUSK_UI_LAST_SEND): read as the tab shows, and
// every few seconds while it does.

import { runtimeSendMessage } from "../platform/extensionApi.js";
import { openWalletTab } from "../background/walletTab.js";
import { clockText } from "../ui/lib/time.js";

/** How often the last payment is read again while the tab shows. */
export const LAST_SEND_EVERY_MS = 5_000;

/**
 * Where the last payment stands, in a sentence: "" for none.
 * @param {{ at: number, state: string } | null | undefined} last
 *   `state`: "waiting" (for the network), "unclear" (handed over without a
 *   clear answer), "not_sent", or the record's status
 */
export function lastSendText(last) {
  if (!last || !Number.isFinite(Number(last.at))) return "";
  const at = `Your payment at ${clockText(Number(last.at))}`;
  switch (last.state) {
    case "waiting":
      return `${at} hasn't gone out yet. It goes out once the network answers.`;
    case "not_sent":
      return `${at} wasn't sent.`;
    case "unclear":
      return `${at} may have gone out already. The wallet checks once the network answers.`;
    case "executed":
      return `${at} went through.`;
    case "failed":
    case "removed":
      return `${at} didn't go through.`;
    case "submitted":
    case "mempool":
    case "unknown":
      return `${at} went out and is on its way.`;
    default:
      return "";
  }
}

/**
 * Wires the tab's Open the wallet and its line on the last payment.
 * @param {Document} [doc]
 */
export function startKeepOpenPage(doc = globalThis.document) {
  const open = doc?.querySelector?.(".engine-open");
  const line = doc?.querySelector?.(".engine-last");
  if (!open || !line) return;
  open.addEventListener("click", () => {
    openWalletTab("full.html").catch(() => {});
  });
  const read = async () => {
    if (doc.visibilityState === "hidden") return;
    const res = await runtimeSendMessage({ type: "DUSK_UI_LAST_SEND" }).catch(() => null);
    const text = lastSendText(res?.result);
    line.textContent = text;
    line.hidden = !text;
  };
  read().catch(() => {});
  doc.addEventListener("visibilitychange", () => read().catch(() => {}));
  setInterval(() => read().catch(() => {}), LAST_SEND_EVERY_MS);
}
