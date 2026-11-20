import { afterEach, describe, expect, it, vi } from "vitest";

import { accessibleName, installFakeDom, isShown, settle, typeInto } from "../testing/fakeDom.js";

vi.mock("../../wallet/bus.js", () => ({ send: vi.fn() }));

const ACCOUNT =
  "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927";
const OTHER =
  "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";
// Two wallets, the first one open; a test may add one, as another window would.
let overview;
const OVERVIEW = {
  hasVault: true,
  isUnlocked: true,
  networkName: "Testnet",
  nodeUrl: "https://testnet.nodes.dusk.network",
  accounts: [ACCOUNT],
  accountCount: 1,
  selectedAccountIndex: 0,
  balance: { value: "0" },
  walletKey: "w1",
  wallets: [
    { key: "w1", n: 1, name: "", walletId: ACCOUNT, accounts: [ACCOUNT], accountNames: {}, active: true },
    { key: "w2", n: 2, name: "", walletId: OTHER, accounts: [OTHER], accountNames: {}, active: false },
  ],
};
// A public BIP39 test phrase, for the words typed in.
const WORDS = "legal winner thank year wave sausage worth useful legal winner thank yellow".split(" ");

afterEach(() => {
  vi.unstubAllGlobals();
});

const flush = async () => {
  for (let i = 0; i < 5; i++) await settle();
};

// The popup on `route`, with the wallet answering as `answer` says, and the
// wallet's own messages to it delivered by `deliver`.
async function popupAt(route, extra = {}, answer = async () => ({}), over = {}) {
  const dom = installFakeDom({ pathname: "/popup.html" });
  dom.document.body.innerHTML = "";
  const actions = dom.document.createElement("div");
  actions.id = "header-actions";
  const app = dom.document.createElement("div");
  app.id = "app";
  dom.document.body.append(actions, app);
  let onMessage = null;
  vi.stubGlobal("browser", {
    runtime: { id: "dusk-wallet", sendMessage: () => {}, onMessage: { addListener: (fn) => (onMessage = fn) } },
  });
  vi.resetModules();
  const { send } = await import("../../wallet/bus.js");
  send.mockReset();
  overview = { ...OVERVIEW, ...over };
  send.mockImplementation(async (message) => (message.type === "DUSK_UI_OVERVIEW" ? overview : answer(message)));
  const { state } = await import("./state.js");
  Object.assign(state, { route, ...extra });
  const { render } = await import("./app.js");
  await render();
  await flush();
  return {
    app,
    state,
    render,
    deliver: async (message) => {
      onMessage(message);
      await flush();
    },
  };
}

// A form's fields by what they are, not what they're called: a word's box by its
// number, a password by its type.
const WORD = (n) => `input[aria-label="Word ${n}"]`;
const PASSWORD = "input[type=password]";
const fieldsOf = (app, selectors) => app.querySelectorAll(selectors.join(", "));
const typeAll = (fields) => fields.forEach((f, i) => typeInto(f, accessibleName(f).startsWith("Word") ? WORDS[i] : "typed password"));
// A figure exactly as written: not inside a longer number, not signed or bounded unless written so, and not followed by
// more digits, letters or a decimal part (1.0025 ≠ 11.0025, 0.005 ≠ −0.005, 2,000,000 ≠ 2,000,000.5, BNB ≠ BNBX).
const exactly = (text) => new RegExp(`(?<![\\d.,+\\-−<>≤≥~])${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\dA-Za-z]|[.,]\\d)`);
// A form's main button, whatever it says: the primary or destructive one shown.
const mainButton = (app) => app.querySelectorAll("button.btn-primary, button.btn-destructive").find(isShown);
// The error shown under a field, as the field is described by it.
const errorOf = (field) =>
  (field.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => field.ownerDocument.getElementById(id))
    .filter((el) => el?.classList.contains("field-error") && isShown(el))
    .map((el) => el.textContent)
    .join("");

// Each wallet form, with the fields it's filled in by.
const FORMS = [
  ["Change password", "change_password", {}, [PASSWORD]],
  ["Remove wallet", "wallet_remove", { walletRemove: "w2" }, [PASSWORD]],
  ["Password on big sends", "send_password", {}, ["#send-password-amount"]],
  ["Add wallet's import", "wallet_add_import", { onboard: { mode: "import", mnemonic: null, password: "", reveal: false, adding: true } }, [WORD(1), WORD(2), PASSWORD]],
  ["Add wallet's new phrase, checked", "wallet_add_confirm", { onboard: { mode: "create", mnemonic: WORDS.join(" "), password: "", reveal: false, adding: true, checkPlaces: [1, 2, 7] } }, [WORD(1), WORD(2), PASSWORD]],
];

