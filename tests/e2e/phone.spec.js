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

async function popupOn(page, route, extra = {}, over = {}) {
  await page.route("**/phone/popup.html", (r) => r.fulfill({
    contentType: "text/html",
    // The popup's shell, its top bar as popup.html has it.
    body: '<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover"><link rel="stylesheet" href="/ui.css"><body class="page--popup"><div class="panel"><header class="panel-header"><div class="brand"><div class="brand-mark" aria-hidden="true"><img class="brand-mark__glyph" src="/icons/dusk-glyph.svg" alt=""></div><button class="panel-subtitle network-pill" id="network-pill" type="button"><span class="network-pill__label"></span><span class="network-pill__chev" aria-hidden="true">▾</span></button></div><div class="header-actions" id="header-actions"></div></header><main class="panel-content"><div id="app"></div></main></div></body>',
  }));
  await page.route("**/src/wallet/localBus.js*", (r) => r.fulfill({
    contentType: "text/javascript",
    body: "export const localSend = message => window.testSend(message);",
  }));
  // Nothing goes to a node.
  await page.route(/nodes\.dusk\.network/, (r) => r.abort());
  await page.goto("/phone/popup.html");
  await page.evaluate(async ({ route, extra, over, ACCOUNT }) => {
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
          ...over,
        };
      }
      if (message.type === "DUSK_UI_GET_CACHED_GAS_PRICE") return { ok: true, result: { min: "1", median: "1", max: "1" } };
      return { ok: true, result: null };
    };
    const { state } = await import("/src/ui/popup/state.js");
    Object.assign(state, { route, addressBook: { ...state.addressBook, loaded: true, items: [] }, ...extra });
    const { render } = await import("/src/ui/popup/app.js");
    await render();
  }, { route, extra, over, ACCOUNT });
}

test("fills the phone's width, as Chen and Marek's popup didn't", async ({ page }) => {
  await popupOn(page, "home");
  await expect(page.locator(".balance-split")).toBeVisible();
  const [panel, width] = await page.evaluate(() => [document.querySelector(".panel").getBoundingClientRect().width, window.innerWidth]);
  expect(panel).toBe(width);
});

