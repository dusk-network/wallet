import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { accessibleName, fakeEvent, installFakeDom, isShown, settle, typeInto, typeKeys, visibleText } from "./testing/fakeDom.js";
import { passwordManagerView } from "./testing/passwordManager.js";
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
// Check your recovery words: each box asked filled with the phrase's word at its place.
const wordBoxes = (body) => body.querySelectorAll("input").filter((input) => /^Word \d+$/.test(input.getAttribute("aria-label") ?? ""));
const fillChecked = (body, phrase) => {
  const words = phrase.split(" ");
  for (const input of wordBoxes(body)) typeInto(input, words[Number(input.getAttribute("aria-label").slice(5)) - 1]);
};

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

  // Chen's: typed a word at a time on the Android app's keyboard, every word went in box 1 and Import blamed word 1.
  it("imports a phrase typed a word at a time with spaces, as a phone's keyboard sends them and as a computer's", async () => {
    for (const as of ["text", "keys"]) {
      const state = { route: "onboard_import", onboard: onboard() };
      const acts = actions();
      const body = show(onboardingImportView({ state, actions: acts }));
      field(body, "Word 1").focus();
      typeKeys(`${MNEMONIC} `, { as });
      // The space after the last word goes on to the password.
      expect(dom.document.activeElement === field(body, "Password"), as).toBe(true);
      typeInto(field(body, "Password"), "long enough");
      typeInto(field(body, "Confirm password"), "long enough");
      button(body, "Import wallet").click();
      await settle();
      expect(errorOf(body.querySelector("[role=group]")), as).toBe("");
      expect(acts.send, as).toHaveBeenCalledWith({ type: "DUSK_UI_CREATE_WALLET", mnemonic: MNEMONIC, password: "long enough" });
    }
  });

  it("says a misspelled word by Import wallet too, where a phone shows it, not only above the words", async () => {
    const state = { route: "onboard_import", onboard: onboard() };
    const body = show(onboardingImportView({ state, actions: actions() }));
    // Sofia's: word 7 misspelled, both passwords in, Import at the bottom.
    typeInto(field(body, "Word 1"), MNEMONIC);
    typeInto(field(body, "Word 7"), "abandn");
    typeInto(field(body, "Password"), "long enough");
    typeInto(field(body, "Confirm password"), "long enough");
    const importBtn = button(body, "Import wallet");
    importBtn.click();
    await settle();
    const said = body.querySelectorAll("[role=alert]").filter((el) => !el.hidden).map((el) => el.textContent);
    expect(said).toEqual(["Word 7 isn't a recovery word. Check its spelling.", "Word 7 isn't a recovery word. Check its spelling."]);
    // Once over the words, once by the button: the form's own line, right above it.
    const row = importBtn.parentNode;
    const byButton = row.children.slice(0, row.children.indexOf(importBtn)).filter((el) => el.getAttribute("role") === "alert" && !el.hidden).at(-1);
    expect(byButton?.textContent).toBe("Word 7 isn't a recovery word. Check its spelling.");
    // Fixed: it goes from beside the button too.
    typeInto(field(body, "Word 7"), "abandon");
    expect(body.querySelectorAll("[role=alert]").filter((el) => !el.hidden).map((el) => el.textContent)).toEqual([]);
  });

  // Amélie's, the seventh time: no way to check the words were written down right.
  it("asks for three of the words written down, chosen at random, and shows the words again when they don't match", async () => {
    const state = { route: "onboard_create_phrase", onboard: onboard() };
    const acts = actions();
    // I wrote it down: three places, chosen then, the same through redraws.
    button(show(onboardingCreatePhraseView({ state, actions: acts })), "I wrote it down").click();
    expect(state.route).toBe("onboard_create_confirm");
    const places = state.onboard.checkPlaces;
    expect(places).toHaveLength(3);
    expect(new Set(places).size).toBe(3);
    expect(places.every((p) => p >= 1 && p <= 12)).toBe(true);
    let body = show(onboardingCreateConfirmView({ state, actions: acts }));
    expect(body.querySelector(".subnav-title").textContent).toBe("Check your recovery words");
    expect(body.querySelector(".auth-lead").textContent).toBe("Enter these words from your recovery phrase.");
    const names = () => wordBoxes(body).map((i) => i.getAttribute("aria-label"));
    expect(names()).toEqual(places.map((p) => `Word ${p}`));
    // As Import's boxes: no password manager, no keyboard learning.
    for (const input of wordBoxes(body)) {
      expect([input.getAttribute("autocomplete"), input.getAttribute("autocorrect"), input.getAttribute("spellcheck"), input.getAttribute("autocapitalize")]).toEqual(["off", "off", "false", "none"]);
    }
    body = show(onboardingCreateConfirmView({ state, actions: acts }));
    expect(names()).toEqual(places.map((p) => `Word ${p}`));
    expect(body.querySelectorAll("button").filter(isShown).map((b) => b.textContent)).toEqual(["← Back", "Check", "Skip for now"]);

    button(body, "Check").click();
    await settle();
    expect(errorOf(body.querySelector("[role=group]"))).toBe("Enter the three words.");
    // A word wrong: the words again, shown, saying so; nothing made.
    for (const input of wordBoxes(body)) typeInto(input, "zoo");
    button(body, "Check").click();
    await settle();
    expect([state.route, state.onboard.reveal, state.onboard.checkPlaces, acts.send.mock.calls]).toEqual(["onboard_create_phrase", true, null, []]);
    const phrase = show(onboardingCreatePhraseView({ state, actions: acts }));
    expect(phrase.querySelector("[role=alert]").textContent).toBe("Those words don't match. Check them against the words below.");
    expect(phrase.querySelector(".srp-grid").classList.contains("is-blurred")).toBe(false);

    // Checked again, right: the wallet made, and said so.
    button(phrase, "I wrote it down").click();
    body = show(onboardingCreateConfirmView({ state, actions: acts }));
    fillChecked(body, MNEMONIC);
    button(body, "Check").click();
    await settle();
    expect(acts.send).toHaveBeenCalledWith(expect.objectContaining({ type: "DUSK_UI_CREATE_WALLET", mnemonic: MNEMONIC }));
    expect(acts.showToast).toHaveBeenCalledWith("Your recovery words match.");
    expect(state.route).toBe("home");
  });

  it("makes the wallet with Skip for now, without the words, and without saying they match", async () => {
    const state = { route: "onboard_create_confirm", onboard: { ...onboard(), checkPlaces: [3, 6, 9] } };
    const acts = actions();
    const body = show(onboardingCreateConfirmView({ state, actions: acts }));
    button(body, "Skip for now").click();
    await settle();
    expect(acts.send).toHaveBeenCalledWith(expect.objectContaining({ type: "DUSK_UI_CREATE_WALLET", mnemonic: MNEMONIC, fresh: true }));
    expect(acts.showToast).not.toHaveBeenCalledWith("Your recovery words match.");
    expect([state.route, state.onboard.mnemonic]).toEqual(["home", null]);
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
      "This removes every recovery phrase on this device, then sets up this one with a new password. If it was here before, its contacts and profile names stay."
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
    // A word typed: Back asks first.
    button(app, "← Back").click();
    await settle();
    button(dom.document.body, "Go back").click();
    await settle();
    expect(app.querySelector("h1").textContent).toBe("Unlock your wallet");
  });

  it("asks before Back clears the words and passwords typed on Import, and keeps them on Cancel", async () => {
    const state = { route: "onboard_import", onboard: { mode: "import" } };
    const acts = actions();
    const body = show(onboardingImportView({ state, actions: acts }));
    // Nothing typed: Back goes at once.
    button(body, "← Back").click();
    await settle();
    expect(state.route).toBe("onboard_welcome");

    state.route = "onboard_import";
    typeInto(field(body, "Word 1"), MNEMONIC);
    typeInto(field(body, "Password"), "long enough");
    button(body, "← Back").click();
    await settle();
    const dialog = body.querySelector("[role=alertdialog]");
    expect(visibleText(dialog)).toBe("Go back?This clears the recovery phrase and password you typed.CancelGo back");
    button(dialog, "Cancel").click();
    await settle();
    expect(state.route).toBe("onboard_import");
    expect(body.querySelector("[role=alertdialog]")).toBeNull();
    expect([field(body, "Word 12").value, field(body, "Password").value]).toEqual(["about", "long enough"]);

    button(body, "← Back").click();
    await settle();
    button(body.querySelector("[role=alertdialog]"), "Go back").click();
    await settle();
    expect(state.route).toBe("onboard_welcome");
  });
});

