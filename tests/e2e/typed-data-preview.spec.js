import { test, expect } from "@playwright/test";

test("typed-data preview visibly discloses clipped text, but not an uncut value", async ({ page }) => {
  // Isolate the real renderer: only the pending-request transport is stubbed.
  await page.route("**/typed-data-preview?rid=test", route => route.fulfill({
    contentType: "text/html",
    body: '<link rel="stylesheet" href="/ui.css"><div id="app"></div>',
  }));
  await page.goto("/typed-data-preview?rid=test");
  await page.evaluate(async () => {
    window.pending = {
      kind: "sign_typed_data", origin: "https://dapp.example",
      hasVault: true, isUnlocked: true, accounts: ["test-account"],
      params: {
        domain: { name: "Preview test", version: "1", chainId: "dusk:0" },
        types: { Message: [{ name: "text", type: "string" }] },
        primaryType: "Message", message: { text: "A".repeat(2048) + " END" },
      },
    };
    window.browser = { runtime: { sendMessage: async ({ type }) =>
      type === "DUSK_GET_PENDING" ? window.pending : { ok: true },
    } };
    const { renderNotification } = await import("/src/ui/notification/app.js");
    window.renderPreview = renderNotification;
    await renderNotification();
  });

  const notice = page.getByText("Text truncated; the full value is signed.", { exact: true });
  await expect(page.locator('code[title="truncated"]')).toHaveText("A".repeat(2048));
  await expect(notice).toBeVisible();
  await expect(page.getByText("Hidden characters detected", { exact: true })).toHaveCount(0);

  await page.evaluate(async () => {
    window.pending.params.message.text = "A".repeat(2048);
    await window.renderPreview();
  });
  await expect(notice).toHaveCount(0);
  await expect(page.locator('code[title="truncated"]')).toHaveCount(0);
});
