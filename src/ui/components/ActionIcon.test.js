import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { installFakeDom, settle } from "../testing/fakeDom.js";
import { iconSvg } from "./ActionIcon.js";
import { openQrScanModal } from "./QrScanModal.js";

// Glyphs the popup drew icons with. Many systems have no font with them, and
// show an empty box, or draw them off-center in their button.
const GLYPHS = ["⟳", "⤢", "▦", "⚙", "★", "✕", "＋", "⬢", "⧉", "ⓘ"];

const VIEWS = [
  "src/ui/popup/header.js",
  "src/ui/popup/views/home.js",
  "src/ui/popup/views/send.js",
  "src/ui/popup/views/receive.js",
  "src/ui/popup/views/addressbook.js",
  "src/ui/popup/views/assets.js",
  "src/ui/components/AccountMenu.js",
  "src/ui/components/QrScanModal.js",
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("popup icons", () => {
  it("are SVG icons rather than glyphs that need a font that has them", async () => {
    for (const file of VIEWS) {
      const source = await readFile(path.resolve(process.cwd(), file), "utf8");
      // A comment may name a glyph; the code may not draw one.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      for (const glyph of GLYPHS) expect(code, `${file} draws ${glyph}`).not.toContain(glyph);
    }

    const names = ["refresh", "eye", "eye-off", "expand", "settings", "qr", "contacts", "close", "plus", "nft", "copy", "info"];
    for (const name of names) {
      expect(iconSvg(name)).toMatch(/^<svg viewBox="0 0 24 24" aria-hidden="true"><(path|rect|circle) [^>]+\/>/);
    }

    // The icon-only buttons size and colour theirs, and rows their icons, the NFT mark among them.
    const css = await readFile(path.resolve(process.cwd(), "public", "ui.css"), "utf8");
    expect(css).toMatch(/\.icon-btn\.icon-only svg,\s*button\.balance-refresh svg,/);
    expect(css).toMatch(/\.row-icon svg,\s*\.row-chev svg,/);
  });

  it("closes the QR scanner with a labelled close icon", async () => {
    const { document } = installFakeDom();
    const scan = openQrScanModal({ title: "Scan request" });
    const close = document.body.querySelector(".qrscan-head button");
    expect([close.getAttribute("aria-label"), close.innerHTML, close.textContent]).toEqual([
      "Close",
      iconSvg("close"),
      "",
    ]);

    close.click();
    await settle();
    expect(await scan).toBeNull();
    expect(document.body.querySelector(".qrscan-overlay")).toBeNull();
  });
});
