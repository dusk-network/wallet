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
  });

  it("is used by every transaction review view", async () => {
    for (const name of ["send", "stake", "convert", "sozu"]) {
      const view = await source(`src/ui/popup/views/${name}.js`);
      expect(view).toContain('import { createGasQuickControls } from "../../components/GasQuickControls.js";');
      expect(view).toContain("createGasQuickControls({");
      expect(view).not.toContain('text: "Loading gas price suggestion…"');
    }
  });
});
