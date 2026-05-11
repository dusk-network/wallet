import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("background lock lifecycle conformance", () => {
  it("explicit lock and auto-lock both clear dApp-visible profiles", async () => {
    const source = await readFile(path.resolve(process.cwd(), "src/background/index.js"), "utf8");

    expect(source).toMatch(
      /message\?\.type === "DUSK_UI_LOCK"[\s\S]*?engineCall\("engine_lock"\)[\s\S]*?broadcastProfilesChangedAll/
    );
    expect(source).toMatch(
      /if \(elapsed >= timeoutMs\) \{[\s\S]*?engineCall\("engine_lock"\)[\s\S]*?broadcastProfilesChangedAll/
    );
  });

  it("unlock publishes fresh dApp profile visibility only after engine unlock succeeds", async () => {
    const source = await readFile(path.resolve(process.cwd(), "src/background/index.js"), "utf8");

    expect(source).toMatch(
      /message\?\.type === "DUSK_UI_UNLOCK"[\s\S]*?unlockVault\(password\)[\s\S]*?engineCall\(\s*"engine_unlock"[\s\S]*?broadcastProfilesChangedAll/
    );
  });
});
