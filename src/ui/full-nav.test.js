import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { installFakeDom, settle } from "./testing/fakeDom.js";

vi.mock("../wallet/bus.js", () => ({ send: vi.fn() }));
vi.mock("../shared/duskNames.js", async (importOriginal) => ({
  ...(await importOriginal()),
  lookupPrimaryName: vi.fn(async () => null),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("full wallet navigation", () => {
  it("exposes Activity after Dashboard, and Shield between Receive and Stake, in full-view shells", async () => {
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
      expect(nav).toContain('data-route="activity">Activity');
      expect(nav).not.toContain(">History<");
      expect(nav.indexOf('data-route="home"')).toBeLessThan(nav.indexOf('data-route="activity"'));
      expect(nav.indexOf('data-route="activity"')).toBeLessThan(nav.indexOf('data-route="send"'));
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
    expect(source).toContain('data-route="activity">Activity');
    expect(source).not.toContain('data-route="activity">History');
  });

  it("opens Activity from the sidebar, and marks it while Activity or a transaction opened there shows", async () => {
    const ACCOUNT =
      "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927";
    const dom = installFakeDom({ pathname: "/full.html" });
    const make = (tag, props = {}) => Object.assign(dom.document.createElement(tag), props);
    // The sidebar's items as full.html has them.
    const shell = await readFile(path.resolve(process.cwd(), "public", "full.html"), "utf8");
    const nav = make("nav", { className: "full-nav" });
    for (const [, route, label] of shell.matchAll(/data-route="([^"]+)">([^<]+)</g)) {
      const item = make("button", { className: "full-nav-item", textContent: label });
      item.setAttribute("data-route", route);
      nav.appendChild(item);
    }
    const pill = make("button", { id: "network-pill" });
    pill.appendChild(make("span", { className: "network-pill__label" }));
    const app = make("div", { id: "app" });
    dom.document.body.append(pill, nav, make("div", { id: "header-actions" }), app);

    vi.resetModules();
    const { send } = await import("../wallet/bus.js");
    send.mockImplementation(async (message) =>
      message.type === "DUSK_UI_OVERVIEW"
        ? { hasVault: true, isUnlocked: true, networkName: "Testnet", nodeUrl: "https://testnet.nodes.dusk.network", accounts: [ACCOUNT], selectedAccountIndex: 0, balance: { value: "0" } }
        : {}
    );
    const { render } = await import("./popup/app.js");
    const { state } = await import("./popup/state.js");
    await render();
    await settle();
    const marked = () => nav.querySelectorAll("[aria-current=page]").map((item) => item.textContent);
    expect(marked()).toEqual(["Dashboard"]);

    state.activityFilter = "sent";
    nav.querySelectorAll("button").find((item) => item.textContent === "Activity").click();
    await settle();
    expect([state.route, state.activityFilter, marked()]).toEqual(["activity", "all", ["Activity"]]);
    expect(app.querySelector(".subnav-title").textContent).toBe("Activity");

    // A transaction's details: the item it was opened from.
    Object.assign(state, { route: "tx", txDetailHash: "ab".repeat(32), txDetailFrom: "activity" });
    await render();
    expect(marked()).toEqual(["Activity"]);
    state.txDetailFrom = "contacts";
    await render();
    expect(marked()).toEqual(["Contacts"]);
    state.txDetailFrom = "home";
    await render();
    expect(marked()).toEqual(["Dashboard"]);
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

  it("puts each wallet page's top row in a header landmark and its content in main", async () => {
    for (const file of [["public", "popup.html"], ["public", "full.html"], ["public", "index.html"], ["public", "options.html"], ["index.html"]]) {
      const source = await readFile(path.resolve(process.cwd(), ...file), "utf8");
      expect(source, file.join("/")).toMatch(/<header class="panel-header">[\s\S]*<\/header>\s*<main class="panel-content">\s*<div id="app"><\/div>\s*<\/main>/);
      expect(source, file.join("/")).not.toMatch(/<div class="panel-(header|content)">/);
    }
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
