import { test, expect, devices } from "@playwright/test";

// The popup as Firefox for Android shows it: a page of its own on a phone,
// 412 CSS px wide. Renderer-only: no vault, keys, node or transactions.
const { defaultBrowserType, ...pixel } = devices["Pixel 7"];
void defaultBrowserType;
test.use(pixel);

const ACCOUNT =
  "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927";
const TO =
  "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";

async function popupOn(page, route, extra = {}, over = {}) {
  await page.route("**/phone/popup.html", (r) => r.fulfill({
    contentType: "text/html",
    // The popup's shell, its top bar as popup.html has it.
    body: '<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover"><link rel="stylesheet" href="/ui.css"><body class="page--popup"><div class="panel"><header class="panel-header"><div class="brand"><div class="brand-mark" aria-hidden="true"><img class="brand-mark__glyph" src="/icons/dusk-glyph.svg" alt=""></div><button class="panel-subtitle network-pill" id="network-pill" type="button"><span class="network-pill__label"></span><span class="network-pill__chev" aria-hidden="true">▾</span></button></div><div class="header-actions" id="header-actions"></div></header><main class="panel-content"><div id="app"></div></main></div></body>',
  }));
  await page.route("**/src/wallet/localBus.js*", (r) => r.fulfill({
    contentType: "text/javascript",
    body: "export const localSend = message => window.testSend(message);",
  }));
  // Nothing goes to a node.
  await page.route(/nodes\.dusk\.network/, (r) => r.abort());
  await page.goto("/phone/popup.html");
  await page.evaluate(async ({ route, extra, over, ACCOUNT }) => {
    window.browser = {
      runtime: { id: "renderer-test", sendMessage: (m) => window.testSend(m), onMessage: { addListener() {} } },
      tabs: { query: async () => [] },
    };
    window.testSend = async (message) => {
      if (message.type === "DUSK_UI_OVERVIEW") {
        return {
          hasVault: true, isUnlocked: true, networkName: "Testnet", nodeUrl: "https://testnet.nodes.dusk.network",
          accounts: [ACCOUNT], addresses: [], selectedAccountIndex: 0, accountCount: 1, txs: [],
          balance: { value: "740900000" }, shieldedBalance: { value: "0", spendable: "0" },
          ...over,
        };
      }
      if (message.type === "DUSK_UI_GET_CACHED_GAS_PRICE") return { ok: true, result: { min: "1", median: "1", max: "1" } };
      return { ok: true, result: null };
    };
    const { state } = await import("/src/ui/popup/state.js");
    Object.assign(state, { route, addressBook: { ...state.addressBook, loaded: true, items: [] }, ...extra });
    const { render } = await import("/src/ui/popup/app.js");
    await render();
  }, { route, extra, over, ACCOUNT });
}

test("fills the phone's width, as Chen and Marek's popup didn't", async ({ page }) => {
  await popupOn(page, "home");
  await expect(page.locator(".balance-split")).toBeVisible();
  const [panel, width] = await page.evaluate(() => [document.querySelector(".panel").getBoundingClientRect().width, window.innerWidth]);
  expect(panel).toBe(width);
});

