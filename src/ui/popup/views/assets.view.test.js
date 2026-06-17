import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("assets view", () => {
  it("passes token data-driver hints through balance, encode, and tx metadata paths", async () => {
    const source = await readFile(
      path.resolve(process.cwd(), "src", "ui", "popup", "views", "assets.js"),
      "utf8"
    );

    expect(source).toContain("driver: t?.driver");
    expect(source).toContain("driver: token?.driver");
    expect(source).toContain("token: { contractId: cid, symbol: sym, name, decimals: dec, driver: token?.driver }");
    expect(source).toContain("driver: token?.driver");
  });
});