describe("a wallet form being filled in", () => {
  it.each(FORMS)("%s is dropped, with what was typed, on another wallet, on leaving it and on a lock", async (_, route, extra, selectors) => {
    const t = await popupAt(route, extra);
    let fields = fieldsOf(t.app, selectors);
    typeAll(fields);
    // Each field there, and typed in.
    expect(fields.length).toBeGreaterThan(0);
    expect(fields.every((f) => f.value)).toBe(true);

    // Another wallet opened, in another window.
    await t.deliver({ type: "DUSK_UI_WALLET_CHANGED" });
    expect(fields.map((f) => f.value).every((v) => v === "")).toBe(true);
    fields = fieldsOf(t.app, selectors);
    expect(fields.map((f) => f.value).every((v) => v === "")).toBe(true);

    // Left for Settings and back.
    typeAll(fields);
    t.state.route = "options";
    await t.render();
    Object.assign(t.state, { route, ...extra });
    await t.render();
    expect(fieldsOf(t.app, selectors).map((f) => f.value).every((v) => v === "")).toBe(true);

    // Locked: the form goes, and the unlock goes back to where it was opened from.
    typeAll(fieldsOf(t.app, selectors));
    await t.deliver({ type: "DUSK_UI_LOCK_STATE", isUnlocked: false });
    expect(t.state.route).toBe(route.startsWith("wallet_add") ? "home" : "options");
    expect(fieldsOf(t.app, selectors)).toEqual([]);
  });

  // Marek's: a browser read a word's box on Import as the screen went; nothing typed stays in the page.
  it("empties the restore's words and passwords as it's left, before the screen goes", async () => {
    const t = await popupAt("restore", {}, async () => ({}), { isUnlocked: false });
    const fields = t.app.querySelectorAll("input").filter((f) => f.closest(".mnemonic-input") || f.getAttribute("type") === "password");
    expect(fields.length).toBeGreaterThan(12);
    typeAll(fields);
    expect(fields.filter((f) => f.value).length).toBeGreaterThan(12);
    t.app.querySelector(".subnav-back").click();
    await flush();
    // Leaving clears them, so it asks first: its yes, not Cancel.
    document.querySelectorAll("[role=alertdialog] button").find((b) => !b.hasAttribute("data-back")).click();
    await flush();
    expect(t.state.route).toBe("home");
    expect(fields.some((f) => t.app.contains(f))).toBe(false);
    expect(fields.map((f) => f.value).filter(Boolean)).toEqual([]);
  });

  // Astra's: wallet A's words shown, then wallet B opened, and A's words stayed under B's name.
  it("drops a recovery phrase shown, or being read, as another wallet opens", async () => {
    const answer = { next: null };
    const t = await popupAt("recovery_phrase", {}, async (message) =>
      message.type === "DUSK_UI_RECOVERY_PHRASE" ? (answer.next ? answer.next.promise : { ok: true, result: WORDS.join(" ") }) : {}
    );
    const words = () => t.app.querySelectorAll(".srp-word-text").map((w) => w.textContent);
    const ask = async () => {
      typeInto(t.app.querySelector(PASSWORD), "the password");
      mainButton(t.app).click();
      await flush();
    };
    await ask();
    expect(words()).toEqual(WORDS);
    await t.deliver({ type: "DUSK_UI_WALLET_CHANGED" });
    expect(words()).toEqual([]);
    expect(t.app.querySelector(PASSWORD).value).toBe("");

    // Read as the wallet changes: what comes is the wallet's before, and isn't shown.
    answer.next = Promise.withResolvers();
    await ask();
    expect(mainButton(t.app).disabled).toBe(true);
    await t.deliver({ type: "DUSK_UI_WALLET_CHANGED" });
    answer.next.resolve({ ok: true, result: WORDS.join(" ") });
    await flush();
    expect(words()).toEqual([]);
    expect(mainButton(t.app).disabled).toBe(false);
  });

  it("keeps a submit under way through a wallet change, with what it says after", async () => {
    const answer = Promise.withResolvers();
    const t = await popupAt("change_password", {}, async (message) => (message.type === "DUSK_UI_CHANGE_PASSWORD" ? answer.promise : {}));
    typeAll(fieldsOf(t.app, [PASSWORD]));
    typeInto(fieldsOf(t.app, [PASSWORD])[0], "the current password");
    const change = mainButton(t.app);
    change.click();
    await flush();
    expect(change.disabled).toBe(true);

    // The same form, still under way: not drawn anew.
    await t.deliver({ type: "DUSK_UI_WALLET_CHANGED" });
    expect([t.app.contains(change), change.disabled]).toEqual([true, true]);

    answer.resolve({ error: { message: "Incorrect password" } });
    await flush();
    await t.deliver({ type: "DUSK_UI_NETWORK_CHANGED" });
    expect(t.app.querySelectorAll(".field-error").filter((el) => !el.hidden).map((el) => el.textContent)).toEqual(["Incorrect password"]);
    expect(mainButton(t.app).disabled).toBe(false);
  });
});

