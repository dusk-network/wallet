import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("send view", () => {
  it("keeps the amount input visually separate from the slider helper", async () => {
    const component = await readFile(
      path.resolve(process.cwd(), "src", "ui", "components", "AmountSliderCard.js"),
      "utf8"
    );
    const css = await readFile(path.resolve(process.cwd(), "public", "ui.css"), "utf8");

    expect(component).toContain('class: "input-row amount-input-row"');
    expect(component).toContain('class: "amount-range-wrap amount-slider-helper"');
    expect(css).toContain(".amount-input-row");
    expect(css).toContain(".amount-card .amount-range-wrap");
    expect(css).not.toMatch(
      /\.amount-card \.amount-input\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent;/s
    );
  });

  it("passes explicit privacy for wallet-initiated transfers", async () => {
    const source = await readFile(
      path.resolve(process.cwd(), "src", "ui", "popup", "views", "send.js"),
      "utf8"
    );

    const draftBlock = source.match(/state\.draft = \{([\s\S]*?)state\.route = "confirm"/);
    expect(draftBlock?.[1]).toContain("privacy,");

    const sendBlock = source.match(/type: "DUSK_UI_SEND_TX"([\s\S]*?)memo: d\.memo/);
    expect(sendBlock?.[1]).toContain("privacy:");
    expect(sendBlock?.[1]).toContain('"shielded"');
    expect(sendBlock?.[1]).toContain('"public"');
  });
});
