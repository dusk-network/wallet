import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import qrcode from "qrcode-generator";

// The QR decoder comes with a scan, not with the popup: opening the wallet
// asks for none of it, and a scan reads a request from an image. The test
// phrase is from src/shared/fixtures/bip39-vectors.json.
const { seeds } = JSON.parse(readFileSync(new URL("../../src/shared/fixtures/bip39-vectors.json", import.meta.url), "utf8"));
const PASSWORD = "password123";
const DECODER = /jsqr/i;

test.beforeEach(async ({ page }) => {
  const nodeUrl = String(process.env.DUSK_RUSK_HTTP ?? "http://127.0.0.1:8080").trim();
  await page.addInitScript(({ nodeUrl }) => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    localStorage.clear();
    localStorage.setItem("dusk_settings_v1", JSON.stringify({ nodeUrl, proverUrl: nodeUrl, archiverUrl: nodeUrl }));
  }, { nodeUrl });
});

const home = (page) => expect(page.locator("#app").getByRole("button", { name: "Send" })).toBeVisible({ timeout: 120_000 });

// A wallet from the test phrase, and its public account, from Receive.
async function openWallet(page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Import wallet" }).click();
  await page.getByLabel("Word 1", { exact: true }).fill(seeds[0].phrase);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Import wallet" }).click();
  await home(page);
  await page.locator("#app").getByRole("button", { name: "Receive" }).first().click();
  const account = await page.locator(".receive-field__address").getAttribute("title");
  await page.getByRole("button", { name: "← Back" }).click();
  await home(page);
  return account;
}

// A request for 1.25 DUSK to `account`, as a QR code in a GIF.
function requestImage(account) {
  const qr = qrcode(0, "M");
  qr.addData(`dusk:public-${account}?amount=1.25&memo=Lunch`);
  qr.make();
  return { name: "request.gif", mimeType: "image/gif", buffer: Buffer.from(qr.createDataURL(8, 4).split(",")[1], "base64") };
}

async function scanImage(page, account) {
  await page.locator(".qrscan-modal input[type=file]").setInputFiles(requestImage(account));
  await expect(page.getByLabel("To", { exact: true })).toHaveValue(account);
  await expect(page.getByLabel("Amount", { exact: true })).toHaveValue("1.25");
  await expect(page.getByLabel("Memo", { exact: true })).toHaveValue("Lunch");
}

test("opens the wallet without the QR decoder, then fills Send from a scanned request", async ({ page }) => {
  const decoder = [];
  page.on("request", (request) => DECODER.test(request.url()) && decoder.push(request.url()));
  const account = await openWallet(page);
  await page.locator("#app").getByRole("button", { name: "Send" }).first().click();
  await expect(page.getByLabel("To", { exact: true })).toBeVisible();
  expect(decoder).toEqual([]);

  await page.getByRole("button", { name: "Scan QR" }).click();
  await expect(page.locator(".qrscan-title")).toHaveText("Scan request");
  await scanImage(page, account);
  expect(decoder.length).toBeGreaterThan(0);
});

test("says the scanner couldn't load while its code doesn't come, and scans once the wallet opens again", async ({ page }) => {
  const account = await openWallet(page);
  await page.route(DECODER, (route) => route.abort("internetdisconnected"));
  await page.locator("#app").getByRole("button", { name: "Send" }).first().click();
  await page.getByRole("button", { name: "Scan QR" }).click();
  await expect(page.getByText("The QR scanner couldn't load. Close the wallet and open it again.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Choose image" })).toBeDisabled();
  await page.locator(".qrscan-modal").getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator(".qrscan-modal")).toHaveCount(0);

  // Opened again, its code there: it scans.
  await page.unroute(DECODER);
  await page.reload();
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Unlock" }).click();
  await home(page);
  await page.locator("#app").getByRole("button", { name: "Send" }).first().click();
  await page.getByRole("button", { name: "Scan QR" }).click();
  await scanImage(page, account);
});