// The wallet's full view on a computer, its top bar a sidebar: the shell full.html has.
async function fullViewOn(page, over = {}) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.route("**/phone/full.html", (r) => r.fulfill({
    contentType: "text/html",
    body: '<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover"><link rel="stylesheet" href="/ui.css"><body class="page--full"><div class="full-wrap"><div class="panel"><header class="panel-header"><div class="brand"><div class="brand-mark" aria-hidden="true"><img class="brand-mark__glyph" src="/icons/dusk-glyph.svg" alt=""></div><div class="brand-text"><div class="panel-title">Dusk Wallet</div></div><button class="panel-subtitle network-pill" id="network-pill" type="button"><span class="network-pill__label"></span><span class="network-pill__chev" aria-hidden="true">▾</span></button></div><nav class="full-nav" aria-label="Wallet"><button class="full-nav-item" type="button" data-route="home">Dashboard</button><button class="full-nav-item" type="button" data-route="activity">Activity</button></nav><div class="header-actions" id="header-actions"></div></header><main class="panel-content"><div id="app"></div></main></div></div></body>',
  }));
  await page.route("**/src/wallet/localBus.js*", (r) => r.fulfill({
    contentType: "text/javascript",
    body: "export const localSend = message => window.testSend(message);",
  }));
  await page.route(/nodes\.dusk\.network/, (r) => r.abort());
  await page.goto("/phone/full.html");
  await page.evaluate(async ({ over, ACCOUNT }) => {
    window.testSend = async (message) => {
      if (message.type === "DUSK_UI_OVERVIEW") {
        return {
          hasVault: true, isUnlocked: true, networkName: "Testnet", nodeUrl: "https://testnet.nodes.dusk.network",
          accounts: [ACCOUNT], addresses: [], selectedAccountIndex: 0, accountCount: 1, txs: [],
          balance: { value: "740900000" }, shieldedBalance: { value: "0", spendable: "0" },
          ...over,
        };
      }
      return { ok: true, result: null };
    };
    const { state } = await import("/src/ui/popup/state.js");
    Object.assign(state, { route: "home", addressBook: { ...state.addressBook, loaded: true, items: [] } });
    const { render } = await import("/src/ui/popup/app.js");
    await render();
  }, { over, ACCOUNT });
}

// Astra's: in the full view's sidebar, the line under the network's pill sat over the pill.
test("puts Can't reach the network under the pill in the full view's sidebar, over nothing", async ({ page }) => {
  await fullViewOn(page, { networkStatus: { nodeStatus: "offline", nodeUrl: "https://testnet.nodes.dusk.network" } });
  const words = page.locator(".network-word");
  await expect(words).toBeVisible();
  await expect(words).not.toBeEmpty();
  const [pill, said, nav] = [await page.locator("#network-pill").boundingBox(), await words.boundingBox(), await page.locator(".full-nav").boundingBox()];
  // Under the pill, clear of it, and above the menu.
  expect(said.y).toBeGreaterThanOrEqual(pill.y + pill.height);
  expect(said.y + said.height).toBeLessThanOrEqual(nav.y);
});

// Amélie's: the word beside the network squeezed her profile's name to "P".
test("keeps the profile's name whole while the network can't be reached, the words on a line of their own", async ({ page }) => {
  await page.setViewportSize({ width: 380, height: 600 });
  await popupOn(page, "home", {}, { networkStatus: { nodeStatus: "offline", nodeUrl: "https://testnet.nodes.dusk.network" } });
  const words = page.locator(".network-word");
  await expect(words).toBeVisible();
  await expect(words).not.toBeEmpty();
  const name = page.locator(".account-chip .chip-text");
  await expect(name).toHaveText("Profile 1");
  // All of the name in view, none of it cut.
  expect(await name.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  // The words under the network's name, not beside it.
  const [pill, said] = [await page.locator("#network-pill").boundingBox(), await words.boundingBox()];
  expect(said.y).toBeGreaterThanOrEqual(pill.y + pill.height - 1);
});

test("shows Send's recipient whole, start to end, rather than its end alone", async ({ page }) => {
  await popupOn(page, "send", { draft: { to: TO, privacy: "public", amountDusk: "", memo: "" } });
  const to = page.locator(".to-input-wrap textarea");
  await expect(to).toHaveValue(TO);
  // Send is drawn again as the history comes in, its field anew: measured in the page, from what's drawn then,
  // and again till that holds, as the chip's test below does. Found first and measured after, the field could be
  // the one just taken away, with no size or style at all (0 against NaN, 1 run in 3 here, 5 in 6 on main).
  await expect(async () => {
    const box = await page.evaluate(() => {
      const el = document.querySelector(".to-input-wrap textarea");
      return el ? { scroll: el.scrollHeight, client: el.clientHeight, wide: el.scrollWidth - el.clientWidth, line: parseFloat(getComputedStyle(el).lineHeight) } : null;
    });
    expect(box).not.toBeNull();
    // On more than one line, with nothing of it out of view.
    expect(box.client).toBeGreaterThan(box.line * 2);
    expect(box.scroll).toBeLessThanOrEqual(box.client + 1);
    expect(box.wide).toBeLessThanOrEqual(0);
  }).toPass();
  // Enter goes on to the amount, never a line break.
  await to.focus();
  await to.press("Enter");
  await expect(to).toHaveValue(TO);
});

test("gives the recovery phrase's Reveal and Copy a finger's height, as Amélie's 28 px ones weren't", async ({ page }) => {
  // A public BIP39 test phrase, never a real wallet's.
  const mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  await popupOn(page, "onboard_create_phrase", { onboard: { mode: "create", mnemonic, password: "", reveal: false } }, { hasVault: false, isUnlocked: false });
  // Measured once the screen has come in: while it slides in (viewIn), a box
  // reads a fraction of a pixel off, as 43.99994.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().endTime !== Infinity)
        .map((a) => a.finished.catch(() => {}))
    )
  );
  for (const name of ["Reveal", "Copy"]) {
    const box = await page.locator(".phrase-tools button", { hasText: name }).boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
});