describe("the password on big sends, in Settings", () => {
  const saves = (answers) => answers.filter((m) => m.type === "DUSK_UI_SET_SEND_PASSWORD");
  // What its row in Settings, found by its name, says it's set to.
  const setTo = (app) => app.querySelectorAll(".settings-row").find((row) => row.textContent.startsWith("Password on big sends"))?.querySelector(".row-sub")?.textContent ?? "";

  it("turns on above an amount, only with the password, and Settings says so", async () => {
    const answers = [];
    const { app } = await popupAt("send_password", {}, async (message) => {
      answers.push(message);
      if (message.type === "DUSK_UI_SET_SEND_PASSWORD" && message.password !== "the password") return { error: { message: "Incorrect password" } };
      return { ok: true };
    });
    const on = app.querySelector("#send-password-on");
    const amount = app.querySelector("#send-password-amount");
    const password = app.querySelector(PASSWORD);
    expect(on.checked).toBe(false);
    // Off, there's nothing to save.
    expect(app.querySelector(".send-password-amount").hidden).toBe(true);
    on.checked = true;
    on.dispatchEvent(new Event("change"));
    expect(app.querySelector(".send-password-amount").hidden).toBe(false);

    // No amount, or none it can read: said under it, and nothing saved.
    for (const typed of ["", "not an amount"]) {
      typeInto(amount, typed);
      mainButton(app).click();
      await flush();
      expect([errorOf(amount), errorOf(password), saves(answers)], typed).toEqual([expect.stringMatching(/\S/), "", []]);
    }
    // An amount: then the password, said under it, and still nothing saved.
    typeInto(amount, "1 000,5".replace(",", ".").replace(" ", ""));
    mainButton(app).click();
    await flush();
    expect([errorOf(amount), errorOf(password), saves(answers)]).toEqual(["", expect.stringMatching(/\S/), []]);

    typeInto(password, "not it");
    mainButton(app).click();
    await flush();
    expect(errorOf(password)).not.toBe("");

    typeInto(password, "the password");
    mainButton(app).click();
    await flush();
    expect(saves(answers).at(-1)).toMatchObject({ password: "the password", limitLux: "1000500000000" });
    // Back in Settings, it says what it's set to.
    expect(setTo(app)).toMatch(exactly("1,000.5 DUSK"));
    expect(setTo(app)).toMatch(/above/i);
  });

  it("turns off only with the password too, and 0 asks on every send", async () => {
    const answers = [];
    const { app, state } = await popupAt("options", {}, async (message) => {
      answers.push(message);
      return { ok: true };
    }, { sendPasswordLimit: "5000000000" });
    expect(setTo(app)).toMatch(exactly("5 DUSK"));
    expect(setTo(app)).toMatch(/above/i);
    app.querySelectorAll(".settings-row").find((row) => row.textContent.startsWith("Password on big sends")).click();
    await flush();
    expect(state.route).toBe("send_password");
    const on = app.querySelector("#send-password-on");
    expect(on.checked).toBe(true);
    expect(app.querySelector("#send-password-amount").value).toBe("5");
    on.checked = false;
    on.dispatchEvent(new Event("change"));
    const password = app.querySelector(PASSWORD);
    mainButton(app).click();
    await flush();
    expect([errorOf(password), saves(answers)]).toEqual([expect.stringMatching(/\S/), []]);
    typeInto(password, "the password");
    mainButton(app).click();
    await flush();
    expect(saves(answers).at(-1)).toMatchObject({ limitLux: null });
    // Off, with no amount any more.
    expect(setTo(app)).toMatch(/\boff\b/i);
    expect(setTo(app)).not.toMatch(/\d/);

    // 0: on every send, not off, and no amount.
    const every = await popupAt("options", {}, async () => ({ ok: true }), { sendPasswordLimit: "0" });
    expect(setTo(every.app)).toMatch(/every/i);
    expect(setTo(every.app)).not.toMatch(/\boff\b|\d/i);
  });
});

