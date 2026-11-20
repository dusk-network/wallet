import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RECOVERY_WORDS_MISMATCH } from "@dusk-network/app-core/recovery-words";
import { accessibleName, fakeEvent, installFakeDom, isShown, settle, typeInto, typeKeys, visibleText } from "./testing/fakeDom.js";
import { passwordManagerView } from "./testing/passwordManager.js";
import { HOLD_TO_SHOW_TEXT } from "./lib/pageAway.js";
import {
  onboardingCreateConfirmView,
  onboardingCreatePasswordView,
  onboardingCreatePhraseView,
  onboardingImportView,
  onboardingWelcomeView,
  restoreWalletView,
} from "./popup/views/onboarding.js";
import { changePasswordView, removeWalletView } from "./popup/views/wallets.js";
import { FINGERPRINTS_CHANGED_TEXT, lockedView } from "./popup/views/locked.js";

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
// A screen's buttons by what they do, not what they say: its main one (primary or destructive), Back, the
// outline one beside the main one (Skip for now, Use fingerprint), and a dialog's yes.
const mainButton = (body) => body.querySelectorAll("button.btn-primary, button.btn-destructive").find(isShown);
const backButton = (body) => body.querySelector(".subnav-back");
const outlineButton = (body) => body.querySelector("button.btn-outline");
const dialogYes = () => dom.document.body.querySelectorAll("[role=alertdialog] button").find((b) => !b.hasAttribute("data-back"));
// The unlock screen's password.
const unlockPassword = (body) => body.querySelector("#unlock-password");
// What describes a field, through aria-describedby, as a screen reader hears it.
const describedBy = (el) =>
  (el.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean).map((id) => dom.document.getElementById(id)).filter((n) => n && isShown(n));
// What the field's error says.
const errorOf = (el) => describedBy(el).find((n) => n.classList.contains("field-error"))?.textContent ?? "";
// The password the wallets here share, where one's added or removed.
const SHARED_PASSWORD = "input[autocomplete=current-password]";
// Two wallets here, by number.
const TWO ={ wallets: [{ key: "k1", n: 1, active: true }, { key: "k2", n: 2 }] };