// Chen's: in the Android app every word typed with a space went in the first box. A phone's keyboard sends a space
// as text, with no key for it, and composes the word it suggests for before it commits it.
test("moves on to the next word's box at a space, sent as text, as a key or with a composed word, and spreads words typed together", async ({ page }) => {
  await popupOn(page, "onboard_import", { onboard: { mode: "import", mnemonic: null, password: "", reveal: false } }, { hasVault: false, isUnlocked: false });
  const box = (n) => page.getByLabel(`Word ${n}`, { exact: true });
  await box(1).focus();
  await page.keyboard.insertText("kiwi");
  await page.keyboard.insertText(" ");
  await expect(box(2)).toBeFocused();
  await page.keyboard.type("lemon ");
  await expect(box(3)).toBeFocused();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "apple", selectionStart: 5, selectionEnd: 5 });
  await cdp.send("Input.insertText", { text: "apple " });
  await expect(box(4)).toBeFocused();
  // Several words at once, as voice typing puts them in.
  await page.keyboard.insertText("pear grape mango ");
  await expect(box(7)).toBeFocused();
  const words = await page.locator(".srp-word-input input").evaluateAll((boxes) => boxes.slice(0, 7).map((b) => b.value));
  expect(words).toEqual(["kiwi", "lemon", "apple", "pear", "grape", "mango", ""]);
});

// Hein's: the boxes suggest words from the wallet's own list as they're typed in, under the box, above the
// keyboard on a phone; a tap takes one and goes on to the next box, the keyboard kept up.
test("suggests the words a box's letters start under its row, a finger's size, above the keyboard, and a tap takes one", async ({ page }) => {
  await popupOn(page, "onboard_import", { onboard: { mode: "import", mnemonic: null, password: "", reveal: false } }, { hasVault: false, isUnlocked: false });
  const box = (n) => page.getByLabel(`Word ${n}`, { exact: true });
  await box(11).tap();
  await page.keyboard.insertText("w");
  await page.keyboard.insertText("a");
  const list = page.getByRole("listbox", { name: "Suggested words" });
  const chips = list.getByRole("option");
  await expect(chips).toHaveText(["wage", "wagon", "wait", "walk"]);
  await expect(chips.first()).toHaveAttribute("aria-selected", "true");
  const rect = (el) => el.evaluate((node) => node.getBoundingClientRect().toJSON());
  const top = await clearOfKeyboard(page);
  await expect.poll(async () => (await rect(list)).bottom).toBeLessThanOrEqual(top);
  expect((await rect(list)).top).toBeGreaterThan((await rect(box(12))).bottom);
  expect((await rect(box(11))).top).toBeGreaterThanOrEqual(0);
  expect((await rect(chips.first())).height).toBeGreaterThanOrEqual(40);
  await chips.nth(3).tap();
  await expect(box(12)).toBeFocused();
  expect(await box(11).inputValue()).toBe("walk");
  await expect(list).toBeHidden();
  // Letters that start no word: said at once, under the box.
  await page.keyboard.insertText("x");
  await page.keyboard.insertText("q");
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(box(12)).toHaveAttribute("aria-invalid", "true");
});

