import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";

// Recovery phrases end to end, in the app's own page: a wallet made from new
// words, unlocked again and restored from them, and test phrases that open
// the accounts they always opened. The new words stay in the page; the test
// phrases come from src/shared/fixtures/bip39-vectors.json.
const { seeds } = JSON.parse(readFileSync(new URL("../../src/shared/fixtures/bip39-vectors.json", import.meta.url), "utf8"));
const PASSWORD = "password123";

test.beforeEach(async ({ page }) => {
  const nodeUrl = String(process.env.DUSK_RUSK_HTTP ?? "http://127.0.0.1:8080").trim();
  await page.addInitScript(({ nodeUrl }) => {
    // Once: later loads of the page keep the wallet made.
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    localStorage.clear();
    localStorage.setItem("dusk_settings_v1", JSON.stringify({ nodeUrl, proverUrl: nodeUrl, archiverUrl: nodeUrl }));
  }, { nodeUrl });
});

const home = (page) => expect(page.locator("#app").getByRole("button", { name: "Send" })).toBeVisible({ timeout: 120_000 });

// The public account Receive shows, then back home.
async function account(page) {
  await page.locator("#app").getByRole("button", { name: "Receive" }).first().click();
  const shown = page.locator(".receive-field__address");
  await expect(shown).toHaveAttribute("title", /^\w{40,}$/);
  const value = await shown.getAttribute("title");
  await page.getByRole("button", { name: "← Back" }).click();
  await home(page);
  return value;
}

async function lock(page) {
  await page.getByTitle("Settings").click();
  await page.getByRole("button", { name: "Lock wallet" }).click();
  await expect(page.getByText("Unlock your wallet")).toBeVisible();
}

// The words the page showed, pasted into its first box.
const pasteWords = (page) =>
  page.getByLabel("Word 1", { exact: true }).evaluate((box) => {
    const data = new DataTransfer();
    data.setData("text/plain", window.shownWords.join(" "));
    box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });

test("makes a wallet from new words, unlocks it, and restores the same one from its words", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Create wallet" }).click();
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm password", { exact: true }).fill(PASSWORD);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator(".srp-word-text")).toHaveCount(12);
  await page.evaluate(() => {
    window.shownWords = [...document.querySelectorAll(".srp-word-text")].map((n) => n.textContent);
  });
  await page.getByRole("button", { name: "I wrote it down" }).click();
  await pasteWords(page);
  await page.getByRole("button", { name: "Create wallet" }).click();
  await home(page);
  const made = await account(page);

  await lock(page);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Unlock" }).click();
  await home(page);
  expect(await account(page)).toBe(made);

  // A forgotten password: the words and a new one make the same wallet.
  await lock(page);
  await page.getByRole("button", { name: "Forgot your password?" }).click();
  await pasteWords(page);
  await page.getByLabel("New password", { exact: true }).fill("another password");
  await page.getByLabel("Confirm password", { exact: true }).fill("another password");
  await page.getByRole("button", { name: "Restore wallet" }).click();
  await home(page);
  expect(await account(page)).toBe(made);
});

// Each account as the wallet opened it with bip39 3.1.0, before @scure/bip39.
const OPENED = [
  [0, "mK48BYb2VmaqheAmX8cesNPnK7DryBRMGM1fQf67JmSUsZLPq4dEwPdXSS8xnibWemVYzDmrnfWjuSHo9D8bK9piMVfk9p27nbWFAr5arkZuR3VK71oxkY2fk3t2LxxH1V3"],
  [5, "227fNwTJfNp4BS5QdBqEhSQivvyHrqDSrS3D9qndwh3Nf7Ais5GRczq3PDvanxVVAoCZ3risu82J7RY4oK54aCgwMZHftB6f6HxLkui1jaJQTtKDYK6Y7bkT6uudHYytLq2J"],
];

for (const [i, opened] of OPENED) {
  test(`opens the account a ${seeds[i].words}-word test phrase always opened`, async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Import wallet" }).click();
    await page.getByLabel("Word 1", { exact: true }).fill(seeds[i].phrase);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByLabel("Confirm password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Import wallet" }).click();
    await home(page);
    expect(await account(page)).toBe(opened);
  });
}
