import { afterEach, describe, expect, it, vi } from "vitest";

import { accessibleName, installFakeDom, settle, typeInto } from "../testing/fakeDom.js";

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

// The form's fields, by their names, and what each holds.
const fieldsOf = (app, names) => app.querySelectorAll("input").filter((i) => names.includes(accessibleName(i)));
const typeAll = (fields) => fields.forEach((f, i) => typeInto(f, accessibleName(f).startsWith("Word") ? WORDS[i] : "typed password"));
const SHARED_PASSWORD = "Password you unlock with";
const button = (app, text) => app.querySelectorAll("button").find((b) => b.textContent === text);

// Each wallet form, with the fields it's filled in by.
const FORMS = [
  ["Change password", "change_password", {}, ["Current password", "New password", "Confirm password"]],
  ["Remove wallet", "wallet_remove", { walletRemove: "w2" }, [SHARED_PASSWORD]],
  ["Password on big sends", "send_password", {}, ["Above this amount, in DUSK"]],
  ["Add wallet's import", "wallet_add_import", { onboard: { mode: "import", mnemonic: null, password: "", reveal: false, adding: true } }, ["Word 1", "Word 2", SHARED_PASSWORD]],
  ["Add wallet's new phrase, confirmed", "wallet_add_confirm", { onboard: { mode: "create", mnemonic: WORDS.join(" "), password: "", reveal: false, adding: true } }, ["Word 1", "Word 2", SHARED_PASSWORD]],
];

describe("a wallet form being filled in", () => {
  it.each(FORMS)("%s keeps what's typed through a redraw that isn't about it", async (_, route, extra, names) => {
    const t = await popupAt(route, extra);
    const fields = fieldsOf(t.app, names);
    expect(fields.map(accessibleName)).toEqual(names);
    typeAll(fields);
    const typed = fields.map((f) => f.value);

    // The node's network read again: the popup draws again.
    await t.deliver({ type: "DUSK_UI_NETWORK_CHANGED" });
    expect(fieldsOf(t.app, names)).toEqual(fields);
    expect(fields.map((f) => f.value)).toEqual(typed);
    expect(fields.every((f) => t.app.contains(f))).toBe(true);
  });

  it.each(FORMS)("%s is dropped, with what was typed, on another wallet, on leaving it and on a lock", async (_, route, extra, names) => {
    const t = await popupAt(route, extra);
    let fields = fieldsOf(t.app, names);
    typeAll(fields);

    // Another wallet opened, in another window.
    await t.deliver({ type: "DUSK_UI_WALLET_CHANGED" });
    expect(fields.map((f) => f.value).every((v) => v === "")).toBe(true);
    fields = fieldsOf(t.app, names);
    expect(fields.map((f) => f.value).every((v) => v === "")).toBe(true);

    // Left for Settings and back.
    typeAll(fields);
    t.state.route = "options";
    await t.render();
    Object.assign(t.state, { route, ...extra });
    await t.render();
    expect(fieldsOf(t.app, names).map((f) => f.value).every((v) => v === "")).toBe(true);

    // Locked: the form goes, and the unlock goes back to where it was opened from.
    typeAll(fieldsOf(t.app, names));
    await t.deliver({ type: "DUSK_UI_LOCK_STATE", isUnlocked: false });
    expect(t.state.route).toBe(route.startsWith("wallet_add") ? "home" : "options");
    expect(fieldsOf(t.app, names)).toEqual([]);
  });

  it("says on Add wallet's import which wallet the phrase becomes, by the wallets here as they change", async () => {
    const t = await popupAt("wallet_add_import", FORMS[2][2]);
    const landing = () => t.app.querySelector(".wallet-landing").textContent;
    expect(landing()).toBe("This becomes Wallet 3.");
    const fields = fieldsOf(t.app, FORMS[2][3]);
    typeAll(fields);
    const typed = fields.map((f) => f.value);

    // Another window adds a wallet: the next one here is Wallet 4, and what's typed stays.
    overview = { ...OVERVIEW, wallets: [...OVERVIEW.wallets, { key: "w3", n: 3, name: "", walletId: "", accounts: [], accountNames: {}, active: false }] };
    await t.deliver({ type: "DUSK_UI_WALLETS_CHANGED" });
    expect(landing()).toBe("This becomes Wallet 4.");
    expect(fieldsOf(t.app, FORMS[2][3]).map((f) => f.value)).toEqual(typed);
  });

  it("keeps a submit under way through a wallet change, with what it says after", async () => {
    const answer = Promise.withResolvers();
    const t = await popupAt("change_password", {}, async (message) => (message.type === "DUSK_UI_CHANGE_PASSWORD" ? answer.promise : {}));
    const names = ["Current password", "New password", "Confirm password"];
    typeAll(fieldsOf(t.app, names));
    typeInto(fieldsOf(t.app, names)[0], "the current password");
    button(t.app, "Change password").click();
    await flush();
    expect(button(t.app, "Changing…")?.disabled).toBe(true);

    await t.deliver({ type: "DUSK_UI_WALLET_CHANGED" });
    expect(button(t.app, "Changing…")?.disabled).toBe(true);
    expect(button(t.app, "Change password")).toBeUndefined();

    answer.resolve({ error: { message: "Incorrect password" } });
    await flush();
    await t.deliver({ type: "DUSK_UI_NETWORK_CHANGED" });
    expect(t.app.querySelectorAll(".field-error").filter((el) => !el.hidden).map((el) => el.textContent)).toEqual(["Incorrect password"]);
    expect(button(t.app, "Change password")?.disabled).toBe(false);
  });
});

