import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The fake DOM goes first: it defines HTMLElement for the gas editor to extend.
import { installFakeDom, isShown, settle, visibleText } from "../testing/fakeDom.js";
import "./GasEditor.js";
import { createGasQuickControls } from "./GasQuickControls.js";

let dom;

beforeEach(() => {
  dom = installFakeDom();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// A 1 DUSK transfer's fee editor with the presets, as Review draws it; the
// node's gas prices are 1, 2 and 5 LUX.
async function feeEditor({ stats = { min: "1", median: "2", max: "5" } } = {}) {
  const editor = dom.document.createElement("dusk-gas-editor");
  editor.amountLux = "1000000000";
  const send = vi.fn(async () => stats);
  createGasQuickControls({ actions: { send }, defaultLimit: "2000000", fallbackPrice: "1", gas: null, gasEditor: editor });
  dom.document.body.appendChild(editor);
  await settle();
  const panel = editor.querySelector(".row");
  const button = (text) => editor.querySelectorAll("button").find((b) => b.textContent === text);
  const shownButtons = () => editor.querySelectorAll("button").filter(isShown).map((b) => b.textContent);
  return { editor, panel, button, shownButtons, send };
}

describe("fee editor", () => {
  it("shows the fee and the total, and keeps the gas price line and the presets behind Edit", async () => {
    const { editor, panel, shownButtons, send } = await feeEditor();
    expect(send).toHaveBeenCalledWith({ type: "DUSK_UI_GET_CACHED_GAS_PRICE" });

    // The recommended (median) price is set, and only the fee and the total show.
    expect(visibleText(editor)).toBe("Network fee (max)0.0040 DUSKEditTotal (max)1.004 DUSK");
    expect(shownButtons()).toEqual(["Edit"]);
    expect(isShown(panel)).toBe(false);

    const edit = editor.querySelector(".link-btn");
    expect(edit.getAttribute("aria-expanded")).toBe("false");
    edit.click();
    expect(edit.textContent).toBe("Hide");
    expect(edit.getAttribute("aria-expanded")).toBe("true");
    expect(shownButtons()).toEqual(["Hide", "Auto", "Low", "Recommended", "High"]);
    expect(visibleText(panel)).toBe(
      "Gas price (LUX): min 1 · median 2 · max 5AutoLowRecommendedHighGas limitGas price" +
        "Max fee = gas limit × gas price. Auto uses the wallet's defaults."
    );

    edit.click();
    expect(isShown(panel)).toBe(false);
    expect(edit.getAttribute("aria-expanded")).toBe("false");
  });

  it("sets the default gas limit with the node's min, median or max price, and Auto clears both", async () => {
    const { editor, button } = await feeEditor();
    editor.querySelector(".link-btn").click();
    const fee = () => editor.querySelector(".box code").textContent;

    button("Low").click();
    expect([editor.getGasInputs(), fee()]).toEqual([{ limit: "2000000", price: "1" }, "0.0020 DUSK"]);
    button("High").click();
    expect([editor.readFinalGas(), fee()]).toEqual([{ limit: "2000000", price: "5" }, "0.0100 DUSK"]);
    button("Recommended").click();
    expect(fee()).toBe("0.0040 DUSK");

    // Auto leaves the gas to the wallet's defaults.
    button("Auto").click();
    expect([editor.readFinalGas(), fee()]).toEqual([undefined, "Auto"]);
    expect(visibleText(editor.querySelector(".box"))).toBe("Network fee (max)AutoHideTotal (max)—");
  });

  it("falls back to the default price when the node's gas prices can't be read", async () => {
    const { editor, panel } = await feeEditor({ stats: { error: { message: "offline" } } });
    expect(editor.readFinalGas()).toEqual({ limit: "2000000", price: "1" });
    editor.querySelector(".link-btn").click();
    expect(visibleText(panel)).toContain("Gas price unavailable (using defaults).");
  });

  it("says that clearing both uses the wallet's defaults where there is no Auto, as on the token Review", () => {
    const editor = dom.document.createElement("dusk-gas-editor");
    editor.setGas({ limit: "500000000", price: "1" });
    dom.document.body.appendChild(editor);
    editor.querySelector(".link-btn").click();
    expect(visibleText(editor.querySelector(".row"))).toBe(
      "Gas limitGas priceMax fee = gas limit × gas price. Clear both to use the wallet's defaults."
    );

    // Cleared, the editor sends no gas of its own.
    editor.setGas(null);
    expect(editor.readFinalGas()).toBeUndefined();
  });

  it("adds nothing to the panel when nothing is put there, as the approval page uses it", async () => {
    const editor = dom.document.createElement("dusk-gas-editor");
    editor.helpText = "Approval help.";
    editor.setGas({ limit: "2000000", price: "1" });
    dom.document.body.appendChild(editor);
    editor.querySelector(".link-btn").click();

    expect(editor.querySelector(".gas-edit-extra").childNodes).toEqual([]);
    expect(visibleText(editor.querySelector(".row"))).toBe("Gas limitGas priceApproval help.");

    // What is put there later still lands in the panel.
    const line = dom.document.createElement("div");
    line.textContent = "Later";
    editor.setEditContent(line);
    expect(editor.querySelector(".gas-edit-extra").childNodes).toEqual([line]);

    // An empty slot takes no room.
    const css = await readFile(path.resolve(process.cwd(), "public", "ui.css"), "utf8");
    expect(css).toMatch(/\.gas-edit-extra:empty \{\s*display: none;\s*\}/);
  });
});
