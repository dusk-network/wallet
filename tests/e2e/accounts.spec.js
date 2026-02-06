import { test, expect } from "@playwright/test";

const MNEMONIC_12 = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const PASSWORD = "password123";

test.beforeEach(async ({ page }) => {
  const nodeUrl = String(process.env.DUSK_RUSK_HTTP ?? "http://127.0.0.1:8080").trim();

  await page.addInitScript(({ nodeUrl }) => {
    try {
      localStorage.clear();
      localStorage.setItem(
        "dusk_settings_v1",
        JSON.stringify({
          nodeUrl,
          proverUrl: nodeUrl,
          archiverUrl: nodeUrl,
        })
      );
    } catch {
      // ignore
    }
  }, { nodeUrl });
});

test("import wallet, add second account, name + switch accounts", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByText("Set up your Dusk Wallet")).toBeVisible();
  await page.getByRole("button", { name: "Import wallet" }).click();

  await expect(page.getByText("Import an existing recovery phrase")).toBeVisible();

  // Paste full phrase into first slot (MnemonicInput distributes it).
  await page.getByLabel("Word 1", { exact: true }).fill(MNEMONIC_12);
  await page.getByPlaceholder("Create password (min 8 chars)").fill(PASSWORD);
  await page.getByPlaceholder("Confirm password").fill(PASSWORD);
  await page.getByRole("button", { name: "Import wallet" }).click();

  // Home view
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 120_000 });

  // Open settings and add a second account
  await page.getByTitle("Options").click();
  await expect(page.getByText("Settings")).toBeVisible();

  await page.getByRole("button", { name: "Add account" }).click();
  await expect(page.locator("select#account option")).toHaveCount(2);

  // Set per-account names (saved on change/blur).
  const name1 = page.getByPlaceholder("Account 1 name (optional)");
  await name1.fill("Main");
  await name1.press("Tab");
  await expect(page.getByPlaceholder("Account 1 name (optional)")).toHaveValue("Main");

  const name2 = page.getByPlaceholder("Account 2 name (optional)");
  await name2.fill("Spending");
  await name2.press("Tab");
  await expect(page.getByPlaceholder("Account 2 name (optional)")).toHaveValue("Spending");

  // Back to home so the header switcher is visible
  await page.getByRole("button", { name: "← Back" }).click();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();

  // Open account menu and switch
  await page.getByTitle("Switch account").click();
  await expect(page.getByText("Select account")).toBeVisible();
  await expect(page.getByText("Main")).toBeVisible();
  await expect(page.getByText("Spending")).toBeVisible();

  await page.getByRole("button", { name: /Spending/ }).click();

  // Verify switch persisted (Settings selector now points to account 2)
  await page.getByTitle("Options").click();
  await expect(page.locator("select#account")).toHaveValue("1");
});
