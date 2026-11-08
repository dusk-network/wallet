import { test, expect, devices } from "@playwright/test";

// The popup as Firefox for Android shows it: a page of its own on a phone,
// 412 CSS px wide. Renderer-only: no vault, keys, node or transactions.
const { defaultBrowserType, ...pixel } = devices["Pixel 7"];
void defaultBrowserType;
test.use(pixel);

const ACCOUNT =
  "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927";
const TO =
  "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";

async function popupOn(page, route, extra = {}) {
  await page.route("**/phone/popup.html", (r) => r.fulfill({
    contentType: "text/html",
    body: '<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover"><link rel="stylesheet" href="/ui.css"><body class="page--popup"><div class="panel"><header class="panel-header"><button id="network-pill"><span class="network-pill__label"></span></button><div id="header-actions"></div></header><main class="panel-content"><div id="app"></div></main></div></body>',
  }));
  await page.route("**/src/wallet/localBus.js*", (r) => r.fulfill({
    contentType: "text/javascript",
    body: "export const localSend = message => window.testSend(message);",
  }));
  // Nothing goes to a node.
  await page.route(/nodes\.dusk\.network/, (r) => r.abort());
  await page.goto("/phone/popup.html");
  await page.evaluate(async ({ route, extra, ACCOUNT }) => {
    window.browser = {
      runtime: { id: "renderer-test", sendMessage: (m) => window.testSend(m), onMessage: { addListener() {} } },
      tabs: { query: async () => [] },
    };
    window.testSend = async (message) => {
      if (message.type === "DUSK_UI_OVERVIEW") {
        return {
          hasVault: true, isUnlocked: true, networkName: "Testnet", nodeUrl: "https://testnet.nodes.dusk.network",
          accounts: [ACCOUNT], addresses: [], selectedAccountIndex: 0, accountCount: 1, txs: [],
          balance: { value: "740900000" }, shieldedBalance: { value: "0", spendable: "0" },
        };
      }
      if (message.type === "DUSK_UI_GET_CACHED_GAS_PRICE") return { ok: true, result: { min: "1", median: "1", max: "1" } };
      return { ok: true, result: null };
    };
    const { state } = await import("/src/ui/popup/state.js");
    Object.assign(state, { route, addressBook: { ...state.addressBook, loaded: true, items: [] }, ...extra });
    const { render } = await import("/src/ui/popup/app.js");
    await render();
  }, { route, extra, ACCOUNT });
}

test("fills the phone's width, as Chen and Marek's popup didn't", async ({ page }) => {
  await popupOn(page, "home");
  await expect(page.locator(".balance-split")).toBeVisible();
  const [panel, width] = await page.evaluate(() => [document.querySelector(".panel").getBoundingClientRect().width, window.innerWidth]);
  expect(panel).toBe(width);
});

test("shows Send's recipient whole, start to end, rather than its end alone", async ({ page }) => {
  await popupOn(page, "send", { draft: { to: TO, privacy: "public", amountDusk: "", memo: "" } });
  const to = page.locator(".to-input-wrap textarea");
  await expect(to).toHaveValue(TO);
  const box = await to.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight, wide: el.scrollWidth - el.clientWidth, line: parseFloat(getComputedStyle(el).lineHeight) }));
  // On more than one line, with nothing of it out of view.
  expect(box.client).toBeGreaterThan(box.line * 2);
  expect(box.scroll).toBeLessThanOrEqual(box.client + 1);
  expect(box.wide).toBeLessThanOrEqual(0);
  // Enter goes on to the amount, never a line break.
  await to.focus();
  await to.press("Enter");
  await expect(to).toHaveValue(TO);
});
