import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("wallet-core asset", () => {
  it("loads the packaged 1.7.1 wasm asset", async () => {
    const root = process.cwd();
    const source = await readFile(path.resolve(root, "src", "shared", "walletEngine.js"), "utf8");
    const asset = path.resolve(root, "public", "wallet_core-1.7.1.wasm");

    expect(source).toContain('assetUrl("wallet_core-1.7.1.wasm")');
    await access(asset);
    expect((await stat(asset)).size).toBeGreaterThan(0);
  });
});
