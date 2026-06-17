import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = process.cwd();
const ICON_DIR = path.resolve(ROOT, "public", "icons");
const SOURCE = path.join(ICON_DIR, "dusk-extension-icon.svg");
const SIZES = [16, 32, 48, 128];

const svg = await fs.readFile(SOURCE, "utf8");
const dataUri = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;

const browser = await chromium.launch({ headless: true });

try {
  for (const size of SIZES) {
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    });

    await page.setContent(
      `<!doctype html><html><body style="margin:0;background:transparent"><img src="${dataUri}" width="${size}" height="${size}" /></body></html>`
    );
    await page.screenshot({
      path: path.join(ICON_DIR, `dusk-${size}.png`),
      clip: { x: 0, y: 0, width: size, height: size },
      omitBackground: true,
    });
    await page.close();
  }
} finally {
  await browser.close();
}
