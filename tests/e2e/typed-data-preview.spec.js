import { createHash } from "node:crypto";
import { hashTypedDataHex } from "@dusk/typed-data";
import { checkPolicyLimits } from "@dusk/typed-data/policy";
import { test, expect } from "@playwright/test";

async function refreshPreview(page) {
  const input = await page.evaluate(() => {
    const { domain, types, primaryType, message } = window.pending.params;
    return { domain, types, primaryType, message, origin: window.pending.origin };
  });
  checkPolicyLimits(input);
  await page.evaluate(async digest => {
    window.pending.params.digestHex = digest;
    await window.renderPreview();
  }, hashTypedDataHex(input));
  return input;
}

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
        types: {
          DuskTypedDataDomain: [
            { name: "name", type: "string" }, { name: "version", type: "string" },
            { name: "chainId", type: "string" }, { name: "verifyingContract", type: "bytes32" },
          ],
          Message: [{ name: "text", type: "string" }],
        },
        primaryType: "Message", message: { text: "A".repeat(2048) + " END" },
      },
    };
    window.decisions = [];
    window.browser = { runtime: { sendMessage: async msg => {
      if (msg.type === "DUSK_GET_PENDING") return window.pending;
      if (msg.type === "DUSK_PENDING_DECISION") window.decisions.push(msg);
      return { ok: true };
    } } };
    const { renderNotification } = await import("/src/ui/notification/app.js");
    window.renderPreview = renderNotification;
  });
  await refreshPreview(page);
});

test("typed-data preview visibly discloses clipped text, but not an uncut value", async ({ page }) => {
  const notice = page.getByText("Text truncated; the full value is signed.", { exact: true });
  await expect(page.locator('code[title="truncated"]')).toHaveText("A".repeat(2048));
  await expect(notice).toBeVisible();
  await expect(page.getByText("Text needs review", { exact: true })).toHaveCount(0);

  await page.evaluate(() => { window.pending.params.message.text = "A".repeat(2048); });
  await refreshPreview(page);
  await expect(notice).toHaveCount(0);
  await expect(page.locator('code[title="truncated"]')).toHaveCount(0);
});

test("typed-data byte previews match every accepted hex spelling", async ({ page }) => {
  for (const [type, hex] of [["bytes", "00"], ["bytes32", "ab".repeat(32)], ["bytes", ""]]) {
    const hash = createHash("sha256").update(Buffer.from(hex, "hex")).digest("hex");
    for (const value of [`0x${hex}`, `0X${hex.toUpperCase()}`, hex]) {
      await page.evaluate(({ type, value }) => {
        window.pending.params.types.Message = [{ name: "data", type }];
        window.pending.params.message = { data: value };
      }, { type, value });
      await refreshPreview(page);
      await expect(page.getByText(
        `${hex.length / 2} bytes · sha256=${hash.slice(0, 12)}…${hash.slice(-8)}`,
        { exact: true }
      )).toBeVisible();
      await expect(page.getByText("(unexpected type)", { exact: true })).toHaveCount(0);
    }
  }
});