describe("setting up and unlocking", () => {
  const onboard = () => ({ mode: null, mnemonic: MNEMONIC, password: "x".repeat(8), reveal: false });
  const actions = () => ({ send: vi.fn(async () => ({})), render: vi.fn(async () => {}), showToast: vi.fn() });

  it("says under each field what's wrong with a new password, and asks for the box", async () => {
    const state = { route: "onboard_create_password", onboard: onboard() };
    const acts = actions();
    const body = show(onboardingCreatePasswordView({ state, actions: acts }));
    const pwd = field(body, "Password");
    const pwd2 = field(body, "Confirm password");

    typeInto(pwd, "short");
    mainButton(body).click();
    await settle();
    expect([errorOf(pwd), pwd.getAttribute("aria-invalid")]).toEqual([expect.stringMatching(/\b8\b/), "true"]);
    // Typing again clears it.
    typeInto(pwd, "long enough");
    expect([errorOf(pwd), pwd.getAttribute("aria-invalid")]).toEqual(["", null]);

    typeInto(pwd2, "something else");
    mainButton(body).click();
    await settle();
    expect(errorOf(pwd2)).not.toBe("");

    typeInto(pwd2, "long enough");
    mainButton(body).click();
    await settle();
    const agree = body.querySelector("input[type=checkbox]");
    expect(errorOf(agree)).not.toBe("");
    expect(state.route).toBe("onboard_create_password");

    agree.checked = true;
    mainButton(body).click();
    await settle();
    expect(state.route).toBe("onboard_create_phrase");
    expect(state.onboard.password).toBe("long enough");
  });

  it("imports a phrase, saying under it what's wrong, as Import wallet", async () => {
    const state = { route: "onboard_import", onboard: onboard() };
    const acts = actions();
    const body = show(onboardingImportView({ state, actions: acts }));
    const group = body.querySelector("[role=group]");

    mainButton(body).click();
    await settle();
    expect(errorOf(group)).not.toBe("");

    // A whole phrase put in at once is checked then, before Import.
    typeInto(field(body, "Word 1"), MNEMONIC.replace("about", "abandon"));
    expect(errorOf(group)).not.toBe("");
    mainButton(body).click();
    await settle();
    expect(errorOf(group)).not.toBe("");

    // Words missing, on Import.
    typeInto(field(body, "Word 1"), MNEMONIC);
    typeInto(field(body, "Word 4"), "");
    mainButton(body).click();
    await settle();
    expect(errorOf(group)).toMatch(/\b4\b/);
    expect(acts.send).not.toHaveBeenCalled();

    typeInto(field(body, "Word 1"), MNEMONIC);
    typeInto(field(body, "Password"), "long enough");
    typeInto(field(body, "Confirm password"), "long enough");
    mainButton(body).click();
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
      typeInto(field(body, "Password"), "long enough");
      typeInto(field(body, "Confirm password"), "long enough");
      mainButton(body).click();
      await settle();
      expect(errorOf(body.querySelector("[role=group]")), as).toBe("");
      expect(acts.send, as).toHaveBeenCalledWith({ type: "DUSK_UI_CREATE_WALLET", mnemonic: MNEMONIC, password: "long enough" });
    }
  });

  // Amélie's, the seventh time: no way to check the words were written down right. Then Nandini's and
  // Amélie's: one word wrong, or three made up, put all twelve on screen.
  it("asks for three of the words written down, chosen at random, and says no more than that they don't match", async () => {
    const state = { route: "onboard_create_phrase", onboard: onboard() };
    const acts = actions();
    // I wrote it down: three places, chosen then, the same through redraws.
    mainButton(show(onboardingCreatePhraseView({ state, actions: acts }))).click();
    expect(state.route).toBe("onboard_create_confirm");
    const places = state.onboard.checkPlaces;
    expect(places).toHaveLength(3);
    expect(new Set(places).size).toBe(3);
    expect(places.every((p) => p >= 1 && p <= 12)).toBe(true);
    let body = show(onboardingCreateConfirmView({ state, actions: acts }));
    const names = () => wordBoxes(body).map((i) => i.getAttribute("aria-label"));
    expect(names()).toEqual(places.map((p) => `Word ${p}`));
    // As Import's boxes: no password manager, no keyboard learning.
    for (const input of wordBoxes(body)) {
      expect([input.getAttribute("autocomplete"), input.getAttribute("autocorrect"), input.getAttribute("spellcheck"), input.getAttribute("autocapitalize")]).toEqual(["off", "off", "false", "none"]);
    }
    body = show(onboardingCreateConfirmView({ state, actions: acts }));
    expect(names()).toEqual(places.map((p) => `Word ${p}`));

    // Lena's: nothing checked, and nothing said, till every box holds a word.
    expect(mainButton(body).disabled).toBe(true);
    mainButton(body).click();
    await settle();
    expect(body.querySelectorAll("[role=alert]").filter(isShown)).toEqual([]);
    // One word wrong, then three made up: said, and nothing else; no word of the phrase, and nothing made.
    const words = MNEMONIC.split(" ");
    for (const typed of [places.map((p, i) => (i === 1 ? "zoo" : words[p - 1])), ["kiwi", "lemon", "cabin"]]) {
      wordBoxes(body).forEach((input, i) => typeInto(input, typed[i]));
      mainButton(body).click();
      await settle();
      expect(visibleText(body)).toContain(RECOVERY_WORDS_MISMATCH);
      expect(visibleText(body)).not.toContain("abandon");
      expect([body.querySelector(".srp-grid"), wordBoxes(body)]).toEqual([null, []]);
      expect([state.route, state.onboard.reveal, acts.send.mock.calls]).toEqual(["onboard_create_confirm", false, []]);
      // Try again: the same three, empty.
      mainButton(body).click();
      expect(names()).toEqual(places.map((p) => `Word ${p}`));
      expect(wordBoxes(body).map((i) => i.value)).toEqual(["", "", ""]);
    }

    // Show my recovery words, apart: back to the words, hidden till Reveal, with nothing said over them.
    for (const input of wordBoxes(body)) typeInto(input, "zoo");
    mainButton(body).click();
    await settle();
    body.querySelector(".words-show").click();
    expect([state.route, state.onboard.reveal]).toEqual(["onboard_create_phrase", false]);
    const phrase = show(onboardingCreatePhraseView({ state, actions: acts }));
    expect(phrase.querySelector(".srp-grid").classList.contains("srp-grid--blur")).toBe(true);
    expect(phrase.querySelectorAll("[role=alert]").filter(isShown)).toEqual([]);

    // Checked again, right: the wallet made, and said so.
    mainButton(phrase).click();
    body = show(onboardingCreateConfirmView({ state, actions: acts }));
    fillChecked(body, MNEMONIC);
    mainButton(body).click();
    await settle();
    expect(acts.send).toHaveBeenCalledWith(expect.objectContaining({ type: "DUSK_UI_CREATE_WALLET", mnemonic: MNEMONIC }));
    expect(acts.showToast).toHaveBeenCalledTimes(1);
    expect(state.route).toBe("home");
  });

  // Marek's: words shown in clear stayed in Android's app switcher and in Firefox's tab list.
  it("hides the words shown in Check your recovery words on a phone the moment the page is hidden, left or loses the focus", () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 6; wv) AppleWebKit/537.36 Chrome/156.0 Mobile Safari/537.36" });
    dom.window.__TAURI_INTERNALS__ = { invoke: vi.fn() };
    const state = { route: "onboard_create_confirm", onboard: { ...onboard(), checkPlaces: [3, 6, 9] } };
    const body = show(onboardingCreateConfirmView({ state, actions: actions() }));
    const grid = body.querySelector(".srp-grid");
    const show_ = body.querySelector(".srp-show");
    typeInto(wordBoxes(body)[0], "abandon");
    for (const away of [
      () => {
        dom.document.visibilityState = "hidden";
        dom.document.dispatchEvent(fakeEvent("visibilitychange"));
      },
      () => dom.window.dispatchEvent(fakeEvent("pagehide")),
      () => dom.window.dispatchEvent(fakeEvent("blur")),
    ]) {
      dom.document.visibilityState = "visible";
      show_.click();
      expect([grid.classList.contains("is-hidden"), show_.getAttribute("aria-pressed")]).toEqual([false, "true"]);
      away();
      expect([grid.classList.contains("is-hidden"), show_.getAttribute("aria-pressed")]).toEqual([true, "false"]);
      dom.document.visibilityState = "visible";
      dom.document.dispatchEvent(fakeEvent("visibilitychange"));
      expect(grid.classList.contains("is-hidden")).toBe(true);
    }
  });

  it("makes the wallet with Skip for now, without the words, and without saying they match", async () => {
    const state = { route: "onboard_create_confirm", onboard: { ...onboard(), checkPlaces: [3, 6, 9] } };
    const acts = actions();
    const body = show(onboardingCreateConfirmView({ state, actions: acts }));
    outlineButton(body).click();
    await settle();
    expect(acts.send).toHaveBeenCalledWith(expect.objectContaining({ type: "DUSK_UI_CREATE_WALLET", mnemonic: MNEMONIC, fresh: true }));
    expect(acts.showToast).not.toHaveBeenCalled();
    expect([state.route, state.onboard.mnemonic]).toEqual(["home", null]);
  });

  it("restores the wallet from its phrase and a new password, saying first what that does", async () => {
    const state = { route: "restore" };
    const acts = actions();
    const body = show(restoreWalletView({ state, actions: acts }));
    // Every other wallet here goes: said before anything's typed.
    expect(visibleText(body.querySelector(".auth-lead"))).not.toBe("");
    const group = body.querySelector("[role=group]");
    typeInto(field(body, "Word 1"), MNEMONIC.replace("about", "abandon"));
    mainButton(body).click();
    await settle();
    expect(errorOf(group)).not.toBe("");
    expect(acts.send).not.toHaveBeenCalled();

    typeInto(field(body, "Word 1"), MNEMONIC);
    typeInto(field(body, "New password"), "long enough");
    typeInto(field(body, "Confirm password"), "long enough");
    mainButton(body).click();
    await settle();
    expect(acts.send).toHaveBeenCalledWith({ type: "DUSK_UI_RESTORE_WALLET", mnemonic: MNEMONIC, password: "long enough" });
    expect(state.route).toBe("home");
    expect(JSON.stringify(state)).not.toContain("long enough");
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
    mainButton(body).click();
    await settle();
    expect(state.route).toBe("onboard_create_phrase");
  };

  // Marek's: the words in clear stayed in Android's app switcher and in Firefox's tab list.
  it("hides its revealed words the moment the page is hidden, left or loses the focus, till Reveal again", () => {
    for (const away of [
      () => {
        dom.document.visibilityState = "hidden";
        dom.document.dispatchEvent(fakeEvent("visibilitychange"));
      },
      () => dom.window.dispatchEvent(fakeEvent("pagehide")),
      () => dom.window.dispatchEvent(fakeEvent("blur")),
    ]) {
      dom.document.visibilityState = "visible";
      const state = { route: "onboard_create_phrase", onboard: { ...emptyFlow(), mnemonic: MNEMONIC, reveal: true } };
      const acts = actions();
      const body = show(onboardingCreatePhraseView({ state, actions: acts }));
      const blurred = (page) => page.querySelector(".srp-grid").classList.contains("srp-grid--blur");
      expect(blurred(body)).toBe(false);
      away();
      // At once, before any redraw: hidden, till Reveal.
      expect([blurred(body), state.onboard.reveal]).toEqual([true, false]);
      expect(acts.render).toHaveBeenCalled();
      // Back in sight, drawn again: still hidden, Copy off, till Reveal.
      dom.document.visibilityState = "visible";
      dom.document.dispatchEvent(fakeEvent("visibilitychange"));
      const again = show(onboardingCreatePhraseView({ state, actions: acts }));
      const [reveal, copy] = again.querySelectorAll(".phrase-tools button");
      expect([blurred(again), reveal.disabled, copy.disabled]).toEqual([true, false, true]);
      reveal.click();
      expect(state.onboard.reveal).toBe(true);
    }
  });

  // Marek's: in Firefox for Android the app switcher took its picture before the page heard it was leaving.
  it("shows its words in Firefox for Android only while Hold to show words is held, with no Copy", () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Android 15; Mobile; rv:159.0) Gecko/159.0 Firefox/159.0" });
    const state = { route: "onboard_create_phrase", onboard: { ...emptyFlow(), mnemonic: MNEMONIC, reveal: true } };
    const acts = actions();
    const body = show(onboardingCreatePhraseView({ state, actions: acts }));
    const blurred = () => body.querySelector(".srp-grid").classList.contains("srp-grid--blur");
    expect([blurred(), body.querySelectorAll(".phrase-tools button").map((b) => b.textContent)]).toEqual([true, [HOLD_TO_SHOW_TEXT]]);
    const hold = body.querySelector(".phrase-tools button");
    hold.click();
    expect([blurred(), state.onboard.reveal]).toEqual([true, false]);
    hold.dispatchEvent(fakeEvent("pointerdown", { button: 0, pointerId: 1 }));
    expect(blurred()).toBe(false);
    hold.dispatchEvent(fakeEvent("pointerup", { button: 0, pointerId: 1 }));
    expect(blurred()).toBe(true);
    hold.dispatchEvent(fakeEvent("pointerdown", { button: 0, pointerId: 2 }));
    dom.document.visibilityState = "hidden";
    dom.document.dispatchEvent(fakeEvent("visibilitychange"));
    expect([blurred(), acts.render.mock.calls.length]).toEqual([true, 0]);
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
    backButton(show(onboardingCreatePhraseView({ state, actions: acts }))).click();
    expect(state.route).toBe("onboard_create_password");
    await pastPassword(state, acts);
    expect(state.onboard.mnemonic).toBe(first);
    expect(state.onboard.reveal).toBe(false);

    // All the way back to the first choice, and Create wallet again.
    backButton(show(onboardingCreatePasswordView({ state, actions: acts }))).click();
    expect(state.route).toBe("onboard_welcome");
    show(onboardingWelcomeView({ state, actions: acts })).querySelectorAll(".onboard-choice")[0].click();
    await pastPassword(state, acts);
    expect(state.onboard.mnemonic).toBe(first);

    // Done with: gone from memory, as the wallet is made.
    state.route = "onboard_create_confirm";
    const confirm = show(onboardingCreateConfirmView({ state, actions: acts }));
    fillChecked(confirm, first);
    mainButton(confirm).click();
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
    backButton(show(onboardingCreatePhraseView({ state, actions: acts, adding: true, ov: TWO }))).click();
    expect(state.route).toBe("wallet_add");
    show(onboardingWelcomeView({ state, actions: acts, adding: true })).querySelectorAll(".onboard-choice")[0].click();
    expect(state.onboard.mnemonic).toBe(first);

    // Left for home: gone.
    backButton(show(onboardingWelcomeView({ state, actions: acts, adding: true }))).click();
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
    typeInto(confirm.querySelector(SHARED_PASSWORD), "password123");
    mainButton(confirm).click();
    await settle();
    expect(state.route).toBe("home");
    expect(JSON.stringify(state)).not.toContain(second);
  });
});

