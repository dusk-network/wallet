import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setAccountName } from "../shared/accountNames.js";
import { clearAddressBook, listAddressBook } from "../shared/addressBook.js";
import { dateText } from "./lib/time.js";
import { accessibleName, fakeEvent, installFakeDom, isShown, screenReaderText, settle, typeInto, visibleText } from "./testing/fakeDom.js";

vi.mock("../shared/accountNames.js", () => ({ setAccountName: vi.fn(async () => {}) }));
vi.mock("../shared/addressBook.js", () => ({ clearAddressBook: vi.fn(async () => {}), listAddressBook: vi.fn(async () => []) }));
// The first profile has a verified .dusk name, as the header shows it.
vi.mock("../shared/duskNames.js", async (importOriginal) => ({
  ...(await importOriginal()),
  lookupPrimaryName: vi.fn(async (account) => (account.startsWith("26FCH7") ? "alice.dusk" : null)),
}));

const ACCOUNTS = [
  "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927",
  "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz",
];

let dom;

beforeEach(() => {
  dom = installFakeDom();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Settings as the extension draws it, where dApps connect; `{ app: true }`
// as the desktop app does, with no extension around it.
async function settings(over = {}, { app = false } = {}) {
  vi.stubGlobal(
    "browser",
    app
      ? undefined
      : {
          runtime: { id: "dusk-wallet", sendMessage: () => {}, getManifest: () => ({ version: "0.3.0" }) },
          tabs: { create: vi.fn(async () => ({})) },
        }
  );
  vi.resetModules();
  const { optionsView } = await import("./popup/views/options.js");
  const ov = {
    isUnlocked: true,
    accounts: ACCOUNTS,
    accountCount: 2,
    selectedAccountIndex: 0,
    nodeUrl: "https://testnet.nodes.dusk.network",
    permissions: [],
    ...over,
  };
  const state = { route: "options", overview: ov };
  const actions = { send: vi.fn(async () => ({})), render: vi.fn(async () => {}), showToast: vi.fn(), renderHeader: vi.fn() };
  const draw = () => dom.document.body.replaceChildren(...optionsView(ov, { state, actions }));
  draw();
  await settle();
  const section = (title) =>
    dom.document.body
      .querySelectorAll(".settings-section")
      .find((s) => {
        const head = s.querySelector(".bracket-title__text");
        return head && screenReaderText(head) === title;
      });
  const shownButtons = (el) => el.querySelectorAll("button").filter(isShown).map((b) => b.textContent);
  return { ov, state, actions, draw, section, shownButtons };
}

describe("profile names", () => {
  const label = (n) => dom.document.body.querySelectorAll("input").find((i) => accessibleName(i) === `Profile ${n} name`);

  it("keep a label being typed through a redraw, and save it when the field is left", async () => {
    setAccountName.mockClear();
    const view = await settings();
    typeInto(label(2), "Spending");
    // A redraw meanwhile, as a sync's status or another label's save brings.
    view.draw();
    expect(label(2).value).toBe("Spending");

    label(2).dispatchEvent(fakeEvent("blur"));
    await settle();
    expect(setAccountName).toHaveBeenCalledTimes(1);
    expect(setAccountName).toHaveBeenCalledWith(ACCOUNTS[0], 1, "Spending");
    // Saved, it shows in the header's pill at once; Settings doesn't redraw for it.
    expect(view.ov.accountNames).toEqual({ 1: "Spending" });
    expect(view.actions.renderHeader).toHaveBeenCalledTimes(1);
    expect(view.actions.render).not.toHaveBeenCalled();
    expect(view.actions.showToast).toHaveBeenCalledWith("Name saved.");
    view.draw();
    expect(label(2).value).toBe("Spending");
  });

  it("keep a label typed for one wallet to that wallet: another opened meanwhile saves nothing of it", async () => {
    setAccountName.mockClear();
    const view = await settings();
    typeInto(label(1), "Typed for A");
    // Another window opens wallet B; Settings is drawn again for it.
    Object.assign(view.ov, { accounts: ["B-account-0", "B-account-1"], accountNames: { 0: "Bob" } });
    view.draw();
    expect(label(1).value).toBe("Bob");
    label(1).dispatchEvent(fakeEvent("blur"));
    await settle();
    expect(setAccountName).not.toHaveBeenCalled();
  });

  it("refuse a name with hidden characters, saying so under its field, and save nothing", async () => {
    // Marek's override, which made a contact read as "Profile 2": a profile's own name can't hold one either.
    setAccountName.mockClear();
    const view = await settings();
    const shownError = () => {
      const id = label(2).getAttribute("aria-describedby");
      return id ? dom.document.getElementById(id).textContent : "";
    };
    typeInto(label(2), "\u202eecilA");
    label(2).dispatchEvent(fakeEvent("blur"));
    await settle();
    expect(setAccountName).not.toHaveBeenCalled();
    expect(shownError()).toBe("This name has hidden characters. Type it again without them.");
    expect(view.actions.showToast).not.toHaveBeenCalledWith("Name saved.");

    typeInto(label(2), "Alice");
    expect(shownError()).toBe("");
    label(2).dispatchEvent(fakeEvent("blur"));
    await settle();
    expect(setAccountName).toHaveBeenCalledWith(ACCOUNTS[0], 1, "Alice");
  });

  // Lena's: Profile 2 named after a contact read as that contact in History.
  it("refuse a name that is, or looks like, another profile's or a contact's, saying whose, and let a profile keep its own", async () => {
    const MARTA = "2Ana1pUpv2ZbMVkwF5FXapYeBEjdxDatLn7nvJkhgTSXbs59SyZSx866bXirPgj8QQVB57uxHJBG1YFvkRbFj4T";
    listAddressBook.mockResolvedValue([
      { id: "c1", name: "Marta", address: MARTA },
      // A contact saved with the second profile's own account.
      { id: "c2", name: "Spending", address: ACCOUNTS[1] },
    ]);
    setAccountName.mockClear();
    await settings();
    const shownError = (n) => {
      const id = label(n).getAttribute("aria-describedby");
      return id ? dom.document.getElementById(id).textContent : "";
    };
    for (const [n, typed, said] of [
      // The first profile goes by its verified .dusk name, the second by its default one.
      [2, "alice.dusk", "Your other profile is called alice.dusk. Choose another name."],
      [1, "Profile 2", "Your other profile is called Profile 2. Choose another name."],
      // Sofía's: the first profile by its own name too, and its .dusk name in look-alike letters (a Cyrillic а).
      [2, "Profile 1", "Your other profile is called Profile 1. Choose another name."],
      [2, "\u0430lice.dusk", "That looks like the name of your other profile alice.dusk. Choose another name."],
      [2, "Marta", "You have a contact called Marta. Choose another name."],
      // A Cyrillic М.
      [2, "\u041carta", "That looks like your contact Marta. Choose another name."],
    ]) {
      typeInto(label(n), typed);
      label(n).dispatchEvent(fakeEvent("blur"));
      await settle();
      expect(shownError(n)).toBe(said);
    }
    expect(setAccountName).not.toHaveBeenCalled();

    // Its own name, and the name of a contact saved with its own account, are the profile's to take.
    typeInto(label(2), "Spending");
    label(2).dispatchEvent(fakeEvent("blur"));
    await settle();
    expect([shownError(2), setAccountName.mock.calls.at(-1)]).toEqual(["", [ACCOUNTS[0], 1, "Spending"]]);
    listAddressBook.mockResolvedValue([]);
  });

  // Amélie's: her profile named Lucas beside her grandson's contact "Lucas (petit-fils)".
  it("ask about a name a contact's starts, or that starts it, word for word, and save it", async () => {
    listAddressBook.mockResolvedValue([{ id: "c1", name: "Lucas (petit-fils)", address: "2Ana1pUpv2ZbMVkwF5FXapYeBEjdxDatLn7nvJkhgTSXbs59SyZSx866bXirPgj8QQVB57uxHJBG1YFvkRbFj4T" }]);
    setAccountName.mockClear();
    await settings();
    const question = () => label(1).parentNode.querySelectorAll(".contact-note").filter(isShown).map((el) => el.textContent);
    typeInto(label(1), "Lucas");
    label(1).dispatchEvent(fakeEvent("blur"));
    await settle();
    expect([question(), setAccountName.mock.calls.at(-1)]).toEqual([["You have a contact called Lucas (petit-fils). Is this someone else?"], [ACCOUNTS[0], 0, "Lucas"]]);
    // Typed again, the question goes with what it asked of.
    typeInto(label(1), "Luc");
    expect(question()).toEqual([]);
    label(1).dispatchEvent(fakeEvent("blur"));
    await settle();
    expect(question()).toEqual([]);
    listAddressBook.mockResolvedValue([]);
  });

  it("save once when the field is left with both a change and a blur, and not when nothing changed", async () => {
    setAccountName.mockClear();
    await settings({ accountNames: { 0: "Main" } });
    typeInto(label(1), "Main ");
    label(1).dispatchEvent(fakeEvent("change"));
    label(1).dispatchEvent(fakeEvent("blur"));
    await settle();
    expect(setAccountName).not.toHaveBeenCalled();

    typeInto(label(1), "Savings");
    label(1).dispatchEvent(fakeEvent("change"));
    label(1).dispatchEvent(fakeEvent("blur"));
    await settle();
    expect(setAccountName.mock.calls).toEqual([[ACCOUNTS[0], 0, "Savings"]]);
  });
});

describe("settings", () => {
  it("lets the section title name the network, with its node addresses behind a disclosure", async () => {
    let view = await settings();
    const network = view.section("Network");
    expect(network.querySelectorAll("label").map((l) => l.textContent)).toEqual(["Node URL", "Prover URL", "Archiver URL"]);
    expect(network.querySelector("select#network").getAttribute("aria-label")).toBe("Network");
    expect([visibleText(network.querySelector("details summary")), network.querySelector("details").open]).toEqual([
      "Node addresses",
      false,
    ]);
    // The list says what the network menu says of each, before one is chosen.
    expect(network.querySelectorAll("select#network option").map((o) => o.textContent)).toEqual([
      "Mainnet",
      "Testnet",
      "Devnet · Experimental",
      "Local · 127.0.0.1:8080",
      "Custom · Any node URL",
    ]);
    expect(network.querySelectorAll(".muted").filter(isShown)).toEqual([]);
  });

  it("names each profile by its verified name, as the header does, with names for this device", async () => {
    const view = await settings();
    const profile = view.section("Profile");
    expect(profile.querySelectorAll("#account option").map((o) => o.textContent)).toEqual([
      "alice.dusk · 26FCH7…Tck927",
      "Profile 2 · 21n5nc…fMMLNz",
    ]);
    expect(visibleText(profile.querySelector(".settings-subtitle"))).toBe("Names on this device");
    expect(profile.querySelectorAll(".settings-profile-line").map(visibleText)).toEqual([
      "alice.dusk · 26FCH7…Tck927",
      "Profile 2 · 21n5nc…fMMLNz",
    ]);
    const inputs = profile.querySelectorAll("input");
    expect(inputs.map((i) => [i.getAttribute("aria-label"), i.getAttribute("placeholder")])).toEqual([
      ["Profile 1 name", "Name, only on this device"],
      ["Profile 2 name", "Name, only on this device"],
    ]);
  });

  describe("a site's record", () => {
    const DAY = 86_400_000;
    const AT = Date.UTC(2031, 0, 15, 12);
    const SITE = "https://app.example";
    const permissions = [{ origin: SITE, walletId: ACCOUNTS[0], accountIndex: 0, lastsMs: 7 * DAY, expiresAt: AT + 7 * DAY }];
    const asked = [
      { at: AT + 3, what: "contract_call", method: "swap\u202Eyenom", answer: "rejected" },
      { at: AT + 2, what: "transfer", answer: "approved" },
      { at: AT + 1, what: "sign_message", answer: "closed" },
      { at: AT, what: "connect", answer: "approved" },
      { at: AT - 1, what: "switch_network", answer: "expired" },
      { at: AT - 2, what: "watch_nft", answer: "cancelled" },
      { at: AT - 3, what: "transfer", answer: "failed" },
      { at: AT - 4, what: "transfer", answer: "unconfirmed" },
      { at: AT - 5, what: "contract_call", method: "depositETHToWithValue", asked: "Bridge to DuskEVM", answer: "approved" },
    ];
    const siteRecords = { [ACCOUNTS[0]]: { [SITE]: { lastUsedAt: AT + 60_000, asked } } };
    const details = (el) => el.querySelector("details.settings-site__details");
    const rowOf = (view, host) =>
      view
        .section("Connected sites")
        .querySelectorAll(".settings-site")
        .find((row) => visibleText(row.querySelector(".settings-site__host")) === host);

    it("says when it was last used, until when it's connected, and under Details how long and what it asked", async () => {
      const view = await settings({ permissions, siteRecords });
      const row = rowOf(view, "app.example");
      const notes = [...row.children].filter((el) => el.classList.contains("settings-site__note")).map(visibleText);
      expect(notes).toEqual([`Last used ${dateText(AT + 60_000)}`, `Connected until ${dateText(AT + 7 * DAY)}`]);
      expect(details(row).open).toBeFalsy();
      expect(row.querySelector('select[aria-label="How long app.example stays connected"]').value).toBe(String(7 * DAY));
      const list = row.querySelectorAll(".settings-site__ask").map((li) => [...li.children].map(visibleText));
      expect(list).toEqual([
        ["Contract call: swap\\u202eyenom", "Rejected", dateText(AT + 3)],
        ["Pay", "Approved", dateText(AT + 2)],
        ["Sign a message", "Window closed", dateText(AT + 1)],
        ["Connect", "Approved", dateText(AT)],
        ["Switch network", "Not answered in time", dateText(AT - 1)],
        ["Import an NFT", "Ended before an answer", dateText(AT - 2)],
        ["Pay", "Approved, not sent", dateText(AT - 3)],
        ["Pay", "Approved, not confirmed", dateText(AT - 4)],
        ["Bridge to DuskEVM", "Approved", dateText(AT - 5)],
      ]);
      // Nothing a site chose reads as something else.
      expect(row.textContent).not.toContain("\u202E");
    });

    it("draws one with nothing kept yet without any of that, its Details still setting how long", async () => {
      const view = await settings({ permissions: [{ origin: SITE, walletId: ACCOUNTS[0], accountIndex: 0 }] });
      const row = rowOf(view, "app.example");
      expect([...row.children].filter((el) => el.classList.contains("settings-site__note"))).toEqual([]);
      expect(row.querySelector('select[aria-label="How long app.example stays connected"]').value).toBe("0");
      expect(row.querySelector(".settings-site__list")).toBeNull();
    });

    it("sets how long from its Details, and says so, and new sites' on their own", async () => {
      const view = await settings({ permissions, siteRecords });
      const choose = (label, value) => {
        const select = view.section("Connected sites").querySelector(`select[aria-label="${label}"]`);
        select.value = String(value);
        select.dispatchEvent(fakeEvent("change"));
      };
      choose("How long app.example stays connected", DAY);
      await settle();
      expect(view.actions.send).toHaveBeenLastCalledWith({ type: "DUSK_UI_SET_SITE_LASTS", origin: SITE, siteWallet: ACCOUNTS[0], lastsMs: DAY });
      expect(view.actions.showToast).toHaveBeenLastCalledWith("app.example stays connected for 1 day.");
      expect(view.actions.render).toHaveBeenLastCalledWith({ forceRefresh: true });
      choose("How long app.example stays connected", 0);
      await settle();
      expect(view.actions.showToast).toHaveBeenLastCalledWith("app.example stays connected until you disconnect it.");

      choose("How long new sites stay connected", 30 * DAY);
      await settle();
      expect(view.actions.send).toHaveBeenLastCalledWith({ type: "DUSK_UI_SET_NEW_SITE_LASTS", lastsMs: 30 * DAY });
      expect(view.actions.showToast).toHaveBeenLastCalledWith("New sites stay connected for 30 days.");

      view.actions.send.mockResolvedValueOnce({ error: { message: "That site isn't connected any more." } });
      choose("How long app.example stays connected", DAY);
      await settle();
      expect(view.actions.showToast).toHaveBeenLastCalledWith("That site isn't connected any more.", 2500);

      const set = await settings({ newSiteLastsMs: 7 * DAY });
      expect(set.section("Connected sites").querySelector('select[aria-label="How long new sites stay connected"]').value).toBe(String(7 * DAY));
    });

    it("keeps its Details open through a redraw", async () => {
      const view = await settings({ permissions, siteRecords });
      const row = () => rowOf(view, "app.example");
      details(row()).open = true;
      details(row()).dispatchEvent(fakeEvent("toggle"));
      view.draw();
      expect(details(row()).open).toBe(true);
    });

    it("lists sites no longer connected under Earlier sites, last heard of first, each to forget", async () => {
      const records = {
        [ACCOUNTS[0]]: {
          [SITE]: { lastUsedAt: AT, asked },
          "https://old.example": { lastUsedAt: AT - DAY },
          "https://refused.example": { asked: [{ at: AT, what: "connect", answer: "rejected" }] },
          // Only what it was set to: nothing to list.
          "https://set.example": { lastsMs: DAY },
        },
      };
      const view = await settings({ permissions, siteRecords: records });
      const earlier = view.section("Connected sites").querySelector(".settings-sites-earlier");
      expect(visibleText(earlier.querySelector("summary"))).toBe("Earlier sites (2)");
      expect(earlier.querySelectorAll(".settings-site__host").map(visibleText)).toEqual(["refused.example", "old.example"]);
      earlier.querySelectorAll("button").find((b) => accessibleName(b) === "Forget old.example").click();
      await settle();
      expect(view.actions.send).toHaveBeenLastCalledWith({ type: "DUSK_UI_FORGET_SITE_RECORD", origin: "https://old.example", siteWallet: ACCOUNTS[0] });
      expect(view.actions.showToast).toHaveBeenLastCalledWith("Forgot old.example.");
      expect(view.actions.render).toHaveBeenLastCalledWith({ forceRefresh: true });
      // A site's connection isn't touched by it, and none listed means no list.
      expect(view.actions.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "DUSK_UI_DISCONNECT_ORIGIN" }));
      const none = await settings({ permissions, siteRecords });
      expect(none.section("Connected sites").querySelector(".settings-sites-earlier")).toBeNull();
    });
  });

  it("disconnects one site, or all of them after asking, away from Reset wallet", async () => {
    let view = await settings();
    expect(visibleText(view.section("Connected sites"))).toContain("[Connected sites]No sites are connected.");

    const permissions = [
      { origin: "https://app.example", accountIndex: 1 },
      { origin: "https://shop.example", accountIndex: 0 },
    ];
    view = await settings({ permissions });
    const sites = view.section("Connected sites");
    expect(sites.querySelectorAll(".settings-site__host").map(visibleText)).toEqual(["app.example", "shop.example"]);
    expect(sites.querySelector('select[aria-label="Profile for app.example"]').value).toBe("1");
    const disconnect = sites.querySelectorAll("button").find((b) => accessibleName(b) === "Disconnect app.example");
    disconnect.click();
    await settle();
    expect(view.actions.send).toHaveBeenCalledWith({ type: "DUSK_UI_DISCONNECT_ORIGIN", origin: "https://app.example" });

    // All of them only after a yes.
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    sites.querySelectorAll("button").find((b) => b.textContent === "Disconnect all sites").click();
    expect(confirm).toHaveBeenCalledWith("Disconnect all 2 sites? They'll ask to connect again.");
    expect(view.actions.send).not.toHaveBeenCalledWith({ type: "DUSK_UI_CLEAR_PERMISSIONS" });
    // Reset wallet is in a section of its own.
    expect(view.shownButtons(sites)).not.toContain("Reset wallet");
    // A local http:// site by its whole origin, as its approval named it.
    const local = (await settings({ permissions: [{ origin: "http://127.0.0.1:5354", accountIndex: 0 }] })).section("Connected sites");
    expect(local.querySelectorAll(".settings-site__host").map(visibleText)).toEqual(["http://127.0.0.1:5354"]);
    expect(view.shownButtons(view.section("Reset"))).toEqual(["Reset wallet"]);
    // One line on what it removes, and that the funds stay on Dusk.
    expect(visibleText(view.section("Reset").querySelector(".settings-note"))).toBe(
      "Removes every wallet, with its contacts, names, activity and connected sites, from this browser, and goes back to Mainnet. Your funds stay on Dusk. You need each recovery phrase to use them again."
    );
  });

  // Chen's and Lena's: two taps, and every wallet was gone, with no password or fingerprint.
  it("asks for the password before a reset, as for removing a wallet, on a screen of its own: Back resets nothing", async () => {
    const view = await settings();
    const browserConfirm = vi.fn(() => true);
    vi.stubGlobal("confirm", browserConfirm);
    const resets = () => view.actions.send.mock.calls.filter(([m]) => m.type === "DUSK_UI_RESET_WALLET");
    dom.document.body.querySelectorAll("button").find((b) => b.textContent === "Reset wallet").click();
    await settle();
    expect([view.state.route, browserConfirm.mock.calls, resets()]).toEqual(["wallet_reset", [], []]);

    const { resetWalletView } = await import("./popup/views/wallets.js");
    const draw = () => dom.document.body.replaceChildren(...resetWalletView(view.ov, { state: view.state, actions: view.actions }));
    draw();
    await settle();
    const body = dom.document.body;
    const press = (name) => body.querySelectorAll("button").find((b) => b.textContent === name).click();
    expect(visibleText(body.querySelector(".auth-lead"))).toBe(
      "This removes every wallet here, with its contacts, names, activity and connected sites. Your funds stay on Dusk. You need each recovery phrase to use them again."
    );
    // Nothing typed: said, and nothing asked of the wallet.
    press("Reset wallet");
    await settle();
    expect(visibleText(body)).toContain("Enter your password.");
    expect(resets()).toEqual([]);
    // A wrong one: the wallet says so, under the field.
    view.actions.send.mockImplementation(async (m) => (m.type === "DUSK_UI_RESET_WALLET" && m.password !== "the password" ? { error: { message: "Incorrect password" } } : {}));
    typeInto(body.querySelectorAll("input").find((i) => accessibleName(i) === "Password you unlock with"), "not it");
    press("Reset wallet");
    await settle();
    expect(visibleText(body)).toContain("Incorrect password");
    expect(view.state.route).toBe("wallet_reset");
    typeInto(body.querySelectorAll("input").find((i) => accessibleName(i) === "Password you unlock with"), "the password");
    press("Reset wallet");
    await settle();
    expect(resets().at(-1)[0]).toEqual({ type: "DUSK_UI_RESET_WALLET", password: "the password" });
    expect(view.state.route).toBe("home");
    expect(view.actions.showToast).toHaveBeenCalledWith("Wallet reset. Import again to continue.", 2500);

    // Back from it: Settings, nothing reset.
    view.state.route = "wallet_reset";
    const before = resets().length;
    draw();
    press("← Back");
    expect([view.state.route, resets().length]).toEqual(["options", before]);
  });

  it("takes a fingerprint for a reset in the app where fingerprint unlock is on", async () => {
    const asked = [];
    dom.window.__TAURI_INTERNALS__ = {
      invoke: vi.fn(async (cmd, args) => {
        if (cmd !== "fingerprint") return null;
        asked.push(args.action);
        if (args.action === "status") return { ok: true, available: true, on: true };
        if (args.action === "unlock") return { ok: true, secret: "the password" };
        return { ok: true };
      }),
    };
    vi.stubGlobal("navigator", { ...globalThis.navigator, userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 6; wv) Chrome/156.0 Mobile Safari/537.36" });
    const view = await settings({}, { app: true });
    const { resetWalletView } = await import("./popup/views/wallets.js");
    view.state.route = "wallet_reset";
    dom.document.body.replaceChildren(...resetWalletView(view.ov, { state: view.state, actions: view.actions }));
    const finger = () => dom.document.body.querySelectorAll("button").find((b) => b.textContent === "Use fingerprint");
    await vi.waitFor(() => expect(isShown(finger())).toBe(true));
    expect(view.actions.send).not.toHaveBeenCalled();
    finger().click();
    await vi.waitFor(() => expect(view.actions.send).toHaveBeenCalledWith({ type: "DUSK_UI_RESET_WALLET", password: "the password" }));
    expect(asked.filter((action) => action !== "status")).toEqual(["unlock", "disable"]);
  });

  it("starts each switch of profile, network or wallet before asking the wallet, so a check begun before it can tell", async () => {
    const view = await settings();
    // The popup's context each time the wallet is asked.
    const before = view.state.context;
    const asked = [];
    view.actions.send.mockImplementation(async (message) => {
      asked.push([message.type, view.state.context]);
      return { ok: true };
    });
    vi.stubGlobal("confirm", vi.fn(() => true));
    const buttonOf = (text) => dom.document.body.querySelectorAll("button").find((b) => b.textContent === text);

    const profile = dom.document.body.querySelector("select#account");
    profile.value = "1";
    profile.dispatchEvent(fakeEvent("change"));
    await settle();
    typeInto(dom.document.body.querySelectorAll("input").find((i) => accessibleName(i) === "Node URL"), "https://nodes.dusk.network");
    buttonOf("Save").click();
    await settle();
    buttonOf("Lock wallet").click();
    await settle();
    const { resetWalletView } = await import("./popup/views/wallets.js");
    dom.document.body.replaceChildren(...resetWalletView(view.ov, { state: view.state, actions: view.actions }));
    typeInto(dom.document.body.querySelectorAll("input").find((i) => accessibleName(i) === "Password you unlock with"), "the password");
    buttonOf("Reset wallet").click();
    await settle();
    expect(asked.map(([type, context]) => [type, context?.reason])).toEqual([
      ["DUSK_UI_SET_ACCOUNT_INDEX", "switch"],
      ["DUSK_UI_SET_NODE_URL", "switch"],
      ["DUSK_UI_LOCK", "lock"],
      ["DUSK_UI_RESET_WALLET", "switch"],
    ]);
    // Each asked in a context of its own, replaced as its switch started.
    expect(new Set([before, ...asked.map(([, context]) => context)]).size).toBe(5);
  });

  it("offers auto-lock after 5 or 15 minutes, or Off, and keeps a new choice through a redraw", async () => {
    const view = await settings({ autoLockTimeoutMinutes: 15 });
    const select = () => dom.document.body.querySelector("select#auto-lock");
    expect(select().querySelectorAll("option").map((o) => o.textContent)).toEqual(["5 minutes", "15 minutes", "Off"]);
    expect(select().value).toBe("15");
    select().value = "5";
    select().dispatchEvent({ type: "change", bubbles: true, target: select(), preventDefault() {}, stopPropagation() {} });
    await settle();
    expect(view.actions.send).toHaveBeenCalledWith({ type: "DUSK_UI_SET_AUTO_LOCK", autoLockTimeoutMinutes: 5 });
    // A redraw before the overview is read again still shows 5.
    view.draw();
    expect(select().value).toBe("5");
  });

  it("keeps custom gas under Advanced, off until it's turned on, as the web wallet does", async () => {
    const view = await settings();
    const advanced = dom.document.body.querySelector("details.settings-advanced");
    expect(visibleText(advanced.querySelector("summary"))).toBe("Advanced");
    const toggle = advanced.querySelector("#custom-gas");
    expect(toggle.checked).toBe(false);
    expect(visibleText(advanced.querySelector(".settings-note"))).toBe(
      "The wallet uses the network's gas price, and a gas limit that suits each transaction."
    );
    toggle.checked = true;
    toggle.dispatchEvent({ type: "change", bubbles: true, target: toggle, preventDefault() {}, stopPropagation() {} });
    await settle();
    expect(view.actions.send).toHaveBeenCalledWith({ type: "DUSK_UI_SET_CUSTOM_GAS", customGas: { limit: "2500000", price: "1" } });
    expect(visibleText(advanced.querySelector(".settings-note"))).toBe(
      "Each transaction costs at most 0.0025 DUSK. One that needs more gas than this limit keeps its own."
    );
  });

  it("keeps custom gas being typed through a redraw, until it's saved", async () => {
    const view = await settings({ customGas: { limit: "3000000", price: "2" } });
    const field = (name) => dom.document.body.querySelectorAll("input").find((i) => accessibleName(i) === name);
    typeInto(field("Gas limit"), "4500000");
    typeInto(field("Gas price (LUX)"), "3");
    // A sync or status push draws Settings again before the field is left.
    view.draw();
    expect([field("Gas limit").value, field("Gas price (LUX)").value]).toEqual(["4500000", "3"]);
    expect(view.actions.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "DUSK_UI_SET_CUSTOM_GAS" }));

    // Left, it's saved, and the saved gas shows from then on.
    field("Gas price (LUX)").dispatchEvent(fakeEvent("change"));
    await settle();
    expect(view.actions.send).toHaveBeenCalledWith({ type: "DUSK_UI_SET_CUSTOM_GAS", customGas: { limit: "4500000", price: "3" } });
    expect(view.state.settings.customGasDraft).toBeNull();
    view.draw();
    expect([field("Gas limit").value, field("Gas price (LUX)").value]).toEqual(["4500000", "3"]);
  });

  it("keeps Delete all contacts under Advanced, asking first", async () => {
    const view = await settings();
    view.state.addressBook = { loaded: true, items: [{ id: "1", name: "Jan (flour)" }] };
    const advanced = dom.document.body.querySelector("details.settings-advanced");
    const remove = advanced.querySelectorAll("button").find((b) => b.textContent === "Delete all contacts");
    expect(remove).toBeTruthy();
    // Not near the Contacts row.
    const contacts = view.section("Contacts");
    expect(contacts.querySelectorAll("button").map(visibleText)).toEqual(["Contacts"]);

    vi.stubGlobal("confirm", vi.fn(() => false));
    remove.click();
    await settle();
    expect(clearAddressBook).not.toHaveBeenCalled();

    vi.stubGlobal("confirm", vi.fn(() => true));
    remove.click();
    await settle();
    expect(confirm).toHaveBeenCalledWith("Delete all saved contacts from this wallet? This can't be undone.");
    expect(clearAddressBook).toHaveBeenCalledTimes(1);
    expect(view.state.addressBook).toMatchObject({ loaded: false, items: null });
    expect(view.actions.showToast).toHaveBeenCalledWith("Deleted all contacts");
  });
});

