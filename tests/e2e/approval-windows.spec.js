import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";

// Renderer-only checks of the site approval windows at the size the wallet
// opens them: the real notification page and styles, with the background's
// answers stubbed. No vault, keys, node or transactions.
const fixtures = JSON.parse(readFileSync(new URL("../../src/shared/fixtures/duskevm-bridge-calls.json", import.meta.url), "utf8"));
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

async function open(page, pending) {
  await page.setViewportSize({ width: 380, height: 590 });
  await page.route("**/approval-window?rid=r1", (route) => route.fulfill({ contentType: "text/html", body: shell }));
  await page.goto("/approval-window?rid=r1");
  await page.evaluate(async (pending) => {
    window.decisions = [];
    window.browser = {
      runtime: {
        sendMessage: async (msg) => {
          if (msg.type === "DUSK_GET_PENDING") return pending;
          if (msg.type === "DUSK_PENDING_DECISION") window.decisions.push(msg);
          if (msg.type === "DUSK_UI_RECIPIENT_NAME") return { ok: true, result: "wallet-both.dusk" };
          return { ok: true };
        },
      },
    };
    const { renderNotification } = await import("/src/ui/notification/app.js");
    await renderNotification();
  }, pending);
}

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
  await expect(page.locator(".ap-recipient__tag")).toHaveText("WB shop · saved contact");
  for (const locator of [
    page.locator(".ap-amount"),
    page.locator(".ap-recipient__lead"),
    page.getByText("Network fee", { exact: true }),
    page.getByRole("button", { name: "Reject", exact: true }),
    page.getByRole("button", { name: "Approve", exact: true }),
  ]) {
    expect(await inView(page, locator)).toBe(true);
  }
  await expect(page.getByText("dusk:2", { exact: true })).toBeHidden();
  await expect(page.locator("#approval-network")).toHaveText("Testnet");

  // The buttons stay put while the page scrolls under them.
  await page.locator(".panel-content").evaluate((el) => el.scrollTo(0, el.scrollHeight));
  expect(await inView(page, page.getByRole("button", { name: "Approve", exact: true }))).toBe(true);
  await page.getByText("Details", { exact: true }).click();
  await expect(page.getByText("dusk:2", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  expect(await page.evaluate(() => window.decisions.map((d) => d.decision))).toEqual(["reject"]);
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
  await expect(page.locator(".ap-tag")).toHaveText("Known DuskEVM bridge call");
  const recipient = page.locator(".kv-value code.ap-address");
  await expect(recipient).toHaveText(deposit.expected.to);
  for (const locator of [page.locator(".ap-amount"), page.locator(".ap-tag"), recipient]) {
    expect(await inView(page, locator)).toBe(true);
  }
  const callData = page.getByText("40 bytes · sha256=2f64b19f5ac0…731c7c2a", { exact: true });
  await expect(callData).toBeHidden();
  await page.getByText("Details", { exact: true }).click();
  await callData.scrollIntoViewIfNeeded();
  await expect(callData).toBeVisible();
  const [recipientY, callY, rawY] = await Promise.all([
    recipient.boundingBox(),
    callData.boundingBox(),
    page.getByText("Raw call data", { exact: true }).boundingBox(),
  ]).then((boxes) => boxes.map((b) => b.y));
  expect(recipientY).toBeLessThan(callY);
  expect(callY).toBeLessThan(rawY);
});

test("a gas limit under the transaction's minimum, or a price of 0, keeps Approve off, saying why", async ({ page }) => {
  await open(page, pendingFor("send_tx", pay));
  await page.getByText("Custom fee", { exact: true }).click();
  const approve = page.getByRole("button", { name: "Approve", exact: true });
  await page.getByLabel("Gas limit", { exact: true }).fill("1500000");
  await expect(page.getByText("The gas limit can't be under 2,000,000 for this transaction.", { exact: true })).toBeVisible();
  await expect(approve).toBeDisabled();
  await page.getByLabel("Gas limit", { exact: true }).fill("2000000");
  await page.getByLabel("Gas price (LUX)", { exact: true }).fill("0");
  await expect(page.getByText("The gas price must be at least 1 LUX.", { exact: true })).toBeVisible();
  await expect(approve).toBeDisabled();
  expect(await page.evaluate(() => window.decisions)).toEqual([]);
  await page.getByLabel("Gas price (LUX)", { exact: true }).fill("1");
  await expect(page.getByText("At most 0.002 DUSK", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.decisions.map((d) => [d.decision, d.approvedParams?.gas?.limit]))).toEqual([
    ["approve", "2000000"],
  ]);
});

test("a locked wallet shows what the site asks, with Reject beside Unlock", async ({ page }) => {
  await open(page, pendingFor("send_tx", pay, { isUnlocked: false, accounts: [], duskNames: {} }));
  await expect(page.getByRole("heading", { name: "Pay" })).toBeVisible();
  await expect(page.locator(".ap-amount")).toHaveText("1 DUSK");
  await expect(page.getByLabel("Unlock to review and approve it")).toBeVisible();
  const reject = page.getByRole("button", { name: "Reject", exact: true });
  const unlock = page.getByRole("button", { name: "Unlock", exact: true });
  const [r, u] = [await reject.boundingBox(), await unlock.boundingBox()];
  expect(Math.abs(r.y - u.y)).toBeLessThan(2);
  expect(r.x).toBeLessThan(u.x);
  expect(await inView(page, unlock)).toBe(true);
  await reject.click();
  expect(await page.evaluate(() => window.decisions.map((d) => d.decision))).toEqual(["reject"]);
});