test("keeps a contact's address at the field's whole width, its chip on a line above it, as Sofía's squeezed into six letters wasn't", async ({ page }) => {
  await popupOn(page, "send", {
    draft: { to: TO, privacy: "public", amountDusk: "", memo: "" },
    addressBook: { loaded: true, items: [{ id: "c1", name: "Chen Studio Lumen", address: TO }] },
  });
  const chip = page.locator(".to-input-wrap .to-chip");
  await expect(chip).toContainText("Chen Studio Lumen");
  await expect(chip).toBeVisible();
  // Send is drawn again as the history comes in, its field and chip anew: the two are measured together, in the
  // page, from what's drawn then, and again till that holds. Measured one after the other, the chip could be the
  // one just taken away.
  await expect(async () => {
    const box = await page.evaluate(() => {
      const el = document.querySelector(".to-input-wrap textarea");
      const badge = el?.closest(".to-input-wrap")?.querySelector(".to-chip");
      if (!el || !badge || badge.hidden) return null;
      const style = getComputedStyle(el);
      const field = el.getBoundingClientRect();
      const chipBox = badge.getBoundingClientRect();
      return {
        chipBottom: chipBox.bottom,
        chipHeight: chipBox.height,
        textWidth: el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
        fieldWidth: field.width,
        textTop: field.top + parseFloat(style.paddingTop),
        lines: Math.round((el.scrollHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) / parseFloat(style.lineHeight)),
        hidden: el.scrollHeight - el.clientHeight,
      };
    });
    expect(box).not.toBeNull();
    expect(box.chipHeight).toBeGreaterThan(0);
    // The chip over the text, not beside it; the address across the field, on a few lines, all of it in view.
    expect(box.chipBottom).toBeLessThanOrEqual(box.textTop + 1);
    expect(box.textWidth).toBeGreaterThan(box.fieldWidth * 0.8);
    expect(box.lines).toBeLessThanOrEqual(5);
    expect(box.hidden).toBeLessThanOrEqual(1);
  }).toPass();
});

// Chen's: an x between two digits drawn as a ×, by the font's contextual alternates.
test("draws addresses and amounts without the font's contextual alternates, so an x is never a ×", async ({ page }) => {
  await popupOn(page, "send", { draft: { to: TO, privacy: "public", amountDusk: "1", memo: "" } });
  // Read in one go in the page, as it's drawn now: Activity draws Send again a moment after it opens, and a
  // field found before that and read after it is no longer on the page, with no style at all.
  const ligaturesOf = (selector) => page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? getComputedStyle(el).fontVariantLigatures : "";
  }, selector);
  for (const selector of [".to-input-wrap textarea", "input.amount-field__input"]) {
    await expect.poll(() => ligaturesOf(selector), { message: selector }).toMatch(/no-contextual|none/);
  }
});

// Where the keyboard starts when the browser says nothing of it, as Firefox's
// add-on page doesn't: the page's top half stays clear of it (keyboard.js).
const clearOfKeyboard = (page) => page.evaluate(() => document.documentElement.clientHeight / 2);

// Amélie's: Review, Back to Send, then Memo tapped first, under the keyboard with Review.
test("keeps Memo and Review above the keyboard on Send opened again from its Review", async ({ page }) => {
  await popupOn(page, "send", { draft: { to: TO, privacy: "public", amountDusk: "0.02", memo: "" } });
  await page.getByRole("button", { name: "Review" }).click();
  // Review's Confirm, whatever it says.
  await expect(page.locator("#app button.btn-primary")).toBeVisible();
  await page.getByRole("button", { name: "← Back" }).click();
  const memo = page.getByLabel("Memo");
  await expect(memo).toBeVisible();
  await memo.focus();
  const top = await clearOfKeyboard(page);
  const bottom = (el) => el.evaluate((node) => node.getBoundingClientRect().bottom);
  await expect.poll(() => bottom(memo)).toBeLessThanOrEqual(top);
  expect(await bottom(page.getByRole("button", { name: "Review" }))).toBeLessThanOrEqual(top);
  expect(await memo.evaluate((node) => node.getBoundingClientRect().top)).toBeGreaterThanOrEqual(0);
});

