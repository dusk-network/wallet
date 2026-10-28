import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fakeEvent, installFakeDom, screenReaderText, settle, visibleText } from "../testing/fakeDom.js";
import { iconSvg } from "../components/ActionIcon.js";

vi.mock("../../shared/duskNames.js", async (importOriginal) => ({
  ...(await importOriginal()),
  lookupPrimaryName: vi.fn(async () => null),
}));

const ACCOUNT =
  "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927";
const SECOND =
  "2Ana1pUpv2ZbMVkwF5FXapYeBEjdxDatLn7nvJkhgTSXbs59SyZSx866bXirPgj8QQVB57uxHJBG1YFvkRbFj4T";

const overview = {
  hasVault: true,
  isUnlocked: true,
  networkName: "Testnet",
  nodeUrl: "https://testnet.nodes.dusk.network",
  accounts: [ACCOUNT, SECOND],
  accountCount: 2,
  selectedAccountIndex: 0,
};

// The popup, or the full view in a tab; env.js reads which when it loads.
const VIEWS = {
  popup: { pathname: "/popup.html", bodyClass: "page--popup" },
  full: { pathname: "/full.html", bodyClass: "page--full" },
};

let menus = [];

async function setup(view) {
  const dom = installFakeDom({ pathname: VIEWS[view].pathname });
  dom.document.body.className = VIEWS[view].bodyClass;
  vi.resetModules();
  const names = await import("../../shared/duskNames.js");
  names.lookupPrimaryName.mockReset();
  names.lookupPrimaryName.mockResolvedValue(null);
  const { createHeaderRenderer } = await import("./header.js");
  const { createAccountMenuController } = await import("../components/AccountMenu.js");

  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const acctMenu = createAccountMenuController({ onSelectAccountIndex: vi.fn() });
  menus.push(acctMenu);
  const renderHeader = createHeaderRenderer({
    headerActionsHost: host,
    netMenu: { isOpen: false, open: vi.fn(), close: vi.fn() },
    acctMenu,
    onOpenOptions: vi.fn(),
    onExpand: vi.fn(),
  });
  return {
    dom,
    names,
    host,
    acctMenu,
    renderHeader,
    chip: () => host.querySelector(".account-chip"),
    menu: () => dom.document.body.querySelector(".acct-menu"),
  };
}

afterEach(() => {
  for (const menu of menus) menu.close();
  menus = [];
  vi.unstubAllGlobals();
});

