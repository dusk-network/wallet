import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";

// More than one recovery phrase, in the app's own page: from a vault the
// current release made (src/shared/fixtures/vault-v1.json, by main's
// createVault), through adding, switching and removing wallets, to a reset.
// Public BIP39 test phrases only.
const { twelve } = JSON.parse(readFileSync(new URL("../../src/shared/fixtures/vault-v1.json", import.meta.url), "utf8"));
const OTHER = "legal winner thank year wave sausage worth useful legal winner thank yellow";

test.beforeEach(async ({ page }) => {
  const nodeUrl = String(process.env.DUSK_RUSK_HTTP ?? "http://127.0.0.1:8080").trim();
  await page.addInitScript(({ nodeUrl, vault }) => {
    // Once, as the update finds it: later loads of the page keep what's there.
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    localStorage.clear();
    localStorage.setItem("dusk_settings_v1", JSON.stringify({ nodeUrl, proverUrl: nodeUrl, archiverUrl: nodeUrl }));
    localStorage.setItem("dusk_vault_v1", JSON.stringify(vault));
  }, { nodeUrl, vault: twelve.vault });
});

const stored = (page, key) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "null"), key);
const home = (page) => expect(page.locator("#app").getByRole("button", { name: "Send" })).toBeVisible({ timeout: 120_000 });
const chip = (page) => page.locator("#header-actions .account-chip .chip-text");

async function unlock(page, password) {
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Unlock" }).click();
}

test("moves the release's vault, adds a wallet, switches both ways without a password, removes one, then resets", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Unlock your wallet")).toBeVisible();
  await unlock(page, twelve.password);
  await home(page);

  // Moved: v1's record, as the release made it, now the first wallet in v2.
  expect(await stored(page, "dusk_vault_v1")).toBeNull();
  const moved = await stored(page, "dusk_vault_v2");
  expect(moved.wallets).toHaveLength(1);
  expect(moved.wallets[0]).toMatchObject({ n: 1, ...twelve.vault });

  // Another wallet, by import, with the password the wallets share.
  await page.locator("#header-actions .account-chip").click();
  await expect(page.locator(".acct-menu-wallet-title")).toHaveText(["Wallet 1"]);
  await page.getByRole("menuitem", { name: "Add wallet" }).click();
  await expect(page.getByText("Your password unlocks every wallet here.")).toBeVisible();
  await page.getByRole("button", { name: /Import wallet/ }).click();
  await page.getByLabel("Word 1", { exact: true }).fill(OTHER);
  await page.getByLabel("Password", { exact: true }).fill(twelve.password);
  await page.getByRole("button", { name: "Import wallet" }).click();
  await home(page);
  await expect(chip(page)).toHaveText("Wallet 2 · Profile 1");

  // Both ways, no password asked.
  await page.locator("#header-actions .account-chip").click();
  await expect(page.locator(".acct-menu-wallet-title")).toHaveText(["Wallet 1", "Wallet 2"]);
  await page.locator(".acct-menu-wallet").first().getByRole("menuitemradio", { name: /^Profile 2/ }).click();
  await expect(chip(page)).toHaveText("Wallet 1 · Profile 2");
  await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
  await page.locator("#header-actions .account-chip").click();
  await page.locator(".acct-menu-wallet").nth(1).getByRole("menuitemradio", { name: /^Profile 1/ }).click();
  await expect(chip(page)).toHaveText("Wallet 2 · Profile 1");

  // The same phrase again: one sentence, nothing added.
  await page.locator("#header-actions .account-chip").click();
  await page.getByRole("menuitem", { name: "Add wallet" }).click();
  await page.getByRole("button", { name: /Import wallet/ }).click();
  await page.getByLabel("Word 1", { exact: true }).fill(twelve.mnemonic);
  await page.getByLabel("Password", { exact: true }).fill(twelve.password);
  await page.getByRole("button", { name: "Import wallet" }).click();
  await expect(page.getByText("This recovery phrase is already in your wallet.")).toBeVisible({ timeout: 60_000 });
  expect((await stored(page, "dusk_vault_v2")).wallets).toHaveLength(2);
  await page.getByRole("button", { name: "← Back" }).click();
  await page.getByRole("button", { name: "← Back" }).click();

  // Wallet 1 removed with the password: wallet 2 as it was.
  const second = (await stored(page, "dusk_vault_v2")).wallets[1];
  await page.getByTitle("Settings").click();
  await page.getByRole("button", { name: "Remove Wallet 1" }).click();
  await expect(page.getByText("This removes Wallet 1 from this device")).toBeVisible();
  await page.getByLabel("Password", { exact: true }).fill(twelve.password);
  await page.getByRole("button", { name: "Remove wallet" }).click();
  await expect(page.getByText("Wallet 1 removed.")).toBeVisible({ timeout: 60_000 });
  expect((await stored(page, "dusk_vault_v2")).wallets).toEqual([second]);
  await expect(page.getByRole("button", { name: /^Remove / })).toHaveCount(0);

  // Reset: every phrase gone.
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Reset wallet" }).click();
  await expect(page.getByText("Set up your Dusk Wallet")).toBeVisible({ timeout: 60_000 });
  expect([await stored(page, "dusk_vault_v1"), await stored(page, "dusk_vault_v2"), await stored(page, "dusk_wallets_v1")]).toEqual([null, null, null]);
});

test("moves nothing with a wrong password, then moves on the right one", async ({ page }) => {
  await page.goto("/");
  await unlock(page, `${twelve.password}!`);
  await expect(page.locator("#unlock-error")).toHaveText("Incorrect password");
  expect(await stored(page, "dusk_vault_v1")).toEqual(twelve.vault);
  expect(await stored(page, "dusk_vault_v2")).toBeNull();

  // A reload, as a popup opened again: still there; the backoff passes, then it moves.
  await page.reload();
  await expect(page.getByText("Unlock your wallet")).toBeVisible();
  await page.waitForTimeout(1_100);
  await unlock(page, twelve.password);
  await home(page);
  expect(await stored(page, "dusk_vault_v1")).toBeNull();
  expect((await stored(page, "dusk_vault_v2")).wallets[0]).toMatchObject(twelve.vault);
});