// Chen's, Sofía's and Amélie's: the request's Amount and Memo above the keyboard, Copy request under it.
test("keeps Copy request above the keyboard with the request's Memo", async ({ page }) => {
  await popupOn(page, "receive", { receive: { tab: "public", requestOpen: true, amountDusk: "0.05", memo: "", context: null } });
  const memo = page.locator(".receive-request").getByLabel("Memo");
  await expect(memo).toBeVisible();
  await memo.focus();
  const top = await clearOfKeyboard(page);
  const copy = page.getByRole("button", { name: "Copy request", exact: true });
  await expect.poll(() => copy.evaluate((node) => node.getBoundingClientRect().bottom)).toBeLessThanOrEqual(top);
  expect(await memo.evaluate((node) => node.getBoundingClientRect().top)).toBeGreaterThanOrEqual(0);
});

// The strip a phone's keyboard leaves when the browser says nothing of it: the
// top half upright, the top fifth sideways (keyboard.js).
const keyboardStrip = (page) =>
  page.evaluate(() => document.documentElement.clientHeight * (String(screen.orientation?.type ?? "").startsWith("landscape") ? 0.2 : 0.5));
const boxOf = (locator) => locator.evaluate((node) => node.getBoundingClientRect().toJSON());
const twoFrames = (page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));

// An amount over the balance, or one that reads two ways, typed on a phone turned sideways: what's said of it
// went above the keyboard with the button after it, and the amount being typed went out of view above them.
test("keeps the amount being typed in above the keyboard, with what's said of it, on a phone turned sideways", async ({ page }) => {
  await page.setViewportSize({ width: 915, height: 412 });
  const screens = [
    { route: "send", extra: { draft: { to: TO, privacy: "public", amountDusk: "", memo: "" } }, amount: () => page.getByLabel("Amount", { exact: true }), typed: ["999999", "1,234"] },
    { route: "receive", extra: { receive: { tab: "public", requestOpen: true, amountDusk: "", memo: "", context: null } }, amount: () => page.locator(".receive-request").getByLabel("Amount"), typed: ["1,234"] },
  ];
  for (const { route, extra, amount: field, typed } of screens) {
    await popupOn(page, route, extra);
    const amount = field();
    for (const text of typed) {
      await amount.focus();
      await amount.fill("");
      await page.keyboard.type(text);
      // What's said of the amount, tied to it, then the frames the page moves in.
      await expect.poll(() => amount.getAttribute("aria-describedby"), { message: `${route} ${text}` }).toBeTruthy();
      const said = page.locator(`#${await amount.getAttribute("aria-describedby")}`);
      await expect(said).toBeVisible();
      await twoFrames(page);
      const strip = await keyboardStrip(page);
      // A question asked of the amount, a button for each reading: the buttons above the keyboard, as what must be
      // answered; else the amount being typed.
      const choices = said.getByRole("button");
      const shown = (await choices.count()) ? await choices.all() : [amount];
      if (text === "1,234") expect(shown.length, `${route} ${text}`).toBe(2);
      for (const el of shown) {
        const box = await boxOf(el);
        expect(box.top, `${route} ${text}`).toBeGreaterThanOrEqual(0);
        expect(box.bottom, `${route} ${text}`).toBeLessThanOrEqual(strip);
      }
    }
  }
});

// The same payment, waiting to go out, said as its memo is typed: Review and as much of what's said as fits above
// the keyboard, a phone turned sideways too. A warning takes the page on to its button; what's said of the field
// itself stays with the field.
test("keeps Review above the keyboard with a warning said as the memo is typed, on a phone turned sideways", async ({ page }) => {
  await page.setViewportSize({ width: 915, height: 412 });
  const waiting = { sendId: "s1", profileIndex: 0, waiting: true, to: TO, lux: "10000000", feeLux: "2500000", memo: "Invoice 2026-115", privacy: "public", at: Date.now() - 60_000 };
  await popupOn(page, "send", { draft: { to: TO, privacy: "public", amountDusk: "0.01", memo: "" } }, { waitingSends: [waiting] });
  const memo = page.getByLabel("Memo");
  await memo.focus();
  await page.keyboard.type("Invoice 2026-115");
  const warning = page.getByRole("alert");
  await expect(warning).toBeVisible();
  await twoFrames(page);
  const strip = await keyboardStrip(page);
  const review = await boxOf(page.getByRole("button", { name: "Review" }));
  expect(review.top).toBeGreaterThanOrEqual(0);
  expect(review.bottom).toBeLessThanOrEqual(strip);
  const said = await boxOf(warning);
  expect(said.bottom).toBeGreaterThan(0);
  expect(said.top).toBeLessThan(strip);
});

