import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installFakeDom, visibleText } from "./testing/fakeDom.js";
import {
  onboardingCreateConfirmView,
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

describe("setting up and unlocking", () => {
  it("says what the buttons and labels don't, once", () => {
    const state = { route: "onboard_welcome", onboard: { mode: null, mnemonic: MNEMONIC, password: "x".repeat(8), reveal: false } };
    const actions = { send: vi.fn(async () => ({})), render: vi.fn(async () => {}), showToast: vi.fn() };

    // Welcome: the buttons say create or import; the line says what matters.
    let body = show(onboardingWelcomeView({ state, actions }));
    expect(body.querySelector(".row > .muted").textContent).toBe(
      "Your recovery phrase is the only way to restore your wallet. Keep it safe."
    );

    // Import: the title and the label say it.
    body = show(onboardingImportView({ state, actions }));
    expect(body.querySelector(".row").children[0].textContent).toBe("Recovery phrase");

    // Confirm: what to type.
    body = show(onboardingCreateConfirmView({ state, actions }));
    expect(body.querySelector(".row > .muted").textContent).toBe("Enter the words you wrote down.");
  });

  it("says unlocking can take a moment, with Unlocking… on the button only", () => {
    const body = show(lockedView({ state: {}, actions: {} }));
    // Shown while an unlock runs.
    const callout = body.querySelector(".callout");
    expect(callout.textContent).toBe("This can take a moment.");
    expect(callout.querySelector(".callout-title")).toBeNull();
    expect(visibleText(body)).toBe("Wallet is locked.PasswordUnlock");
  });
});