// Amélie's: the word beside the network squeezed her profile's name to "P".
test("keeps the profile's name whole while the network can't be reached, the words on a line of their own", async ({ page }) => {
  await page.setViewportSize({ width: 380, height: 600 });
  await popupOn(page, "home", {}, { networkStatus: { nodeStatus: "offline", nodeUrl: "https://testnet.nodes.dusk.network" } });
  const words = page.locator(".network-word");
  await expect(words).toHaveText("Can't reach the network");
  const name = page.locator(".account-chip .chip-text");
  await expect(name).toHaveText("Profile 1");
  // All of the name in view, none of it cut.
  expect(await name.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  // The words under the network's name, not beside it.
  const [pill, said] = [await page.locator("#network-pill").boundingBox(), await words.boundingBox()];
  expect(said.y).toBeGreaterThanOrEqual(pill.y + pill.height - 1);
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

test("gives the recovery phrase's Reveal and Copy a finger's height, as Amélie's 28 px ones weren't", async ({ page }) => {
  // A public BIP39 test phrase, never a real wallet's.
  const mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  await popupOn(page, "onboard_create_phrase", { onboard: { mode: "create", mnemonic, password: "", reveal: false } }, { hasVault: false, isUnlocked: false });
  for (const name of ["Reveal", "Copy"]) {
    const box = await page.locator(".phrase-tools button", { hasText: name }).boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
});

test("keeps a contact's address at the field's whole width, its chip on a line above it, as Sofía's squeezed into six letters wasn't", async ({ page }) => {
  await popupOn(page, "send", {
    draft: { to: TO, privacy: "public", amountDusk: "", memo: "" },
    addressBook: { loaded: true, items: [{ id: "c1", name: "Chen Studio Lumen", address: TO }] },
  });
  const chip = page.locator(".to-input-wrap .to-chip");
  await expect(chip).toContainText("Chen Studio Lumen");
  const to = page.locator(".to-input-wrap textarea");
  const box = await to.evaluate((el) => {
    const style = getComputedStyle(el);
    const field = el.getBoundingClientRect();
    return {
      textWidth: el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      fieldWidth: field.width,
      textTop: field.top + parseFloat(style.paddingTop),
      lines: Math.round((el.scrollHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) / parseFloat(style.lineHeight)),
      hidden: el.scrollHeight - el.clientHeight,
    };
  });
  const chipBox = await chip.boundingBox();
  // The chip over the text, not beside it; the address across the field, on a few lines, all of it in view.
  expect(chipBox.y + chipBox.height).toBeLessThanOrEqual(box.textTop + 1);
  expect(box.textWidth).toBeGreaterThan(box.fieldWidth * 0.8);
  expect(box.lines).toBeLessThanOrEqual(5);
  expect(box.hidden).toBeLessThanOrEqual(1);
});

// Chen's: an x between two digits drawn as a ×, by the font's contextual alternates.
test("draws addresses and amounts without the font's contextual alternates, so an x is never a ×", async ({ page }) => {
  await popupOn(page, "send", { draft: { to: TO, privacy: "public", amountDusk: "1", memo: "" } });
  for (const selector of [".to-input-wrap textarea", "input.amount-field__input"]) {
    const ligatures = await page.locator(selector).first().evaluate((el) => getComputedStyle(el).fontVariantLigatures);
    expect(ligatures).toMatch(/no-contextual|none/);
  }
});

// Where the keyboard starts when the browser says nothing of it, as Firefox's
// add-on page doesn't: the page's top half stays clear of it (keyboard.js).
const clearOfKeyboard = (page) => page.evaluate(() => document.documentElement.clientHeight / 2);

// Amélie's: Review, Back to Send, then Memo tapped first, under the keyboard with Review.
test("keeps Memo and Review above the keyboard on Send opened again from its Review", async ({ page }) => {
  await popupOn(page, "send", { draft: { to: TO, privacy: "public", amountDusk: "0.02", memo: "" } });
  await page.getByRole("button", { name: "Review" }).click();
  await expect(page.getByRole("button", { name: "Confirm" })).toBeVisible();
  await page.getByRole("button", { name: "← Back" }).click();
  const memo = page.getByLabel("Memo");
  await expect(memo).toBeVisible();
  await memo.focus();
  const top = await clearOfKeyboard(page);
  const bottom = (el) => el.evaluate((node) => node.getBoundingClientRect().bottom);
  await expect.poll(() => bottom(memo)).toBeLessThanOrEqual(top);
  expect(await bottom(page.getByRole("button", { name: "Review" }))).toBeLessThanOrEqual(top);
  expect(await memo.evaluate((node) => node.getBoundingClientRect().top)).toBeGreaterThanOrEqual(0);
});

// Chen's, Sofía's and Amélie's: the request's Amount and Memo above the keyboard, Copy request link under it.
test("keeps Copy request link above the keyboard with the request's Memo", async ({ page }) => {
  await popupOn(page, "receive", { receive: { tab: "public", requestOpen: true, amountDusk: "0.05", memo: "", context: null } });
  const memo = page.locator(".receive-request").getByLabel("Memo");
  await expect(memo).toBeVisible();
  await memo.focus();
  const top = await clearOfKeyboard(page);
  const copy = page.getByRole("button", { name: "Copy request link" });
  await expect.poll(() => copy.evaluate((node) => node.getBoundingClientRect().bottom)).toBeLessThanOrEqual(top);
  expect(await memo.evaluate((node) => node.getBoundingClientRect().top)).toBeGreaterThanOrEqual(0);
});

// Sofía's and Lena's: in landscape, Review's Confirm bar covered the address, fee and total until a scroll.
test("puts Review's Confirm after its details on a phone turned sideways, over none of them", async ({ page }) => {
  await page.setViewportSize({ width: 915, height: 412 });
  await popupOn(page, "confirm", { draft: { to: TO, privacy: "public", amountDusk: "0.01", amountLux: "10000000", memo: "Invoice 2026-115" } });
  const confirm = page.getByRole("button", { name: "Confirm" });
  await expect(confirm).toBeVisible();
  const [confirmTop, detailsBottom] = await page.evaluate(() => {
    const top = (el) => el.getBoundingClientRect().top + document.querySelector(".panel-content").scrollTop;
    const button = [...document.querySelectorAll("button")].find((b) => b.textContent === "Confirm");
    const details = [...document.querySelectorAll("#app .kv")];
    return [top(button), Math.max(...details.map((el) => top(el) + el.getBoundingClientRect().height))];
  });
  expect(confirmTop).toBeGreaterThanOrEqual(detailsBottom);
});