// Sofía's and Lena's: in landscape, Review's Confirm bar covered the address, fee and total until a scroll.
test("puts Review's Confirm after its details on a phone turned sideways, over none of them", async ({ page }) => {
  await page.setViewportSize({ width: 915, height: 412 });
  await popupOn(page, "confirm", { draft: { to: TO, privacy: "public", amountDusk: "0.01", amountLux: "10000000", memo: "Invoice 2026-115" } });
  const confirm = page.locator("#app button.btn-primary");
  await expect(confirm).toBeVisible();
  const [confirmTop, detailsBottom] = await page.evaluate(() => {
    const top = (el) => el.getBoundingClientRect().top + document.querySelector(".panel-content").scrollTop;
    const button = document.querySelector("#app button.btn-primary");
    const details = [...document.querySelectorAll("#app .kv")];
    return [top(button), Math.max(...details.map((el) => top(el) + el.getBoundingClientRect().height))];
  });
  expect(confirmTop).toBeGreaterThanOrEqual(detailsBottom);
});

// The Android app, as index.html has it: the full view's shell as a column, its top bar over the page as it scrolls,
// the app's internals there (its store kept in the page). Renderer-only, as above.
async function appOn(page, route, extra = {}) {
  await page.addInitScript(() => {
    const store = new Map();
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
      transformCallback: () => 1,
      invoke: async (cmd, args = {}) => {
        if (cmd === "plugin:store|load" || cmd === "plugin:store|get_store") return 1;
        if (cmd === "plugin:store|get") return [store.get(args.key), store.has(args.key)];
        if (cmd === "plugin:store|set") return void store.set(args.key, args.value);
        if (cmd === "plugin:store|has") return store.has(args.key);
        if (cmd === "plugin:store|delete") return store.delete(args.key);
        if (cmd === "plugin:store|entries") return [...store.entries()];
        if (cmd === "plugin:store|keys") return [...store.keys()];
        if (cmd === "plugin:store|values") return [...store.values()];
        if (cmd === "plugin:store|length") return store.size;
        return null;
      },
    };
  });
  await page.route("**/phone/app.html", (r) => r.fulfill({
    contentType: "text/html",
    body: '<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover"><link rel="stylesheet" href="/ui.css"><body class="page--full"><div class="full-wrap"><div class="panel"><header class="panel-header"><div class="brand"><div class="brand-mark" aria-hidden="true"><img class="brand-mark__glyph" src="/icons/dusk-glyph.svg" alt=""></div><div class="brand-text"><div class="panel-title">Dusk Wallet</div></div><button class="panel-subtitle network-pill" id="network-pill" type="button"><span class="network-pill__label"></span><span class="network-pill__chev" aria-hidden="true">▾</span></button></div><div class="header-actions" id="header-actions"></div></header><main class="panel-content"><div id="app"></div></main></div></div></body>',
  }));
  await page.route("**/src/wallet/localBus.js*", (r) => r.fulfill({
    contentType: "text/javascript",
    body: "export const localSend = message => window.testSend(message);",
  }));
  await page.route(/nodes\.dusk\.network/, (r) => r.abort());
  await page.goto("/phone/app.html");
  await page.evaluate(async ({ route, extra, ACCOUNT }) => {
    window.testSend = async (message) => {
      if (message.type === "DUSK_UI_OVERVIEW") {
        return {
          hasVault: true, isUnlocked: true, networkName: "Testnet", nodeUrl: "https://testnet.nodes.dusk.network",
          accounts: [ACCOUNT], addresses: [], selectedAccountIndex: 0, accountCount: 1, txs: [],
          balance: { value: "1234567890000" }, shieldedBalance: { value: "0", spendable: "0" },
        };
      }
      if (message.type === "DUSK_UI_GET_CACHED_GAS_PRICE") return { ok: true, result: { min: "1", median: "1", max: "1" } };
      return { ok: true, result: null };
    };
    const { state } = await import("/src/ui/popup/state.js");
    Object.assign(state, { route, addressBook: { ...state.addressBook, loaded: true, items: [] }, ...extra });
    const { render } = await import("/src/ui/popup/app.js");
    await render();
  }, { route, extra, ACCOUNT });
  await expect(page.locator("body")).toHaveAttribute("data-runtime", "tauri");
}

