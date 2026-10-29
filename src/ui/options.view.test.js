import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setAccountName } from "../shared/accountNames.js";
import { clearAddressBook } from "../shared/addressBook.js";
import { accessibleName, fakeEvent, installFakeDom, isShown, screenReaderText, settle, typeInto, visibleText } from "./testing/fakeDom.js";

vi.mock("../shared/accountNames.js", () => ({ setAccountName: vi.fn(async () => {}) }));
vi.mock("../shared/addressBook.js", () => ({ clearAddressBook: vi.fn(async () => {}) }));
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

describe("profile labels", () => {
  const label = (n) => dom.document.body.querySelectorAll("input").find((i) => accessibleName(i) === `Profile ${n} label`);

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
    expect(view.actions.showToast).toHaveBeenCalledWith("Label saved.");
    view.draw();
    expect(label(2).value).toBe("Spending");
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
    // Testnet says it all.
    expect(network.querySelectorAll(".muted").filter(isShown)).toEqual([]);

    view = await settings({ nodeUrl: "https://devnet.nodes.dusk.network" });
    expect(view.section("Network").querySelectorAll(".muted").filter(isShown).map((el) => el.textContent)).toEqual([
      "Experimental",
    ]);
  });

  it("names each profile by its verified name, as the header does, with labels for this device", async () => {
    const view = await settings();
    const profile = view.section("Profile");
    expect(profile.querySelectorAll("#account option").map((o) => o.textContent)).toEqual([
      "alice.dusk · 26FCH7…Tck927",
      "Profile 2 · 21n5nc…fMMLNz",
    ]);
    expect(visibleText(profile.querySelector(".settings-subtitle"))).toBe("Labels on this device");
    expect(profile.querySelectorAll(".settings-profile-line").map(visibleText)).toEqual([
      "alice.dusk · 26FCH7…Tck927",
      "Profile 2 · 21n5nc…fMMLNz",
    ]);
    const inputs = profile.querySelectorAll("input");
    expect(inputs.map((i) => [i.getAttribute("aria-label"), i.getAttribute("placeholder")])).toEqual([
      ["Profile 1 label", "Label, only on this device"],
      ["Profile 2 label", "Label, only on this device"],
    ]);
  });

  it("disconnects one site, or all of them after asking, away from Reset wallet", async () => {
    let view = await settings();
    expect(visibleText(view.section("Connected sites"))).toBe("[Connected sites]No sites are connected.");

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
      "Removes this wallet, its contacts, activity and connected sites from this browser. Your funds stay on Dusk. You need the recovery phrase to use it again."
    );
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

  it("keeps them on a custom node, and in the desktop app, which has no version to show", async () => {
    const custom = await settings({ nodeUrl: "https://my-node.example" });
    expect(legal(custom.section).map((b) => b.textContent)).toEqual(["Terms of use", "Privacy policy"]);

    const app = await settings({}, { app: true });
    expect(visibleText(app.section("About"))).not.toMatch(/Dusk Wallet v/);
    expect(legal(app.section).map((b) => b.textContent)).toEqual(["Terms of use", "Privacy policy"]);
  });
});
