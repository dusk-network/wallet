import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NAME_HIDES } from "@dusk-network/app-core/names";
import { clearAddressBook, listAddressBook, markAddressBookNameChecked, removeAddressBookEntry, upsertAddressBookEntry } from "../shared/addressBook.js";
import { lookupDuskName } from "../shared/duskNames.js";
import { noteChainId } from "../shared/nodeNetwork.js";
import { TX_KIND } from "../shared/constants.js";
import { decodeBase58, encodeBase58 } from "@duskdomains/sdk";
import { shortAddress } from "./lib/strings.js";
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

// A real account with one character changed: the right length, but no key.
const MISTYPED = "2131Xe28JCogeQqgK4VTjtDwY5GJ5oFSUQgQobAiFbUKcXK2BzpJdoj4iGam2HGgkbnbykjqPVWmy3S83TDgqfPmtLgBv56ZzeuhHbuFy9bCerhU4JTwEi2oCxxPKSx5983T";

describe("contacts whose names look like another's", () => {
  it("say so in the list and the picker, each with its address, as Sofia's three Estudio Marta", () => {
    const items = [
      { id: "1", name: "Estudio Marta", address: ACCOUNT, type: "account" },
      { id: "2", name: "Estudio M\u0430rta", address: ADDRESS, type: "address", duskName: "marta.dusk" },
      { id: "3", name: "estudio marta.", address: OWN.slice(0, -1) + "x", type: "account" },
      { id: "4", name: "Bob", address: ADDRESS.slice(0, -1) + "y", type: "address" },
      // Saved before a profile's name was refused.
      { id: "5", name: "Profile 1", address: ACCOUNT.slice(0, -1) + "z", type: "account" },
    ];
    for (const mode of ["manage", "pick"]) {
      mount({ items, mode });
      const rows = dom.document.body.querySelectorAll(".contact-row").map((row) => row.querySelectorAll(".row-sub").map((el) => el.textContent));
      expect(rows, mode).toEqual([
        [`${shortAddress(ACCOUNT)} · Public`, "Looks like another contact"],
        // Its address, not its .dusk name, beside the name it looks like.
        [`${shortAddress(ADDRESS)} · Shielded`, "Looks like another contact"],
        [`${shortAddress(items[2].address)} · Public`, "Looks like another contact"],
        [`${shortAddress(items[3].address)} · Shielded`],
        [`${shortAddress(items[4].address)} · Public`, "Looks like your profile's name"],
      ]);
    }
  });
});

