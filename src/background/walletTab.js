// The wallet's own page in a tab, for a request link or a notice: the wallet
// tab open already, shown at the page asked for and brought to the front,
// rather than one more beside it; a new one where there's none.

import { runtimeGetURL, tabsCreate, tabsQuery, tabsRemove, tabsUpdate, windowsGet, windowsUpdate } from "../platform/extensionApi.js";

// The wallet's pages a tab can hold: the full view, and the popup as Firefox for Android shows it.
const WALLET_PAGES = ["full.html", "popup.html"];

/**
 * @param {string} path - the page and its query, as "full.html?route=send"
 * @param {{ replacing?: number }} [opts] - a tab whose place the wallet's
 *   takes, as the web page that handed a link over: it goes once the
 *   wallet's tab shows it, and with none open, the wallet opens in it
 * @returns {Promise<{ id?: number } | null>} the tab it's in
 */
export async function openWalletTab(path, { replacing } = {}) {
  const url = runtimeGetURL(path);
  const pages = WALLET_PAGES.map((page) => runtimeGetURL(page));
  const tabs = (await tabsQuery({}).catch(() => [])) ?? [];
  const open = tabs.find((tab) => pages.some((page) => String(tab?.url ?? "").startsWith(page)));
  const replaces = Number.isInteger(replacing) ? replacing : undefined;
  if (open?.id !== undefined) {
    try {
      await tabsUpdate(open.id, { url, active: true });
      // Its window too; a window that can't come forward leaves the tab as it is.
      await frontWindow(open.windowId).catch(() => {});
      if (replaces !== undefined && replaces !== open.id) await tabsRemove(replaces).catch(() => {});
      return open;
    } catch {
      // Gone meanwhile: a new one.
    }
  }
  if (replaces !== undefined) {
    try {
      return await tabsUpdate(replaces, { url, active: true });
    } catch {
      // Gone meanwhile: a new one.
    }
  }
  return tabsCreate({ url });
}

// The tab's window to the front too, as it may be another, minimised: a
// minimised one shown again, any other as it was. A phone's browser has no windows.
async function frontWindow(windowId) {
  if (windowId === undefined) return;
  const shown = await windowsGet(windowId).catch(() => null);
  await windowsUpdate(windowId, shown?.state === "minimized" ? { focused: true, state: "normal" } : { focused: true }).catch(() => {});
}
