import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The fake DOM goes first: it defines HTMLElement for the gas editor to extend.
import { accessibleName, installFakeDom, isShown, settle, typeInto, visibleText } from "../testing/fakeDom.js";
import "./GasEditor.js";
import { gasFeeLux, reviewGas, startingGas, useNetworkGas } from "./NetworkGas.js";

let dom;

beforeEach(() => {
  dom = installFakeDom();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// A 1 DUSK public transfer's fee, as Review draws it: the node asks 2 LUX.
async function feeEditor({ stats = { min: "1", median: "2", max: "5" }, gas = null } = {}) {
  const editor = dom.document.createElement("dusk-gas-editor");
  editor.amountLux = "1000000000";
  const send = vi.fn(async () => stats);
  useNetworkGas({ actions: { send }, defaultLimit: "2500000", fallbackPrice: "1", gas, gasEditor: editor, minLimit: "2000000" });
  dom.document.body.appendChild(editor);
  await settle();
  const field = (name) => editor.querySelectorAll("input").find((i) => accessibleName(i) === name);
  const fee = () => visibleText(editor.querySelector(".gas-fee"));
  return { editor, field, fee, send };
}

describe("fee editor", () => {
  it("uses the network's gas price", async () => {
    const { editor, fee, send } = await feeEditor();
    expect(send).toHaveBeenCalledWith({ type: "DUSK_UI_GET_CACHED_GAS_PRICE" });
    expect(fee()).toMatch(/0\.005 DUSK[\s\S]*1\.005 DUSK/);
    expect(editor.readFinalGas()).toEqual({ limit: "2500000", price: "2" });
  });

  it("warns under the transaction's minimum gas limit while it's typed, and refuses it", async () => {
    const { editor, field, fee } = await feeEditor();
    const limit = field("Gas limit");
    const error = editor.querySelector(".field-error");
    typeInto(limit, "1500000");
    expect(isShown(error)).toBe(true);
    expect(error.textContent).toMatch(/2,000,000/);
    expect(() => editor.readFinalGas()).toThrow(/2,000,000/);

    typeInto(limit, "3000000");
    expect(isShown(error)).toBe(false);
    expect(fee()).toMatch(/0\.006 DUSK[\s\S]*1\.006 DUSK/);
  });

  it("shows what the gas comes to in DUSK under the fields, exactly", async () => {
    const { editor, field } = await feeEditor();
    const max = () => editor.querySelector(".gas-max");
    expect(isShown(max())).toBe(true);
    expect(visibleText(max())).toMatch(/\b0\.005 DUSK/);
    typeInto(field("Gas limit"), "2840001");
    typeInto(field("Gas price (LUX)"), "1");
    expect(visibleText(max())).toMatch(/\b0\.002840001 DUSK/);
    // Nothing to add up without both.
    typeInto(field("Gas price (LUX)"), "");
    expect(isShown(max())).toBe(false);
  });

  it("refuses a price of 0, and shows no fee or total for gas that won't do", async () => {
    const { editor, field, fee } = await feeEditor();
    const price = field("Gas price (LUX)");
    typeInto(price, "0");
    const error = dom.document.getElementById(price.getAttribute("aria-describedby"));
    expect(isShown(error)).toBe(true);
    expect(error.textContent).not.toBe("");
    // No fee or total, no figure at all.
    expect(fee()).not.toMatch(/\d/);
    expect(editor.error).not.toBe("");
    expect(isShown(editor.querySelector(".gas-max"))).toBe(false);
    expect(() => editor.readFinalGas()).toThrow();
    expect(() => editor.readOverrideGas({ limit: "2500000", price: "2" })).toThrow();

    // A limit under the minimum doesn't show a fee either.
    typeInto(price, "1");
    typeInto(field("Gas limit"), "1000");
    expect(fee()).not.toMatch(/\d/);
    typeInto(field("Gas limit"), "2500000");
    expect(editor.error).toBe("");
    expect(fee()).toMatch(/0\.0025 DUSK[\s\S]*1\.0025 DUSK/);
  });

  it("tells the page the most the gas comes to as it changes, and none while it won't do", async () => {
    const { editor, field } = await feeEditor();
    const fees = [];
    editor.addEventListener("dusk-gas-fee", (event) => fees.push(event.detail.feeLux));
    typeInto(field("Gas limit"), "3000000");
    typeInto(field("Gas limit"), "3000000");
    typeInto(field("Gas price (LUX)"), "0");
    typeInto(field("Gas price (LUX)"), "");
    expect(fees).toEqual([6_000_000n, null]);
  });

  it("keeps Confirm off while the gas won't do, and on again once it will", async () => {
    const { submitOnGasEnter } = await import("./FormControls.js");
    const { editor, field } = await feeEditor();
    const confirm = dom.document.createElement("button");
    let ready = true;
    submitOnGasEnter(editor, confirm, { ready: () => ready });
    expect(confirm.disabled).toBe(false);
    typeInto(field("Gas price (LUX)"), "0");
    expect(confirm.disabled).toBe(true);
    typeInto(field("Gas limit"), "10");
    expect(confirm.disabled).toBe(true);
    typeInto(field("Gas price (LUX)"), "1");
    expect(confirm.disabled).toBe(true);
    // Fixed, unless the page isn't ready for its own reasons.
    ready = false;
    typeInto(field("Gas limit"), "2500000");
    expect(confirm.disabled).toBe(true);
    typeInto(field("Gas limit"), "10");
    ready = true;
    typeInto(field("Gas limit"), "2500000");
    expect(confirm.disabled).toBe(false);
  });

  it("refuses an approval's override under the minimum too, so the window stays open to fix it", () => {
    const editor = dom.document.createElement("dusk-gas-editor");
    const base = { limit: "2500000", price: "1" };
    editor.minLimit = "2000000";
    editor.setGas(base);
    dom.document.body.appendChild(editor);
    const limit = editor.querySelectorAll("input").find((i) => accessibleName(i) === "Gas limit");

    typeInto(limit, "1500000");
    expect(() => editor.readOverrideGas(base)).toThrow(/2,000,000/);
    typeInto(limit, "2000000");
    expect(editor.readOverrideGas(base)).toEqual({ gas: { limit: "2000000" } });
    typeInto(limit, "2500000");
    expect(editor.readOverrideGas(base)).toBeNull();
  });

  // Lena's: an unstake's Review said "Total up to 0.01 DUSK" for the 0.1 DUSK coming back.
  it("says what comes back as what you receive, the fee apart, whatever the gas, and nothing of an amount not known", () => {
    const editor = dom.document.createElement("dusk-gas-editor");
    editor.comesBack = true;
    editor.amountLux = "100000000";
    editor.setGas({ limit: "10000000", price: "1" });
    dom.document.body.appendChild(editor);
    const rows = () => editor.querySelectorAll(".gas-fee .kv").filter(isShown).map(visibleText);
    // The fee, then the 0.1 DUSK coming back: never fee and amount added up.
    expect(rows()).toHaveLength(2);
    expect(rows()[0]).toMatch(/\b0\.01 DUSK/);
    expect(rows()[1]).toMatch(/\b0\.1 DUSK/);
    // Gas that won't do has no fee; what comes back is the same.
    typeInto(editor.querySelectorAll("input").find((i) => accessibleName(i) === "Gas price (LUX)"), "0");
    expect(rows()[0]).not.toMatch(/\d/);
    expect(rows()[1]).toMatch(/\b0\.1 DUSK/);
    // Hidden as the balance it is.
    editor.hideTotal = true;
    editor.amountLux = "100000000";
    expect(rows()[1]).toMatch(/•••• DUSK/);
    expect(rows()[1]).not.toMatch(/0\.1/);
    editor.amountLux = "0";
    expect(rows()).toHaveLength(1);
  });

  it("rounds the fee and the total up, as the maximums they are", () => {
    const editor = dom.document.createElement("dusk-gas-editor");
    editor.amountLux = "1000000000";
    // 0.001840001 DUSK at most: 0.0018 to the nearest would read lower.
    editor.setGas({ limit: "1840001", price: "1" });
    dom.document.body.appendChild(editor);
    expect(visibleText(editor.querySelector(".gas-fee"))).toMatch(/0\.0019 DUSK[\s\S]*1\.0019 DUSK/);
  });

  it("goes back to the network's price from a custom one", async () => {
    const { editor, field } = await feeEditor();
    const reset = () => editor.querySelector("button.gas-reset");
    typeInto(field("Gas price (LUX)"), "7");
    expect(editor.readFinalGas()).toEqual({ limit: "2500000", price: "7" });
    expect(isShown(reset())).toBe(true);
    reset().click();
    expect(editor.readFinalGas()).toEqual({ limit: "2500000", price: "2" });
    expect(isShown(reset())).toBe(false);
  });

  it("keeps gas the draft brought back, and the wallet's price when the node's can't be read", async () => {
    const kept = await feeEditor({ gas: { limit: "3000000", price: "4" } });
    expect(kept.editor.readFinalGas()).toEqual({ limit: "3000000", price: "4" });
    const offline = await feeEditor({ stats: { error: { message: "offline" } } });
    expect(offline.editor.readFinalGas()).toEqual({ limit: "2500000", price: "1" });
  });

  it("starts at custom gas from Settings, with the transaction's own limit where the custom one is under its minimum", async () => {
    const shield = async (customGas) => {
      const editor = dom.document.createElement("dusk-gas-editor");
      const send = vi.fn(async () => ({ median: "2" }));
      useNetworkGas({ actions: { send }, defaultLimit: "50000000", fallbackPrice: "1", gas: null, gasEditor: editor, minLimit: "30000000", customGas });
      dom.document.body.appendChild(editor);
      await settle();
      return [editor.readFinalGas(), visibleText(editor.querySelector(".gas-note"))];
    };
    const [gas, note] = await shield({ limit: "40000000", price: "3" });
    expect(gas).toEqual({ limit: "40000000", price: "3" });
    // It says the gas is the user's own from Settings.
    expect(note).not.toBe("");
    expect((await shield({ limit: "2500000", price: "3" }))[0]).toEqual({ limit: "50000000", price: "3" });
  });

  it("keeps a contract call's own limit with custom gas, as it has no minimum to hold the custom limit to", async () => {
    const editor = dom.document.createElement("dusk-gas-editor");
    const send = vi.fn(async () => ({ median: "2" }));
    const customGas = { limit: "2500000", price: "3" };
    useNetworkGas({ actions: { send }, defaultLimit: "500000000", fallbackPrice: "1", gas: null, gasEditor: editor, minLimit: null, customGas });
    dom.document.body.appendChild(editor);
    await settle();
    expect(editor.readFinalGas()).toEqual({ limit: "500000000", price: "3" });
    expect(visibleText(editor.querySelector(".gas-note"))).not.toBe("");
  });

  it("starts each Review from the draft's gas, else custom gas, else the transaction's default", () => {
    const transfer = { limit: "2500000", price: "1" };
    const custom = { limit: "3000000", price: "3" };
    expect(startingGas({ defaultGas: transfer, minLimit: "2000000" })).toEqual(transfer);
    expect(startingGas({ defaultGas: transfer, minLimit: "2000000", customGas: custom })).toEqual(custom);
    expect(startingGas({ defaultGas: transfer, minLimit: "2000000", customGas: custom, gas: { limit: "4000000", price: "2" } })).toEqual({
      limit: "4000000",
      price: "2",
    });
    // Custom gas under the minimum, or with none known, keeps the transaction's own limit.
    expect(startingGas({ defaultGas: { limit: "50000000", price: "1" }, minLimit: "30000000", customGas: custom })).toEqual({
      limit: "50000000",
      price: "3",
    });
    expect(startingGas({ defaultGas: { limit: "500000000", price: "1" }, minLimit: null, customGas: custom })).toEqual({
      limit: "500000000",
      price: "3",
    });
    expect(startingGas({ defaultGas: null, customGas: custom })).toBeNull();
    expect(gasFeeLux({ limit: "500000000", price: "3" })).toBe(1500000000n);
    expect(gasFeeLux(null)).toBe(0n);
  });

  it("leaves blank gas to the network where a site's request has none, as the approval page uses it", () => {
    const editor = dom.document.createElement("dusk-gas-editor");
    editor.setGas(null);
    dom.document.body.appendChild(editor);
    // No fee of its own to show.
    expect(visibleText(editor.querySelector(".gas-fee"))).not.toMatch(/\d/);
    expect(editor.readFinalGas()).toBeUndefined();
    expect(editor.readOverrideGas(null)).toBeNull();
  });

  it("sets a Review up for its transaction, and says above Confirm when its gas won't do", async () => {
    const send = vi.fn(async () => ({ median: "2" }));
    const review = reviewGas({ kind: "transfer", gasOpts: { privacy: "public" }, amountLux: "1000000000", ov: {}, actions: { send } });
    expect(review.defaultGas).toEqual({ limit: "2500000", price: "1" });
    dom.document.body.append(review.editor, review.error);
    await settle();
    expect(review.editor.minLimit).toBe(2_000_000n);
    expect([review.readGas(), review.error.hidden]).toEqual([{ limit: "2500000", price: "2" }, true]);

    const limit = review.editor.querySelectorAll("input").find((i) => accessibleName(i) === "Gas limit");
    typeInto(limit, "");
    expect(review.readGas()).toBe(false);
    expect(review.error.hidden).toBe(false);
    expect(review.error.textContent).not.toBe("");
    typeInto(limit, "2500000");
    expect([review.readGas(), review.error.hidden]).toEqual([{ limit: "2500000", price: "2" }, true]);
  });
});
