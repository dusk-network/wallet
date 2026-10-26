import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearAddressBook, markAddressBookNameChecked, upsertAddressBookEntry } from "../shared/addressBook.js";
import { lookupDuskName } from "../shared/duskNames.js";
import { TX_KIND } from "../shared/constants.js";
import { accessibleName, installFakeDom, isShown, settle, typeInto, visibleText } from "./testing/fakeDom.js";
import { addressBookView, NAME_RECHECK_MS } from "./popup/views/addressbook.js";

vi.mock("../shared/addressBook.js", () => ({
  listAddressBook: vi.fn(async () => []),
  clearAddressBook: vi.fn(async () => {}),
  markAddressBookNameChecked: vi.fn(async (entry) => entry),
  removeAddressBookEntry: vi.fn(async () => {}),
  upsertAddressBookEntry: vi.fn(async (entry) => ({ id: entry.id ?? "new", ...entry })),
}));
vi.mock("../shared/duskNames.js", async (importOriginal) => ({
  ...(await importOriginal()),
  lookupDuskName: vi.fn(),
}));

const ACCOUNT =
  "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927";
const ADDRESS = "2Ana1pUpv2ZbMVkwF5FXapYeBEjdxDatLn7nvJkhgTSXbs59SyZSx866bXirPgj8QQVB57uxHJBG1YFvkRbFj4T";
const OWN =
  "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";
const NODE = "https://testnet.nodes.dusk.network";
const ALICE = { id: "1", name: "Alice", address: ACCOUNT, type: "account" };
const SHOP = { ok: true, name: "alice-shop.dusk", account: ACCOUNT, address: ADDRESS };

let dom;