describe("the password on big sends, in Settings", () => {
  // Chen's: "what sites ask", in an app no site reaches.
  it("says what it asks on in the app without sites, which only the extension has", async () => {
    const note = (app) => app.querySelector(".settings-note").textContent;
    const ext = await popupAt("send_password");
    expect(note(ext.app)).toMatch(/^On sends, stakes, shielding and what sites ask, network fee included\./);
    vi.stubGlobal("browser", undefined);
    globalThis.window.__TAURI_INTERNALS__ = { invoke: vi.fn(async () => null), transformCallback: () => 0 };
    // Opened again in the app: Settings, then the page.
    ext.state.route = "options";
    await ext.render({ forceRefresh: true });
    ext.state.route = "send_password";
    await ext.render({ forceRefresh: true });
    await flush();
    expect(note(ext.app)).toMatch(/^On sends, stakes and shielding, network fee included\./);
    expect(note(ext.app)).not.toContain("site");
  });

  const typed = (app, name, value) => typeInto(app.querySelectorAll("input").find((i) => accessibleName(i) === name), value);
  const pressed = (app, name) => app.querySelectorAll("button").find((b) => b.textContent === name).click();
  const errorsOf = (app) => app.querySelectorAll(".field-error").filter((el) => !el.hidden).map((el) => el.textContent);

  it("turns on above an amount, only with the password, and Settings says so", async () => {
    const answers = [];
    const { app } = await popupAt("send_password", {}, async (message) => {
      answers.push(message);
      if (message.type === "DUSK_UI_SET_SEND_PASSWORD" && message.password !== "the password") return { error: { message: "Incorrect password" } };
      return { ok: true };
    });
    const on = app.querySelector("#send-password-on");
    expect(on.checked).toBe(false);
    // Off, there's nothing to save.
    expect(app.querySelector(".send-password-amount").hidden).toBe(true);
    on.checked = true;
    on.dispatchEvent(new Event("change"));
    expect(app.querySelector(".send-password-amount").hidden).toBe(false);

    pressed(app, "Save");
    await flush();
    expect(errorsOf(app)).toEqual(["Enter an amount such as 100 or 100.5. 0 asks on every send."]);
    typed(app, "Above this amount, in DUSK", "not an amount");
    pressed(app, "Save");
    await flush();
    expect(errorsOf(app)).toEqual(["Enter an amount such as 100 or 100.5. 0 asks on every send."]);
    typed(app, "Above this amount, in DUSK", "1 000,5".replace(",", ".").replace(" ", ""));
    pressed(app, "Save");
    await flush();
    expect(errorsOf(app)).toEqual(["Enter your password."]);
    expect(answers.filter((m) => m.type === "DUSK_UI_SET_SEND_PASSWORD")).toEqual([]);

    typed(app, "Password you unlock with", "not it");
    pressed(app, "Save");
    await flush();
    expect(errorsOf(app)).toEqual(["Wrong password."]);

    typed(app, "Password you unlock with", "the password");
    pressed(app, "Save");
    await flush();
    expect(answers.filter((m) => m.type === "DUSK_UI_SET_SEND_PASSWORD").at(-1)).toMatchObject({ password: "the password", limitLux: "1000500000000" });
    // Back in Settings, it says what it's set to.
    expect(app.querySelectorAll(".settings-row").map((row) => row.textContent)).toContain("Password on big sendsAbove 1,000.5 DUSK");
  });

  it("turns off only with the password too, and 0 asks on every send", async () => {
    const answers = [];
    const { app, state } = await popupAt("options", {}, async (message) => {
      answers.push(message);
      return { ok: true };
    }, { sendPasswordLimit: "5000000000" });
    expect(app.querySelectorAll(".settings-row").map((row) => row.textContent)).toContain("Password on big sendsAbove 5 DUSK");
    app.querySelectorAll(".settings-row").find((row) => row.textContent.startsWith("Password on big sends")).click();
    await flush();
    expect(state.route).toBe("send_password");
    const on = app.querySelector("#send-password-on");
    expect(on.checked).toBe(true);
    expect(app.querySelector("#send-password-amount").value).toBe("5");
    on.checked = false;
    on.dispatchEvent(new Event("change"));
    pressed(app, "Turn off");
    await flush();
    expect(errorsOf(app)).toEqual(["Enter your password."]);
    typed(app, "Password you unlock with", "the password");
    pressed(app, "Turn off");
    await flush();
    expect(answers.filter((m) => m.type === "DUSK_UI_SET_SEND_PASSWORD").at(-1)).toMatchObject({ limitLux: null });
    expect(app.querySelectorAll(".settings-row").map((row) => row.textContent)).toContain("Password on big sendsOff");

    const every = await popupAt("options", {}, async () => ({ ok: true }), { sendPasswordLimit: "0" });
    expect(every.app.querySelectorAll(".settings-row").map((row) => row.textContent)).toContain("Password on big sendsOn every send");
  });
});
