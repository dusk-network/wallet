import { test, expect } from "@playwright/test";

// Renderer-only checks: no real vault, credentials, keys, node or transactions.
const PASSWORD = " renderer-only password é ";

test.beforeEach(async ({ page }) => {
  await page.route("**/unlock-form", route => route.fulfill({
    contentType: "text/html",
    body: '<link rel="stylesheet" href="/ui.css"><button id="network-pill"><span class="network-pill__label"></span></button><div id="header-actions"></div><div id="app"></div>',
  }));
  // Keep the actual popup, overview and bus; stub the wallet transport only.
  await page.route("**/src/wallet/localBus.js*", route => route.fulfill({
    contentType: "text/javascript",
    body: "export const localSend = message => window.testSend(message);",
  }));
  await page.goto("/unlock-form");
  await page.evaluate(async () => {
    window.pageErrors = [];
    window.addEventListener("unhandledrejection", event => window.pageErrors.push(String(event.reason)));
    window.listeners = [];
    window.browser = {
      runtime: {
        id: "renderer-test",
        sendMessage: message => window.testSend(message),
        onMessage: { addListener: listener => window.listeners.push(listener) },
      },
      tabs: { query: async () => [] },
    };
    window.overview = { hasVault: true, isUnlocked: false, networkName: "Initial network" };
    window.overviewReads = 0;
    window.unlockRequests = [];
    window.testSend = async message => {
      if (message.type === "DUSK_UI_ACTIVITY") return { ok: true };
      if (message.type === "DUSK_UI_OVERVIEW") {
        window.overviewReads++;
        return window.overviewReply?.promise ?? structuredClone(window.overview);
      }
      if (message.type === "DUSK_UI_UNLOCK") {
        window.unlockRequests.push(structuredClone(message));
        window.unlockReply = Promise.withResolvers();
        return window.unlockReply.promise;
      }
      if (message.type === "DUSK_UI_GET_SOZU_STATUS") return { error: { message: "No position in renderer test" } };
      if (message.type === "DUSK_UI_ASSETS_GET") return { tokens: [], nfts: [] };
      throw new Error(`Unexpected renderer test message: ${message.type}`);
    };
    const { state } = await import("/src/ui/popup/state.js");
    window.uiState = state;
    state.addressBook = { ...state.addressBook, loaded: true, items: [] };
    const { render } = await import("/src/ui/popup/app.js");
    window.renderPopup = render;
    await render();
    window.originalPassword = document.querySelector('input[type="password"]');
    window.originalButton = document.querySelector("#app button");
  });
});

test.afterEach(async ({ page }) => {
  expect(await page.evaluate(() => window.pageErrors)).toEqual([]);
  expect(await page.evaluate(password => ({
    local: Object.keys(localStorage),
    session: Object.keys(sessionStorage),
    inState: JSON.stringify(window.uiState).includes(password),
  }), PASSWORD)).toEqual({ local: [], session: [], inState: false });
});

async function expectOriginalInput(page, { focused = false } = {}) {
  const input = page.getByPlaceholder("Password", { exact: true });
  await expect(input).toHaveValue(PASSWORD);
  expect(await input.evaluate(el => el === window.originalPassword)).toBe(true);
  if (focused) {
    await expect(input).toBeFocused();
    expect(await input.evaluate(el => [el.selectionStart, el.selectionEnd, el.selectionDirection])).toEqual([2, 9, "backward"]);
  }
}

test("a delayed overview keeps the entered password, focus and selection before Enter", async ({ page }) => {
  await page.evaluate(() => {
    window.overviewReply = Promise.withResolvers();
    window.pendingRender = window.renderPopup({ forceRefresh: true });
  });
  await expect.poll(() => page.evaluate(() => window.overviewReads)).toBe(2);
  const input = page.getByPlaceholder("Password", { exact: true });
  await input.fill(PASSWORD);
  await input.evaluate(el => el.setSelectionRange(2, 9, "backward"));
  await page.evaluate(async () => {
    window.overviewReply.resolve({ ...window.overview, networkName: "Refreshed network" });
    await window.pendingRender;
    window.overviewReply = null;
  });
  await expect(page.locator(".network-pill__label")).toHaveText("Refreshed network");
  await expectOriginalInput(page, { focused: true });
  await input.press("Enter");
  await expect.poll(() => page.evaluate(() => window.unlockRequests)).toEqual([
    { type: "DUSK_UI_UNLOCK", password: PASSWORD },
  ]);
});

