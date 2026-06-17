import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("home dashboard action icons", () => {
  it("uses crisp SVG glyphs for the primary wallet actions", async () => {
    const source = await readFile(
      path.resolve(process.cwd(), "src", "ui", "popup", "views", "home.js"),
      "utf8"
    );

    expect(source).toContain('send: [');
    expect(source).toContain('receive: [');
    expect(source).toContain('shield: [');
    expect(source).toContain('stake: [');
    expect(source).toContain('actionBtn("Send", "send"');
    expect(source).toContain('actionBtn("Receive", "receive"');
    expect(source).toContain('actionBtn("Shield", "shield"');
    expect(source).toContain('actionBtn("Stake", "stake"');
    expect(source).not.toContain('actionBtn("Send", "↑"');
    expect(source).not.toContain('actionBtn("Receive", "↓"');
    expect(source).not.toContain('actionBtn("Shield", "✦"');
    expect(source).not.toContain('actionBtn("Stake", "△"');
  });
});