// The app's WebView says what its keyboard covers: the visual viewport gets shorter by it (`px`, 0 for none), as
// tall as the page otherwise, whatever the window's made. The keyboard stays so at least a frame, as a real one
// does, for the page to see it.
const keyboardUp = (page, px) =>
  page.evaluate((px) => {
    const vv = window.visualViewport;
    Object.defineProperty(vv, "height", { configurable: true, get: () => document.documentElement.clientHeight - px });
    vv.dispatchEvent(new Event("resize"));
    return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  }, px);
// The phone's screen as the window says it: which way round it's held, and as tall as `tall`, else the window.
const phoneScreen = (tall = 0) => {
  Object.defineProperty(Screen.prototype, "height", { configurable: true, get: () => tall || window.innerHeight });
  Object.defineProperty(Screen.prototype, "width", { configurable: true, get: () => window.innerWidth });
  Object.defineProperty(ScreenOrientation.prototype, "type", { configurable: true, get: () => (window.innerWidth > window.innerHeight ? "landscape-primary" : "portrait-primary") });
};
const typingSideways = (page) => page.evaluate(() => document.documentElement.hasAttribute("data-typing-sideways"));

// The app turned sideways at its column's widths (860 px or less), its top bar over the page: typing "1,234" with
// the keyboard up leaves a 94 px strip, and its two answers went half under the keyboard with the bar shown.
for (const [width, height] of [[800, 360], [844, 390]]) {
  test.describe(`the app turned sideways at ${width} × ${height}`, () => {
    test.use({ viewport: { width, height }, screen: { width, height } });
    test("gives the top bar's room to the amount's answers, both whole above the keyboard", async ({ page }) => {
      await appOn(page, "send", { draft: { to: TO, privacy: "public", amountDusk: "", memo: "" } });
      const amount = page.getByLabel("Amount", { exact: true });
      await amount.focus();
      await keyboardUp(page, height - 94);
      await page.keyboard.type("1,234");
      const choices = page.locator(".amount-question__choice");
      await expect(choices).toHaveCount(2);
      await expect.poll(() => typingSideways(page)).toBe(true);
      await twoFrames(page);
      // What's left above the keyboard: from the top of the page that scrolls to the keyboard's top.
      const top = await page.evaluate(() => Math.max(0, document.querySelector(".panel-content").getBoundingClientRect().top));
      for (const choice of await choices.all()) {
        const box = await boxOf(choice);
        expect(box.top).toBeGreaterThanOrEqual(top);
        expect(box.bottom).toBeLessThanOrEqual(94);
      }
    });
  });
}

// A window in a part of the screen, sideways, shorter than the screen without a keyboard (800 × 260 of one 420 px
// tall): the keyboard up, then down with the amount still typed in, and the top bar back.
test.describe("the app in a window shorter than its screen", () => {
  test.use({ viewport: { width: 800, height: 260 } });
  test("brings the top bar back once the keyboard's down, the amount still typed in", async ({ page }) => {
    // The screen, as the phone says it: on its side, 420 px tall, more than the window.
    await page.addInitScript(phoneScreen, 420);
    await appOn(page, "send", { draft: { to: TO, privacy: "public", amountDusk: "", memo: "" } });
    const amount = page.getByLabel("Amount", { exact: true });
    await amount.focus();
    await keyboardUp(page, 170);
    await expect.poll(() => typingSideways(page)).toBe(true);
    await expect(page.locator(".panel-header")).toBeHidden();
    await keyboardUp(page, 0);
    await expect.poll(() => typingSideways(page)).toBe(false);
    await expect(page.locator(".panel-header")).toBeVisible();
    await expect(amount).toBeFocused();
  });
});

