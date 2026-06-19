import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("convert view", () => {
  it("uses shared recipient badges for shield and unshield flow indicators", async () => {
    const source = await readFile(
      path.resolve(process.cwd(), "src", "ui", "popup", "views", "convert.js"),
      "utf8"
    );
    const badgeComponent = await readFile(
      path.resolve(process.cwd(), "src", "ui", "components", "RecipientBadge.js"),
      "utf8"
    );

    expect(source).toContain("RecipientBadge.js");
    expect(source).toContain("privacyFlowBadgeOptions");
    expect(source).toContain("recipientBadge");
    expect(source).not.toContain('class: "meta-pill", text: `${fromLabel} → ${toLabel}`');

    expect(badgeComponent).toContain("privacyFlowBadgeOptions");
    expect(badgeComponent).toContain("`${fromLabel} -> ${toLabel}`");
  });
});
