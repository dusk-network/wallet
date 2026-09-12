import { createHash } from "node:crypto";
import { hashTypedDataHex } from "@dusk/typed-data";
import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
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
});

test("typed-data preview visibly discloses clipped text, but not an uncut value", async ({ page }) => {
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

test("typed-data byte previews match every accepted hex spelling", async ({ page }) => {
  for (const [type, hex] of [["bytes", "00"], ["bytes32", "ab".repeat(32)], ["bytes", ""]]) {
    const hash = createHash("sha256").update(Buffer.from(hex, "hex")).digest("hex");
    for (const value of [`0x${hex}`, `0X${hex.toUpperCase()}`, hex]) {
      await page.evaluate(async ({ type, value }) => {
        window.pending.params.types = { Message: [{ name: "data", type }] };
        window.pending.params.message = { data: value };
        await window.renderPreview();
      }, { type, value });
      await expect(page.getByText(
        `${hex.length / 2} bytes · sha256=${hash.slice(0, 12)}…${hash.slice(-8)}`,
        { exact: true }
      )).toBeVisible();
      await expect(page.getByText("(unexpected type)", { exact: true })).toHaveCount(0);
    }
  }
});

for (const field of ["name", "version"]) {
  test(`typed-data domain ${field} uses display safeguards without changing the digest`, async ({ page }) => {
    const input = {
      origin: "https://dapp.example",
      domain: { name: "Safe app", version: "1", chainId: "dusk:0" },
      types: {
        DuskTypedDataDomain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "string" },
          { name: "verifyingContract", type: "bytes32" },
        ],
        Message: [{ name: "text", type: "string" }],
      },
      primaryType: "Message", message: { text: "Safe message" },
    };
    const warning = page.getByText("Hidden characters detected", { exact: true });
    const notice = page.getByText("Text truncated; the full value is signed.", { exact: true });
    const valueRow = page.getByText(`Domain ${field}`, { exact: true }).locator("..").locator("code");
    for (const [raw, display, unsafe, clipped] of [
      ["x\u0007\u202ey\u202c", "x��y�", true, false],
      ["A".repeat(2048) + " END", "A".repeat(2048), false, true],
      ["A".repeat(2048), "A".repeat(2048), false, false],
    ]) {
      input.domain[field] = raw;
      const digestHex = hashTypedDataHex(input);
      if (raw !== display) {
        expect(hashTypedDataHex({ ...input, domain: { ...input.domain, [field]: display } })).not.toBe(digestHex);
      }
      await page.evaluate(async (params) => {
        window.pending.params = params;
        await window.renderPreview();
      }, { ...input, digestHex });
      await expect(valueRow).toHaveText(display);
      await expect(warning).toHaveCount(unsafe ? 1 : 0);
      await expect(notice).toHaveCount(clipped ? 1 : 0);
      await page.getByText("Digest (verify against the dApp)", { exact: true }).click();
      await expect(page.getByText(digestHex, { exact: true })).toBeVisible();
      expect(await page.evaluate(field => window.pending.params.domain[field], field)).toBe(raw);
      await expect(page.getByRole("button", { name: "Sign", exact: true })).toBeEnabled();
    }
  });
}
