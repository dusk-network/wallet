import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("extension icon assets", () => {
  it("uses high-contrast toolbar icons generated from a dedicated source", async () => {
    const root = process.cwd();
    const chromeManifest = JSON.parse(
      await readFile(path.resolve(root, "public", "manifest.json"), "utf8")
    );
    const firefoxManifest = JSON.parse(
      await readFile(path.resolve(root, "config", "manifest.firefox.json"), "utf8")
    );
    const source = await readFile(
      path.resolve(root, "public", "icons", "dusk-extension-icon.svg"),
      "utf8"
    );
    const generator = await readFile(
      path.resolve(root, "scripts", "generate-icons.js"),
      "utf8"
    );

    for (const manifest of [chromeManifest, firefoxManifest]) {
      expect(manifest.action.default_icon).toEqual({
        16: "icons/dusk-16.png",
        32: "icons/dusk-32.png",
        48: "icons/dusk-48.png",
        128: "icons/dusk-128.png",
      });
      expect(manifest.icons).toEqual(manifest.action.default_icon);
    }

    expect(source).toContain('fill="#101010"');
    expect(source).toContain('fill="#E2DFE9"');
    expect(generator).toContain("const SIZES = [16, 32, 48, 128];");
  });
});
