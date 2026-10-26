import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TX_KIND } from "../shared/constants.js";
// The fake DOM goes before the views: it defines HTMLElement for the gas editor.
import { accessibleName, installFakeDom, isShown, press, settle, typeInto, visibleText } from "./testing/fakeDom.js";
import { convertConfirmView, convertFormView } from "./popup/views/convert.js";

vi.mock("../shared/duskNames.js", async (importOriginal) => ({
  ...(await importOriginal()),
  lookupPrimaryName: vi.fn(async () => "alice.dusk"),
}));

describe("shield and unshield", () => {
  let dom;

  beforeEach(() => {
    dom = installFakeDom();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // 1482.9383 DUSK public and 25 DUSK shielded; either way the fee is at most 0.05 DUSK.
  const ov = {
    nodeUrl: "https://testnet.nodes.dusk.network",
    accounts: ["acct"],
    selectedAccountIndex: 0,
    balance: { value: "1482938300000" },
    shieldedBalance: { value: "25000000000", spendable: "25000000000" },
  };
  const actions = (state) => ({
    send: vi.fn(async () => ({})),
    render: vi.fn(async () => draw(state)),
    showToast: vi.fn(),
  });
  const draw = (state) =>
    dom.document.body.replaceChildren(
      ...(state.route === "convert_confirm" ? convertConfirmView : convertFormView)(ov, { state, actions: actions(state) })
    );
  const body = () => dom.document.body;
  const button = (text) => body().querySelectorAll("button").find((b) => b.textContent === text);

  it("says which way it goes, and what's available after fees, as Send does", () => {
    const state = { route: "convert", draft: { kind: TX_KIND.SHIELD } };
    draw(state);
    const read = () => [
      visibleText(body().querySelector(".convert-flow")),
      visibleText(body().querySelector(".amount-avail__text")),
      visibleText(body().querySelector(".amount-fee-note")),
    ];
    expect(read()).toEqual([
      "From your public balance to your shielded balance.",
      "Available after fees 1,482.8883 DUSK",
      "Network fee up to 0.05 DUSK",
    ]);
    // The switch says which is picked, and the arrow keys move it.
    const tabs = body().querySelector("[role=tablist]");
    expect(accessibleName(tabs)).toBe("Direction");
    expect(tabs.querySelectorAll("[role=tab]").map((t) => [t.textContent, t.getAttribute("aria-selected")])).toEqual([
      ["Shield", "true"],
      ["Unshield", "false"],
    ]);
    press(tabs.querySelector("[aria-selected=true]"), "ArrowRight");
    expect(state.draft.kind).toBe(TX_KIND.UNSHIELD);
    expect(read()).toEqual([
      "From your shielded balance to your public balance.",
      "Available after fees 24.95 DUSK",
      "Network fee up to 0.05 DUSK",
    ]);
  });

  it("fills Max with the real amount, and says under the field what's wrong", () => {
    const state = { route: "convert", draft: { kind: TX_KIND.UNSHIELD } };
    draw(state);
    const input = body().querySelector("input.amount-field__input");
    const error = () => (isShown(body().querySelector(".amount-field__error")) ? body().querySelector(".amount-field__error").textContent : "");
    button("Max").click();
    expect(input.value).toBe("24.95");
    typeInto(input, "30");
    expect(error()).toBe("That's more than your shielded balance, with the network fee.");
    typeInto(input, "");
    button("Review").click();
    expect([error(), state.route]).toEqual(["Enter an amount.", "convert"]);
    typeInto(input, "2");
    button("Review").click();
    expect(state).toMatchObject({ route: "convert_confirm", draft: { kind: TX_KIND.UNSHIELD, amountLux: "2000000000" } });
  });

  it("reviews the amount, the profile it moves within, and the fee, with Back and Confirm", async () => {
    const state = { route: "convert_confirm", draft: { kind: TX_KIND.SHIELD, amountLux: "1000000000", amountDusk: "1" } };
    draw(state);
    await settle();
    expect(visibleText(body().querySelector(".review-head"))).toBe("Shield1 DUSKFrom your public balance to your shielded balance");
    expect(body().querySelectorAll(".convert-review > .group > .kv").map(visibleText)).toEqual([
      "Fromalice.dusk · Public",
      "Toalice.dusk · Shielded",
    ]);
    const shown = () => body().querySelectorAll("button").filter(isShown).map((b) => b.textContent);
    expect(shown()).toEqual(["← Back", "Confirm"]);
    expect(visibleText(body().querySelector("details.gas-custom summary"))).toBe("Custom fee");
  });
});
