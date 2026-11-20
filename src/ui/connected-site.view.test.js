import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { installFakeDom, settle, visibleText } from "./testing/fakeDom.js";

vi.mock("../wallet/bus.js", () => ({ send: vi.fn() }));
vi.mock("../shared/duskNames.js", async (importOriginal) => ({
  ...(await importOriginal()),
  lookupPrimaryName: vi.fn(async () => null),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("connected site status", () => {
  it("exposes UI messages for connecting and disconnecting the active origin", async () => {
    const background = await readFile(
      path.resolve(process.cwd(), "src", "background", "index.js"),
      "utf8"
    );

    expect(background).toContain('message?.type === "DUSK_UI_CONNECT_ORIGIN"');
    expect(background).toContain('message?.type === "DUSK_UI_DISCONNECT_ORIGIN"');
    expect(background).toContain("approveOrigin(origin");
    // From the wallet the site's row names, else the open one (txLifecycle.flow.test.js).
    expect(background).toContain('const owner = String(message.siteWallet ?? "") || open;');
    expect(background).toContain("revokeOrigin(origin, owner)");
  });

  it("names the site in the popup's bar as its approval did: with its port, and http:// for a local site", async () => {
    const ACCOUNT =
      "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927";
    const dom = installFakeDom({ pathname: "/popup.html" });
    const make = (tag, props = {}) => Object.assign(dom.document.createElement(tag), props);
    const pill = make("button", { id: "network-pill" });
    pill.appendChild(make("span", { className: "network-pill__label" }));
    const app = make("div", { id: "app" });
    dom.document.body.append(pill, make("div", { id: "header-actions" }), app);

    vi.resetModules();
    const { send } = await import("../wallet/bus.js");
    let site = { activeOrigin: "http://127.0.0.1:5354", activeConnected: true };
    send.mockImplementation(async (message) =>
      message.type === "DUSK_UI_OVERVIEW"
        ? { hasVault: true, isUnlocked: true, networkName: "Testnet", nodeUrl: "https://testnet.nodes.dusk.network", accounts: [ACCOUNT], selectedAccountIndex: 0, balance: { value: "0" }, ...site }
        : {}
    );
    const { render } = await import("./popup/app.js");
    await render();
    await settle();
    const bar = () => app.querySelector(".site-bar");
    const origin = () => visibleText(bar().querySelector(".site-bar-origin"));
    const status = () => visibleText(bar().querySelector(".site-bar-status"));
    expect(origin()).toBe("http://127.0.0.1:5354");
    expect(bar().title).toBe("http://127.0.0.1:5354");
    const connected = status();

    // Amélie's: Wikipedia never asked for anything, and a big Connect sat on Home, Activity and Receive.
    site = { activeOrigin: "https://www.wikipedia.org", activeConnected: false };
    await render({ forceRefresh: true });
    expect(bar()).toBeNull();

    // A site that asked before, and isn't connected now: its Connect.
    site = { activeOrigin: "https://app.example:8443", activeConnected: false, siteRecords: { [ACCOUNT]: { "https://app.example:8443": { asked: [{ at: Date.now(), kind: "connect", answer: "rejected" }] } } } };
    await render({ forceRefresh: true });
    expect(origin()).toBe("app.example:8443");
    expect(status()).not.toBe(connected);

    // Not over a screen that moves money, where a stray press on a phone would connect the site open.
    const { state } = await import("./popup/state.js");
    for (const route of ["send", "confirm", "stake", "sent"]) {
      state.route = route;
      state.sent = route === "sent" ? { phase: "sent", status: "submitted", hash: "ab".repeat(32) } : null;
      await render({ forceRefresh: true });
      expect([route, bar()]).toEqual([route, null]);
    }
    state.route = "home";
    await render({ forceRefresh: true });
    expect(bar()).toBeTruthy();
  });
});
