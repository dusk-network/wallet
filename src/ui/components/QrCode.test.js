import { afterEach, describe, expect, it, vi } from "vitest";
import { installFakeDom } from "../testing/fakeDom.js";
import { qrPngBlob, qrSvgString } from "./QrCode.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("QrCode", () => {
  it("exports an SVG string for a QR value", () => {
    const svg = qrSvgString("dusk:public-abc123");

    expect(svg).toContain("<svg");
    expect(svg).toContain("viewBox=");
    expect(svg).toContain("width=");
    expect(svg).toContain("height=");
    expect(svg).toContain("class=\"qr-svg\"");
    expect(svg).toContain("<path");
  });

  it("returns an empty string for an empty QR value", () => {
    expect(qrSvgString("")).toBe("");
    expect(qrSvgString("   ")).toBe("");
  });
});

// Chen's and Sofía's: "Dusk payment request · Te…" and "To sofiadesign.dusk · sEeMSo…v9…" on the saved picture.
describe("a request's saved picture", () => {
  it("writes each line of its caption whole, on more lines where one is too wide, and the picture grows for them", async () => {
    // A canvas whose text is half its size wide a character, recording what's written where.
    const written = [];
    const canvases = [];
    installFakeDom({
      elements: {
        canvas: (el) => {
          canvases.push(el);
          const ctx = {
            font: "",
            measureText: (text) => ({ width: Array.from(text).length * Number.parseFloat(String(ctx.font).split(" ")[1]) * 0.5 }),
            fillRect() {},
            drawImage() {},
            fillText: (text, x, y) => written.push({ text, y, font: ctx.font }),
          };
          el.getContext = () => ctx;
          el.toBlob = (done) => done(new Blob(["png"]));
        },
      },
    });
    vi.stubGlobal("URL", { createObjectURL: () => "blob:qr", revokeObjectURL: () => {} });
    vi.stubGlobal("Image", class {
      set src(url) {
        setTimeout(() => this.onload?.(url));
      }
    });
    const caption = [
      { size: 44, weight: 600, text: "Dusk payment request · Testnet" },
      { size: 64, weight: 600, text: "0.03 DUSK" },
      { size: 40, text: "Invoice 2026-115" },
      { size: 36, text: "To sofiadesign.dusk · sEeMSo…v9kgd7" },
    ];
    await qrPngBlob("dusk:public-abc123@dusk:2?amount=0.03", { caption });
    const lines = written.map((w) => w.text);
    // Nothing cut: every word there, in its order, and no ellipsis added.
    expect(lines.join(" ")).toBe(caption.map((c) => c.text).join(" "));
    expect(lines.filter((line) => line.endsWith("…"))).toEqual([]);
    // In the width there is, on more lines than the caption has.
    const [canvas] = canvases;
    const wide = (w) => Array.from(w.text).length * Number.parseFloat(w.font.split(" ")[1]) * 0.5;
    expect(written.every((w) => wide(w) <= canvas.width - 32)).toBe(true);
    expect(lines.length).toBeGreaterThan(caption.length);
    // Each line under the one before, all in the picture.
    expect(written.every((w, i) => i === 0 || w.y > written[i - 1].y)).toBe(true);
    expect(written.at(-1).y + 36).toBeLessThanOrEqual(canvas.height);
  });
});