describe("the network", () => {
  const choose = async (id) => {
    const select = dom.document.body.querySelector("select#network");
    select.value = id;
    select.dispatchEvent(fakeEvent("change"));
    await settle();
    return select;
  };
  const field = (name) => dom.document.body.querySelectorAll("input").find((i) => accessibleName(i) === name);
  const saveButton = () => dom.document.body.querySelectorAll("button").find((b) => b.textContent === "Save");
  const shownText = (el) => el.querySelectorAll("[role=status], [role=alert]").filter(isShown).map((n) => n.textContent);

  it("switches as soon as it's chosen, as the menu at the top does, and says so", async () => {
    const view = await settings({ nodeUrl: "https://nodes.dusk.network" });
    view.actions.send.mockImplementation(async () => ({ ok: true }));
    await choose("testnet");
    expect(view.actions.send).toHaveBeenCalledWith({
      type: "DUSK_UI_SET_NODE_URL",
      nodeUrl: "https://testnet.nodes.dusk.network",
      proverUrl: "https://testnet.provers.dusk.network",
      archiverUrl: "https://testnet.nodes.dusk.network",
    });
    expect(view.actions.showToast).toHaveBeenCalledWith("Switched to Testnet.");
    expect(view.actions.render).toHaveBeenCalledWith({ forceRefresh: true });
    expect(view.state.context?.reason).toBe("switch");
  });

  it("names the network it's still on when the switch fails, and says why under the choice", async () => {
    const view = await settings({ nodeUrl: "https://nodes.dusk.network" });
    view.actions.send.mockImplementation(async () => ({ error: { message: "Couldn't reach the node" } }));
    const select = await choose("testnet");
    expect(select.value).toBe("mainnet");
    expect(shownText(view.section("Network"))).toEqual(["Couldn't reach the node"]);
    expect(view.actions.showToast).not.toHaveBeenCalled();
  });

  it("asks nothing when it's chosen again as it is", async () => {
    const view = await settings({ nodeUrl: "https://nodes.dusk.network", proverUrl: "https://provers.dusk.network", archiverUrl: "https://nodes.dusk.network" });
    await choose("mainnet");
    expect(view.actions.send).not.toHaveBeenCalled();
    expect(shownText(view.section("Network"))).toEqual([]);
  });

  it("opens the node addresses for Custom, says it isn't saved until Save, and keeps that through a redraw", async () => {
    const view = await settings({ nodeUrl: "https://nodes.dusk.network", proverUrl: "https://provers.dusk.network", archiverUrl: "https://nodes.dusk.network" });
    await choose("custom");
    const network = () => view.section("Network");
    expect(view.actions.send).not.toHaveBeenCalled();
    expect(network().querySelector("details").open).toBe(true);
    expect(isShown(saveButton())).toBe(true);
    expect(shownText(network())).toEqual(["Not saved. The wallet stays on Mainnet until you press Save."]);
    expect(field("Node URL").value).toBe("");

    typeInto(field("Node URL"), "https://my-node.example");
    view.draw();
    expect(network().querySelector("select#network").value).toBe("custom");
    expect(field("Node URL").value).toBe("https://my-node.example");
    expect(shownText(network())).toEqual(["Not saved. The wallet stays on Mainnet until you press Save."]);

    view.actions.send.mockImplementation(async () => ({ ok: true }));
    saveButton().click();
    await settle();
    expect(view.actions.send).toHaveBeenCalledWith(expect.objectContaining({ type: "DUSK_UI_SET_NODE_URL", nodeUrl: "https://my-node.example" }));
    expect(view.state.settings.nodeDraft).toBeNull();
  });

  it("is Custom while its prover or archiver is someone else's, and the network chosen again puts its own back", async () => {
    const view = await settings({ nodeUrl: "https://testnet.nodes.dusk.network", proverUrl: "https://testnet.provers.dusk.network", archiverUrl: "https://hostile-node.example" });
    expect(dom.document.body.querySelector("select#network").value).toBe("custom");
    view.actions.send.mockImplementation(async () => ({ ok: true }));
    await choose("testnet");
    expect(view.actions.send).toHaveBeenCalledWith({
      type: "DUSK_UI_SET_NODE_URL",
      nodeUrl: "https://testnet.nodes.dusk.network",
      proverUrl: "https://testnet.provers.dusk.network",
      archiverUrl: "https://testnet.nodes.dusk.network",
    });
  });

  it("refuses plain http to another computer, as a site's switch does, and takes it on this one", async () => {
    const testnet = { nodeUrl: "https://testnet.nodes.dusk.network", proverUrl: "https://testnet.provers.dusk.network", archiverUrl: "https://testnet.nodes.dusk.network" };
    const saved = (view) => view.actions.send.mock.calls.filter(([m]) => m.type === "DUSK_UI_SET_NODE_URL");
    for (const [name, typed, problem] of [
      ["Prover URL", "http://hostile-node.example", "The prover URL must start with https://, unless it's on this computer."],
      ["Archiver URL", "http://192.168.1.20:8080", "The archiver URL must start with https://, unless it's on this computer."],
      ["Node URL", "https://user:pass@node.example", "Invalid node URL format"],
    ]) {
      const view = await settings(testnet);
      typeInto(field(name), typed);
      saveButton().click();
      await settle();
      expect(shownText(view.section("Network"))).toContain(problem);
      expect(saved(view)).toEqual([]);
    }

    const view = await settings(testnet);
    view.actions.send.mockImplementation(async () => ({ ok: true }));
    const sends = () => saved(view);
    typeInto(field("Prover URL"), "http://127.0.0.1:8080");
    saveButton().click();
    await settle();
    expect(sends()).toEqual([[expect.objectContaining({ nodeUrl: "https://testnet.nodes.dusk.network", proverUrl: "http://127.0.0.1:8080" })]]);
  });

  it("drops what wasn't saved on leaving Settings, so coming back says what the wallet is on", async () => {
    const view = await settings({ nodeUrl: "https://nodes.dusk.network" });
    await choose("custom");
    dom.document.body.querySelectorAll("button").find((b) => b.textContent === "← Back").click();
    view.draw();
    expect(dom.document.body.querySelector("select#network").value).toBe("mainnet");
    expect(shownText(view.section("Network"))).toEqual([]);
  });

  it("asks before using a saved node on another chain than it was added with, and stays as it was without a yes", async () => {
    const view = await settings({ nodeUrl: "https://my-node.example", proverUrl: "https://my-node.example", archiverUrl: "https://my-node.example" });
    const question = "my-node.example now says it's on Mainnet (chain 1), not Testnet (chain 2). Use it on Mainnet (chain 1) from now on? What you sign there will count there.";
    const refused = { error: { message: "my-node.example now says it's on Mainnet (chain 1), not Testnet (chain 2). To use it anyway, save it in Settings.", data: { chainChanged: { pinned: 2, answered: 1, question } } } };
    view.actions.send.mockImplementation(async (message) => (message.acceptChain ? { ok: true } : refused));
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    saveButton().click();
    await settle();
    expect(confirm).toHaveBeenCalledWith(question);
    expect(view.actions.send).toHaveBeenCalledTimes(1);
    expect(visibleText(view.section("Network"))).toContain("To use it anyway, save it in Settings.");

    confirm.mockReturnValue(true);
    saveButton().click();
    await settle();
    expect(view.actions.send).toHaveBeenLastCalledWith(expect.objectContaining({ acceptChain: 1 }));
    expect(view.actions.showToast).toHaveBeenCalledWith("Settings saved.");
  });
});

