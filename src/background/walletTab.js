// The wallet's own page in a tab, for a request link or a notice: the wallet
// tab open already, shown at the page asked for and brought to the front,
// rather than one more beside it; a new one where there's none.

import { runtimeGetURL, tabsCreate, tabsQuery, tabsUpdate } from "../platform/extensionApi.js";

// The wallet's pages a tab can hold: the full view, and the popup as Firefox for Android shows it.
const WALLET_PAGES = ["full.html", "popup.html"];

/**
 * @param {string} path - the page and its query, as "full.html?route=send"
 * @returns {Promise<{ id?: number } | null>} the tab it's in
 */
export async function openWalletTab(path) {
  const url = runtimeGetURL(path);
  const pages = WALLET_PAGES.map((page) => runtimeGetURL(page));
  const tabs = (await tabsQuery({}).catch(() => [])) ?? [];
  const open = tabs.find((tab) => pages.some((page) => String(tab?.url ?? "").startsWith(page)));
  if (open?.id !== undefined) {
    try {
      await tabsUpdate(open.id, { url, active: true });
      return open;
    } catch {
      // Gone meanwhile: a new one.
    }
  }
  return tabsCreate({ url });
}