beforeEach(() => {
  dom = installFakeDom();
  clearAddressBook.mockClear();
  markAddressBookNameChecked.mockClear();
  upsertAddressBookEntry.mockClear();
  lookupDuskName.mockReset();
  lookupDuskName.mockImplementation((name) => {
    const result = name === "alice-shop.dusk" ? SHOP : { ok: false, name, reason: "not_registered" };
    return { result, promise: Promise.resolve(result) };
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Renders Contacts as the popup does, its list loaded with `items`.
function mount(addressBook = {}, ov = { nodeUrl: NODE, accounts: [OWN], selectedAccountIndex: 0, txs: [] }) {
  const state = {
    route: "contacts",
    addressBook: { mode: "manage", view: "list", loaded: true, loading: false, items: [], ...addressBook },
  };
  const draw = () => dom.document.body.replaceChildren(...addressBookView(ov, { state, actions }));
  const actions = { render: vi.fn(async () => draw()), showToast: vi.fn() };
  draw();
  const buttons = () => dom.document.body.querySelectorAll("button").filter(isShown).map((b) => b.textContent);
  const button = (text) => dom.document.body.querySelectorAll("button").find((b) => b.textContent === text);
  const field = (name) => dom.document.body.querySelectorAll("input").find((i) => accessibleName(i) === name);
  const error = (name) => {
    const id = field(name).getAttribute("aria-describedby");
    return id ? dom.document.getElementById(id).textContent : "";
  };
  return { state, actions, buttons, button, field, error, draw };
}

describe("contacts", () => {
  it("lists contacts by name with their address, and keeps Delete all apart, asking first", async () => {
    let view = mount();
    expect(dom.document.body.querySelector('input[type="search"]').getAttribute("aria-label")).toBe("Search contacts");
    expect(view.buttons()).toEqual(["← Back", "New contact"]);
    expect(visibleText(dom.document.body.querySelector(".contacts-empty"))).toBe("No contacts yet.");

    view = mount({ items: [ALICE, { id: "2", name: "Shop", address: ACCOUNT, type: "account", duskName: "alice-shop.dusk", checkedAt: 1 }] });
    expect(dom.document.body.querySelectorAll(".contact-row").map(visibleText)).toEqual([
      "Alice26FCH7…Tck927 · Public",
      "Shopalice-shop.dusk · Public",
    ]);
    // The last thing on the page, away from New contact.
    expect(view.buttons().at(-1)).toBe("Delete all contacts");
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    view.button("Delete all contacts").click();
    await settle();
    expect(confirm).toHaveBeenCalledWith("Delete all contacts?");
    expect(clearAddressBook).toHaveBeenCalledTimes(1);
  });

  it("offers this profile's recent recipients to pick or save, but never its own account", () => {
    const txs = [
      { kind: TX_KIND.TRANSFER, to: ACCOUNT, toName: "alice.dusk", hash: "ab".repeat(32), status: "executed", submittedAt: 2 },
      { kind: TX_KIND.TRANSFER, to: OWN, hash: "cd".repeat(32), status: "executed", submittedAt: 1 },
    ];
    const view = mount({ mode: "pick", pickReturnRoute: "send" }, { nodeUrl: NODE, accounts: [OWN], selectedAccountIndex: 0, txs });
    const rows = dom.document.body.querySelectorAll(".contacts-section .contact-row");
    expect(rows.map(visibleText)).toEqual(["alice.dusk Public Save"].map((t) => t.replace(/ /g, "")));
    const save = rows[0].querySelector(".mini-btn");
    expect(accessibleName(save)).toBe("Save alice.dusk to Contacts");
    save.click();
    expect(view.state.addressBook).toMatchObject({ view: "edit", editAddress: ACCOUNT, editName: "alice.dusk" });
  });

  it("saves a contact from a .dusk name, with the name and when it was checked", async () => {
    const view = mount({ view: "edit", editId: null, editReturnView: "list" });
    expect(view.buttons()).toEqual(["← Back", "Save"]);
    typeInto(view.field("Name"), "Shop");
    typeInto(view.field("Address"), "alice-shop.dusk");
    // Both addresses of the name, to pick from, as Send shows them.
    expect(dom.document.body.querySelectorAll("[role=radio]").length).toBe(2);
    dom.document.body.querySelectorAll("[role=radio]")[1].click();
    view.button("Save").click();
    await settle();
    expect(upsertAddressBookEntry).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Shop", address: ADDRESS, type: "address", duskName: "alice-shop.dusk", checkedAt: expect.any(Number) })
    );
  });

  it("says under the field what can't be saved: no name, an unknown name, this profile's own account", async () => {
    const view = mount({ view: "edit", editId: null, editReturnView: "list" });
    view.button("Save").click();
    await settle();
    expect(view.error("Name")).toBe("Enter a name.");

    typeInto(view.field("Name"), "Typo");
    typeInto(view.field("Address"), "alcie-shop.dusk");
    expect(view.error("Address")).toBe("alcie-shop.dusk isn't registered.");
    view.button("Save").click();
    await settle();
    expect(upsertAddressBookEntry).not.toHaveBeenCalled();

    typeInto(view.field("Address"), OWN);
    view.button("Save").click();
    await settle();
    expect(view.error("Address")).toBe("That's this profile's own account.");
    expect(upsertAddressBookEntry).not.toHaveBeenCalled();
  });

  it("edits a contact by its .dusk name, with Delete for a saved one and Back to leave", () => {
    const shop = { id: "2", name: "Shop", address: ADDRESS, type: "address", duskName: "alice-shop.dusk", checkedAt: 1 };
    const view = mount({ view: "edit", items: [shop] });
    view.state.addressBook.view = "list";
    view.draw();
    dom.document.body.querySelector(".contact-row").click();
    view.button("Edit").click();
    expect(view.field("Address").value).toBe("alice-shop.dusk");
    expect(dom.document.body.querySelectorAll("[role=radio]").map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "true"]);
    expect(view.buttons()).toEqual(["← Back", "Save", "Delete contact"]);
    dom.document.body.querySelector(".subnav-back").click();
    expect(view.state.addressBook.view).toBe("detail");
  });

  it("marks an hour-old .dusk name checked on the contact as saved, never writing back the copy it showed", async () => {
    const shop = { id: "2", name: "Shop", address: ADDRESS, type: "address", duskName: "alice-shop.dusk", checkedAt: Date.now() - NAME_RECHECK_MS - 1 };
    mount({ view: "detail", detailId: "2", items: [shop] });
    await settle();
    expect(markAddressBookNameChecked).toHaveBeenCalledWith(shop);
    expect(upsertAddressBookEntry).not.toHaveBeenCalled();
    expect(isShown(dom.document.body.querySelector(".contact-name-check"))).toBe(false);
  });

  it("checks an hour-old .dusk name again, and says so when it points elsewhere now", async () => {
    lookupDuskName.mockImplementation((name) => {
      const result = { ...SHOP, name, account: OWN };
      return { result, promise: Promise.resolve(result) };
    });
    const shop = { id: "2", name: "Shop", address: ACCOUNT, type: "account", duskName: "alice-shop.dusk", checkedAt: Date.now() - NAME_RECHECK_MS - 1 };
    mount({ view: "detail", detailId: "2", items: [shop] });
    await settle();
    expect(visibleText(dom.document.body.querySelector(".contact-name-check"))).toBe(
      "alice-shop.dusk now points to another address. Edit the contact before you send to it."
    );
    expect(visibleText(dom.document.body.querySelector(".contact-hero"))).toBe("Shopalice-shop.dusk26FCH7…Tck927Public");
  });
});
