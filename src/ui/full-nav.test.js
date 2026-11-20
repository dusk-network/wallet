import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("the pages' lock state", () => {
  it("refreshes stale lock state from full-view navigation and profile switching", async () => {
    const source = await readFile(path.resolve(process.cwd(), "src", "ui", "popup", "app.js"), "utf8");

    expect(source).toContain('state.needsRefresh = true;');
    expect(source).toContain("await render({ forceRefresh: true });");
    expect(source).toContain("isWalletLockedResponse(resp)");
    expect(source).toContain("applyLockedOverviewPatch();");
  });

  it("listens for background lock-state pushes", async () => {
    const source = await readFile(path.resolve(process.cwd(), "src", "ui", "popup", "app.js"), "utf8");

    expect(source).toContain('msg?.type === "DUSK_UI_LOCK_STATE"');
    expect(source).toContain("scheduleLockedRefresh();");
  });

  it("background broadcasts UI lock-state changes", async () => {
    const source = await readFile(path.resolve(process.cwd(), "src", "background", "index.js"), "utf8");

    expect(source).toContain('type: "DUSK_UI_LOCK_STATE"');
    expect(source).toContain('lockWallet("auto_lock")');
    expect(source).toContain('lockWallet("manual_lock")');
    expect(source).toContain('emitUiLockState(true, "unlock")');
  });
});
