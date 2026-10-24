import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TX_KIND } from "../shared/constants.js";
// The fake DOM goes before the views: it defines HTMLElement for the gas editor.
import { installFakeDom, isShown, settle } from "./testing/fakeDom.js";
import { convertConfirmView, convertFormView } from "./popup/views/convert.js";

describe("convert view", () => {
  it("uses shared recipient badges for shield and unshield flow indicators", async () => {
    const source = await readFile(
      path.resolve(process.cwd(), "src", "ui", "popup", "views", "convert.js"),
      "utf8"
    );
    const badgeComponent = await readFile(
      path.resolve(process.cwd(), "src", "ui", "components", "RecipientBadge.js"),
      "utf8"
    );

    expect(source).toContain("RecipientBadge.js");
    expect(source).toContain("privacyFlowBadgeOptions");
    expect(source).toContain("recipientBadge");
    expect(source).not.toContain('class: "meta-pill", text: `${fromLabel} → ${toLabel}`');

    expect(badgeComponent).toContain("privacyFlowBadgeOptions");
    expect(badgeComponent).toContain("`${fromLabel} -> ${toLabel}`");
  });
});

describe("shield and unshield", () => {
  let dom;

  beforeEach(() => {
    dom = installFakeDom();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // 1482.9383 DUSK public and 25 DUSK shielded; either way the fee cap is 0.05 DUSK.
  const ov = { balance: { value: "1482938300000" }, shieldedBalance: { value: "25000000000", spendable: "25000000000" } };
  const actions = () => ({ send: vi.fn(async () => ({})), render: vi.fn(async () => {}), showToast: vi.fn() });

  it("words the balance as Send does, with the fee cap on its own line", () => {
    const lines = (kind) => {
      dom.document.body.replaceChildren(...convertFormView(ov, { state: { route: "convert", draft: { kind } }, actions: actions() }));
      return dom.document.body.querySelectorAll(".row > .box > .muted").map((line) => line.textContent);
    };
    expect(lines(TX_KIND.SHIELD)).toEqual(["Available (public): 1482.8883 DUSK", "Fee cap: 0.05 DUSK"]);
    expect(lines(TX_KIND.UNSHIELD)).toEqual(["Spendable (shielded): 24.95 DUSK", "Fee cap: 0.05 DUSK"]);
    expect(dom.document.body.querySelector("input.amount-input").getAttribute("placeholder")).toBe("e.g. 1.25 DUSK");
  });

  it("names the whole-balance button Max, in the type other buttons use, as Stake and Sozu do", async () => {
    for (const kind of [TX_KIND.SHIELD, TX_KIND.UNSHIELD]) {
      dom.document.body.replaceChildren(...convertFormView(ov, { state: { route: "convert", draft: { kind } }, actions: actions() }));
      expect(dom.document.body.querySelector(".amount-input-row button").textContent).toBe("Max");
    }
    const css = await readFile(path.resolve(process.cwd(), "public", "ui.css"), "utf8");
    expect(css).not.toContain(".max-btn");
  });

  it("reviews with Back and Confirm, the gas presets behind the fee's Edit", async () => {
    const state = { route: "convert_confirm", draft: { kind: TX_KIND.SHIELD, amountLux: "1000000000", amountDusk: "1" } };
    dom.document.body.replaceChildren(...convertConfirmView(ov, { state, actions: actions() }));
    await settle();
    const shown = () => dom.document.body.querySelectorAll("button").filter(isShown).map((b) => b.textContent);
    expect(shown()).toEqual(["← Back", "Edit", "Confirm"]);
    dom.document.body.querySelectorAll("button").find((b) => b.textContent === "Edit").click();
    expect(shown()).toEqual(["← Back", "Hide", "Auto", "Low", "Recommended", "High", "Confirm"]);
  });
});
