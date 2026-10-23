import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

async function source(relativePath) {
  return await readFile(path.resolve(root, relativePath), "utf8");
}

describe("gas quick controls", () => {
  it("owns the shared gas suggestion behavior", async () => {
    const component = await source("src/ui/components/GasQuickControls.js");

    expect(component).toContain("DUSK_UI_GET_CACHED_GAS_PRICE");
    expect(component).toContain('text: "Recommended"');
    expect(component).toContain("gasEditor.setGas");
    expect(component).toContain("Gas price unavailable (using defaults).");
    // The gas price line and the presets go in the panel the fee's Edit opens.
    expect(component).toContain("gasEditor.setEditContent([gasHint, gasQuickRow]);");
  });

  it("is used by every transaction review view, which leaves it to the fee's Edit and has no Cancel", async () => {
    for (const name of ["send", "stake", "convert", "sozu"]) {
      const view = await source(`src/ui/popup/views/${name}.js`);
      expect(view).toContain('import { createGasQuickControls } from "../../components/GasQuickControls.js";');
      expect(view).toContain("createGasQuickControls({");
      expect(view).not.toContain('text: "Loading gas price suggestion…"');
      // The view doesn't place the gas price line or the presets itself.
      expect(view).not.toMatch(/gasHint|gasQuickRow/);
      // Back does what Cancel did.
      expect(view).not.toContain('text: "Cancel"');
    }

    // A token transfer's Review keeps its gas price suggestion behind Edit too.
    const assets = await source("src/ui/popup/views/assets.js");
    expect(assets).toContain("gasEditor.setEditContent([gasHint]);");
    expect(assets).not.toContain('text: "Cancel"');
  });
});
