import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TX_KIND } from "../shared/constants.js";
// The fake DOM goes before the views: it defines HTMLElement for the gas editor.
import { accessibleName, installFakeDom, isShown, pastClickGuard, settle, typeInto, visibleText } from "./testing/fakeDom.js";
import { convertConfirmView, convertFormView } from "./popup/views/convert.js";
import { reviewOf } from "./popup/views/sent.js";

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
  // A Review's Confirm, whatever it says: the one button at the Review's end (FormControls.js reviewActions).
  const confirm = () => body().querySelector(".review-actions button");

  it("says which way it goes, and what's available after fees, as Send does", () => {
    const state = { route: "convert", draft: { kind: TX_KIND.SHIELD } };
    draw(state);
    const flow = () => visibleText(body().querySelector(".convert-flow"));
    const available = () => visibleText(body().querySelector(".amount-avail__text"));
    const fee = () => visibleText(body().querySelector(".amount-fee-note"));
    expect(flow()).toMatch(/public.*shielded/);
    expect(available()).toMatch(/1,482\.8883 DUSK/);
    expect(fee()).toMatch(/0\.05 DUSK/);
    // The other way, picked on the switch.
    body().querySelector("[role=tab][aria-selected=false]").click();
    expect(state.draft.kind).toBe(TX_KIND.UNSHIELD);
    expect(flow()).toMatch(/shielded.*public/);
    expect(available()).toMatch(/24\.95 DUSK/);
    expect(fee()).toMatch(/0\.05 DUSK/);
  });

  // Lena's and Chen's: opened with no signal, the shielded balance said 0 where it couldn't be read.
  it("says no Available and nothing missing for an Unshield whose shielded balance can't be read now", () => {
    const unread = { ...ov, shieldedBalance: { value: "0", spendable: "0" }, shieldedStale: true, shieldedError: "Failed to fetch" };
    const state = { route: "convert", draft: { kind: TX_KIND.UNSHIELD } };
    dom.document.body.replaceChildren(...convertFormView(unread, { state, actions: actions(state) }));
    expect(isShown(body().querySelector(".amount-avail"))).toBe(false);
    typeInto(body().querySelectorAll("input").find((i) => accessibleName(i) === "Amount"), "1");
    // Nothing missing under the field, and no balance of 0 anywhere.
    expect(isShown(body().querySelector(".amount-field__error"))).toBe(false);
    expect(visibleText(body())).not.toMatch(/(?<![\d.,])0 DUSK/);
  });

  it("fills Max with the real amount, and says under the field what's wrong", () => {
    const state = { route: "convert", draft: { kind: TX_KIND.UNSHIELD } };
    draw(state);
    const input = body().querySelector("input.amount-field__input");
    const error = () => (isShown(body().querySelector(".amount-field__error")) ? body().querySelector(".amount-field__error").textContent : "");
    button("Max").click();
    expect(input.value).toBe("24.95");
    typeInto(input, "30");
    // How much is missing, of the shielded balance.
    expect(error()).toMatch(/5\.05 DUSK/);
    expect(error()).toMatch(/shielded/);
    typeInto(input, "");
    button("Review").click();
    // That an amount is missing, and no Review.
    expect(error()).not.toBe("");
    expect(state.route).toBe("convert");
    typeInto(input, "2");
    button("Review").click();
    expect(state).toMatchObject({ route: "convert_confirm", draft: { kind: TX_KIND.UNSHIELD, amountLux: "2000000000" } });
  });

  it("sets aside the fee Review starts from, with custom gas from Settings", async () => {
    // Price 3 and the shield's own 50M limit, as the custom 2.5M is under its minimum.
    const custom = { ...ov, customGas: { limit: "2500000", price: "3" } };
    const state = { route: "convert", draft: { kind: TX_KIND.SHIELD } };
    const show = () =>
      dom.document.body.replaceChildren(
        ...(state.route === "convert_confirm" ? convertConfirmView : convertFormView)(custom, {
          state,
          actions: { send: vi.fn(async () => ({})), render: vi.fn(async () => show()), showToast: vi.fn() },
        })
      );
    show();
    expect(visibleText(body().querySelector(".amount-avail__text"))).toMatch(/1,482\.7883 DUSK/);
    expect(visibleText(body().querySelector(".amount-fee-note"))).toMatch(/0\.15 DUSK/);
    button("Max").click();
    expect(body().querySelector("input.amount-field__input").value).toBe("1482.7883");
    button("Review").click();
    await settle();
    // The fee at most, and the total at most.
    expect(visibleText(body().querySelector(".gas-fee"))).toMatch(/0\.15 DUSK.*1,482\.9383 DUSK/);
  });

  it("reviews the amount, the profile it moves within, and the fee, with Back and Confirm", async () => {
    const state = { route: "convert_confirm", draft: { kind: TX_KIND.SHIELD, amountLux: "1000000000", amountDusk: "1" } };
    draw(state);
    await settle();
    // 1 DUSK, not 0.1 or 21.
    expect(visibleText(body().querySelector(".review-head"))).toMatch(/(?<![\d.,])1 DUSK/);
    const row = (label) => body().querySelectorAll(".convert-review > .group > .kv").map(visibleText).find((text) => text.startsWith(label));
    expect(row("From")).toMatch(/alice\.dusk.*Public/);
    expect(row("To")).toMatch(/alice\.dusk.*Shielded/);
    // The fee at most, and the total at most, with a fee of your own on offer.
    expect(visibleText(body().querySelector(".gas-fee"))).toMatch(/0\.05 DUSK.*1\.05 DUSK/);
    expect(body().querySelector("details.gas-custom")).toBeTruthy();
    expect(isShown(body().querySelector(".subnav-back"))).toBe(true);
    expect(confirm().disabled).toBe(false);
  });

  // Lena's, three rounds: the default followed the mempool's median, which one transaction waiting alone at 2 made
  // everyone's price. What waits fits in a block: the minimum.
  it.each([[TX_KIND.SHIELD], [TX_KIND.UNSHIELD]])("starts a %s from the minimum with one transaction waiting at 2, and the capped median with a full mempool", async (kind) => {
    const priceSent = async (stats) => {
      const state = { route: "convert_confirm", draft: { kind, amountLux: "1000000000", amountDusk: "1" } };
      const sent = [];
      const own = {
        send: vi.fn(async (message) => {
          if (message.type === "DUSK_UI_SEND_TX") sent.push(message);
          return message.type === "DUSK_UI_GET_CACHED_GAS_PRICE" ? stats : { ok: true, result: { hash: "ab".repeat(32) } };
        }),
        render: vi.fn(async () => {}),
        showToast: vi.fn(),
      };
      dom.document.body.replaceChildren(...convertConfirmView(ov, { state, actions: { ...own, review: reviewOf({ ...ov, isUnlocked: true }, state) } }));
      await settle();
      // Whether it says the network is busy.
      const busy = visibleText(body().querySelector("dusk-gas-editor .gas-busy") ?? { textContent: "" }) !== "";
      pastClickGuard();
      confirm().click();
      await settle();
      return [sent[0]?.params.gas?.price, busy];
    };
    expect(await priceSent({ mempool: [{ gasPrice: "2", gasLimit: "6000000" }] })).toEqual(["1", false]);
    const full = { mempool: Array.from({ length: 1000 }, () => ({ gasPrice: "900", gasLimit: "2500000" })) };
    expect(await priceSent(full)).toEqual(["5", true]);
  });

  it("keeps Review off while an amount typed won't do, and on for an empty one to say what's missing", () => {
    draw({ route: "convert", draft: { kind: TX_KIND.UNSHIELD } });
    const input = body().querySelector("input.amount-field__input");
    const review = button("Review");
    for (const bad of ["abc", "0", "0.1234567891", "99999"]) {
      typeInto(input, bad);
      expect(review.disabled).toBe(true);
    }
    typeInto(input, "1");
    expect(review.disabled).toBe(false);
    typeInto(input, "");
    expect(review.disabled).toBe(false);
  });

  it("says on Review how much is missing once the fee takes it past the balance, and keeps Confirm off", async () => {
    const dusk = (n) => (BigInt(n) * 1_000_000_000n).toString();
    const { convertConfirmView } = await import("./popup/views/convert.js");
    const state = { route: "convert_confirm", draft: { kind: "unshield", amountDusk: "1", amountLux: dusk(1), gas: { limit: "50000000", price: "1" } } };
    const actions = { send: vi.fn(async () => ({})), render: vi.fn(async () => {}), showToast: vi.fn(), review: {} };
    const ov = { isUnlocked: true, accounts: ["a"], addresses: ["b"], selectedAccountIndex: 0, balance: { value: dusk(100) }, shieldedBalance: { value: dusk(2), spendable: dusk(1) } };
    dom.document.body.replaceChildren(...convertConfirmView(ov, { state, actions }));
    await settle();
    // How much is missing, of the shielded balance.
    expect(dom.document.body.querySelector(".pay-guard").textContent).toMatch(/0\.05 DUSK/);
    expect(dom.document.body.querySelector(".pay-guard").textContent).toMatch(/shielded/);
    expect(confirm().disabled).toBe(true);
  });

  it("names the wallet beside the profile with more than one wallet, as the Review was drawn for", async () => {
    const state = { route: "convert_confirm", draft: { kind: TX_KIND.UNSHIELD, amountLux: "1000000000", amountDusk: "1" } };
    const two = { ...ov, wallets: [{ key: "w1", n: 1, active: true }, { key: "w2", n: 2 }] };
    dom.document.body.replaceChildren(...convertConfirmView(two, { state, actions: { ...actions(state), review: reviewOf(two, state) } }));
    await settle();
    const row = (label) => body().querySelectorAll(".convert-review > .group > .kv").map(visibleText).find((text) => text.startsWith(label));
    expect(row("From")).toMatch(/Wallet 1.*alice\.dusk.*Shielded/);
    expect(row("To")).toMatch(/Wallet 1.*alice\.dusk.*Public/);
  });
});
