import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("full wallet navigation", () => {
  it("exposes Shield between Receive and Stake in full-view shells", async () => {
    const files = [
      ["public", "full.html"],
      ["public", "index.html"],
      ["public", "options.html"],
      ["index.html"],
    ];

    for (const file of files) {
      const source = await readFile(path.resolve(process.cwd(), ...file), "utf8");
      const nav = source.match(/<nav class="full-nav"[\s\S]*?<\/nav>/)?.[0] ?? "";

      expect(nav).toContain('data-route="convert">Shield');
      expect(nav).not.toContain('data-route="activity"');
      expect(nav).not.toContain(">History<");
      expect(nav.indexOf('data-route="receive"')).toBeLessThan(nav.indexOf('data-route="convert"'));
      expect(nav.indexOf('data-route="convert"')).toBeLessThan(nav.indexOf('data-route="stake"'));
    }
  });

  it("marks Shield active while reviewing a shield transaction", async () => {
    const source = await readFile(path.resolve(process.cwd(), "src", "ui", "popup", "app.js"), "utf8");

    expect(source).toContain('rawRoute === "convert_confirm"');
    expect(source).toContain('? "convert"');
  });

  it("generates Shield in full-view nav shells", async () => {
    const source = await readFile(path.resolve(process.cwd(), "scripts", "generate-shells.js"), "utf8");

    expect(source).toContain('data-route="convert">Shield');
    expect(source).not.toContain('data-route="activity">History');
  });

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

  it("names every page's language, English, so screen readers read it in an English voice", async () => {
    const { readdir } = await import("node:fs/promises");
    const pages = (await readdir(path.resolve(process.cwd(), "public"))).filter((f) => f.endsWith(".html")).map((f) => ["public", f]);
    expect(pages.map((p) => p[1])).toEqual(expect.arrayContaining(["popup.html", "full.html", "notification.html", "options.html"]));
    for (const file of [...pages, ["index.html"]]) {
      const source = await readFile(path.resolve(process.cwd(), ...file), "utf8");
      expect(source, file.join("/")).toMatch(/<html lang="en">/);
    }
    // The shells the build generates say so too.
    const generator = await readFile(path.resolve(process.cwd(), "scripts", "generate-shells.js"), "utf8");
    expect(generator).not.toMatch(/<html>/);
  });
});
