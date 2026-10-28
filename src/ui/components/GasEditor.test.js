import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The fake DOM goes first: it defines HTMLElement for the gas editor to extend.
import { accessibleName, installFakeDom, isShown, settle, typeInto, visibleText } from "../testing/fakeDom.js";
import "./GasEditor.js";
import { gasFeeLux, startingGas, useNetworkGas } from "./NetworkGas.js";

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
  const custom = editor.querySelector("details.gas-custom");
  const field = (name) => editor.querySelectorAll("input").find((i) => accessibleName(i) === name);
  const button = (text) => editor.querySelectorAll("button").find((b) => b.textContent === text);
  const fee = () => visibleText(editor.querySelector(".gas-fee"));
  return { editor, custom, field, button, fee, send };
}

describe("fee editor", () => {
  it("uses the network's gas price, with one Custom fee and no presets", async () => {
    const { editor, custom, fee, send } = await feeEditor();
    expect(send).toHaveBeenCalledWith({ type: "DUSK_UI_GET_CACHED_GAS_PRICE" });
    expect(fee()).toBe("Network feeup to 0.005 DUSKTotalup to 1.005 DUSK");
    expect(editor.readFinalGas()).toEqual({ limit: "2500000", price: "2" });
    // One choice, closed: no Auto, Low, Recommended or High.
    expect(visibleText(custom.querySelector("summary"))).toBe("Custom fee");
    expect(custom.open).toBe(false);
    expect(editor.querySelectorAll("button").map((b) => b.textContent)).toEqual(["Use the network's price"]);
    expect(isShown(editor.querySelector("button.gas-reset"))).toBe(false);
  });

  it("warns under the transaction's minimum gas limit while it's typed, and refuses it", async () => {
    const { editor, field, fee } = await feeEditor();
    const limit = field("Gas limit");
    const error = editor.querySelector(".field-error");
    typeInto(limit, "1500000");
    expect(isShown(error)).toBe(true);
    expect(error.textContent).toBe("The gas limit can't be under 2,000,000 for this transaction.");
    expect(limit.getAttribute("aria-invalid")).toBe("true");
    expect(limit.getAttribute("aria-describedby")).toBe(error.id);
    expect(() => editor.readFinalGas()).toThrow("The gas limit can't be under 2,000,000 for this transaction.");

    typeInto(limit, "3000000");
    expect(isShown(error)).toBe(false);
    expect(limit.getAttribute("aria-invalid")).toBeNull();
    expect(fee()).toBe("Network feeup to 0.006 DUSKTotalup to 1.006 DUSK");
  });

  it("shows what the gas comes to in DUSK under the fields, exactly", async () => {
    const { editor, field } = await feeEditor();
    const max = () => editor.querySelector(".gas-max");
    expect([isShown(max()), visibleText(max())]).toEqual([true, "At most 0.005 DUSK"]);
    typeInto(field("Gas limit"), "2840001");
    typeInto(field("Gas price (LUX)"), "1");
    expect(visibleText(max())).toBe("At most 0.002840001 DUSK");
    // Nothing to add up without both.
    typeInto(field("Gas price (LUX)"), "");
    expect(isShown(max())).toBe(false);
  });

  it("refuses a price of 0, and shows no fee or total for gas that won't do", async () => {
    const { editor, field, fee } = await feeEditor();
    const price = field("Gas price (LUX)");
    typeInto(price, "0");
    const error = dom.document.getElementById(price.getAttribute("aria-describedby"));
    expect([isShown(error), error.textContent, price.getAttribute("aria-invalid")]).toEqual([
      true,
      "The gas price must be at least 1 LUX.",
      "true",
    ]);
    expect(fee()).toBe("Network fee—Total—");
    expect(editor.error).toBe("The gas price must be at least 1 LUX.");
    expect(isShown(editor.querySelector(".gas-max"))).toBe(false);
    expect(() => editor.readFinalGas()).toThrow("The gas price must be at least 1 LUX.");
    expect(() => editor.readOverrideGas({ limit: "2500000", price: "2" })).toThrow("The gas price must be at least 1 LUX.");

    // A limit under the minimum doesn't show a fee either.
    typeInto(price, "1");
    typeInto(field("Gas limit"), "1000");
    expect(fee()).toBe("Network fee—Total—");
    typeInto(field("Gas limit"), "2500000");
    expect([editor.error, fee()]).toEqual(["", "Network feeup to 0.0025 DUSKTotalup to 1.0025 DUSK"]);
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
    expect(() => editor.readOverrideGas(base)).toThrow("The gas limit can't be under 2,000,000 for this transaction.");
    typeInto(limit, "2000000");
    expect(editor.readOverrideGas(base)).toEqual({ gas: { limit: "2000000" } });
    typeInto(limit, "2500000");
    expect(editor.readOverrideGas(base)).toBeNull();
  });

  it("rounds the fee and the total up, as the maximums they are", () => {
    const editor = dom.document.createElement("dusk-gas-editor");
    editor.amountLux = "1000000000";
    // 0.001840001 DUSK at most: 0.0018 to the nearest would read lower.
    editor.setGas({ limit: "1840001", price: "1" });
    dom.document.body.appendChild(editor);
    expect(visibleText(editor.querySelector(".gas-fee"))).toBe("Network feeup to 0.0019 DUSKTotalup to 1.0019 DUSK");
  });

  it("goes back to the network's price from a custom one", async () => {
    const { editor, field, button } = await feeEditor();
    typeInto(field("Gas price (LUX)"), "7");
    expect(isShown(button("Use the network's price"))).toBe(true);
    button("Use the network's price").click();
    expect(editor.readFinalGas()).toEqual({ limit: "2500000", price: "2" });
    expect(isShown(button("Use the network's price"))).toBe(false);
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
    expect(await shield({ limit: "40000000", price: "3" })).toEqual([
      { limit: "40000000", price: "3" },
      "The wallet uses your custom gas from Settings.",
    ]);
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
    expect(visibleText(editor.querySelector(".gas-note"))).toBe("The wallet uses your custom gas from Settings.");
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

  it("leaves blank gas to the network where a site's request has none, as the approval page uses it", async () => {
    const editor = dom.document.createElement("dusk-gas-editor");
    editor.helpText = "Approval help.";
    editor.setGas(null);
    dom.document.body.appendChild(editor);
    expect(visibleText(editor.querySelector(".gas-fee"))).toBe("Network feeSet by the networkTotal—");
    expect(editor.readFinalGas()).toBeUndefined();
    expect(editor.readOverrideGas(null)).toBeNull();
    expect(visibleText(editor.querySelector(".gas-help"))).toBe("Approval help.");

    // What is put in the panel later still lands there; an empty slot takes no room.
    const line = dom.document.createElement("div");
    line.textContent = "Later";
    editor.setEditContent(line);
    expect(editor.querySelector(".gas-edit-extra").childNodes).toEqual([line]);
    const css = await readFile(path.resolve(process.cwd(), "public", "ui.css"), "utf8");
    expect(css).toMatch(/\.gas-edit-extra:empty \{\s*display: none;\s*\}/);
  });

  it("is used by every transaction review view, which has no presets and no Cancel", async () => {
    for (const name of ["send", "stake", "convert", "sozu", "assets"]) {
      const view = await readFile(path.resolve(process.cwd(), "src", "ui", "popup", "views", `${name}.js`), "utf8");
      expect(view).toMatch(/import \{[^}]*\buseNetworkGas\b[^}]*\} from "\.\.\/\.\.\/components\/NetworkGas\.js";/);
      expect(view).toContain("minLimit: getMinimumGas(");
      expect(view).not.toMatch(/"Recommended"|"Low"|"High"|gasHint/);
      expect(view).not.toContain('text: "Cancel"');
    }
  });
});