test("typed-data empty structs visibly retain their paths and declared type", async ({ page }) => {
  const input = await page.evaluate(() => ({ ...window.pending.params, origin: window.pending.origin }));
  input.types.Message = [{ name: "note", type: "string" }, { name: "approveAll", type: "Empty" }];
  input.types.Empty = [];
  input.message = { note: "Sign in", approveAll: {} };
  const params = { ...input, digestHex: hashTypedDataHex(input) };
  await page.evaluate(async params => {
    window.pending.params = params;
    await window.renderPreview();
  }, params);
  await expect(page.getByText("approveAll · Empty", { exact: true }).locator("..").locator("code")).toHaveText("{}");
  await expect(page.getByText("approveAll · Empty", { exact: true })).toBeVisible();
  await expect(page.getByText("more field(s) not shown.", { exact: false })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sign", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => window.pending.params)).toEqual(params);
});

test("typed-data arrays of empty structs are visible or explicitly row-limited", async ({ page }) => {
  const input = await page.evaluate(() => ({ ...window.pending.params, origin: window.pending.origin }));
  input.types.Empty = [];
  for (const length of [2, 201]) {
    input.types.Message = [{ name: "permissions", type: `Empty[${length}]` }];
    input.message = { permissions: Array.from({ length }, () => ({})) };
    const params = { ...input, digestHex: hashTypedDataHex(input) };
    await page.evaluate(async params => {
      window.pending.params = params;
      await window.renderPreview();
    }, params);
    const count = Math.min(length, 200);
    await expect(page.getByText(/^permissions\[\d+\] · Empty$/)).toHaveCount(count);
    for (const index of [0, count - 1]) {
      const label = page.getByText(`permissions[${index}] · Empty`, { exact: true });
      await label.scrollIntoViewIfNeeded();
      await expect(label).toBeVisible();
      await expect(label.locator("..").locator("code")).toHaveText("{}");
    }
    const notice = page.getByText("1 more field(s) not shown. Open Full signing request (escaped JSON) above to inspect every value. The digest below covers the whole message.", { exact: true });
    await expect(notice).toHaveCount(length > 200 ? 1 : 0);
    if (length > 200) await expect(notice).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign", exact: true })).toBeEnabled();
    expect(await page.evaluate(() => window.pending.params)).toEqual(params);
  }
});

test("a keyboard-accessible full view includes every omitted value, bytes and declared schema", async ({ page }) => {
  await page.evaluate(() => {
    const p = window.pending.params;
    p.origin = "https://spoofed.example"; // Must not replace the signer's origin.
    p.types.Empty = [];
    p.types.Message = [
      { name: "amounts", type: "uint64[210]" }, { name: "note", type: "string" },
      { name: "blob", type: "bytes" }, { name: "marker", type: "Empty" },
    ];
    p.message = { amounts: Array(210).fill(1), note: "A".repeat(2048) + " ORIGINAL TAIL", blob: "0X00AB", marker: {} };
  });
  const input = await refreshPreview(page);
  const summary = page.getByText("Full signing request (escaped JSON)", { exact: true });
  const fullView = page.getByRole("textbox", { name: "Full signing request (escaped JSON)" });
  await expect(summary).toBeVisible();
  await expect(page.locator("textarea")).toBeHidden();
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(fullView).toBeVisible();
  await expect(fullView).toHaveJSProperty("readOnly", true);
  const originalFull = await fullView.inputValue();
  expect(JSON.parse(originalFull)).toEqual(input);
  expect(originalFull).not.toContain("spoofed.example");
  await expect(page.getByText("32 zero bytes (default)", { exact: true })).toBeVisible();
  await fullView.focus();
  await page.keyboard.press("Control+End");
  // Native keyboard scrolling completes asynchronously in Chromium.
  await expect.poll(() => fullView.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThanOrEqual(1);
  const labels = page.getByText(/^amounts\[\d+\] · uint64$/);
  expect(await labels.count()).toBe(200);
  const originalRows = await labels.evaluateAll(els => els.map(el => el.parentElement.textContent));

  // Same bounded preview, but a different full request and digest.
  await page.evaluate(() => { window.pending.params.message.amounts[209] = 2; });
  const changed = await refreshPreview(page);
  await summary.click();
  expect(await labels.evaluateAll(els => els.map(el => el.parentElement.textContent))).toEqual(originalRows);
  expect(await fullView.inputValue()).not.toBe(originalFull);
  expect(JSON.parse(await fullView.inputValue())).toEqual(changed);
  expect(hashTypedDataHex(changed)).not.toBe(hashTypedDataHex(input));
  await expect(page.getByRole("button", { name: "Sign", exact: true })).toBeEnabled();
});

test("the full view preserves string tails and Unicode originals, not normalized or injected markup", async ({ page }) => {
  for (const text of ["A".repeat(2048) + " X", "A".repeat(2048) + " Y", "é", "e\u0301", "\\u00e9", "<img src=x onerror=alert(1)>\namount : uint64 = 5\u202e"]) {
    await page.evaluate(text => { window.pending.params.message.text = text; }, text);
    const input = await refreshPreview(page);
    await page.getByText("Full signing request (escaped JSON)", { exact: true }).click();
    const full = await page.getByRole("textbox", { name: "Full signing request (escaped JSON)" }).inputValue();
    expect(full).not.toMatch(/[\u007f-\uffff]/);
    expect(JSON.parse(full)).toEqual(input);
    expect(hashTypedDataHex(JSON.parse(full))).toBe(hashTypedDataHex(input));
    await expect(page.locator("#app img")).toHaveCount(0);
    await expect(page.getByText("text · string", { exact: true })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Sign", exact: true })).toBeEnabled();
  }
});

for (const failure of ["digest mismatch", "display budget"]) {
  test(`${failure} prevents approval but leaves rejection available`, async ({ page }) => {
    await page.evaluate(async failure => {
      if (failure === "digest mismatch") {
        window.pending.params.message.text = "Changed after hashing";
      } else {
        let unused = [];
        for (let i = 0; i < 32; i++) unused = [unused];
        window.pending.params.types.Unused = Array(2000).fill(unused);
      }
      await window.renderPreview();
    }, failure);
    await expect(page.getByRole("alert")).toContainText("Cannot safely disclose the full signing request");
    await expect(page.getByRole("button", { name: "Sign", exact: true })).toBeDisabled();
    await expect(page.locator("textarea")).toHaveCount(0);
    await page.getByRole("button", { name: "Reject", exact: true }).click();
    expect(await page.evaluate(() => window.decisions.map(d => d.decision))).toEqual(["reject"]);
  });
}

for (const [section, field] of [["domain", "name"], ["domain", "version"], ["message", "text"]]) {
  test(`typed-data ${section} ${field} uses display safeguards without changing the digest`, async ({ page }) => {
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
    const warning = page.getByText("Text needs review", { exact: true });
    const notice = page.getByText("Text truncated; the full value is signed.", { exact: true });
    const label = section === "domain" ? `Domain ${field}` : `${field} · string`;
    const valueRow = page.getByText(label, { exact: true }).locator("..").locator("code");
    for (const [raw, display, unsafe, clipped] of [
      ["Amount: \u061c123 456", "Amount: �123 456", true, false],
      ["x\u0007\u202ey\u202c", "x��y�", true, false],
      ["A".repeat(2048) + " END", "A".repeat(2048), false, true],
      ["A".repeat(2048), "A".repeat(2048), false, false],
      ["Ali\u200bce", "Ali\\u200bce", true, false],
      ["👩‍💻", "👩\\u200d💻", true, false],
      ["A\nB\rC\u2028D\u2029E", "A\\u000aB\\u000dC\\u2028D\\u2029E", true, false],
      ["e\u0301", "e\u0301", true, false],
    ]) {
      input[section][field] = raw;
      const digestHex = hashTypedDataHex(input);
      if (raw !== display) {
        expect(hashTypedDataHex({ ...input, [section]: { ...input[section], [field]: display } })).not.toBe(digestHex);
      }
      await page.evaluate(async (params) => {
        window.pending.params = params;
        await window.renderPreview();
      }, { ...input, digestHex });
      await expect(valueRow).toHaveText(display);
      await expect(warning).toHaveCount(unsafe ? 1 : 0);
      if (unsafe) await expect(warning).toBeVisible();
      await expect(notice).toHaveCount(clipped ? 1 : 0);
      await page.getByText("Digest (verify against the dApp)", { exact: true }).click();
      await expect(page.getByText(digestHex, { exact: true })).toBeVisible();
      expect(await page.evaluate(([section, field]) => window.pending.params[section][field], [section, field])).toBe(raw);
      await expect(page.getByRole("button", { name: "Sign", exact: true })).toBeEnabled();
    }
  });
}
