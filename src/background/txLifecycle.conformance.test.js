import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("transaction lifecycle conformance", () => {
  it("does not treat execution watcher timeout/errors as transaction failure", async () => {
    const runtime = await readFile(path.resolve(process.cwd(), "src/engine/runtime.js"), "utf8");
    const localBus = await readFile(path.resolve(process.cwd(), "src/wallet/localBus.js"), "utf8");

    expect(runtime).not.toMatch(/catch \(e\) \{[\s\S]*?type: "DUSK_TX_EXECUTED"[\s\S]*?ok: false/);
    expect(localBus).not.toMatch(/catch \(e\) \{[\s\S]*?status: "failed"/);
  });
});
