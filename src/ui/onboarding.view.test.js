import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { accessibleName, installFakeDom, isShown, settle, typeInto, visibleText } from "./testing/fakeDom.js";
import {
  onboardingCreateConfirmView,
  onboardingCreatePasswordView,
  onboardingCreatePhraseView,
  onboardingImportView,
  onboardingWelcomeView,
  restoreWalletView,
} from "./popup/views/onboarding.js";
import { changePasswordView, removeWalletView } from "./popup/views/wallets.js";
import { lockedView } from "./popup/views/locked.js";

vi.mock("../wallet/bus.js", () => ({ send: vi.fn() }));

const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

let dom;

beforeEach(() => {
  dom = installFakeDom();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function show(nodes) {
  dom.document.body.replaceChildren(...nodes);
  return dom.document.body;
}

const field = (body, name) => body.querySelectorAll("input").find((i) => accessibleName(i) === name);
const button = (body, text) => body.querySelectorAll("button").find((b) => b.textContent === text);
// What describes a field, through aria-describedby, as a screen reader hears it.
const describedBy = (el) =>
  (el.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean).map((id) => dom.document.getElementById(id)).filter((n) => n && isShown(n));
// What the field's error says.
const errorOf = (el) => describedBy(el).find((n) => n.classList.contains("field-error"))?.textContent ?? "";
// The password field beside other wallets: its label, no placeholder, and a line under it.
const SHARED_PASSWORD = "Password you unlock with";
const ONE_PASSWORD = "One password unlocks every wallet here.";
const expectSharedPassword = (pwd) => {
  expect(pwd.getAttribute("placeholder")).toBeNull();
  expect(describedBy(pwd).map((n) => n.textContent)).toEqual([ONE_PASSWORD]);
  expect(isShown(pwd.parentNode.querySelectorAll("p.field-hint").find((p) => p.textContent === ONE_PASSWORD))).toBe(true);
};
// Two wallets here, by number, and wallets 1 and 3 (2 was removed).
const TWO = { wallets: [{ key: "k1", n: 1, active: true }, { key: "k2", n: 2 }] };
const GAP = { wallets: [{ key: "k1", n: 1 }, { key: "k3", n: 3, active: true }] };

describe("setting up and unlocking", () => {
  const onboard = () => ({ mode: null, mnemonic: MNEMONIC, password: "x".repeat(8), reveal: false });
  const actions = () => ({ send: vi.fn(async () => ({})), render: vi.fn(async () => {}), showToast: vi.fn() });

  it("welcomes with a heading, one line, and create or import as rows", () => {
    const state = { route: "onboard_welcome", onboard: onboard() };
    const body = show(onboardingWelcomeView({ state, actions: actions() }));
    expect(body.querySelector("h1").textContent).toBe("Set up your Dusk Wallet");
    expect(body.querySelector(".auth-lead").textContent).toBe(
      "Your recovery phrase is the only way to restore your wallet. Keep it safe."
    );
    expect(body.querySelectorAll(".onboard-choice").map(visibleText)).toEqual([
      "Create walletGet a new recovery phrase",
      "Import walletUse a recovery phrase you have",
    ]);
    body.querySelectorAll(".onboard-choice")[1].click();
    expect([state.route, state.onboard.mode]).toEqual(["onboard_import", "import"]);
  });

  it("says under each field what's wrong with a new password, and asks for the box", async () => {
    const state = { route: "onboard_create_password", onboard: onboard() };
    const acts = actions();
    const body = show(onboardingCreatePasswordView({ state, actions: acts }));
    expect(body.querySelector("h1").textContent).toBe("Create wallet");
    const pwd = field(body, "Password");
    const pwd2 = field(body, "Confirm password");
    expect([pwd.getAttribute("placeholder"), pwd2.getAttribute("placeholder")]).toEqual(["At least 8 characters", "The same password again"]);

    typeInto(pwd, "short");
    button(body, "Continue").click();
    await settle();
    expect([errorOf(pwd), pwd.getAttribute("aria-invalid")]).toEqual(["Use at least 8 characters.", "true"]);
    // Typing again clears it.
    typeInto(pwd, "long enough");
    expect([errorOf(pwd), pwd.getAttribute("aria-invalid")]).toEqual(["", null]);

    typeInto(pwd2, "something else");
    button(body, "Continue").click();
    await settle();
    expect(errorOf(pwd2)).toBe("The passwords don't match.");

    typeInto(pwd2, "long enough");
    button(body, "Continue").click();
    await settle();
    const agree = body.querySelector("input[type=checkbox]");
    expect(errorOf(agree)).toBe("Tick this to go on.");
    expect(state.route).toBe("onboard_create_password");

    agree.checked = true;
    button(body, "Continue").click();
    await settle();
    expect(state.route).toBe("onboard_create_phrase");
    expect(state.onboard.password).toBe("long enough");
  });

  it("imports a phrase, saying under it what's wrong, as Import wallet", async () => {
    const state = { route: "onboard_import", onboard: onboard() };
    const acts = actions();
    const body = show(onboardingImportView({ state, actions: acts }));
    expect(body.querySelector("h1").textContent).toBe("Import wallet");
    expect(body.querySelector(".row").children[0].textContent).toBe("Recovery phrase");
    const group = body.querySelector("[role=group]");
    // A line above the boxes, there to read, not a placeholder.
    expect(describedBy(group).map((n) => n.textContent)).toEqual(["Paste the whole phrase into any box."]);

    button(body, "Import wallet").click();
    await settle();
    expect(errorOf(group)).toBe("Enter your recovery phrase.");
    // A group is described by its error, not marked invalid.
    expect(group.getAttribute("aria-invalid")).toBeNull();

    // A whole phrase put in at once is checked then, before Import.
    typeInto(field(body, "Word 1"), MNEMONIC.replace("about", "abandon"));
    expect(errorOf(group)).toBe("That isn't a valid recovery phrase. Check each word.");
    button(body, "Import wallet").click();
    await settle();
    expect(errorOf(group)).toBe("That isn't a valid recovery phrase. Check each word.");

    // Words missing, on Import.
    typeInto(field(body, "Word 1"), MNEMONIC);
    typeInto(field(body, "Word 4"), "");
    button(body, "Import wallet").click();
    await settle();
    expect(errorOf(group)).toBe("Word 4 is missing.");

    typeInto(field(body, "Word 1"), MNEMONIC);
    typeInto(field(body, "Password"), "long enough");
    typeInto(field(body, "Confirm password"), "long enough");
    button(body, "Import wallet").click();
    await settle();
    expect(errorOf(group)).toBe("");
    expect(acts.send).toHaveBeenCalledWith({ type: "DUSK_UI_CREATE_WALLET", mnemonic: MNEMONIC, password: "long enough" });
    expect(state.route).toBe("home");
  });

  it("asks for the words written down, and says when they don't match", async () => {
    const state = { route: "onboard_create_confirm", onboard: onboard() };
    const acts = actions();
    const body = show(onboardingCreateConfirmView({ state, actions: acts }));
    expect(body.querySelector(".auth-lead").textContent).toBe("Enter the words you wrote down.");
    button(body, "Create wallet").click();
    await settle();
    expect(errorOf(body.querySelector("[role=group]"))).toBe("Enter your recovery phrase.");
    typeInto(field(body, "Word 1"), MNEMONIC.replace("about", "abandon"));
    button(body, "Create wallet").click();
    await settle();
    expect(errorOf(body.querySelector("[role=group]"))).toBe("The words don't match your recovery phrase.");
    expect(acts.send).not.toHaveBeenCalled();
  });

  it("unlocks under a heading, and says unlocking can take a moment, with Unlocking… on the button only", () => {
    const body = show(lockedView({ state: {}, actions: {} }));
    expect(body.querySelector("h1").textContent).toBe("Unlock your wallet");
    // Shown while an unlock runs.
    const note = body.querySelector(".auth-note");
    expect([note.textContent, isShown(note)]).toEqual(["This can take a moment.", false]);
    expect(visibleText(body)).toBe("Unlock your walletPasswordUnlockForgot your password?");
  });

  it("restores the wallet from its phrase and a new password, saying first what that does", async () => {
    const state = { route: "restore" };
    const acts = actions();
    const body = show(restoreWalletView({ state, actions: acts }));
    expect(body.querySelector("h1").textContent).toBe("Restore wallet");
    expect(body.querySelector(".auth-lead").textContent).toBe(
      "This removes every recovery phrase on this device, then sets up this one with a new password. If it was here before, its contacts stay."
    );
    const group = body.querySelector("[role=group]");
    typeInto(field(body, "Word 1"), MNEMONIC.replace("about", "abandon"));
    button(body, "Restore wallet").click();
    await settle();
    expect(errorOf(group)).toBe("That isn't a valid recovery phrase. Check each word.");

    typeInto(field(body, "Word 1"), MNEMONIC);
    typeInto(field(body, "New password"), "long enough");
    typeInto(field(body, "Confirm password"), "long enough");
    button(body, "Restore wallet").click();
    await settle();
    expect(acts.send).toHaveBeenCalledWith({ type: "DUSK_UI_RESTORE_WALLET", mnemonic: MNEMONIC, password: "long enough" });
    expect(state.route).toBe("home");
    expect(JSON.stringify(state)).not.toContain("long enough");
  });

  it("goes from the unlock form to the restore and back, keeping what's typed while the popup redraws", async () => {
    const make = (tag, props = {}) => Object.assign(dom.document.createElement(tag), props);
    const pill = make("button", { id: "network-pill" });
    pill.appendChild(make("span", { className: "network-pill__label" }));
    const app = make("div", { id: "app" });
    dom.document.body.append(pill, make("div", { id: "header-actions" }), app);
    vi.resetModules();
    const { send } = await import("../wallet/bus.js");
    send.mockImplementation(async (message) => (message.type === "DUSK_UI_OVERVIEW" ? { hasVault: true, isUnlocked: false, networkName: "Testnet" } : {}));
    const { render } = await import("./popup/app.js");
    await render();
    button(app, "Forgot your password?").click();
    await settle();
    expect(app.querySelector("h1").textContent).toBe("Restore wallet");
    typeInto(field(app, "Word 1"), "abandon");
    await render({ forceRefresh: true });
    expect(field(app, "Word 1").value).toBe("abandon");
    button(app, "← Back").click();
    await settle();
    expect(app.querySelector("h1").textContent).toBe("Unlock your wallet");
  });
});

describe("adding a wallet beside the ones here", () => {
  const actions = (reply = {}) => ({ send: vi.fn(async () => reply), render: vi.fn(async () => {}), showToast: vi.fn() });
  const DUP = "This recovery phrase is already in your wallet.";

  it("offers create or import under Add wallet, and a new phrase skips the password", () => {
    const state = { route: "wallet_add", onboard: { adding: true } };
    const acts = actions();
    const body = show(onboardingWelcomeView({ state, actions: acts, adding: true }));
    expect(body.querySelector("h1").textContent).toBe("Add wallet");
    expect(body.querySelector(".auth-lead").textContent).toBe("Your password unlocks every wallet here.");
    body.querySelectorAll(".onboard-choice")[0].click();
    expect(state.route).toBe("wallet_add_phrase");
    expect(state.onboard.mnemonic.split(" ")).toHaveLength(12);

    // Its words, under the wallet it becomes, then Back to the choice, not to a new password.
    const phrase = show(onboardingCreatePhraseView({ state, actions: acts, adding: true, ov: TWO }));
    expect(phrase.querySelectorAll(".auth-lead").map((p) => p.textContent)).toEqual([
      "This becomes Wallet 3.",
      "Write down these 12 words in order and keep them somewhere safe.",
    ]);
    button(phrase, "I wrote it down").click();
    expect(state.route).toBe("wallet_add_confirm");
    show(onboardingCreatePhraseView({ state, actions: acts, adding: true }));
    button(dom.document.body, "← Back").click();
    expect(state.route).toBe("wallet_add");
  });

  it("asks for the words and the password the wallets share, and says under each what's wrong", async () => {
    const state = { route: "wallet_add_confirm", onboard: { adding: true, mnemonic: MNEMONIC } };
    let reply = { error: { message: "Incorrect password" } };
    const acts = { ...actions(), send: vi.fn(async () => reply) };
    const body = show(onboardingCreateConfirmView({ state, actions: acts, adding: true }));
    expect(field(body, "Confirm password")).toBeUndefined();
    const pwd = field(body, SHARED_PASSWORD);
    expectSharedPassword(pwd);

    typeInto(field(body, "Word 1"), MNEMONIC);
    button(body, "Add wallet").click();
    await settle();
    expect(errorOf(pwd)).toBe("Enter your password.");
    expect(acts.send).not.toHaveBeenCalled();

    typeInto(pwd, "password123");
    button(body, "Add wallet").click();
    await settle();
    // A phrase made here: the wallet sets its shielded checkpoint as it adds it.
    expect(acts.send).toHaveBeenCalledWith({ type: "DUSK_UI_ADD_WALLET", mnemonic: MNEMONIC, password: "password123", fresh: true });
    expect([errorOf(pwd), pwd.value]).toEqual(["Incorrect password", ""]);
    // The line under it stays, after the error.
    expect(describedBy(pwd).map((n) => n.textContent)).toEqual(["Incorrect password", ONE_PASSWORD]);

    reply = { ok: true };
    typeInto(pwd, "password123");
    button(body, "Add wallet").click();
    await settle();
    expect([state.route, state.onboard.mnemonic]).toEqual(["home", null]);
    expect(acts.showToast).toHaveBeenCalledWith("Wallet added.");
    expect(JSON.stringify(state)).not.toContain("password123");
    expect(acts.send.mock.calls.map(([m]) => m.type)).toEqual(["DUSK_UI_ADD_WALLET", "DUSK_UI_ADD_WALLET"]);
  });

  it("imports a phrase with the password, and refuses one that's here with one sentence under it", async () => {
    const state = { route: "wallet_add_import", onboard: { adding: true } };
    const acts = actions({ error: { message: DUP } });
    const body = show(onboardingImportView({ state, actions: acts, adding: true, ov: GAP }));
    expect(body.querySelector("h1").textContent).toBe("Import wallet");
    // Under the title: the wallet it becomes, by the next number, past a removed one.
    expect(body.querySelector(".row").children[0].textContent).toBe("This becomes Wallet 4.");
    expectSharedPassword(field(body, SHARED_PASSWORD));
    typeInto(field(body, "Word 1"), MNEMONIC);
    typeInto(field(body, SHARED_PASSWORD), "password123");
    button(body, "Import wallet").click();
    await settle();
    expect(acts.send).toHaveBeenCalledWith({ type: "DUSK_UI_ADD_WALLET", mnemonic: MNEMONIC, password: "password123" });
    expect(errorOf(body.querySelector("[role=group]"))).toBe(DUP);
    expect(state.route).toBe("wallet_add_import");
    button(body, "← Back").click();
    expect(state.route).toBe("wallet_add");
  });
});

describe("removing a wallet, and a new password", () => {
  const ov = {
    isUnlocked: true,
    wallets: [
      { key: "k1", n: 1, name: "", accounts: ["acct1"], active: true },
      { key: "k2", n: 2, name: "Savings", accounts: ["acct2"], active: false },
    ],
  };
  const actions = (replies) => ({ send: vi.fn(async () => replies.shift() ?? {}), render: vi.fn(async () => {}), showToast: vi.fn() });

  it("says what removing a wallet takes, asks for the password, and goes back to Settings", async () => {
    const state = { route: "wallet_remove", walletRemove: "k2" };
    const acts = actions([{ error: { message: "Incorrect password" } }, { ok: true }]);
    const body = show(removeWalletView(ov, { state, actions: acts }));
    expect(body.querySelector("h1").textContent).toBe("Remove wallet");
    expect(visibleText(body.querySelector(".auth-lead"))).toBe(
      "This removes Savings from this device: its recovery phrase, contacts, activity and connected sites. Your other wallets stay as they are."
    );
    const pwd = field(body, SHARED_PASSWORD);
    expectSharedPassword(pwd);
    button(body, "Remove wallet").click();
    await settle();
    expect(errorOf(pwd)).toBe("Enter your password.");

    typeInto(pwd, "wrong one");
    button(body, "Remove wallet").click();
    await settle();
    expect(errorOf(pwd)).toBe("Incorrect password");
    typeInto(pwd, "password123");
    button(body, "Remove wallet").click();
    await settle();
    expect(acts.send).toHaveBeenLastCalledWith({ type: "DUSK_UI_REMOVE_WALLET", walletKey: "k2", password: "password123" });
    expect([state.route, state.walletRemove]).toEqual(["options", null]);
    expect(acts.showToast).toHaveBeenCalledWith("Savings removed.");
  });

  it("never offers to remove the only wallet", () => {
    const state = { route: "wallet_remove", walletRemove: "k1" };
    expect(removeWalletView({ ...ov, wallets: ov.wallets.slice(0, 1) }, { state, actions: actions([]) })).toEqual([]);
    expect(state.route).toBe("options");
  });

  it("changes the password of every phrase, with the current one, and the new one twice", async () => {
    const state = { route: "change_password" };
    const acts = actions([{ error: { message: "Incorrect password" } }, { ok: true }]);
    const body = show(changePasswordView(ov, { state, actions: acts }));
    expect(body.querySelector(".auth-lead").textContent).toBe("Every recovery phrase here is encrypted again with the new password.");
    const [current, next, again] = ["Current password", "New password", "Confirm password"].map((name) => field(body, name));
    typeInto(current, "password123");
    typeInto(next, "short");
    button(body, "Change password").click();
    await settle();
    expect(errorOf(next)).toBe("Use at least 8 characters.");
    typeInto(next, "a new password");
    typeInto(again, "another one");
    button(body, "Change password").click();
    await settle();
    expect(errorOf(again)).toBe("The passwords don't match.");
    expect(acts.send).not.toHaveBeenCalled();

    typeInto(again, "a new password");
    button(body, "Change password").click();
    await settle();
    expect(errorOf(current)).toBe("Incorrect password");
    button(body, "Change password").click();
    await settle();
    expect(acts.send).toHaveBeenLastCalledWith({ type: "DUSK_UI_CHANGE_PASSWORD", password: "password123", newPassword: "a new password" });
    expect(state.route).toBe("options");
    expect(JSON.stringify(state)).not.toContain("password");
  });
});