describe("adding a wallet beside the ones here", () => {
  const actions = (reply = {}) => ({ send: vi.fn(async () => reply), render: vi.fn(async () => {}), showToast: vi.fn() });
  const DUP = "This recovery phrase is already in your wallet.";

  it("asks for the words and the password the wallets share, and says under each what's wrong", async () => {
    const state = { route: "wallet_add_confirm", onboard: { adding: true, mnemonic: MNEMONIC } };
    let reply = { error: { message: "Incorrect password" } };
    const acts = { ...actions(), send: vi.fn(async () => reply) };
    const body = show(onboardingCreateConfirmView({ state, actions: acts, adding: true }));
    // The one password they share, not a new one twice.
    expect(body.querySelectorAll("input[type=password]")).toHaveLength(1);
    const pwd = body.querySelector(SHARED_PASSWORD);

    fillChecked(body, MNEMONIC);
    mainButton(body).click();
    await settle();
    expect(errorOf(pwd)).not.toBe("");
    expect(acts.send).not.toHaveBeenCalled();

    typeInto(pwd, "password123");
    fillChecked(body, MNEMONIC);
    mainButton(body).click();
    await settle();
    // A phrase made here: the wallet sets its shielded checkpoint as it adds it.
    expect(acts.send).toHaveBeenCalledWith({ type: "DUSK_UI_ADD_WALLET", mnemonic: MNEMONIC, password: "password123", fresh: true });
    expect([errorOf(pwd), pwd.value]).toEqual([expect.stringMatching(/\S/), ""]);

    reply = { ok: true };
    typeInto(pwd, "password123");
    fillChecked(body, MNEMONIC);
    mainButton(body).click();
    await settle();
    expect([state.route, state.onboard.mnemonic]).toEqual(["home", null]);
    expect(JSON.stringify(state)).not.toContain("password123");
    expect(acts.send.mock.calls.map(([m]) => m.type)).toEqual(["DUSK_UI_ADD_WALLET", "DUSK_UI_ADD_WALLET"]);
  });

  it("imports a phrase with the password, and refuses one that's here under the words", async () => {
    const state = { route: "wallet_add_import", onboard: { adding: true } };
    const acts = actions({ error: { message: DUP } });
    const body = show(onboardingImportView({ state, actions: acts, adding: true, ov: TWO }));
    typeInto(field(body, "Word 1"), MNEMONIC);
    typeInto(body.querySelector(SHARED_PASSWORD), "password123");
    mainButton(body).click();
    await settle();
    expect(acts.send).toHaveBeenCalledWith({ type: "DUSK_UI_ADD_WALLET", mnemonic: MNEMONIC, password: "password123" });
    expect(errorOf(body.querySelector("[role=group]"))).not.toBe("");
    expect(state.route).toBe("wallet_add_import");
    backButton(body).click();
    await settle();
    dialogYes().click();
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

  it("names the wallet it removes, asks for the password, and goes back to Settings", async () => {
    const state = { route: "wallet_remove", walletRemove: "k2" };
    const acts = actions([{ error: { message: "Incorrect password" } }, { ok: true }]);
    const body = show(removeWalletView(ov, { state, actions: acts }));
    expect(visibleText(body)).toContain("Savings");
    const pwd = body.querySelector(SHARED_PASSWORD);
    mainButton(body).click();
    await settle();
    expect(errorOf(pwd)).not.toBe("");
    expect(acts.send).not.toHaveBeenCalled();

    typeInto(pwd, "wrong one");
    mainButton(body).click();
    await settle();
    expect(errorOf(pwd)).not.toBe("");
    typeInto(pwd, "password123");
    mainButton(body).click();
    await settle();
    expect(acts.send).toHaveBeenLastCalledWith({ type: "DUSK_UI_REMOVE_WALLET", walletKey: "k2", password: "password123" });
    expect([state.route, state.walletRemove]).toEqual(["options", null]);
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
    const [current, next, again] = ["Current password", "New password", "Confirm password"].map((name) => field(body, name));
    typeInto(current, "password123");
    typeInto(next, "short");
    mainButton(body).click();
    await settle();
    expect(errorOf(next)).toMatch(/\b8\b/);
    typeInto(next, "a new password");
    typeInto(again, "another one");
    mainButton(body).click();
    await settle();
    expect(errorOf(again)).not.toBe("");
    // The one it has already changes nothing, so it's said.
    typeInto(next, "password123");
    typeInto(again, "password123");
    mainButton(body).click();
    await settle();
    expect(errorOf(next)).not.toBe("");
    expect(acts.send).not.toHaveBeenCalled();

    typeInto(next, "a new password");
    typeInto(again, "a new password");
    mainButton(body).click();
    await settle();
    expect(errorOf(current)).not.toBe("");
    mainButton(body).click();
    await settle();
    expect(acts.send).toHaveBeenLastCalledWith({ type: "DUSK_UI_CHANGE_PASSWORD", password: "password123", newPassword: "a new password" });
    expect(state.route).toBe("options");
    expect(JSON.stringify(state)).not.toContain("password");
  });
});


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
      const show_ = body.querySelector(".srp-show");
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
});

