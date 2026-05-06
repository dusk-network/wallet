import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("notification approval UI", () => {
  it("derives transfer rail labels from declared privacy, not recipient type", async () => {
    const source = await readFile(path.resolve(process.cwd(), "src", "ui", "notification", "app.js"), "utf8");
    const transferBlock = source.match(/if \(txKind === TX_KIND\.TRANSFER\) \{([\s\S]*?)const amountLuxStr = prettyAmount/);

    expect(transferBlock?.[1]).toContain('privacy === "shielded"');
    expect(transferBlock?.[1]).toContain("Shielded (Phoenix)");
    expect(transferBlock?.[1]).toContain("Public (Moonlight)");
    expect(transferBlock?.[1]).not.toContain("ProfileGenerator.typeOf");
  });
});