// An ordinary phone held upright: the top bar stays while the amount's typed in, the keyboard up and down.
test("keeps the app's top bar on a phone held upright, the keyboard up or down", async ({ page }) => {
  await appOn(page, "send", { draft: { to: TO, privacy: "public", amountDusk: "", memo: "" } });
  const amount = page.getByLabel("Amount", { exact: true });
  await amount.focus();
  await keyboardUp(page, 336);
  await page.keyboard.type("1,234");
  await expect(page.locator(".amount-question__choice")).toHaveCount(2);
  expect(await typingSideways(page)).toBe(false);
  await expect(page.locator(".panel-header")).toBeVisible();
  await keyboardUp(page, 0);
  await expect(page.locator(".panel-header")).toBeVisible();
});

// A window in a split screen made 100 px shorter, a keyboard opened and closed in it before: the window's new
// height, not a keyboard. The top bar stays, and goes and comes back with a keyboard after.
test.describe("the app in a split screen made shorter", () => {
  test.use({ viewport: { width: 800, height: 420 } });
  test("keeps the top bar once the window's made shorter with no keyboard, and hides it only for one", async ({ page }) => {
    await page.addInitScript(phoneScreen);
    await appOn(page, "send", { draft: { to: TO, privacy: "public", amountDusk: "", memo: "" } });
    const amount = page.getByLabel("Amount", { exact: true });
    await amount.focus();
    await keyboardUp(page, 300);
    await expect.poll(() => typingSideways(page)).toBe(true);
    await keyboardUp(page, 0);
    await expect.poll(() => typingSideways(page)).toBe(false);
    // A moment on, the divider moved: the window 100 px shorter, no keyboard, the amount still focused.
    await page.waitForTimeout(1600);
    await page.setViewportSize({ width: 800, height: 320 });
    await keyboardUp(page, 0);
    await expect.poll(() => typingSideways(page)).toBe(false);
    await expect(page.locator(".panel-header")).toBeVisible();
    // A keyboard again: the bar's room given to it, then the bar back.
    await keyboardUp(page, 226);
    await expect.poll(() => typingSideways(page)).toBe(true);
    await keyboardUp(page, 0);
    await expect.poll(() => typingSideways(page)).toBe(false);
    await expect(page.locator(".panel-header")).toBeVisible();
    await expect(amount).toBeFocused();
  });
});

// A keyboard that makes the page itself shorter (the visual viewport as tall as the page), up as the phone's turned:
// still up once turned, though the first height sideways is already the keyboard's, and gone once the page is a
// keyboard's height taller again.
test("hides the top bar for a keyboard that makes the page shorter, through a turn, and brings it back once it's gone", async ({ page }) => {
  await page.addInitScript(phoneScreen);
  await page.setViewportSize({ width: 360, height: 800 });
  await appOn(page, "send", { draft: { to: TO, privacy: "public", amountDusk: "", memo: "" } });
  await keyboardUp(page, 0);
  const amount = page.getByLabel("Amount", { exact: true });
  await amount.focus();
  // Upright, the keyboard up: the page 336 px shorter, the top bar where it is.
  await page.setViewportSize({ width: 360, height: 464 });
  await twoFrames(page);
  expect(await typingSideways(page)).toBe(false);
  await expect(page.locator(".panel-header")).toBeVisible();
  // Turned with it up: the strip sideways is 94 px, the bar's room given to it.
  await page.setViewportSize({ width: 800, height: 94 });
  await expect.poll(() => typingSideways(page)).toBe(true);
  await expect(page.locator(".panel-header")).toBeHidden();
  // The keyboard goes: the page 266 px taller, the bar back.
  await page.setViewportSize({ width: 800, height: 360 });
  await expect.poll(() => typingSideways(page)).toBe(false);
  await expect(page.locator(".panel-header")).toBeVisible();
  await expect(amount).toBeFocused();
});