describe("a new recovery phrase", () => {
  const actions = (reply = {}) => ({ send: vi.fn(async () => reply), render: vi.fn(async () => {}), showToast: vi.fn() });
  const emptyFlow = () => ({ mode: null, mnemonic: null, password: "", reveal: false });
  // On from the password, with what the form needs.
  const pastPassword = async (state, acts) => {
    const body = show(onboardingCreatePasswordView({ state, actions: acts }));
    typeInto(field(body, "Password"), "long enough");
    typeInto(field(body, "Confirm password"), "long enough");
    body.querySelector("input[type=checkbox]").checked = true;
    button(body, "Continue").click();
    await settle();
    expect(state.route).toBe("onboard_create_phrase");
  };

  it("shows its words as large as the web wallet's, and keeps I wrote it down in view at the bottom", async () => {
    const state = { route: "onboard_create_phrase", onboard: { ...emptyFlow(), mnemonic: MNEMONIC, reveal: true } };
    const body = show(onboardingCreatePhraseView({ state, actions: actions() }));
    // With Confirm on a Review, in the actions that stay at the bottom of the page.
    expect(button(body, "I wrote it down").closest(".review-actions")).toBeTruthy();
    const css = await readFile(path.resolve(process.cwd(), "public", "ui.css"), "utf8");
    expect(css).toMatch(/\.review-actions \{\s*position: sticky;/);
    expect(Number(/\.srp-word-text \{[^}]*font-size: (\d+)px/.exec(css)?.[1])).toBeGreaterThanOrEqual(18);
  });

  it("keeps its words through Back to the password and forward again", async () => {
    const state = { route: "onboard_welcome", onboard: emptyFlow() };
    const acts = actions();
    show(onboardingWelcomeView({ state, actions: acts })).querySelectorAll(".onboard-choice")[0].click();
    expect(state.route).toBe("onboard_create_password");
    await pastPassword(state, acts);
    const first = state.onboard.mnemonic;
    expect(first.split(" ")).toHaveLength(12);

    // Back to the password, and on again: hidden again, the same words.
    state.onboard.reveal = true;
    button(show(onboardingCreatePhraseView({ state, actions: acts })), "← Back").click();
    expect(state.route).toBe("onboard_create_password");
    await pastPassword(state, acts);
    expect(state.onboard.mnemonic).toBe(first);
    expect(state.onboard.reveal).toBe(false);

    // All the way back to the first choice, and Create wallet again.
    button(show(onboardingCreatePasswordView({ state, actions: acts })), "← Back").click();
    expect(state.route).toBe("onboard_welcome");
    show(onboardingWelcomeView({ state, actions: acts })).querySelectorAll(".onboard-choice")[0].click();
    await pastPassword(state, acts);
    expect(state.onboard.mnemonic).toBe(first);

    // Done with: gone from memory, as the wallet is made.
    state.route = "onboard_create_confirm";
    const confirm = show(onboardingCreateConfirmView({ state, actions: acts }));
    fillChecked(confirm, first);
    button(confirm, "Check").click();
    await settle();
    expect(acts.send).toHaveBeenCalledWith(expect.objectContaining({ type: "DUSK_UI_CREATE_WALLET", mnemonic: first }));
    expect(state.onboard.mnemonic).toBeNull();
    expect(JSON.stringify(state)).not.toContain(first);
  });

  it("isn't kept once someone chooses to import one instead", async () => {
    const state = { route: "onboard_welcome", onboard: emptyFlow() };
    const acts = actions();
    show(onboardingWelcomeView({ state, actions: acts })).querySelectorAll(".onboard-choice")[0].click();
    await pastPassword(state, acts);
    const first = state.onboard.mnemonic;
    show(onboardingWelcomeView({ state, actions: acts })).querySelectorAll(".onboard-choice")[1].click();
    expect(state.onboard.mnemonic).toBeNull();
    expect(JSON.stringify(state)).not.toContain(first);
  });

  it("keeps its words through Back in Add wallet, and drops them when Add wallet is left or done", async () => {
    const state = { route: "wallet_add", onboard: { ...emptyFlow(), adding: true } };
    const acts = actions();
    show(onboardingWelcomeView({ state, actions: acts, adding: true })).querySelectorAll(".onboard-choice")[0].click();
    const first = state.onboard.mnemonic;
    expect(first.split(" ")).toHaveLength(12);

    // Back from the words to the choice, and on again.
    button(show(onboardingCreatePhraseView({ state, actions: acts, adding: true, ov: TWO })), "← Back").click();
    expect(state.route).toBe("wallet_add");
    show(onboardingWelcomeView({ state, actions: acts, adding: true })).querySelectorAll(".onboard-choice")[0].click();
    expect(state.onboard.mnemonic).toBe(first);

    // Left for home: gone.
    button(show(onboardingWelcomeView({ state, actions: acts, adding: true })), "← Back").click();
    expect(state.route).toBe("home");
    expect(JSON.stringify(state)).not.toContain(first);

    // Done: gone too.
    state.route = "wallet_add";
    state.onboard = { ...emptyFlow(), adding: true };
    show(onboardingWelcomeView({ state, actions: acts, adding: true })).querySelectorAll(".onboard-choice")[0].click();
    const second = state.onboard.mnemonic;
    state.route = "wallet_add_confirm";
    const confirm = show(onboardingCreateConfirmView({ state, actions: acts, adding: true }));
    fillChecked(confirm, second);
    typeInto(field(confirm, SHARED_PASSWORD), "password123");
    button(confirm, "Check").click();
    await settle();
    expect(state.route).toBe("home");
    expect(JSON.stringify(state)).not.toContain(second);
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

    fillChecked(body, MNEMONIC);
    button(body, "Check").click();
    await settle();
    expect(errorOf(pwd)).toBe("Enter your password.");
    expect(acts.send).not.toHaveBeenCalled();

    typeInto(pwd, "password123");
    fillChecked(body, MNEMONIC);
    button(body, "Check").click();
    await settle();
    // A phrase made here: the wallet sets its shielded checkpoint as it adds it.
    expect(acts.send).toHaveBeenCalledWith({ type: "DUSK_UI_ADD_WALLET", mnemonic: MNEMONIC, password: "password123", fresh: true });
    expect([errorOf(pwd), pwd.value]).toEqual(["Incorrect password", ""]);
    // The line under it stays, after the error.
    expect(describedBy(pwd).map((n) => n.textContent)).toEqual(["Incorrect password", ONE_PASSWORD]);

    reply = { ok: true };
    typeInto(pwd, "password123");
    fillChecked(body, MNEMONIC);
    button(body, "Check").click();
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
    await settle();
    button(body, "Go back").click();
    await settle();
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
    // The one it has already changes nothing, so it's said.
    typeInto(next, "password123");
    typeInto(again, "password123");
    button(body, "Change password").click();
    await settle();
    expect(errorOf(next)).toBe("Use a different password from the current one.");
    expect(acts.send).not.toHaveBeenCalled();

    typeInto(next, "a new password");
    typeInto(again, "a new password");
    button(body, "Change password").click();
    await settle();
    expect(errorOf(current)).toBe("Incorrect password");
    button(body, "Change password").click();
    await settle();
    expect(acts.send).toHaveBeenLastCalledWith({ type: "DUSK_UI_CHANGE_PASSWORD", password: "password123", newPassword: "a new password" });
    expect(acts.showToast).toHaveBeenCalledWith("Password changed.");
    expect(state.route).toBe("options");
    expect(JSON.stringify(state)).not.toContain("password");
  });
});


// Fingerprint unlock in the app on Android, as phone wallets have it: the
// app's `fingerprint` command (android/KeystorePlugin.kt) answers here.
// Marek's, in Firefox for Android: leaving Import, Firefox offered to keep a
// recovery word's box as a password; Chen's: its "Use strong password?" came
// up over Import. And on a computer, a word's box before the password would
// be the username Firefox keeps it with.
describe("the recovery words and passwords, as a browser's password manager reads them", () => {
  const ov = {
    isUnlocked: true,
    wallets: [
      { key: "k1", n: 1, name: "", accounts: ["acct1"], active: true },
      { key: "k2", n: 2, name: "Savings", accounts: ["acct2"], active: false },
    ],
  };
  const acts = () => ({ send: vi.fn(async () => ({})), render: vi.fn(async () => {}), showToast: vi.fn() });
  const onboard = (over = {}) => ({ mode: "import", mnemonic: null, password: "", reveal: false, ...over });
  const SCREENS = [
    ["Import", () => onboardingImportView({ state: { route: "onboard_import", onboard: onboard() }, actions: acts() })],
    ["Add wallet's import", () => onboardingImportView({ state: { route: "wallet_add_import", onboard: onboard({ adding: true }) }, actions: acts(), adding: true, ov: TWO })],
    ["the restore", () => restoreWalletView({ state: { route: "restore" }, actions: acts() })],
    ["Create's password", () => onboardingCreatePasswordView({ state: { route: "onboard_create_password", onboard: onboard({ mode: "create" }) }, actions: acts() })],
    ["Create's words, confirmed", () => onboardingCreateConfirmView({ state: { route: "onboard_create_confirm", onboard: onboard({ mode: "create", mnemonic: MNEMONIC, password: "x".repeat(8) }) }, actions: acts() })],
    ["Add wallet's new phrase, confirmed", () => onboardingCreateConfirmView({ state: { route: "wallet_add_confirm", onboard: onboard({ mode: "create", mnemonic: MNEMONIC, adding: true }) }, actions: acts(), adding: true })],
    ["Change password", () => changePasswordView(ov, { state: { route: "change_password" }, actions: acts() })],
    ["Remove wallet", () => removeWalletView(ov, { state: { route: "wallet_remove", walletRemove: "k2" }, actions: acts() })],
  ];
  const DEVICES = [
    ["Firefox for Android", "Mozilla/5.0 (Android 15; Mobile; rv:159.0) Gecko/159.0 Firefox/159.0"],
    ["Firefox on a computer", "Mozilla/5.0 (X11; Linux x86_64; rv:159.0) Gecko/20100101 Firefox/159.0"],
  ];
  const wordBoxes = (body) => body.querySelectorAll(".mnemonic-input input");

  it.each(DEVICES.flatMap(([device, agent]) => SCREENS.map(([screen, view]) => [screen, device, agent, view])))(
    "%s in %s: no word is a password, or a password's username, and no password field gets a password of the browser's",
    (_, __, agent, view) => {
      vi.stubGlobal("navigator", { ...globalThis.navigator, userAgent: agent });
      const body = show(view());
      MNEMONIC.split(" ").forEach((word, i) => wordBoxes(body)[i] && typeInto(wordBoxes(body)[i], word));
      for (const pwd of body.querySelectorAll("input[type=password]")) typeInto(pwd, "long enough");
      // Shown and hidden again on a phone, never a password box either.
      const show_ = body.querySelectorAll("button").find((b) => b.textContent === "Show words");
      show_?.click();
      show_?.click();

      for (const { field: pwd, username, offersPassword } of passwordManagerView(dom.document)) {
        expect(pwd.closest(".mnemonic-input"), accessibleName(pwd)).toBeNull();
        expect(username?.closest(".mnemonic-input") ?? null, accessibleName(pwd)).toBeNull();
        expect(offersPassword, accessibleName(pwd)).toBe(false);
      }
      // The words are a form of their own.
      for (const box of wordBoxes(body)) expect(box.closest("form")?.classList.contains("mnemonic-input")).toBe(true);
    }
  );

  // Firefox for Android gives a screen reader nothing inside a box laid out with display: contents: in a password's
  // form so, the fields, their captions and errors went unread on the phone. The form is a box of its own, a column
  // with its row's gap, which looks as the fields did without it.
  it("lays a password's form out as a box of its own that a screen reader reads into", async () => {
    const css = await readFile(path.resolve(process.cwd(), "public", "ui.css"), "utf8");
    const rule = (selector) => css.split("\n}").find((block) => `\n${block}`.includes(`\n${selector} {`)) ?? "";
    expect(css.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/display:\s*contents/);
    expect(rule("form.password-form")).toMatch(/display: block;\s*margin: 0;/);
    expect(rule(".row > form.password-form")).toMatch(/display: flex;\s*flex-direction: column;\s*gap: inherit;/);
    expect(rule(".row")).toMatch(/display: flex;\s*flex-direction: column;\s*gap: 10px;/);
    // Each screen's password forms sit in a row of fields.
    for (const [screen, view] of SCREENS) {
      for (const form of show(view()).querySelectorAll("form.password-form")) expect(form.parentNode?.classList?.contains("row"), screen).toBe(true);
    }
  });
});

describe("fingerprint unlock", () => {
  const actions = (reply = {}) => ({ send: vi.fn(async () => reply), render: vi.fn(async () => {}), showToast: vi.fn() });
  // The phone: `on` with a fingerprint kept, and what each prompt answers.
  const phone = ({ available = true, on = false, lost = false, unlock = { ok: true, secret: "kept password" }, enable = { ok: true } } = {}) => {
    const asked = [];
    const invoke = vi.fn(async (cmd, args) => {
      if (cmd !== "fingerprint") return null;
      asked.push([args.action, args.args?.secret]);
      if (args.action === "status") return { ok: true, available, on, lost };
      if (args.action === "unlock") return typeof unlock === "function" ? unlock() : unlock;
      if (args.action === "enable") return enable;
      return { ok: true };
    });
    dom.window.__TAURI_INTERNALS__ = { invoke };
    return { asked };
  };

  it("asks for the fingerprint by itself as the wallet opens, and unlocks with the password it kept", async () => {
    const { asked } = phone({ on: true });
    const acts = actions();
    show(lockedView({ state: {}, actions: acts }));
    await vi.waitFor(() => expect(acts.send).toHaveBeenCalledWith({ type: "DUSK_UI_UNLOCK", password: "kept password" }));
    expect(asked.map(([action]) => action)).toEqual(["status", "unlock"]);
  });

  it("asks again as the app comes back to the front still locked", async () => {
    const { asked } = phone({ on: true, unlock: { ok: false, reason: "password" } });
    show(lockedView({ state: {}, actions: actions() }));
    await vi.waitFor(() => expect(asked.filter(([action]) => action === "unlock")).toHaveLength(1));
    dom.document.visibilityState = "hidden";
    dom.document.dispatchEvent(fakeEvent("visibilitychange"));
    dom.document.visibilityState = "visible";
    dom.document.dispatchEvent(fakeEvent("visibilitychange"));
    await vi.waitFor(() => expect(asked.filter(([action]) => action === "unlock")).toHaveLength(2));
  });

  // Chen's: the field focused, and the keyboard down until it was tapped.
  it("leaves the password to type when the person picks Use password, keyboard up, and asks again with Use fingerprint", async () => {
    const { asked } = phone({ on: true, unlock: { ok: false, reason: "password" } });
    const acts = actions();
    const body = show(lockedView({ state: {}, actions: acts }));
    await vi.waitFor(() => expect(asked.map(([action]) => action)).toEqual(["status", "unlock", "keyboard"]));
    await settle();
    expect(acts.send).not.toHaveBeenCalled();
    expect(isShown(field(body, "Password"))).toBe(true);
    expect(dom.document.activeElement).toBe(field(body, "Password"));
    button(body, "Use fingerprint").click();
    await vi.waitFor(() => expect(asked.filter(([action]) => action === "unlock")).toHaveLength(2));
  });

  it("asks nothing of a phone without it, nor outside the app", async () => {
    const { asked } = phone({ available: false, on: false });
    const body = show(lockedView({ state: {}, actions: actions() }));
    await vi.waitFor(() => expect(asked).toEqual([["status", undefined]]));
    await settle();
    expect(isShown(button(body, "Use fingerprint"))).toBe(false);
  });

  it("says so once the phone's fingerprints changed, unlocks with the password, then offers it again with that password", async () => {
    const { asked } = phone({ on: true, unlock: { ok: false, reason: "invalidated" } });
    const acts = actions();
    const body = show(lockedView({ state: {}, actions: acts }));
    await vi.waitFor(() => expect(visibleText(body)).toContain("Your fingerprints changed, so fingerprint unlock is off. Unlock with your password."));
    expect(isShown(button(body, "Use fingerprint"))).toBe(false);
    typeInto(field(body, "Password"), "typed password");
    button(body, "Unlock").click();
    await vi.waitFor(() => expect(dom.document.body.querySelector("[role=alertdialog]")).toBeTruthy());
    expect(acts.send).toHaveBeenCalledWith({ type: "DUSK_UI_UNLOCK", password: "typed password" });
    expect(visibleText(dom.document.body.querySelector("[role=alertdialog]"))).toContain("Turn fingerprint unlock on again?");
    button(dom.document.body, "Turn on").click();
    await vi.waitFor(() => expect(asked.at(-1)).toEqual(["enable", "typed password"]));
  });

  // Chen's: the phone's screen lock removed, its fingerprint with it; still "on", and a button that did nothing.
  it("says so once the phone's fingerprint is gone, asks for nothing, and turns it on again after the password once there's one", async () => {
    const { asked } = phone({ available: true, on: false, lost: true });
    const acts = actions();
    const body = show(lockedView({ state: {}, actions: acts }));
    await vi.waitFor(() => expect(visibleText(body)).toContain("Your fingerprints changed, so fingerprint unlock is off. Unlock with your password."));
    expect(isShown(button(body, "Use fingerprint"))).toBe(false);
    expect(asked.map(([action]) => action)).toEqual(["status"]);
    typeInto(field(body, "Password"), "typed password");
    button(body, "Unlock").click();
    await vi.waitFor(() => expect(dom.document.body.querySelector("[role=alertdialog]")).toBeTruthy());
    button(dom.document.body, "Turn on").click();
    await vi.waitFor(() => expect(asked.at(-1)).toEqual(["enable", "typed password"]));
  });

  it("leaves it off without asking once the phone has no fingerprint left, after the password", async () => {
    const { asked } = phone({ available: false, on: false, lost: true });
    const acts = actions();
    const body = show(lockedView({ state: {}, actions: acts }));
    await vi.waitFor(() => expect(visibleText(body)).toContain("Your fingerprints changed, so fingerprint unlock is off. Unlock with your password."));
    typeInto(field(body, "Password"), "typed password");
    button(body, "Unlock").click();
    await vi.waitFor(() => expect(asked.at(-1)).toEqual(["disable", undefined]));
    expect(dom.document.body.querySelector("[role=alertdialog]")).toBeFalsy();
  });

  it("turns it off when the password kept is an old one, and says so", async () => {
    const { asked } = phone({ on: true });
    const acts = actions({ error: { message: "Incorrect password" } });
    const body = show(lockedView({ state: {}, actions: acts }));
    await vi.waitFor(() => expect(asked.map(([action]) => action)).toContain("disable"));
    await settle();
    expect(visibleText(body)).toContain("Your password changed, so fingerprint unlock is off. Unlock with your password.");
  });

  it("offers it beside a new wallet's password, and asks for the fingerprint once the wallet is made", async () => {
    const { asked } = phone({ available: true });
    const state = { route: "onboard_create_password", onboard: { mode: "create", mnemonic: null, password: "", reveal: false } };
    const acts = actions();
    let body = show(onboardingCreatePasswordView({ state, actions: acts }));
    await vi.waitFor(() => expect(isShown(body.querySelector("#onboard-fingerprint").parentNode)).toBe(true));
    expect(visibleText(body.querySelector("#onboard-fingerprint").parentNode)).toBe("Unlock with fingerprint");
    const box = body.querySelector("#onboard-fingerprint");
    box.checked = true;
    box.dispatchEvent(fakeEvent("change"));
    expect(state.onboard.fingerprint).toBe(true);

    // The words written down, then the wallet made with the password.
    Object.assign(state.onboard, { mnemonic: MNEMONIC, password: "long enough" });
    body = show(onboardingCreateConfirmView({ state, actions: acts }));
    button(body, "Skip for now").click();
    await vi.waitFor(() => expect(asked.at(-1)).toEqual(["enable", "long enough"]));
    expect(acts.send).toHaveBeenCalledWith(expect.objectContaining({ type: "DUSK_UI_CREATE_WALLET", password: "long enough" }));
  });
});
