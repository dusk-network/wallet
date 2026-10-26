import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { accessibleName, installFakeDom, isShown, settle, typeInto, visibleText } from "./testing/fakeDom.js";
import {
  onboardingCreateConfirmView,
  onboardingCreatePasswordView,
  onboardingImportView,
  onboardingWelcomeView,
} from "./popup/views/onboarding.js";
import { lockedView } from "./popup/views/locked.js";

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
// What the field's error says, through aria-describedby, as a screen reader hears it.
const errorOf = (el) => {
  const id = el.getAttribute("aria-describedby");
  return id && isShown(dom.document.getElementById(id)) ? dom.document.getElementById(id).textContent : "";
};

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

    button(body, "Import wallet").click();
    await settle();
    expect(errorOf(group)).toBe("Enter your recovery phrase.");
    // A group is described by its error, not marked invalid.
    expect(group.getAttribute("aria-invalid")).toBeNull();

    typeInto(field(body, "Word 1"), MNEMONIC.replace("about", "abandon"));
    button(body, "Import wallet").click();
    await settle();
    expect(errorOf(group)).toBe("That isn't a valid recovery phrase. Check each word.");

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
    expect(visibleText(body)).toBe("Unlock your walletPasswordUnlock");
  });
});