describe("about", () => {
  const legal = (section) => section("About").querySelectorAll("button").filter(isShown);

  it("links Dusk's terms of use and privacy policy, as the network's file names them, and nowhere else", async () => {
    const { section, actions } = await settings();
    expect(visibleText(section("About").querySelector(".settings-legal"))).toBe("Terms of use·Privacy policy");
    expect(section("About").querySelector(".settings-legal .sep").getAttribute("aria-hidden")).toBe("true");
    expect(dom.document.body.querySelectorAll("button").filter((b) => /Terms|Privacy/.test(b.textContent))).toHaveLength(2);

    for (const link of legal(section)) link.click();
    await settle();
    expect(globalThis.browser.tabs.create.mock.calls.map(([options]) => options.url)).toEqual([
      "https://dusk.network/terms-of-use",
      "https://dusk.network/privacy-policy",
    ]);
    expect(actions.showToast).not.toHaveBeenCalled();
  });

  it("says Reset for a phone in the app, which has no browser and no connected sites, as Chen and Sofia read it", async () => {
    dom.window.__TAURI_INTERNALS__ = { invoke: vi.fn() };
    vi.stubGlobal("navigator", { ...globalThis.navigator, userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 6; wv) Chrome/156.0 Mobile Safari/537.36" });
    const app = await settings({}, { app: true });
    expect(visibleText(app.section("Reset").querySelector(".settings-note"))).toBe(
      "Removes every wallet, with its contacts, names and activity, from this phone, and goes back to Mainnet. Your funds stay on Dusk. You need each recovery phrase to use them again."
    );
    const { resetWalletView } = await import("./popup/views/wallets.js");
    dom.document.body.replaceChildren(...resetWalletView(app.ov, { state: app.state, actions: app.actions }));
    expect(visibleText(dom.document.body.querySelector(".auth-lead"))).not.toMatch(/browser|connected sites/);
  });

  it("keeps them on a custom node, and in the desktop app, which has no version to show", async () => {
    const custom = await settings({ nodeUrl: "https://my-node.example" });
    expect(legal(custom.section).map((b) => b.textContent)).toEqual(["Terms of use", "Privacy policy"]);

    const app = await settings({}, { app: true });
    expect(visibleText(app.section("About"))).not.toMatch(/Dusk Wallet v/);
    expect(legal(app.section).map((b) => b.textContent)).toEqual(["Terms of use", "Privacy policy"]);
  });
});

describe("wallets", () => {
  const W2 = ["w2acct0LongEnoughToShortenAtTheEnd000000", "w2acct1LongEnoughToShortenAtTheEnd111111"];
  // Each test's own: a rename changes them.
  const fresh = () => [
    { key: "k1", n: 1, name: "", walletId: ACCOUNTS[0], accounts: ACCOUNTS, accountNames: {}, active: true },
    { key: "k2", n: 2, name: "Savings", walletId: W2[0], accounts: W2, accountNames: { 1: "Rainy day" }, active: false },
  ];
  const nameField = (n) => dom.document.body.querySelectorAll("input").find((i) => i.id === `wallet-name-${n}`);
  const button = (section, name) => section.querySelectorAll("button").find((b) => accessibleName(b) === name);
  // Settings drawn again on render, as the popup does.
  const drawn = async (over) => {
    const view = await settings(over);
    view.actions.render.mockImplementation(async () => view.draw());
    return view;
  };

  it("lists each wallet by its name alone, Rename and Remove beside each, and Add wallet", async () => {
    const view = await drawn({ wallets: fresh() });
    const section = view.section("Wallets");
    expect(section.querySelectorAll(".settings-wallet__head .settings-profile-line").map(visibleText)).toEqual(["Wallet 1", "Savings"]);
    expect(view.shownButtons(section)).toEqual(["Rename", "Remove", "Rename", "Remove", expect.stringContaining("Add wallet")]);
    // One weight for both: neither is the louder.
    expect(section.querySelectorAll(".settings-wallet__actions button").map((b) => b.className)).toEqual(Array(4).fill("mini-btn"));
    expect(section.querySelectorAll("input")).toEqual([]);

    button(section, "Remove Savings").click();
    await settle();
    expect([view.state.route, view.state.walletRemove]).toEqual(["wallet_remove", "k2"]);

    view.state.route = "options";
    view.draw();
    view.section("Wallets").querySelectorAll("button").find((b) => b.textContent.includes("Add wallet")).click();
    await settle();
    expect([view.state.route, view.state.onboard.adding]).toEqual(["wallet_add", true]);
  });

  it("renames a wallet in the field Rename opens: Save or Enter keeps the name, Cancel or Escape leaves it", async () => {
    const view = await drawn({ wallets: fresh() });
    button(view.section("Wallets"), "Rename Wallet 1").click();
    await settle();
    // The field with its label, its hint, and the wallet's number for no name.
    const field = nameField(1);
    expect([accessibleName(field), field.value, field.getAttribute("placeholder")]).toEqual(["Wallet 1 name", "", "Wallet 1"]);
    const row = field.closest(".settings-wallet");
    expect(visibleText(row.querySelector("label"))).toBe("Name");
    expect(dom.document.getElementById(field.getAttribute("aria-describedby")).textContent).toBe("Only on this device.");
    expect(view.shownButtons(row)).toEqual(["Save", "Cancel"]);

    // What's typed stays through a redraw; Enter saves it.
    typeInto(field, "Everyday");
    view.draw();
    expect(nameField(1).value).toBe("Everyday");
    nameField(1).dispatchEvent(fakeEvent("keydown", { key: "Enter" }));
    await settle();
    expect(view.actions.send).toHaveBeenCalledWith({ type: "DUSK_UI_RENAME_WALLET", walletKey: "k1", name: "Everyday" });
    expect(view.ov.wallets[0].name).toBe("Everyday");
    expect(view.actions.showToast).toHaveBeenCalledWith("Name saved.");
    expect(view.section("Wallets").querySelectorAll(".settings-profile-line").map(visibleText)).toEqual(["Everyday", "Savings"]);

    // Escape and Cancel leave the name as it was.
    view.actions.send.mockClear();
    const cancel = () => view.section("Wallets").querySelectorAll("button").find((b) => b.textContent === "Cancel").click();
    for (const leave of [(f) => f.dispatchEvent(fakeEvent("keydown", { key: "Escape" })), cancel]) {
      button(view.section("Wallets"), "Rename Savings").click();
      await settle();
      expect(nameField(2).value).toBe("Savings");
      typeInto(nameField(2), "Spent");
      leave(nameField(2));
      await settle();
      expect(nameField(2)).toBeUndefined();
    }
    expect(view.actions.send).not.toHaveBeenCalled();
    expect(view.section("Wallets").querySelectorAll(".settings-profile-line").map(visibleText)).toEqual(["Everyday", "Savings"]);

    // Save, pressed.
    button(view.section("Wallets"), "Rename Savings").click();
    await settle();
    typeInto(nameField(2), "Rainy day fund");
    button(view.section("Wallets"), "Save Savings's name").click();
    await settle();
    expect(view.actions.send).toHaveBeenCalledWith({ type: "DUSK_UI_RENAME_WALLET", walletKey: "k2", name: "Rainy day fund" });
  });

  it("says Lock wallet for one wallet and Lock for more, and that a new password is every wallet's", async () => {
    const one = await drawn({ wallets: fresh().slice(0, 1) });
    expect(one.shownButtons(one.section("Wallets"))).toEqual(["Rename", expect.stringContaining("Add wallet")]);
    const security = one.section("Security");
    expect(security.querySelectorAll("p.settings-note").map(visibleText)).toEqual([
      "Locks the wallet after this long without use.",
      "Changes the password for every wallet here.",
    ]);
    expect(dom.document.body.querySelectorAll("button").map((b) => b.textContent)).toContain("Lock wallet");
    security.querySelectorAll("button").find((b) => b.textContent === "Change password").click();
    await settle();
    expect(one.state.route).toBe("change_password");

    const two = await drawn({ wallets: fresh() });
    expect(two.section("Security").querySelector("p.settings-note").textContent).toBe("Locks every wallet after this long without use.");
    const buttons = dom.document.body.querySelectorAll("button").map((b) => b.textContent);
    expect([buttons.includes("Lock"), buttons.includes("Lock wallet")]).toEqual([true, false]);

    // One wallet open, and another in the vault that another password opens.
    const sealed = await drawn({ wallets: fresh().slice(0, 1), walletsHere: 2 });
    expect(sealed.section("Security").querySelector("p.settings-note").textContent).toBe("Locks every wallet after this long without use.");
    expect(dom.document.body.querySelectorAll("button").map((b) => b.textContent)).toContain("Lock");
  });

  it("names each connected site's wallet, and disconnects a site from its own wallet", async () => {
    const permissions = [
      { origin: "https://app.example", walletId: ACCOUNTS[0], accountIndex: 0 },
      { origin: "https://shop.example", walletId: W2[0], accountIndex: 1 },
    ];
    const view = await drawn({ wallets: fresh(), permissions });
    const sites = view.section("Connected sites");
    expect(sites.querySelectorAll(".settings-site__wallet").map(visibleText)).toEqual(["Wallet 1", "Savings · Rainy day"]);
    // The open wallet's site changes profile here; another's doesn't.
    expect(sites.querySelectorAll("select").map((sel) => sel.getAttribute("aria-label")).filter((label) => label.startsWith("Profile"))).toEqual(["Profile for app.example"]);

    vi.stubGlobal("confirm", vi.fn(() => true));
    button(sites, "Disconnect shop.example from Savings").click();
    await settle();
    expect(view.actions.send).toHaveBeenLastCalledWith({ type: "DUSK_UI_DISCONNECT_ORIGIN", origin: "https://shop.example", siteWallet: W2[0] });
    button(sites, "Disconnect app.example from Wallet 1").click();
    await settle();
    expect(view.actions.send).toHaveBeenLastCalledWith({ type: "DUSK_UI_DISCONNECT_ORIGIN", origin: "https://app.example" });
    sites.querySelectorAll("button").find((b) => b.textContent === "Disconnect all sites").click();
    await settle();
    expect(view.actions.send).toHaveBeenLastCalledWith({ type: "DUSK_UI_CLEAR_PERMISSIONS", siteWallets: [ACCOUNTS[0], W2[0]] });
  });
});


// The app on a phone: Auto-lock's Immediately, and fingerprint unlock, as phone wallets have them.
describe("security in the app on a phone", () => {
  const onPhone = ({ available = true, on = false, enroll = false } = {}) => {
    const asked = [];
    dom.window.__TAURI_INTERNALS__ = {
      invoke: vi.fn(async (cmd, args) => {
        if (cmd !== "fingerprint") return null;
        asked.push([args.action, args.args?.secret]);
        return args.action === "status" ? { ok: true, available, on, enroll } : { ok: true };
      }),
    };
    vi.stubGlobal("navigator", { ...globalThis.navigator, userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 6; wv) AppleWebKit/537.36 Chrome/156.0 Mobile Safari/537.36" });
    return { asked };
  };
  const finger = () => dom.document.body.querySelector("#fingerprint-unlock");

  it("turns fingerprint unlock on with the password, checked first, then a fingerprint; and off at once", async () => {
    const { asked } = onPhone();
    const view = await settings({}, { app: true });
    await vi.waitFor(() => expect(isShown(finger())).toBe(true));
    expect(visibleText(finger().parentNode)).toBe("Unlock with fingerprint");
    expect(finger().checked).toBe(false);
    finger().checked = true;
    finger().dispatchEvent(fakeEvent("change"));
    const pwd = dom.document.body.querySelector("#fingerprint-password");
    expect(isShown(pwd)).toBe(true);

    // A wrong password: said, and no fingerprint asked.
    view.actions.send.mockImplementation(async (m) => (m.type === "DUSK_UI_CHECK_PASSWORD" && m.password !== "right one" ? { error: { message: "Incorrect password" } } : {}));
    typeInto(pwd, "wrong one");
    dom.document.body.querySelectorAll("button").find((b) => b.textContent === "Turn on").click();
    await settle();
    expect(dom.document.body.querySelector("#fingerprint-error").textContent).toBe("Wrong password.");
    expect(asked.map(([action]) => action)).toEqual(["status"]);

    typeInto(pwd, "right one");
    dom.document.body.querySelectorAll("button").find((b) => b.textContent === "Turn on").click();
    await vi.waitFor(() => expect(asked.at(-1)).toEqual(["enable", "right one"]));
    expect(view.actions.showToast).toHaveBeenCalledWith("Fingerprint unlock is on.");

    finger().checked = false;
    finger().dispatchEvent(fakeEvent("change"));
    await vi.waitFor(() => expect(asked.at(-1)).toEqual(["disable", undefined]));
  });

  // Astra's: Turn on pressed, the switch off and on while the password was checked, and Turn on again:
  // two turnings on, each making the Keystore key anew, could leave neither working.
  it("starts one turning on at a time, whatever's switched or pressed while one is under way", async () => {
    const { asked } = onPhone();
    const view = await settings({}, { app: true });
    await vi.waitFor(() => expect(isShown(finger())).toBe(true));
    const checked = Promise.withResolvers();
    view.actions.send.mockImplementation(async (m) => (m.type === "DUSK_UI_CHECK_PASSWORD" ? checked.promise : {}));
    const turnOn = () => dom.document.body.querySelectorAll("button").find((b) => b.textContent === "Turn on");
    const flip = (on) => {
      finger().checked = on;
      finger().dispatchEvent(fakeEvent("change"));
    };
    flip(true);
    typeInto(dom.document.body.querySelector("#fingerprint-password"), "right one");
    turnOn().click();
    // While the password is checked: off and on again, and Turn on again.
    flip(false);
    flip(true);
    const again = dom.document.body.querySelector("#fingerprint-password");
    if (again) typeInto(again, "right one");
    turnOn()?.click();
    checked.resolve({});
    await settle();
    await vi.waitFor(() => expect(asked.filter(([action]) => action === "enable")).toHaveLength(1));
    await settle();
    expect(asked.filter(([action]) => action === "enable" || action === "disable")).toEqual([["enable", "right one"]]);
  });

  // Chen's, Sofía's and Lena's: nothing said fingerprint unlock was there until a fingerprint was added.
  it("lists fingerprint unlock on a phone without a fingerprint yet, off, with what to do first", async () => {
    const { asked } = onPhone({ available: false, enroll: true });
    await settings({}, { app: true });
    await vi.waitFor(() => expect(isShown(finger())).toBe(true));
    expect([finger().checked, finger().disabled]).toEqual([false, true]);
    expect(visibleText(finger().closest(".settings-fingerprint"))).toBe("Unlock with fingerprintAdd a fingerprint in your phone's settings first.");
    expect(asked).toEqual([["status", undefined]]);
  });

  // Chen's: no way in the app to see the recovery words again, or to change the password.
  it("offers the recovery phrase and a new password in the app, each behind the password", async () => {
    onPhone({ on: false });
    const view = await settings({}, { app: true });
    const security = view.section("Security");
    expect(view.shownButtons(security)).toEqual(expect.arrayContaining(["Change password", expect.stringContaining("Recovery phrase")]));
    security.querySelectorAll("button").find((b) => b.textContent.includes("Recovery phrase")).click();
    await settle();
    expect(view.state.route).toBe("recovery_phrase");

    const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    view.actions.send.mockImplementation(async (m) =>
      m.type === "DUSK_UI_RECOVERY_PHRASE" ? (m.password === "the password" ? { ok: true, result: MNEMONIC } : { error: { message: "Incorrect password" } }) : {}
    );
    const { recoveryPhraseView } = await import("./popup/views/wallets.js");
    dom.document.body.replaceChildren(...recoveryPhraseView(view.ov, { state: view.state, actions: view.actions }));
    const body = dom.document.body;
    const password = () => body.querySelectorAll("input").find((i) => accessibleName(i) === "Password you unlock with");
    const press = (name) => body.querySelectorAll("button").find((b) => b.textContent === name).click();
    expect(body.querySelector(".srp-grid")).toBeNull();
    typeInto(password(), "not it");
    press("Show recovery phrase");
    await settle();
    expect(visibleText(body)).toContain("Incorrect password");
    expect(body.querySelector(".srp-grid")).toBeNull();
    typeInto(password(), "the password");
    press("Show recovery phrase");
    await settle();
    expect(body.querySelectorAll(".srp-word-text").map((w) => w.textContent)).toEqual(MNEMONIC.split(" "));
    expect(view.actions.send).toHaveBeenLastCalledWith({ type: "DUSK_UI_RECOVERY_PHRASE", password: "the password" });
    press("Done");
    expect(view.state.route).toBe("options");
  });

  it("shows no recovery phrase in Settings outside the app", async () => {
    const view = await settings();
    expect(view.shownButtons(view.section("Security")).some((b) => b.includes("Recovery phrase"))).toBe(false);
  });

  it("offers no fingerprint unlock on a phone that can't guard the password with one", async () => {
    const { asked } = onPhone({ available: false });
    await settings({}, { app: true });
    await vi.waitFor(() => expect(asked).toEqual([["status", undefined]]));
    await settle();
    expect(isShown(finger())).toBe(false);
  });
});
