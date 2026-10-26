import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The fake DOM goes first: it defines HTMLElement for the gas editor to extend.
import { accessibleName, installFakeDom, isShown, settle, typeInto, visibleText } from "../testing/fakeDom.js";
import "./GasEditor.js";
import { useNetworkGas } from "./NetworkGas.js";

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
      expect(view).toContain('import { useNetworkGas } from "../../components/NetworkGas.js";');
      expect(view).toContain("minLimit: getMinimumGas(");
      expect(view).not.toMatch(/"Recommended"|"Low"|"High"|gasHint/);
      expect(view).not.toContain('text: "Cancel"');
    }
  });
});