describe("Import wallet's network", () => {
  const tabsOf = (app) => app.querySelectorAll('[role=tablist][aria-label="Network"] [role=tab]');
  // Amélie's: her phrase, used on Testnet, imported opened on Mainnet with "TOTAL BALANCE 0 DUSK", twice. Sofía's and
  // Lena's: with Mainnet picked to begin with, importing the old way still landed there.
  it("asks which network first, none picked to begin with, moves the wallet there keeping what's typed, and imports it there", async () => {
    const messages = [];
    const answer = async (message) => {
      messages.push(message);
      if (message.type === "DUSK_UI_SET_NODE_URL") Object.assign(overview, { nodeUrl: message.nodeUrl, networkName: "Testnet" });
      if (message.type === "DUSK_UI_CREATE_WALLET") Object.assign(overview, { hasVault: true, isUnlocked: true, accounts: [ACCOUNT], wallets: [OVERVIEW.wallets[0]] });
      return { ok: true };
    };
    const fresh = { hasVault: false, isUnlocked: false, accounts: [], accountCount: 0, wallets: [], walletKey: null, networkName: "Mainnet", nodeUrl: "https://nodes.dusk.network" };
    const t = await popupAt("onboard_import", { onboard: { mode: "import", mnemonic: null, password: "", reveal: false } }, answer, fresh);
    const picked = () => tabsOf(t.app).map((tab) => tab.getAttribute("aria-selected"));
    const [main, test] = tabsOf(t.app);
    expect([main.textContent, test.textContent]).toEqual([expect.stringContaining("Mainnet"), expect.stringContaining("Testnet")]);
    expect(picked()).toEqual(["false", "false"]);
    // Amélie's: nothing said which one is real money. Each says what its DUSK is, under its name.
    const sub = (tab) => tab.querySelector(".tab-sub")?.textContent ?? "";
    expect(sub(main)).toMatch(/real/i);
    expect(sub(main)).not.toMatch(/no value/i);
    expect(sub(test)).toMatch(/no value/i);
    expect(sub(test)).not.toMatch(/real/i);

    // The words and the password typed first: Import waits for a network, and says so.
    const selectors = [...WORDS.map((_, i) => WORD(i + 1)), PASSWORD];
    const fields = fieldsOf(t.app, selectors);
    typeAll(fields);
    mainButton(t.app).click();
    await flush();
    expect(messages.filter((m) => m.type === "DUSK_UI_CREATE_WALLET")).toEqual([]);
    // Said under the network's choice, its own alert.
    const choice = t.app.querySelector(".onboard-network");
    const under = choice.parentNode.children[choice.parentNode.children.indexOf(choice) + 1];
    expect([under.getAttribute("role"), isShown(under), under.textContent]).toEqual(["alert", true, expect.stringMatching(/\S/)]);

    tabsOf(t.app)[1].click();
    await flush();
    expect(messages.filter((m) => m.type === "DUSK_UI_SET_NODE_URL")).toEqual([
      {
        type: "DUSK_UI_SET_NODE_URL",
        nodeUrl: "https://testnet.nodes.dusk.network",
        proverUrl: "https://testnet.provers.dusk.network",
        archiverUrl: "https://testnet.nodes.dusk.network",
      },
    ]);
    expect(picked()).toEqual(["false", "true"]);
    expect(fieldsOf(t.app, selectors)).toEqual(fields);
    expect(fields.every((f) => f.value && t.app.contains(f))).toBe(true);

    mainButton(t.app).click();
    await flush();
    expect(messages.map((m) => m.type).filter((type) => type === "DUSK_UI_SET_NODE_URL" || type === "DUSK_UI_CREATE_WALLET")).toEqual(["DUSK_UI_SET_NODE_URL", "DUSK_UI_CREATE_WALLET"]);
    expect(messages.find((m) => m.type === "DUSK_UI_CREATE_WALLET").mnemonic).toBe(WORDS.join(" "));
    expect([t.state.route, overview.nodeUrl]).toEqual(["home", "https://testnet.nodes.dusk.network"]);
  });

  // Lena's and Chen's, in the app: Testnet picked on the setup screen, the import page had neither picked, and Enter
  // after the password went back up to "Choose Mainnet or Testnet."; Sofía's: so after Go back and in again.
  it("has the network picked on the setup screen, or Testnet, which is only ever picked, picked as it opens, still changeable", async () => {
    const messages = [];
    const answer = async (message) => {
      messages.push(message);
      if (message.type === "DUSK_UI_SET_NODE_URL") Object.assign(overview, { nodeUrl: message.nodeUrl, networkName: message.nodeUrl.includes("testnet") ? "Testnet" : "Mainnet" });
      return { ok: true };
    };
    const onboard = { mode: "import", mnemonic: null, password: "", reveal: false };
    const mainnet = { hasVault: false, isUnlocked: false, accounts: [], accountCount: 0, wallets: [], walletKey: null, networkName: "Mainnet", nodeUrl: "https://nodes.dusk.network" };
    const testnet = { ...mainnet, networkName: "Testnet", nodeUrl: "https://testnet.nodes.dusk.network" };
    const tabs = (t) => tabsOf(t.app).map((tab) => tab.getAttribute("aria-selected"));

    // On Testnet: picked. Enter after the password imports there, with nothing to choose first.
    let t = await popupAt("onboard_import", { onboard: { ...onboard } }, answer, testnet);
    expect(tabs(t)).toEqual(["false", "true"]);
    typeAll(fieldsOf(t.app, [...WORDS.map((_, i) => WORD(i + 1)), PASSWORD]));
    mainButton(t.app).click();
    await flush();
    expect(messages.filter((m) => m.type === "DUSK_UI_CREATE_WALLET")).toHaveLength(1);

    // Mainnet, the wallet's first network: picked only where it was picked, on the setup screen or here before.
    t = await popupAt("onboard_import", { onboard: { ...onboard }, setupNetwork: null }, answer, mainnet);
    expect(tabs(t)).toEqual(["false", "false"]);
    t = await popupAt("onboard_import", { onboard: { ...onboard }, setupNetwork: "mainnet" }, answer, mainnet);
    expect(tabs(t)).toEqual(["true", "false"]);
    // Still changeable, and what's picked here stays picked for the next time in.
    tabsOf(t.app)[1].click();
    await flush();
    expect([tabs(t), t.state.setupNetwork]).toEqual([["false", "true"], "testnet"]);
  });

  it("keeps the network picked on the setup screen's network menu for Import wallet", async () => {
    const dom = installFakeDom({ pathname: "/popup.html" });
    dom.document.body.innerHTML = "";
    const pill = dom.document.createElement("button");
    pill.id = "network-pill";
    pill.className = "network-pill";
    const label = dom.document.createElement("span");
    label.className = "network-pill__label";
    pill.appendChild(label);
    const actions = dom.document.createElement("div");
    actions.id = "header-actions";
    const app = dom.document.createElement("div");
    app.id = "app";
    dom.document.body.append(pill, actions, app);
    vi.stubGlobal("browser", { runtime: { id: "dusk-wallet", sendMessage: () => {}, onMessage: { addListener: () => {} } } });
    vi.resetModules();
    const { send } = await import("../../wallet/bus.js");
    send.mockReset();
    const fresh = { hasVault: false, isUnlocked: false, accounts: [], wallets: [], walletKey: null, networkName: "Mainnet", nodeUrl: "https://nodes.dusk.network" };
    send.mockImplementation(async (message) => {
      if (message.type === "DUSK_UI_SET_NODE_URL") Object.assign(fresh, { nodeUrl: message.nodeUrl, networkName: "Testnet" });
      return message.type === "DUSK_UI_OVERVIEW" ? fresh : { ok: true };
    });
    const { state } = await import("./state.js");
    Object.assign(state, { route: "onboard_welcome" });
    const { render } = await import("./app.js");
    await render();
    await flush();
    pill.click();
    dom.document.body
      .querySelectorAll(".net-menu [role=menuitemradio]")
      .find((el) => el.querySelector(".net-menu-item-label").textContent === "Testnet")
      .click();
    await flush();
    expect(state.setupNetwork).toBe("testnet");
  });

  it("asks nothing on another network picked before, nor beside other wallets, where the top bar names it", async () => {
    const devnet = { hasVault: false, isUnlocked: false, accounts: [], wallets: [], walletKey: null, networkName: "Devnet", nodeUrl: "https://devnet.nodes.dusk.network" };
    let t = await popupAt("onboard_import", { onboard: { mode: "import", mnemonic: null, password: "", reveal: false } }, async () => ({}), devnet);
    expect(t.app.querySelectorAll('[role=tablist][aria-label="Network"]')).toHaveLength(0);
    expect(fieldsOf(t.app, [WORD(1)])).toHaveLength(1);

    t = await popupAt("wallet_add_import", { onboard: { mode: "import", mnemonic: null, password: "", reveal: false, adding: true } });
    expect(t.app.querySelectorAll('[role=tablist][aria-label="Network"]')).toHaveLength(0);
  });
});