test("runtime refreshes and toast expiry preserve the mounted input", async ({ page }) => {
  await page.getByPlaceholder("Password", { exact: true }).fill(PASSWORD);
  await page.evaluate(() => window.originalPassword.setSelectionRange(2, 9, "backward"));
  for (const message of [
    { type: "DUSK_UI_LOCK_STATE", isUnlocked: false },
    { type: "DUSK_UI_SHIELDED_STATUS", status: { state: "idle", progress: 1 } },
    { type: "DUSK_UI_TX_STATUS", status: "executed" },
  ]) {
    await page.evaluate(message => {
      window.overview.networkName = message.type;
      for (const listener of window.listeners) listener(message);
    }, message);
    await expect(page.locator(".network-pill__label")).toHaveText(message.type);
    await expectOriginalInput(page, { focused: true });
  }
  await expect(page.locator(".toast")).toHaveText("Transaction executed");
  await expect(page.locator(".toast")).toHaveCount(0);
  await expectOriginalInput(page, { focused: true });
});

test("rerendering an in-flight unlock keeps it busy, blocks duplicates and allows a retry", async ({ page }) => {
  const input = page.getByPlaceholder("Password", { exact: true });
  await input.fill(PASSWORD);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.unlockRequests.length)).toBe(1);
  await page.evaluate(async () => {
    for (let i = 0; i < 3; i++) await window.renderPopup({ forceRefresh: true });
  });
  await expectOriginalInput(page);
  await expect(input).toBeDisabled();
  await expect(page.getByRole("button", { name: "Unlocking…", exact: true })).toBeDisabled();
  await expect(page.getByText("Decrypting your vault.", { exact: false })).toBeVisible();
  // Exercise the handler guard too, not only native disabled-button behavior.
  await page.evaluate(() => {
    window.originalButton.dispatchEvent(new MouseEvent("click"));
    window.originalPassword.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  expect(await page.evaluate(() => window.unlockRequests.length)).toBe(1);
  await page.evaluate(() => window.unlockReply.resolve({ error: { message: "Incorrect password" } }));
  await expect(page.locator(".toast")).toHaveText("Incorrect password");
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue("");
  await input.fill(PASSWORD);
  await input.press("Enter");
  await expect.poll(() => page.evaluate(() => window.unlockRequests.length)).toBe(2);
  await page.evaluate(() => {
    window.overview.isUnlocked = true;
    window.unlockReply.resolve({ ok: true });
  });
  await expect(page.locator("body")).toHaveAttribute("data-wallet-ready", "true");
  await expect(input).toHaveCount(0);
  expect(await page.evaluate(() => window.originalPassword.value)).toBe("");
  await page.evaluate(async () => {
    window.overview.isUnlocked = false;
    await window.renderPopup({ forceRefresh: true });
  });
  await expect(input).toHaveValue("");
  await expect(input).toBeEnabled();
  expect(await input.evaluate(el => el === window.originalPassword)).toBe(false);
});

test("a rejected unlock transport recovers without an unhandled rejection", async ({ page }) => {
  const input = page.getByPlaceholder("Password", { exact: true });
  await input.fill(PASSWORD);
  await input.press("Enter");
  await expect.poll(() => page.evaluate(() => window.unlockRequests.length)).toBe(1);
  await page.evaluate(() => window.unlockReply.reject(new Error("Transport unavailable")));
  await expect(page.locator(".toast")).toHaveText("Transport unavailable");
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue("");
  await input.fill(PASSWORD);
  await input.press("Enter");
  await expect.poll(() => page.evaluate(() => window.unlockRequests.length)).toBe(2);
});

