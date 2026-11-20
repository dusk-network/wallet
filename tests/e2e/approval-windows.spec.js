import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { dataDrivers } from "@dusk/w3sper";

// Renderer-only checks of the site approval windows at the size the wallet
// opens them: the real notification page and styles, with the background's
// answers stubbed, but for a token call, which the wallet's engine reads with
// its own drivers. No vault, keys, node or transactions.
const fixtures = JSON.parse(readFileSync(new URL("../../src/shared/fixtures/duskevm-bridge-calls.json", import.meta.url), "utf8"));
// A call to a DRC20 standard token, as the standard's driver writes it for a site.
const standard = dataDrivers
  .load(new Uint8Array(readFileSync(new URL("../../public/drivers/drc20_standard_data_driver.wasm", import.meta.url))))
  .then((driver) => (driver.init(), driver));
const standardCall = async (fnName, json) => `0x${Buffer.from((await standard).encodeInputFn(fnName, json)).toString("hex")}`;
const shell = readFileSync(new URL("../../public/notification.html", import.meta.url), "utf8")
  .replace(/href="(ui|notification)\.css"/g, 'href="/$1.css"')
  .replace(/src="icons\//g, 'src="/icons/')
  .replace(/<script type="module" src="notification.js"><\/script>/, "");

const ALICE = "qxwSidLBa1rJ74ngfP4GUCaNsAYjMboDPHzbmiVEMmNNK26hVkYe8QccH6ipYdVRsUDnx9QS1KBeu8ZoMDFpXJJE6YCcHy2AykvJ7eEAGc7PGDgCZFV5YJBxzukADkQ2Bgr";
const SHOP = "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";
const TESTNET = "https://testnet.nodes.dusk.network";
const pendingFor = (kind, params, over = {}) => ({
  rid: "r1",
  kind,
  origin: "https://shop.example",
  params,
  nodeUrl: TESTNET,
  networkName: "Testnet",
  hasVault: true,
  isUnlocked: true,
  accounts: [ALICE],
  addresses: ["addr0"],
  accountCount: 1,
  selectedAccountIndex: 0,
  accountNames: {},
  duskNames: { [ALICE]: "alice.dusk" },
  contacts: [{ name: "WB shop", address: SHOP }],
  permissionAccountIndex: 0,
  ...over,
});
const pay = { kind: "transfer", privacy: "public", to: SHOP, amount: "1000000000", memo: "Order 1042", gas: { limit: "2500000", price: "1" }, chainId: "dusk:2", nodeUrl: TESTNET, networkName: "Testnet" };

// `held`: the page's clock stopped before the window draws, for the test to move.
async function open(page, pending, { held = false } = {}) {
  await page.setViewportSize({ width: 380, height: 590 });
  if (held) await page.clock.install();
  await page.route("**/approval-window?rid=r1", (route) => route.fulfill({ contentType: "text/html", body: shell }));
  await page.goto("/approval-window?rid=r1");
  if (held) await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
  await page.evaluate(async (pending) => {
    window.decisions = [];
    window.browser = {
      runtime: {
        sendMessage: async (msg) => {
          if (msg.type === "DUSK_GET_PENDING") return pending;
          if (msg.type === "DUSK_PENDING_DECISION") window.decisions.push(msg);
          if (msg.type === "DUSK_UI_RECIPIENT_NAME") return { ok: true, result: "wallet-both.dusk" };
          if (msg.type === "DUSK_UI_DRC20_DECODE_INPUT") {
            const { decodeDrc20Input } = await import("/src/shared/walletEngine.js");
            return { ok: true, result: await decodeDrc20Input(msg) };
          }
          if (msg.type === "DUSK_UI_DRC20_GET_METADATA") return { ok: true, result: { name: "Token", symbol: "TKN", decimals: 9 } };
          return { ok: true };
        },
      },
    };
    const { renderNotification } = await import("/src/ui/notification/app.js");
    await renderNotification();
  }, pending);
}

// The approval's buttons, by their place in its bar rather than their words.
const approveButton = (page) => page.locator("#approval-actions .btn-primary");
const rejectButton = (page) => page.locator("#approval-actions .btn-outline");
// The fold that holds the request's details, before any fold inside it.
const detailsFold = (page) => page.locator("details.ap-details > summary").first();

// Whether `locator` lies wholly inside the window.
async function inView(page, locator) {
  const box = await locator.boundingBox();
  const { width, height } = page.viewportSize();
  return Boolean(box) && box.y >= 0 && box.x >= 0 && box.y + box.height <= height && box.x + box.width <= width;
}

test("a payment shows its amount, recipient, fee and both buttons without scrolling, the chain under Details", async ({ page }) => {
  await open(page, pendingFor("send_tx", pay));
  await expect(page.locator(".ap-amount")).toHaveText("1 DUSK");
  await expect(page.locator(".ap-recipient__lead")).toHaveText("wallet-both.dusk");
  await expect(page.locator(".ap-recipient__tag")).toContainText("WB shop");
  for (const locator of [
    page.locator(".ap-amount"),
    page.locator(".ap-recipient__lead"),
    page.locator("dusk-gas-editor .gas-fee .kv").first(),
    rejectButton(page),
    approveButton(page),
  ]) {
    expect(await inView(page, locator)).toBe(true);
  }
  await expect(page.getByText("dusk:2", { exact: true })).toBeHidden();
  await expect(page.locator("#approval-network")).toHaveText("Testnet");

  // The buttons stay put while the page scrolls under them.
  await page.locator(".panel-content").evaluate((el) => el.scrollTo(0, el.scrollHeight));
  expect(await inView(page, approveButton(page))).toBe(true);
  await detailsFold(page).click();
  await expect(page.getByText("dusk:2", { exact: true })).toBeVisible();
  await rejectButton(page).click();
  expect(await page.evaluate(() => window.decisions.map((d) => d.decision))).toEqual(["reject"]);
});

test("what keeps Approve off is in view with it, under a long request", async ({ page }) => {
  const highFee = { ...pay, gas: { limit: "10000000", price: "50" }, feeFromSite: { limit: true, price: true } };
  await open(page, pendingFor("send_tx", highFee, { payBalance: "1000" }));
  const reason = page.locator(".pay-guard");
  await expect(reason).toContainText("1.5 DUSK");
  await expect(approveButton(page)).toBeDisabled();
  expect(await inView(page, reason)).toBe(true);
  expect(await inView(page, rejectButton(page))).toBe(true);
});

test("a Review keeps Confirm, and what stops it, in view at the popup's size as the page scrolls under it", async ({ page }) => {
  const popupShell = readFileSync(new URL("../../public/popup.html", import.meta.url), "utf8")
    .replace('href="ui.css"', 'href="/ui.css"')
    .replace(/src="icons\//g, 'src="/icons/')
    .replace(/<script type="module" src="popup.js"><\/script>/, "");
  await page.setViewportSize({ width: 380, height: 600 });
  await page.route("**/review-window", (route) => route.fulfill({ contentType: "text/html", body: popupShell }));
  await page.goto("/review-window");
  await page.evaluate(async ({ from, to }) => {
    const { sendConfirmView } = await import("/src/ui/popup/views/send.js");
    const ov = {
      isUnlocked: true,
      nodeUrl: "https://testnet.nodes.dusk.network",
      accounts: [from],
      addresses: ["addr0"],
      selectedAccountIndex: 0,
      balance: { value: "1000000000" },
      shieldedBalance: { value: "0", spendable: "0" },
    };
    const state = {
      route: "confirm",
      addressBook: { loaded: true, items: [] },
      draft: { to, privacy: "public", amountDusk: "1", amountLux: "1000000000", memo: "Order 1042 ".repeat(12) },
    };
    const actions = { send: async () => ({}), render: async () => {}, showToast: () => {}, review: {} };
    document.getElementById("app").replaceChildren(...sendConfirmView(ov, { state, actions }));
  }, { from: ALICE, to: SHOP });

  const confirm = page.locator("#app button.btn-primary");
  const reason = page.locator(".pay-guard");
  await expect(reason).toContainText("0.0025 DUSK");
  await expect(confirm).toBeDisabled();
  const scroller = page.locator(".panel-content");
  // It does go on under the fold.
  expect(await scroller.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  for (const y of ["0", "100", "el.scrollHeight"]) {
    await scroller.evaluate((el, y) => el.scrollTo(0, y === "el.scrollHeight" ? el.scrollHeight : Number(y)), y);
    expect(await inView(page, confirm), `Confirm at ${y}`).toBe(true);
    expect(await inView(page, reason), `the reason at ${y}`).toBe(true);
  }
});

test("a DuskEVM deposit shows what it does on top, and its bytes' hash under Details", async ({ page }) => {
  const deposit = fixtures.calls.find((c) => c.name === "deposit-shoot");
  await open(
    page,
    pendingFor("send_tx", {
      kind: "contract_call",
      privacy: "public",
      contractId: "0x2257e5f8ff49cf7c9704a14ca35acbf48eb7ade11a079d98d5cd5655eea1b31d",
      fnName: deposit.fnName,
      fnArgs: deposit.args,
      amount: "0",
      deposit: "100000000",
      gas: { limit: "5000000", price: "1" },
      chainId: "dusk:2",
      nodeUrl: TESTNET,
      networkName: "Testnet",
    })
  );
  await expect(page.locator(".ap-tag")).toContainText("DuskEVM");
  const recipient = page.locator(".kv-value code.ap-address");
  await expect(recipient).toHaveText(deposit.expected.to);
  for (const locator of [page.locator(".ap-amount"), page.locator(".ap-tag"), recipient]) {
    expect(await inView(page, locator)).toBe(true);
  }
  // The call data's hash, under Details.
  const callData = page.getByText(/2f64b19f5ac0/);
  await expect(callData).toBeHidden();
  await detailsFold(page).click();
  await callData.scrollIntoViewIfNeeded();
  await expect(callData).toBeVisible();
  const [recipientY, callY] = await Promise.all([recipient.boundingBox(), callData.boundingBox()]).then((boxes) => boxes.map((b) => b.y));
  expect(recipientY).toBeLessThan(callY);
});

test("a DRC20 standard transfer shows its exact amount and its recipient without scrolling", async ({ page }) => {
  await open(
    page,
    pendingFor("send_tx", {
      kind: "contract_call",
      privacy: "public",
      contractId: `0x${"11".repeat(32)}`,
      fnName: "transfer",
      fnArgs: await standardCall("transfer", `{"to":{"Moonlight":"${SHOP}"},"amount":9007199254740993}`),
      amount: "0",
      deposit: "0",
      gas: { limit: "5000000", price: "1" },
      chainId: "dusk:2",
      nodeUrl: TESTNET,
      networkName: "Testnet",
    })
  );
  await expect(page.locator(".ap-amount")).toHaveText("9,007,199.254740993 TKN");
  await expect(page.locator(".ap-recipient__lead")).toHaveText("wallet-both.dusk");
  await expect(page.locator(".ap-recipient__tag")).toContainText("WB shop");
  // Its raw units, exactly, on the page.
  await expect(page.getByText("9007199254740993", { exact: true })).toHaveCount(1);
  for (const locator of [page.locator(".ap-amount"), page.locator(".ap-recipient__lead"), approveButton(page)]) {
    expect(await inView(page, locator)).toBe(true);
  }
});

test("a gas limit under the transaction's minimum, or a price of 0, keeps Approve off, saying why", async ({ page }) => {
  await open(page, pendingFor("send_tx", pay), { held: true });
  await page.locator("details.gas-custom > summary").click();
  const approve = approveButton(page);
  const error = page.locator("dusk-gas-editor .field-error").filter({ visible: true });
  await page.getByLabel("Gas limit", { exact: true }).fill("1500000");
  await expect(error).toContainText("2,000,000");
  await expect(approve).toBeDisabled();
  await page.getByLabel("Gas limit", { exact: true }).fill("2000000");
  await page.getByLabel("Gas price (LUX)", { exact: true }).fill("0");
  await expect(error).toHaveCount(1);
  await expect(error).not.toContainText("2,000,000");
  await expect(approve).toBeDisabled();
  expect(await page.evaluate(() => window.decisions)).toEqual([]);
  await page.getByLabel("Gas price (LUX)", { exact: true }).fill("1");
  await expect(error).toHaveCount(0);
  await expect(page.locator("dusk-gas-editor .gas-max")).toContainText("0.002 DUSK");
  await page.clock.runFor(500);
  await approve.click();
  await expect.poll(() => page.evaluate(() => window.decisions.map((d) => [d.decision, d.approvedParams?.gas?.limit]))).toEqual([
    ["approve", "2000000"],
  ]);
});

test("Approve ignores a click as the window shows, where a double-click on the site lands, and takes one half a second on", async ({ page }) => {
  await open(page, pendingFor("send_tx", pay), { held: true });
  const approve = approveButton(page);
  const decisions = () => page.evaluate(() => window.decisions.map((d) => d.decision));
  // It looks as it always does meanwhile.
  await expect(approve).toBeEnabled();
  await approve.click();
  await page.clock.runFor(499);
  await approve.click();
  expect(await decisions()).toEqual([]);

  await page.clock.runFor(1);
  await approve.click();
  await expect.poll(decisions).toEqual(["approve"]);
});

test("a locked wallet shows what the site asks, with Reject beside Unlock", async ({ page }) => {
  await open(page, pendingFor("send_tx", pay, { isUnlocked: false, accounts: [], duskNames: {} }));
  await expect(page.locator(".ap-head h1")).toBeVisible();
  await expect(page.locator(".ap-amount")).toHaveText("1 DUSK");
  await expect(page.locator("#approval-password")).toBeVisible();
  const reject = rejectButton(page);
  const unlock = approveButton(page);
  const [r, u] = [await reject.boundingBox(), await unlock.boundingBox()];
  expect(Math.abs(r.y - u.y)).toBeLessThan(2);
  expect(r.x).toBeLessThan(u.x);
  expect(await inView(page, unlock)).toBe(true);
  await reject.click();
  expect(await page.evaluate(() => window.decisions.map((d) => d.decision))).toEqual(["reject"]);
});
