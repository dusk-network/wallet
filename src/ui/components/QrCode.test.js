import { describe, expect, it } from "vitest";
import { qrSvgString } from "./QrCode.js";

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