test("success refreshes a replacement unlock form after returning before completion", async ({ page }) => {
  const input = page.getByPlaceholder("Password", { exact: true });
  await input.fill(PASSWORD);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.unlockRequests.length)).toBe(1);
  await page.getByTitle("Options", { exact: true }).click();
  await expect(page.getByText("Settings", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "← Back", exact: true }).click();
  await expect(input).toBeEnabled();
  await input.fill(PASSWORD);
  expect(await input.evaluate(el => el === window.originalPassword)).toBe(false);
  expect(await page.evaluate(() => window.originalPassword.isConnected)).toBe(false);
  expect(await page.evaluate(() => window.uiState.overview.isUnlocked)).toBe(false);
  const reads = await page.evaluate(() => window.overviewReads);
  await input.evaluate(el => { window.replacementPassword = el; });
  // Resolve only the backend request: no lock-state push or manual rerender.
  await page.evaluate(() => {
    window.overview.isUnlocked = true;
    window.unlockReply.resolve({ ok: true });
  });
  await expect.poll(() => page.evaluate(() => window.uiState.overview.isUnlocked)).toBe(true);
  expect(await page.evaluate(() => window.overviewReads)).toBeGreaterThan(reads);
  await expect(page.locator("body")).toHaveAttribute("data-wallet-ready", "true");
  await expect(input).toHaveCount(0);
  expect(await page.evaluate(() => [window.originalPassword.value, window.replacementPassword.value])).toEqual(["", ""]);
  expect(await page.evaluate(() => window.unlockRequests.length)).toBe(1);
});

for (const [destination, placeholder, draft] of [
  ["options", "https://provers.dusk.network", "https://unsaved.example"],
  ["contacts", "Name (e.g. Alice)", "Unsaved contact"],
]) {
  test(`a late successful unlock preserves the active ${destination} draft`, async ({ page }) => {
    await page.getByPlaceholder("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Unlock", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.unlockRequests.length)).toBe(1);
    await page.getByTitle("Options", { exact: true }).click();
    await expect(page.getByText("Settings", { exact: true })).toBeVisible();
    if (destination === "contacts") {
      await page.evaluate(async () => {
        window.uiState.route = "contacts";
        await window.renderPopup();
      });
      await page.getByRole("button", { name: "New contact", exact: true }).click();
    }
    const field = page.getByPlaceholder(placeholder, { exact: true });
    await field.fill(draft);
    await field.evaluate(el => { window.draftField = el; });
    await page.evaluate(() => {
      window.overview.isUnlocked = true;
      window.unlockReply.resolve({ ok: true });
    });
    await expect.poll(() => page.evaluate(() => window.originalButton.textContent)).toBe("Unlock");
    expect(await page.evaluate(() => ({
      needsRefresh: window.uiState.needsRefresh,
      password: window.originalPassword.value,
    }))).toEqual({ needsRefresh: true, password: "" });
    await expect(field).toHaveValue(draft);
    await expect(field).toBeFocused();
    expect(await field.evaluate(el => el === window.draftField)).toBe(true);
    if (destination === "options") {
      await page.getByRole("button", { name: "← Back", exact: true }).click();
      await expect(page.locator("body")).toHaveAttribute("data-wallet-ready", "true");
      await expect(page.getByPlaceholder("Password", { exact: true })).toHaveCount(0);
    }
  });
}

for (const destination of ["options", "contacts", "reset"]) {
  test(`leaving for ${destination} clears the old input and ignores a late unlock error`, async ({ page }) => {
    const input = page.getByPlaceholder("Password", { exact: true });
    await input.fill(PASSWORD);
    await input.press("Enter");
    await expect.poll(() => page.evaluate(() => window.unlockRequests.length)).toBe(1);
    await page.evaluate(async destination => {
      window.uiState.route = destination === "reset" ? "home" : destination;
      if (destination === "reset") window.overview.hasVault = false;
      await window.renderPopup({ forceRefresh: true });
    }, destination);
    await expect(input).toHaveCount(0);
    expect(await page.evaluate(() => [window.originalPassword.isConnected, window.originalPassword.value])).toEqual([false, ""]);
    await page.evaluate(async () => {
      window.uiState.route = "home";
      window.overview.hasVault = true;
      await window.renderPopup({ forceRefresh: true });
    });
    await input.fill(PASSWORD);
    await page.evaluate(() => window.unlockReply.resolve({ error: { message: "Abandoned unlock" } }));
    await expect.poll(() => page.evaluate(() => window.originalButton.textContent)).toBe("Unlock");
    await expect(input).toHaveValue(PASSWORD);
    await expect(input).toBeEnabled();
    await expect(page.locator(".toast")).toHaveCount(0);
    // Detached handlers cannot submit another unlock.
    await page.evaluate(() => window.originalButton.dispatchEvent(new MouseEvent("click")));
    expect(await page.evaluate(() => window.unlockRequests.length)).toBe(1);
  });
}
