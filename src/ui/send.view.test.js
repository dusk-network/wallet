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

  it("uses shared recipient badges for send contact and privacy indicators", async () => {
    const sendView = await readFile(
      path.resolve(process.cwd(), "src", "ui", "popup", "views", "send.js"),
      "utf8"
    );
    const badgeComponent = await readFile(
      path.resolve(process.cwd(), "src", "ui", "components", "RecipientBadge.js"),
      "utf8"
    );
    const css = await readFile(path.resolve(process.cwd(), "public", "ui.css"), "utf8");

    expect(sendView).toContain("RecipientBadge.js");
    expect(sendView).toContain("recipientTypeBadgeOptions");
    expect(sendView).toContain('kind: "contact"');
    expect(sendView).toContain('className: "to-chip"');

    expect(badgeComponent).toContain("recipientBadge");
    expect(badgeComponent).toContain('label: "Public"');
    expect(badgeComponent).toContain('label: "Shielded"');
    expect(badgeComponent).toContain('icon: "public"');
    expect(badgeComponent).toContain('icon: "shielded"');
    expect(badgeComponent).not.toContain('icon: "P"');
    expect(badgeComponent).not.toContain('icon: "S"');

    expect(css).toContain(".recipient-badge--contact");
    expect(css).toMatch(/\.recipient-badge--contact\s*\{[^}]*var\(--ok\)/s);
    expect(css).toContain(".recipient-badge--rail");
    expect(css).toMatch(/\.recipient-badge--rail\s*\{[^}]*var\(--primary\)/s);
    expect(css).toContain(".recipient-badge__glyph--svg svg");
  });
});