describe("contacts", () => {
  it("reads the list once a visit: one that failed says why, and a locked wallet shows its unlock form", async () => {
    listAddressBook.mockRejectedValueOnce(new Error("Couldn't read your contacts"));
    const view = mount({ loaded: false, items: null });
    await settle();
    view.draw();
    view.draw();
    await settle();
    expect(listAddressBook).toHaveBeenCalledTimes(1);
    expect(visibleText(dom.document.body)).toContain("Couldn't read your contacts");
    expect(view.actions.render).toHaveBeenCalledWith();

    // The wallet locked meanwhile: the app reads its state again, and shows the unlock form.
    listAddressBook.mockClear();
    listAddressBook.mockRejectedValueOnce(new Error("Wallet locked"));
    const locked = mount({ loaded: false, items: null });
    await settle();
    expect(listAddressBook).toHaveBeenCalledTimes(1);
    expect(locked.actions.render).toHaveBeenCalledWith({ forceRefresh: true });
    listAddressBook.mockClear();
  });

  it("finds a contact by its name typed without its accents, or its address", () => {
    // Sofia's: a search needs no accent typed.
    const items = [{ id: "1", name: "Ilustraci\u00f3n Sol", address: ACCOUNT, type: "account" }, { id: "2", name: "Bob", address: ADDRESS, type: "address" }];
    const titles = (query) => {
      const view = mount({ items, query });
      void view;
      return dom.document.body.querySelectorAll(".contact-row .row-title").map((el) => el.textContent);
    };
    expect(titles("ilustracion")).toEqual(["Ilustraci\u00f3n Sol"]);
    expect(titles("ILUSTRACIÓN sol")).toEqual(["Ilustraci\u00f3n Sol"]);
    expect(titles(ADDRESS.slice(10, 30))).toEqual(["Bob"]);
    expect(titles("carla")).toEqual([]);
  });

  it("lists contacts by name with their address and first letter, and leaves Delete all to Settings", async () => {
    let view = mount();
    expect(dom.document.body.querySelector('input[type="search"]').getAttribute("aria-label")).toBe("Search contacts");
    expect(view.buttons()).toEqual(["← Back", "New contact"]);
    expect(visibleText(dom.document.body.querySelector(".contacts-empty"))).toBe("No contacts yet.");

    view = mount({ items: [ALICE, { id: "2", name: "Shop", address: ACCOUNT, type: "account", duskName: "alice-shop.dusk", checkedAt: 1 }] });
    expect(dom.document.body.querySelectorAll(".contact-row").map(visibleText)).toEqual([
      "AAlice26FCH7…Tck927 · Public",
      "SShopalice-shop.dusk · Public",
    ]);
    // Each by the first letter of its name, not a picture that can come out blank.
    const avatars = dom.document.body.querySelectorAll(".contact-row .row-icon");
    expect(avatars.map((a) => [a.className, a.textContent, a.getAttribute("aria-hidden")])).toEqual([
      ["row-icon contact-letter", "A", "true"],
      ["row-icon contact-letter", "S", "true"],
    ]);
    expect(dom.document.body.querySelector(".identicon")).toBeNull();
    // Delete all isn't beside the list.
    expect(view.buttons()).not.toContain("Delete all contacts");
    expect(clearAddressBook).not.toHaveBeenCalled();
  });

  it("offers this profile's recent recipients to pick or save, but never its own account", () => {
    const txs = [
      { kind: TX_KIND.TRANSFER, to: ACCOUNT, toName: "alice.dusk", hash: "ab".repeat(32), status: "executed", submittedAt: 2 },
      { kind: TX_KIND.TRANSFER, to: OWN, hash: "cd".repeat(32), status: "executed", submittedAt: 1 },
    ];
    const view = mount({ mode: "pick", pickReturnRoute: "send" }, { nodeUrl: NODE, accounts: [OWN], selectedAccountIndex: 0, txs });
    const rows = dom.document.body.querySelectorAll(".contacts-section .contact-row");
    expect(rows.map(visibleText)).toEqual(["A alice.dusk Public Save"].map((t) => t.replace(/ /g, "")));
    const save = rows[0].querySelector(".mini-btn");
    expect(accessibleName(save)).toBe("Save alice.dusk to Contacts");
    save.click();
    // Named after a .dusk name, it's saved from that name.
    expect(view.state.addressBook).toMatchObject({ view: "edit", editAddress: "alice.dusk", editName: "alice.dusk" });
  });

  it("finds recent recipients with the search too, as Sofia's 'norte' looks for one", () => {
    const txs = [
      { kind: TX_KIND.TRANSFER, to: ACCOUNT, toName: "alice.dusk", hash: "ab".repeat(32), status: "executed", submittedAt: 2 },
      { kind: TX_KIND.TRANSFER, to: ADDRESS, hash: "cd".repeat(32), status: "executed", submittedAt: 1 },
    ];
    const recent = (query) => {
      mount({ mode: "pick", pickReturnRoute: "send", items: [{ id: "9", name: "Norte Café", address: OWN.replace("21n5", "21n6"), type: "account" }], query }, { nodeUrl: NODE, accounts: [OWN], selectedAccountIndex: 0, txs });
      const section = dom.document.body.querySelectorAll(".contacts-section")[0];
      return section ? section.querySelectorAll(".contact-row .row-title").map((el) => el.textContent) : [];
    };
    expect(recent("")).toEqual(["alice.dusk", shortAddress(ADDRESS)]);
    expect(recent("ALICE")).toEqual(["alice.dusk"]);
    expect(recent(ADDRESS.slice(5, 25))).toEqual([shortAddress(ADDRESS)]);
    // Nothing recent matches: Recent goes, and the contact it finds is first.
    expect(recent("norte")).toEqual([]);
    expect(dom.document.body.querySelectorAll(".contact-row .row-title").map((el) => el.textContent)).toEqual(["Norte Café"]);
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
      expect.objectContaining({ name: "Shop", address: ADDRESS, type: "address", duskName: "alice-shop.dusk", checkedAt: expect.any(Number) }),
      expect.anything()
    );
  });

  it("won't save a mistyped account", async () => {
    const view = mount({ view: "edit", editId: null, editReturnView: "list" });
    typeInto(view.field("Name"), "Typo");
    typeInto(view.field("Address"), MISTYPED);
    expect(view.error("Address")).toBe("Not a valid address. Check it and try again.");
    view.button("Save").click();
    await settle();
    expect(view.error("Address")).toBe("Not a valid address. Check it and try again.");
    expect(upsertAddressBookEntry).not.toHaveBeenCalled();
  });

  it("won't save a contact named like a .dusk name it isn't saved from", async () => {
    const view = mount({ view: "edit", editId: null, editReturnView: "list" });
    typeInto(view.field("Address"), ACCOUNT);
    for (const name of ["alice.dusk", "ALICE.Dusk", " alice.dusk ", "alice.dusk."]) {
      typeInto(view.field("Name"), name);
      view.button("Save").click();
      await settle();
      expect(view.error("Name")).toBe("That looks like a .dusk name. Enter it as the address below, or choose another name.");
    }
    expect(upsertAddressBookEntry).not.toHaveBeenCalled();
  });

  it("won't save an address under a second name, and says which it has", async () => {
    const view = mount({ view: "edit", editId: null, editReturnView: "list", items: [{ id: "2", name: "Shop", address: ACCOUNT, type: "account" }] });
    typeInto(view.field("Name"), "Spaarpotje");
    typeInto(view.field("Address"), ACCOUNT);
    view.button("Save").click();
    await settle();
    expect(view.error("Address")).toBe("This address is already saved as Shop.");
    expect(upsertAddressBookEntry).not.toHaveBeenCalled();
  });

  it("joins up an address that a chat app broke with spaces", async () => {
    const view = mount({ view: "edit", editId: null, editReturnView: "list" });
    typeInto(view.field("Name"), "Shop");
    typeInto(view.field("Address"), `${ACCOUNT.slice(0, 50)} ${ACCOUNT.slice(50)}`);
    view.button("Save").click();
    await settle();
    expect(upsertAddressBookEntry).toHaveBeenCalledWith(expect.objectContaining({ address: ACCOUNT }), expect.anything());
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

  describe("what a new contact warns of", () => {
    // Other accounts that are keys, and shielded addresses of the right length.
    const BOB = "26JfWKvhYdVY71bdSPVLNJ51Buy4GjimCT7zcsoxNQtydDbdoH2AwZaH8W7rjcAc9riAu39Vw9Lx1w7yrkBgotSjWmUdkSyQuaTKDZWVCKp9g1GxiEnnksv3W3onToB5NsNi";
    const CAROL = "zFVXTQZfY6gB2rWZFEm4ToWY2NKrpgeswTboWMAe7cjzaqHjsdGuADp8GsYzeruRkP3ZozA34mhWedEHkEiUr73iv8EcK3A192Y5b2uQYxLgprkZ2u8WKZyfDuZiyy4yEuL";
    const ADDRESS_OWN = "4QpZhL54DtNrCpXRK54BhfF8WYsgvPbfVTfeNf2ePSRPTCnuZYMk988Es2NMbwCXMPTKGTLfYunZ4mbFc7i743QE";
    const ADDRESS_SECOND = encodeBase58(decodeBase58(ADDRESS_OWN).map((byte, i, all) => (i === all.length - 1 ? byte ^ 1 : byte)));
    const shownNote = () =>
      dom.document.body.querySelectorAll(".contact-note").filter(isShown).map((el) => (el.querySelector(".contact-note__words") ?? el).textContent);
    // Yes, save it, under a name's question at Save.
    const yes = () => dom.document.body.querySelectorAll(".contact-note button").find((b) => isShown(b) && b.textContent === "Yes, save it");
    const edit = (over = {}, ov) => mount({ view: "edit", editId: null, editReturnView: "list", loaded: true, items: [ALICE, { id: "2", name: "Estudio Marta", address: ADDRESS, type: "address" }], ...over }, ov);

    it("asks about a name in use, with the address it has, and saves it only once that's answered", async () => {
      const view = edit();
      const name = view.field("Name");
      expect(shownNote()).toEqual([]);
      for (const typed of ["Estudio Marta", "  estudio   marta ", "Estudió Marta"]) {
        typeInto(name, typed);
        expect(shownNote()).toEqual([`You have a contact called Estudio Marta, at ${shortAddress(ADDRESS)}. Is this someone else?`]);
      }
      // A name it starts as, word for word, is asked about too; another name isn't.
      typeInto(name, "Estudio Marta 2");
      expect(shownNote()).toEqual([`You have a contact called Estudio Marta, at ${shortAddress(ADDRESS)}. Is this someone else?`]);
      typeInto(name, "Estudio Pablo");
      expect(shownNote()).toEqual([]);

      typeInto(name, "Alice");
      typeInto(view.field("Address"), BOB);
      expect(shownNote()).toEqual([`You have a contact called Alice, at ${shortAddress(ACCOUNT)}. Is this someone else?`]);
      expect(yes()).toBeUndefined();
      // A question, not a refusal: two people can have one name. Saved once it's answered.
      view.button("Save").click();
      await settle();
      expect(upsertAddressBookEntry).not.toHaveBeenCalled();
      yes().click();
      await settle();
      expect(upsertAddressBookEntry).toHaveBeenCalledWith(expect.objectContaining({ name: "Alice", address: BOB }), expect.anything());
    });

    // Amélie's: "Mamie, c'est Lucas, nouveau compte": a plain "Lucas" beside "Lucas (petit-fils)" wasn't questioned.
    it("asks about a name an existing contact's starts as, or that starts it, at Save", async () => {
      const view = edit({ items: [ALICE, { id: "3", name: "Lucas (petit-fils)", address: ADDRESS, type: "address" }] });
      typeInto(view.field("Name"), "Lucas");
      typeInto(view.field("Address"), BOB);
      view.button("Save").click();
      await settle();
      expect(shownNote()).toEqual([`You have a contact called Lucas (petit-fils), at ${shortAddress(ADDRESS)}. Is this someone else?`]);
      expect(upsertAddressBookEntry).not.toHaveBeenCalled();
      // Changed after the question: the question goes, and Yes is for none.
      typeInto(view.field("Name"), "Lucas Martin");
      expect([shownNote(), yes()]).toEqual([[], undefined]);
      view.button("Save").click();
      await settle();
      expect(upsertAddressBookEntry).toHaveBeenCalledWith(expect.objectContaining({ name: "Lucas Martin", address: BOB }), expect.anything());
    });

    it("asks about a name that looks like another contact's in other letters, and saves it once that's answered", async () => {
      const view = edit();
      const name = view.field("Name");
      const alike = `That looks like your contact Alice, at ${shortAddress(ACCOUNT)}. Is this someone else?`;
      // Cyrillic А and е, Greek Α, a capital I for the l, and a 1.
      for (const typed of ["\u0410lice", "Alic\u0435", "\u0391LICE", "AIice", "A1ice"]) {
        typeInto(name, typed);
        expect(shownNote(), typed).toEqual([alike]);
      }
      for (const typed of ["Alicia", "Bob", "Estudio Marta"]) {
        typeInto(name, typed);
        expect(shownNote()).not.toContain(alike);
      }
      typeInto(name, "\u0410lice");
      typeInto(view.field("Address"), BOB);
      view.button("Save").click();
      await settle();
      expect(upsertAddressBookEntry).not.toHaveBeenCalled();
      yes().click();
      await settle();
      expect(upsertAddressBookEntry).toHaveBeenCalledWith(expect.objectContaining({ name: "\u0410lice", address: BOB }), expect.anything());
    });

    it("refuses a name with hidden characters, as it's typed and on Save", async () => {
      // Marek's: an override at the start reads as "Profile 2" and "Alice", and a space that takes no room.
      const view = edit();
      const name = view.field("Name");
      for (const typed of ["\u202e2 eliforP", "\u202eecilA", "Ali\u200bce"]) {
        typeInto(name, typed);
        expect(view.error("Name"), typed).toBe(NAME_HIDES);
        expect(name.getAttribute("aria-invalid"), typed).toBe("true");
        expect(shownNote(), typed).toEqual([]);
      }
      typeInto(view.field("Address"), BOB);
      view.button("Save").click();
      await settle();
      expect(view.error("Name")).toBe(NAME_HIDES);
      expect(upsertAddressBookEntry).not.toHaveBeenCalled();

      typeInto(name, "Alicia");
      expect(view.error("Name")).toBe("");
      view.button("Save").click();
      await settle();
      expect(upsertAddressBookEntry).toHaveBeenCalledWith(expect.objectContaining({ name: "Alicia", address: BOB }), expect.anything());
    });

    it("doesn't warn a contact of its own name, as it's edited", () => {
      edit({ editId: "1", editName: "Alice", editAddress: ACCOUNT });
      expect(shownNote()).toEqual([]);
    });

    it("says an address is another profile's of yours, or another wallet's, and lets it be saved", async () => {
      const ov = {
        nodeUrl: NODE,
        accounts: [OWN, BOB],
        addresses: [ADDRESS_OWN, ADDRESS_SECOND],
        selectedAccountIndex: 0,
        accountNames: { 1: "Savings" },
        txs: [],
        wallets: [{ key: "w1", active: true, accounts: [OWN, BOB] }, { key: "w2", n: 2, active: false, accounts: [CAROL], accountNames: {} }],
      };
      const view = edit({}, ov);
      typeInto(view.field("Name"), "Rainy day");
      typeInto(view.field("Address"), BOB);
      expect(shownNote()).toEqual(["That's your own profile: Savings."]);
      typeInto(view.field("Address"), ADDRESS_SECOND);
      expect(shownNote()).toEqual(["That's your own profile: Savings."]);
      typeInto(view.field("Address"), CAROL);
      expect(shownNote()).toEqual(["That's your own profile: Wallet 2 · Profile 1."]);
      view.button("Save").click();
      await settle();
      expect(upsertAddressBookEntry).toHaveBeenCalledWith(expect.objectContaining({ name: "Rainy day", address: CAROL }), expect.anything());
    });

    it("won't save a contact named like a profile of yours, as Review would read it as that profile, but for that profile's own address", async () => {
      // Marek's: "Profile 2" with someone else's address read "To Profile 2" on Review, as his own did.
      const ov = { nodeUrl: NODE, accounts: [OWN, BOB], addresses: [ADDRESS_OWN, ADDRESS_SECOND], selectedAccountIndex: 0, txs: [] };
      const view = edit({}, ov);
      typeInto(view.field("Address"), CAROL);
      typeInto(view.field("Name"), "Profile 2");
      expect(view.error("Name")).toBe("One of your profiles is called Profile 2. Choose another name.");
      typeInto(view.field("Name"), "ProfiIe  2");
      expect(view.error("Name")).toBe("That looks like Profile 2, one of your profiles. Choose another name.");
      view.button("Save").click();
      await settle();
      expect(upsertAddressBookEntry).not.toHaveBeenCalled();

      // Profile 2's own account may be saved by its name.
      typeInto(view.field("Name"), "Profile 2");
      typeInto(view.field("Address"), BOB);
      expect(view.error("Name")).toBe("");
      view.button("Save").click();
      await settle();
      expect(upsertAddressBookEntry).toHaveBeenCalledWith(expect.objectContaining({ name: "Profile 2", address: BOB }), expect.anything());
    });

    // Amélie's: her own profile named Lucas, by a slip, beside her grandson saved as "Lucas (petit-fils)": Send read
    // "From Lucas … To Lucas (petit-fils)".
    it("asks about a name a profile's starts, or that starts it, word for word, and saves it once that's answered", async () => {
      const ov = { nodeUrl: NODE, accounts: [OWN, BOB], addresses: [ADDRESS_OWN, ADDRESS_SECOND], accountNames: { 0: "Lucas" }, selectedAccountIndex: 0, txs: [] };
      const view = edit({}, ov);
      typeInto(view.field("Address"), CAROL);
      for (const typed of ["Lucas (petit-fils)", "lucas petit-fils", "Luc\u0430s (petit-fils)"]) {
        typeInto(view.field("Name"), typed);
        expect([view.error("Name"), shownNote()], typed).toEqual(["", ["One of your profiles is called Lucas. Is this someone else?"]]);
      }
      // Not a whole word of it: nothing to ask.
      typeInto(view.field("Name"), "Lucastor");
      expect(shownNote()).toEqual([]);
      typeInto(view.field("Name"), "Lucas (petit-fils)");
      view.button("Save").click();
      await settle();
      expect(upsertAddressBookEntry).not.toHaveBeenCalled();
      yes().click();
      await settle();
      expect(upsertAddressBookEntry).toHaveBeenCalledWith(expect.objectContaining({ name: "Lucas (petit-fils)", address: CAROL }), expect.anything());
    });

    it("says this profile's own address as it's typed, under the field, and won't save it", async () => {
      const ov = { nodeUrl: NODE, accounts: [OWN], addresses: [ADDRESS_OWN], selectedAccountIndex: 0, txs: [] };
      const view = edit({}, ov);
      typeInto(view.field("Name"), "Me");
      typeInto(view.field("Address"), OWN);
      expect(view.error("Address")).toBe("That's this profile's own account.");
      typeInto(view.field("Address"), ADDRESS_OWN);
      expect(view.error("Address")).toBe("That's this profile's own shielded address.");
      view.button("Save").click();
      await settle();
      expect(upsertAddressBookEntry).not.toHaveBeenCalled();
    });

    it("says it of an address a .dusk name points to", async () => {
      const ov = { nodeUrl: NODE, accounts: [OWN, ACCOUNT], addresses: [ADDRESS_OWN], selectedAccountIndex: 0, accountNames: { 1: "Savings" }, txs: [] };
      const view = edit({}, ov);
      typeInto(view.field("Name"), "Shop");
      typeInto(view.field("Address"), "alice-shop.dusk");
      await settle();
      expect(shownNote()).toEqual(["That's your own profile: Savings."]);
    });
  });

  it("shows a contact saved with hidden characters by their codes, says so, and lets it be deleted", async () => {
    // Marek's, saved before such names were refused: it read as "Alice", over a stranger's address.
    const stranger = { id: "9", name: "\u202eecilA", address: ADDRESS, type: "address" };
    const view = mount({ items: [ALICE, stranger] });
    const [, row] = dom.document.body.querySelectorAll(".contact-row");
    expect(row.querySelector(".row-title").textContent).toBe("\\u202eecilA");
    expect(row.querySelectorAll(".row-sub").map((el) => el.textContent)).toEqual([`${shortAddress(ADDRESS)} · Shielded`, "Its name has hidden characters"]);
    // No letter for a name that starts with what can't be seen.
    expect(row.querySelector(".row-icon").textContent).toBe("");
    expect(visibleText(dom.document.body)).not.toContain("\u202e");

    row.click();
    expect(dom.document.body.querySelector(".tx-hero-name").textContent).toBe("\\u202eecilA");
    expect(visibleText(dom.document.body.querySelector(".contact-hidden-name"))).toBe(
      "This name has hidden characters, shown here as codes. Edit the contact to type it again, or delete it."
    );
    expect(visibleText(dom.document.body)).not.toContain("\u202e");

    view.button("Edit").click();
    expect(view.error("Name")).toBe(NAME_HIDES);
    vi.stubGlobal("confirm", () => true);
    removeAddressBookEntry.mockClear();
    view.button("Delete contact").click();
    await settle();
    expect(removeAddressBookEntry).toHaveBeenCalledWith("9", expect.anything());
  });

  it("says an address is saved already by its contact's name, hidden characters as codes", async () => {
    const view = mount({ view: "edit", editId: null, items: [{ id: "9", name: "\u202eecilA", address: ACCOUNT, type: "account" }] });
    typeInto(view.field("Name"), "Alice");
    typeInto(view.field("Address"), ACCOUNT);
    view.button("Save").click();
    await settle();
    expect(view.error("Address")).toBe("This address is already saved as \\u202eecilA.");
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

  it("lists the token approvals that let the contact spend, in its Activity", () => {
    const approval = {
      hash: "ef".repeat(32),
      kind: TX_KIND.CONTRACT_CALL,
      status: "executed",
      submittedAt: 3,
      profileIndex: 0,
      asset: { type: "DRC20", op: "approve", symbol: "TKN", decimals: 0, valueUnits: "5", spender: ACCOUNT },
    };
    const other = { ...approval, hash: "aa".repeat(32), asset: { ...approval.asset, spender: OWN } };
    mount({ view: "detail", detailId: "1", items: [ALICE] }, { nodeUrl: NODE, accounts: [OWN], selectedAccountIndex: 0, txs: [approval, other] });
    const rows = dom.document.body.querySelectorAll(".contact-detail .tx-row");
    expect(rows.map((r) => visibleText(r.querySelector(".tx-name")))).toEqual(["Alice"]);
    expect(visibleText(rows[0].querySelector(".tx-sub"))).toMatch(/^Approval · /);
  });

  it("saves, checks and deletes a contact for the wallet the page was drawn for", async () => {
    const shown = { walletId: OWN };
    const view = mount({ view: "edit", editId: null, editReturnView: "list" }, { isUnlocked: true, nodeUrl: NODE, accounts: [OWN], selectedAccountIndex: 0, txs: [] });
    typeInto(view.field("Name"), "Shop");
    typeInto(view.field("Address"), ADDRESS);
    view.button("Save").click();
    await settle();
    expect(upsertAddressBookEntry).toHaveBeenCalledWith(expect.objectContaining({ name: "Shop", address: ADDRESS }), shown);
  });

  describe("a name read through a node the wallet doesn't know", () => {
    const CUSTOM = "https://my-node.example:8443";
    const NOTE = "Checked by my-node.example:8443, a node the wallet doesn't know. Check the address too.";
    const onCustom = { nodeUrl: CUSTOM, accounts: [OWN], selectedAccountIndex: 0, txs: [] };
    const notes = () => dom.document.body.querySelectorAll('[role="note"]').map(visibleText);

    beforeEach(() => noteChainId(CUSTOM, 2));
    afterEach(() => noteChainId(CUSTOM, null));

    it("says whose word it is on the contact form, and leaves it due for a check", async () => {
      const view = mount({ view: "edit" }, onCustom);
      typeInto(view.field("Name"), "Shop");
      typeInto(view.field("Address"), "alice-shop.dusk");
      await settle();
      expect(notes()).toContain(NOTE);
      view.button("Save").click();
      await settle();
      expect(upsertAddressBookEntry).toHaveBeenCalledWith(expect.objectContaining({ duskName: "alice-shop.dusk", checkedAt: 0 }), expect.anything());
    });

    it("says nothing on a network's own node, where saving counts as a check", async () => {
      const view = mount({ view: "edit" });
      typeInto(view.field("Name"), "Shop");
      typeInto(view.field("Address"), "alice-shop.dusk");
      await settle();
      expect(notes()).not.toContain(NOTE);
      view.button("Save").click();
      await settle();
      expect(upsertAddressBookEntry.mock.lastCall[0].checkedAt).toBeGreaterThan(0);
    });

    it("says so with what it says of a saved contact's name, and doesn't count it as a check", async () => {
      const shop = { id: "2", name: "Shop", address: ACCOUNT, type: "account", duskName: "alice-shop.dusk", checkedAt: Date.now() - NAME_RECHECK_MS - 1 };
      mount({ view: "detail", detailId: "2", items: [shop] }, onCustom);
      await settle();
      expect(markAddressBookNameChecked).not.toHaveBeenCalled();
      expect(isShown(dom.document.body.querySelector(".contact-name-check"))).toBe(false);

      lookupDuskName.mockImplementation((name) => {
        const result = { ...SHOP, name, account: OWN };
        return { result, promise: Promise.resolve(result) };
      });
      mount({ view: "detail", detailId: "2", items: [shop] }, onCustom);
      await settle();
      expect(visibleText(dom.document.body.querySelector(".contact-name-check"))).toBe(`alice-shop.dusk now points to another address. Edit the contact before you send to it. ${NOTE}`);
    });
  });

  it("marks an hour-old .dusk name checked on the contact as saved, never writing back the copy it showed", async () => {
    const shop = { id: "2", name: "Shop", address: ADDRESS, type: "address", duskName: "alice-shop.dusk", checkedAt: Date.now() - NAME_RECHECK_MS - 1 };
    mount({ view: "detail", detailId: "2", items: [shop] });
    await settle();
    expect(markAddressBookNameChecked).toHaveBeenCalledWith(shop, expect.any(Number), expect.anything());
    expect(upsertAddressBookEntry).not.toHaveBeenCalled();
    expect(isShown(dom.document.body.querySelector(".contact-name-check"))).toBe(false);
  });

  it.each([
    ["expired", "alice-shop.dusk has expired. Edit the contact before you send to it."],
    ["not_registered", "alice-shop.dusk isn't registered. Edit the contact before you send to it."],
    ["no_account", "alice-shop.dusk has no address to send to. Edit the contact before you send to it."],
    ["lookup_failed", null],
  ])("says so when an hour-old .dusk name no longer resolves (%s), not when the lookup failed", async (reason, text) => {
    lookupDuskName.mockImplementation((name) => {
      const result = { ok: false, name, reason };
      return { result, promise: Promise.resolve(result) };
    });
    const shop = { id: "2", name: "Shop", address: ACCOUNT, type: "account", duskName: "alice-shop.dusk", checkedAt: Date.now() - NAME_RECHECK_MS - 1 };
    mount({ view: "detail", detailId: "2", items: [shop] });
    await settle();
    const check = dom.document.body.querySelector(".contact-name-check");
    expect(isShown(check) ? visibleText(check) : null).toBe(text);
    expect(markAddressBookNameChecked).not.toHaveBeenCalled();
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
    expect(visibleText(dom.document.body.querySelector(".contact-hero"))).toBe("SShopalice-shop.dusk26FCH7…Tck927Public");
  });
});
