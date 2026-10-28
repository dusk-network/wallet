import { afterEach, describe, expect, it, vi } from "vitest";

import { installFakeDom, settle, visibleText } from "../testing/fakeDom.js";

vi.mock("../../wallet/bus.js", () => ({ send: vi.fn() }));
vi.mock("../../shared/duskNames.js", async (importOriginal) => ({
  ...(await importOriginal()),
  lookupPrimaryName: vi.fn(async () => null),
}));

const ACCOUNT =
  "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927";
const LABEL = "Alice (landlord, private)";

afterEach(() => {
  vi.unstubAllGlobals();
});

// The popup, its wallet answering through the bus: contacts only while unlocked.
async function boot(overview) {
  const dom = installFakeDom({ pathname: "/popup.html" });
  dom.document.body.innerHTML = "";
  for (const id of ["header-actions", "app"]) {
    const el = dom.document.createElement("div");
    el.id = id;
    dom.document.body.append(el);
  }
  vi.resetModules();
  const { send } = await import("../../wallet/bus.js");
  const ov = { ...overview };
  send.mockImplementation(async (message) => {
    if (message.type === "DUSK_UI_OVERVIEW") return { ...ov };
    if (message.type === "DUSK_UI_CONTACTS") {
      return ov.isUnlocked ? { ok: true, result: [{ id: "1", name: LABEL, address: ACCOUNT }] } : { error: { message: "Wallet locked" } };
    }
    return {};
  });
  const { render } = await import("./app.js");
  const { state } = await import("./state.js");
  return { dom, send, render, state, ov };
}

describe("contacts in the popup", () => {
  it("open only while the wallet is unlocked, and go from the page once it locks", async () => {
    const { dom, send, render, state, ov } = await boot({
      hasVault: true,
      isUnlocked: false,
      networkName: "Testnet",
      nodeUrl: "https://testnet.nodes.dusk.network",
      accounts: [],
    });
    const app = () => dom.document.getElementById("app");
    const asked = () => send.mock.calls.filter(([message]) => message.type === "DUSK_UI_CONTACTS").length;

    // Settings' Contacts while locked: the unlock form, and no contact asked for.
    state.route = "contacts";
    await render({ forceRefresh: true });
    await settle();
    expect(dom.document.getElementById("unlock-password")).toBeTruthy();
    expect(asked()).toBe(0);

    Object.assign(ov, { isUnlocked: true, accounts: [ACCOUNT], selectedAccountIndex: 0, balance: { value: "0" } });
    await render({ forceRefresh: true });
    await settle();
    expect(state.route).toBe("contacts");
    expect(visibleText(app())).toContain(LABEL);
    expect(asked()).toBe(1);

    // Locked again: the unlock form, and nothing of the contacts kept in the page.
    Object.assign(ov, { isUnlocked: false, accounts: [] });
    await render({ forceRefresh: true });
    await settle();
    expect(dom.document.getElementById("unlock-password")).toBeTruthy();
    expect(visibleText(app())).not.toContain("landlord");
    expect(state.addressBook).toMatchObject({ loaded: false, items: null });
  });
});