describe("header", () => {
  it.each(Object.keys(VIEWS))("holds the account chip and Settings, no ▾ button or Refresh (%s)", async (view) => {
    const { host, renderHeader } = await setup(view);
    renderHeader(overview);
    expect(host.children.map((el) => el.className)).toEqual(["account-chip", "icon-btn icon-only"]);
    expect(host.children[1].title).toBe("Settings");
    for (const title of ["Switch profile", "Profiles", "Refresh"]) {
      expect(host.querySelector(`[title="${title}"]`)).toBeNull();
    }
    expect(host.textContent).not.toContain("⟳");
  });

  it("draws Expand view and Settings as labelled SVG icons, not glyphs", async () => {
    const { host, renderHeader } = await setup("popup");
    // The extension's popup can expand into a tab.
    vi.stubGlobal("browser", { runtime: { id: "dusk-wallet", sendMessage: () => {} } });
    renderHeader(overview);
    expect(
      host.querySelectorAll(".icon-btn").map((b) => [b.title, b.getAttribute("aria-label"), b.innerHTML, b.textContent])
    ).toEqual([
      ["Expand view", "Expand view", iconSvg("expand"), ""],
      ["Settings", "Settings", iconSvg("settings"), ""],
    ]);
  });

  it("shows the profile's label without a name, the account only in the tooltip, and the verified name once there is one", async () => {
    const { names, renderHeader, chip } = await setup("popup");
    renderHeader(overview);
    await settle();
    expect(visibleText(chip())).toBe("Profile 1▾");
    expect(chip().title).toBe(`Profile 1\n${ACCOUNT}`);
    expect(screenReaderText(chip())).not.toContain(ACCOUNT.slice(0, 6));
    expect(names.lookupPrimaryName).toHaveBeenCalledWith(ACCOUNT, { nodeUrl: overview.nodeUrl, stale: true });

    // A label set on this device takes its place; another profile shows its own.
    renderHeader({ ...overview, accountNames: { 0: "Savings" } });
    await settle();
    expect(visibleText(chip())).toBe("Savings▾");
    renderHeader({ ...overview, selectedAccountIndex: 1 });
    await settle();
    expect([visibleText(chip()), chip().title]).toEqual(["Profile 2▾", `Profile 2\n${SECOND}`]);

    names.lookupPrimaryName.mockResolvedValue("alice.dusk");
    renderHeader(overview);
    await settle();
    expect(chip().textContent).toBe("alice.dusk▾");
    expect(chip().title).toBe(`alice.dusk\n${ACCOUNT}`);
  });

  it("opens and closes the profile switcher from the chip", async () => {
    const { acctMenu, renderHeader, chip, menu } = await setup("popup");
    renderHeader(overview);
    chip().click();
    expect(acctMenu.isOpen).toBe(true);
    expect(menu().textContent).toContain("Select profile");
    expect(menu().querySelectorAll(".acct-menu-row")).toHaveLength(2);
    expect(chip().getAttribute("aria-expanded")).toBe("true");

    chip().click();
    expect(acctMenu.isOpen).toBe(false);
    expect(menu()).toBeNull();
    expect(chip().getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps the chip through renders while the switcher is open, so pressing it still closes it", async () => {
    const { acctMenu, renderHeader, chip } = await setup("popup");
    renderHeader(overview);
    chip().click();
    const opened = chip();

    // A toast or the shielded-sync poll redraws the header.
    renderHeader(overview);
    renderHeader({ ...overview, networkStatus: { nodeStatus: "online" } });
    expect(chip()).toBe(opened);

    // The switcher closes on a press outside it, and the chip isn't outside.
    chip().dispatchEvent(fakeEvent("mousedown"));
    expect(acctMenu.isOpen).toBe(true);
    chip().click();
    expect(acctMenu.isOpen).toBe(false);

    // Closed, the next render draws a fresh chip.
    renderHeader(overview);
    expect(chip()).not.toBe(opened);
  });

  it("names the network it moves to on the pill while it switches", async () => {
    const { dom, renderHeader } = await setup("popup");
    // The pill, as popup.html has it.
    const pill = dom.document.createElement("button");
    pill.id = "network-pill";
    pill.className = "network-pill";
    const label = dom.document.createElement("span");
    label.className = "network-pill__label";
    pill.appendChild(label);
    dom.document.body.appendChild(pill);
    renderHeader(overview);
    expect(label.textContent).toBe("Testnet");

    const { setNetworkSwitching } = await import("../components/NetworkMenu.js");
    setNetworkSwitching(pill, "Mainnet");
    // A render meanwhile, from a toast or a poll, still has the old network.
    renderHeader(overview);
    expect(label.textContent).toBe("Mainnet");
    setNetworkSwitching(pill, null);
    renderHeader({ ...overview, networkName: "Mainnet" });
    expect([label.textContent, pill.className]).toEqual(["Mainnet", "network-pill"]);
  });

  it.each(Object.keys(VIEWS))("says above the header that test DUSK has no value, on a test network only (%s)", async (view) => {
    const { dom, renderHeader } = await setup(view);
    // The page's panel, its header first, as popup.html and full.html have it.
    const panel = dom.document.createElement("div");
    panel.className = "panel";
    const header = dom.document.createElement("div");
    header.className = "panel-header";
    panel.appendChild(header);
    dom.document.body.appendChild(panel);
    const strips = () => panel.querySelectorAll(".testnet-strip");

    renderHeader(overview);
    expect(strips().map((s) => [s.textContent, s.getAttribute("role")])).toEqual([["Testnet · Test DUSK has no value", "note"]]);
    expect(panel.children[0]).toBe(strips()[0]);
    // Locked, it still says so; a redraw keeps the one strip.
    renderHeader({ ...overview, isUnlocked: false });
    expect(strips()).toHaveLength(1);
    renderHeader({ ...overview, networkName: "Devnet" });
    expect(strips().map((s) => s.textContent)).toEqual(["Devnet · Test DUSK has no value"]);

    renderHeader({ ...overview, networkName: "Mainnet", nodeUrl: "https://nodes.dusk.network" });
    expect(strips()).toHaveLength(0);
    expect(panel.children).toEqual([header]);
  });

  it("puts the strip across the top of the full view, over the sidebar, staying as the page scrolls", async () => {
    const css = await readFile(path.resolve(process.cwd(), "public", "ui.css"), "utf8");
    // A rule's declarations, by its selector and indent as the sheet writes it.
    const rule = (selector) => css.split("\n}").find((block) => `\n${block}`.includes(`\n${selector} {`)) ?? "";
    const desktop = css.slice(css.indexOf("@media (min-width: 861px) {"));
    const inDesktop = (selector) => desktop.split("\n  }").find((block) => `\n${block}`.includes(`\n  ${selector} {`)) ?? "";

    const strip = inDesktop("body.page--full .panel > .testnet-strip");
    for (const declaration of ["position: sticky;", "top: 0;", "grid-column: 1 / -1;", "grid-row: 1;", "height: var(--strip-height);"]) {
      expect(strip, declaration).toContain(declaration);
    }
    expect(inDesktop("body.page--full .panel")).toContain("grid-template-rows: auto minmax(0, 1fr);");
    // The sidebar and the page under it.
    const sidebar = inDesktop("body.page--full .panel-header");
    expect(sidebar).toContain("grid-row: 2;");
    expect(sidebar).toContain("top: var(--strip-height);");
    expect(sidebar).toContain("height: calc(100vh - var(--strip-height));");
    expect(inDesktop("body.page--full .panel-content")).toContain("grid-row: 2;");
    // The strip's height, only while it shows.
    expect(rule("body.page--full")).toContain("--strip-height: 0px;");
    expect(rule("body.page--full:has(.panel > .testnet-strip)")).toContain("--strip-height: 35px;");
    // Sticky to the window: the wrap clips without becoming a scroll box.
    expect(rule(".full-wrap")).toContain("overflow: clip;");
    expect(rule(".full-wrap")).not.toContain("overflow: hidden;");
  });

  it("names the active site in the chip's tooltip as its approval did", async () => {
    // Sites connect in the extension only.
    vi.stubGlobal("chrome", { runtime: { id: "wallet", sendMessage: vi.fn() } });
    const { renderHeader, chip } = await setup("popup");
    renderHeader({ ...overview, activeOrigin: "http://127.0.0.1:5354", activeConnected: true });
    expect(chip().title.split("\n").at(-1)).toBe("Connected: http://127.0.0.1:5354");
    renderHeader({ ...overview, activeOrigin: "https://app.example:8443", activeConnected: false });
    expect(chip().title.split("\n").at(-1)).toBe("Site: app.example:8443");
  });

  it("keeps the keyboard on the chip when another profile redraws it", async () => {
    const { dom, renderHeader, chip } = await setup("popup");
    renderHeader(overview);
    const first = chip();
    first.focus();
    renderHeader({ ...overview, selectedAccountIndex: 1 });
    expect(chip()).not.toBe(first);
    expect(dom.document.activeElement).toBe(chip());
  });

  it("leaves the chip out while the wallet is locked", async () => {
    const { host, renderHeader, chip } = await setup("popup");
    renderHeader({ ...overview, isUnlocked: false });
    expect(chip()).toBeNull();
    expect(host.children.map((el) => el.title)).toEqual(["Settings"]);
  });

  it("keeps the brand and network pill at full width and lets the chip give way", async () => {
    const css = await readFile(path.resolve(process.cwd(), "public", "ui.css"), "utf8");
    // The declarations of the top-level rule for exactly `selector`.
    const rule = (selector) => css.split("\n}").find((block) => `\n${block}`.includes(`\n${selector} {`)) ?? "";

    expect(rule(".brand")).toContain("flex: 0 0 auto;");
    expect(rule(".brand")).not.toContain("min-width: 0;");
    expect(rule(".header-actions")).toContain("min-width: 0;");
    expect(rule(".header-actions > *")).toContain("flex: 0 0 auto;");
    expect(rule(".header-actions > .account-chip")).toContain("flex: 0 1 auto;");
    expect(rule(".account-chip")).toContain("min-width: 0;");
    // One line that ends in one "…" when it has to shrink, whatever it holds.
    for (const declaration of ["min-width: 0;", "overflow: hidden;", "text-overflow: ellipsis;", "white-space: nowrap;"]) {
      expect(rule(".account-chip .chip-text")).toContain(declaration);
    }
    expect(css).not.toContain("chip-text__");
    expect(rule(".account-chip .chip-chev")).toContain("flex: 0 0 auto;");
    // The chip shows its line in the popup too, and stays on narrow screens.
    expect(css).not.toMatch(/body\.page--popup \.account-chip \.chip-text\s*\{[^}]*display: none/);
    expect(css).not.toMatch(/\.account-chip \{ display: none; \}/);
    expect(css).toMatch(/@media \(max-width: 520px\) \{\s*body\.page--full \.brand-text \{ display: none; \}/);
  });
});