// Fingerprint unlock in the app on Android, as phone wallets have it: the
// app's `fingerprint` command (android/KeystorePlugin.kt) answers here.
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

  it("leaves the password to type when the person picks Use password, and asks again with Use fingerprint", async () => {
    const { asked } = phone({ on: true, unlock: { ok: false, reason: "password" } });
    const acts = actions();
    const body = show(lockedView({ state: {}, actions: acts }));
    await vi.waitFor(() => expect(asked.map(([action]) => action).slice(0, 2)).toEqual(["status", "unlock"]));
    await settle();
    expect(acts.send).not.toHaveBeenCalled();
    expect(isShown(unlockPassword(body))).toBe(true);
    outlineButton(body).click();
    await vi.waitFor(() => expect(asked.filter(([action]) => action === "unlock")).toHaveLength(2));
  });

  it("asks nothing of a phone without it, nor outside the app", async () => {
    const { asked } = phone({ available: false, on: false });
    const body = show(lockedView({ state: {}, actions: actions() }));
    await vi.waitFor(() => expect(asked).toEqual([["status", undefined]]));
    await settle();
    expect(isShown(outlineButton(body))).toBe(false);
  });

  it("says so once the phone's fingerprints changed, unlocks with the password, then offers it again with that password", async () => {
    const { asked } = phone({ on: true, unlock: { ok: false, reason: "invalidated" } });
    const acts = actions();
    const body = show(lockedView({ state: {}, actions: acts }));
    await vi.waitFor(() => expect(visibleText(body)).toContain(FINGERPRINTS_CHANGED_TEXT));
    expect(isShown(outlineButton(body))).toBe(false);
    typeInto(unlockPassword(body), "typed password");
    mainButton(body).click();
    await vi.waitFor(() => expect(dom.document.body.querySelector("[role=alertdialog]")).toBeTruthy());
    expect(acts.send).toHaveBeenCalledWith({ type: "DUSK_UI_UNLOCK", password: "typed password" });
    dialogYes().click();
    await vi.waitFor(() => expect(asked.at(-1)).toEqual(["enable", "typed password"]));
  });

  // Chen's: the phone's screen lock removed, its fingerprint with it; still "on", and a button that did nothing.
  it("says so once the phone's fingerprint is gone, asks for nothing, and turns it on again after the password once there's one", async () => {
    const { asked } = phone({ available: true, on: false, lost: true });
    const acts = actions();
    const body = show(lockedView({ state: {}, actions: acts }));
    await vi.waitFor(() => expect(visibleText(body)).toContain(FINGERPRINTS_CHANGED_TEXT));
    expect(isShown(outlineButton(body))).toBe(false);
    expect(asked.map(([action]) => action)).toEqual(["status"]);
    typeInto(unlockPassword(body), "typed password");
    mainButton(body).click();
    await vi.waitFor(() => expect(dom.document.body.querySelector("[role=alertdialog]")).toBeTruthy());
    dialogYes().click();
    await vi.waitFor(() => expect(asked.at(-1)).toEqual(["enable", "typed password"]));
  });

  it("leaves it off without asking once the phone has no fingerprint left, after the password", async () => {
    const { asked } = phone({ available: false, on: false, lost: true });
    const acts = actions();
    const body = show(lockedView({ state: {}, actions: acts }));
    await vi.waitFor(() => expect(visibleText(body)).toContain(FINGERPRINTS_CHANGED_TEXT));
    typeInto(unlockPassword(body), "typed password");
    mainButton(body).click();
    await vi.waitFor(() => expect(asked.at(-1)).toEqual(["disable", undefined]));
    expect(dom.document.body.querySelector("[role=alertdialog]")).toBeFalsy();
  });

  it("turns it off when the password kept is an old one, and says so", async () => {
    const { asked } = phone({ on: true });
    const acts = actions({ error: { message: "Incorrect password" } });
    const body = show(lockedView({ state: {}, actions: acts }));
    await vi.waitFor(() => expect(asked.map(([action]) => action)).toContain("disable"));
    await settle();
    expect(visibleText(body.querySelector("#unlock-error"))).not.toBe("");
  });

  it("offers it beside a new wallet's password, and asks for the fingerprint once the wallet is made", async () => {
    const { asked } = phone({ available: true });
    const state = { route: "onboard_create_password", onboard: { mode: "create", mnemonic: null, password: "", reveal: false } };
    const acts = actions();
    let body = show(onboardingCreatePasswordView({ state, actions: acts }));
    await vi.waitFor(() => expect(isShown(body.querySelector("#onboard-fingerprint").parentNode)).toBe(true));
    const box = body.querySelector("#onboard-fingerprint");
    box.checked = true;
    box.dispatchEvent(fakeEvent("change"));
    expect(state.onboard.fingerprint).toBe(true);

    // The words written down, then the wallet made with the password.
    Object.assign(state.onboard, { mnemonic: MNEMONIC, password: "long enough" });
    body = show(onboardingCreateConfirmView({ state, actions: acts }));
    outlineButton(body).click();
    await vi.waitFor(() => expect(asked.at(-1)).toEqual(["enable", "long enough"]));
    expect(acts.send).toHaveBeenCalledWith(expect.objectContaining({ type: "DUSK_UI_CREATE_WALLET", password: "long enough" }));
  });
});
