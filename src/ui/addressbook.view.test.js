import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NAME_HIDES } from "@dusk-network/app-core/names";
import { markAddressBookNameChecked, removeAddressBookEntry, upsertAddressBookEntry } from "../shared/addressBook.js";
import { duskNameErrorText, lookupDuskName } from "../shared/duskNames.js";
import { noteChainId } from "../shared/nodeNetwork.js";
import { TX_KIND } from "../shared/constants.js";
import { decodeBase58, encodeBase58 } from "@duskdomains/sdk";
import { HIDDEN_NAME_NOTE, HIDDEN_NAME_ROW, lookAlikeText } from "./lib/contactNames.js";
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
// That name, whole: not malice-shop.dusk.
const SHOP_NAMED = /(?<![\w.-])alice-shop\.dusk(?![\w-])/;

let dom;

beforeEach(() => {
  dom = installFakeDom();
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
  // The form's Save, by where it is rather than its words.
  const save = () => dom.document.body.querySelector(".contact-form .btn-primary");
  const field = (name) => dom.document.body.querySelectorAll("input").find((i) => accessibleName(i) === name);
  const error = (name) => {
    const id = field(name).getAttribute("aria-describedby");
    return id ? dom.document.getElementById(id).textContent : "";
  };
  return { state, save, field, error };
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
    const [contact, profile] = [lookAlikeText({ kind: "contact" }), lookAlikeText({ kind: "profile" })];
    for (const mode of ["manage", "pick"]) {
      mount({ items, mode });
      const rows = dom.document.body.querySelectorAll(".contact-row").map((row) => row.querySelectorAll(".row-sub").map((el) => el.textContent));
      expect(rows, mode).toEqual([
        [expect.stringContaining(shortAddress(ACCOUNT)), contact],
        // Its address, not its .dusk name, beside the name it looks like.
        [expect.stringContaining(shortAddress(ADDRESS)), contact],
        [expect.stringContaining(shortAddress(items[2].address)), contact],
        [expect.stringContaining(shortAddress(items[3].address))],
        [expect.stringContaining(shortAddress(items[4].address)), profile],
      ]);
    }
  });
});

describe("contacts", () => {
  it("saves a contact from a .dusk name, with the name and when it was checked", async () => {
    const view = mount({ view: "edit", editId: null, editReturnView: "list" });
    typeInto(view.field("Name"), "Shop");
    typeInto(view.field("Address"), "alice-shop.dusk");
    // Both addresses of the name, to pick from, as Send shows them.
    expect(dom.document.body.querySelectorAll("[role=radio]").length).toBe(2);
    dom.document.body.querySelectorAll("[role=radio]")[1].click();
    view.save().click();
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
    expect(view.error("Address")).not.toBe("");
    view.save().click();
    await settle();
    expect(view.error("Address")).not.toBe("");
    expect(upsertAddressBookEntry).not.toHaveBeenCalled();
  });

  it("won't save a contact named like a .dusk name it isn't saved from", async () => {
    const view = mount({ view: "edit", editId: null, editReturnView: "list" });
    typeInto(view.field("Address"), ACCOUNT);
    // Marek's: a .dusk name in small capitals, or after a fullwidth point, passed too; then after a middle dot.
    for (const name of ["alice.dusk", "ALICE.Dusk", " alice.dusk ", "alice.dusk.", "alice.\u1d05\u1d1c\ua731\u1d0b", "alice\uff0edusk", "alice\u00b7dusk", "alice\u3002dusk", "alice\u2022dusk"]) {
      typeInto(view.field("Name"), name);
      view.save().click();
      await settle();
      expect(view.error("Name"), name).not.toBe("");
    }
    expect(upsertAddressBookEntry).not.toHaveBeenCalled();
  });

  it("won't save an address under a second name, and says which it has", async () => {
    const view = mount({ view: "edit", editId: null, editReturnView: "list", items: [{ id: "2", name: "Shop", address: ACCOUNT, type: "account" }] });
    typeInto(view.field("Name"), "Spaarpotje");
    typeInto(view.field("Address"), ACCOUNT);
    view.save().click();
    await settle();
    expect(view.error("Address")).toMatch(/\bShop\b/);
    expect(upsertAddressBookEntry).not.toHaveBeenCalled();
  });

  it("joins up an address that a chat app broke with spaces", async () => {
    const view = mount({ view: "edit", editId: null, editReturnView: "list" });
    typeInto(view.field("Name"), "Shop");
    typeInto(view.field("Address"), `${ACCOUNT.slice(0, 50)} ${ACCOUNT.slice(50)}`);
    view.save().click();
    await settle();
    expect(upsertAddressBookEntry).toHaveBeenCalledWith(expect.objectContaining({ address: ACCOUNT }), expect.anything());
  });

  it("says under the field what can't be saved: no name, an unknown name, this profile's own account", async () => {
    const view = mount({ view: "edit", editId: null, editReturnView: "list" });
    view.save().click();
    await settle();
    expect(view.error("Name")).not.toBe("");

    typeInto(view.field("Name"), "Typo");
    typeInto(view.field("Address"), "alcie-shop.dusk");
    expect(view.error("Address")).toContain(duskNameErrorText({ name: "alcie-shop.dusk", reason: "not_registered" }));
    view.save().click();
    await settle();
    expect(upsertAddressBookEntry).not.toHaveBeenCalled();

    typeInto(view.field("Address"), OWN);
    view.save().click();
    await settle();
    expect(view.error("Address")).not.toBe("");
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
    // A note that names each of `values`, whatever its words: whose name it is, and that one's address. Each whole,
    // no letter or digit on either side: Profile 1 isn't Profile 12, nor Alice Alicia.
    const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const naming = (...values) =>
      expect.stringMatching(new RegExp(values.map((value) => `(?=[\\s\\S]*(?<![\\p{L}\\p{N}])${escaped(value)}(?![\\p{L}\\p{N}]))`).join(""), "u"));
    // Yes, save it, under a name's question at Save.
    const yes = () => dom.document.body.querySelectorAll(".contact-note__yes").find(isShown);
    const edit = (over = {}, ov) => mount({ view: "edit", editId: null, editReturnView: "list", loaded: true, items: [ALICE, { id: "2", name: "Estudio Marta", address: ADDRESS, type: "address" }], ...over }, ov);

    it("asks about a name in use, with the address it has, and saves it only once that's answered", async () => {
      const view = edit();
      const name = view.field("Name");
      expect(shownNote()).toEqual([]);
      for (const typed of ["Estudio Marta", "  estudio   marta ", "Estudió Marta"]) {
        typeInto(name, typed);
        expect(shownNote()).toEqual([naming("Estudio Marta", shortAddress(ADDRESS))]);
      }
      // A name it starts as, word for word, is asked about too; another name isn't.
      typeInto(name, "Estudio Marta 2");
      expect(shownNote()).toEqual([naming("Estudio Marta", shortAddress(ADDRESS))]);
      typeInto(name, "Estudio Pablo");
      expect(shownNote()).toEqual([]);

      typeInto(name, "Alice");
      typeInto(view.field("Address"), BOB);
      expect(shownNote()).toEqual([naming("Alice", shortAddress(ACCOUNT))]);
      expect(yes()).toBeUndefined();
      // A question, not a refusal: two people can have one name. Saved once it's answered.
      view.save().click();
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
      view.save().click();
      await settle();
      expect(shownNote()).toEqual([naming("Lucas (petit-fils)", shortAddress(ADDRESS))]);
      expect(upsertAddressBookEntry).not.toHaveBeenCalled();
      // Changed after the question: the question goes, and Yes is for none.
      typeInto(view.field("Name"), "Lucas Martin");
      expect([shownNote(), yes()]).toEqual([[], undefined]);
      view.save().click();
      await settle();
      expect(upsertAddressBookEntry).toHaveBeenCalledWith(expect.objectContaining({ name: "Lucas Martin", address: BOB }), expect.anything());
    });

    it("asks about a name that looks like another contact's in other letters, and saves it once that's answered", async () => {
      const view = edit();
      const name = view.field("Name");
      const alike = naming("Alice", shortAddress(ACCOUNT));
      // Cyrillic А and е, Greek Α, a capital I for the l, and a 1.
      for (const typed of ["\u0410lice", "Alic\u0435", "\u0391LICE", "AIice", "A1ice"]) {
        typeInto(name, typed);
        expect(shownNote(), typed).toEqual([alike]);
      }
      for (const typed of ["Alicia", "Bob", "Estudio Marta"]) {
        typeInto(name, typed);
        expect(shownNote()).not.toContainEqual(alike);
      }
      typeInto(name, "\u0410lice");
      typeInto(view.field("Address"), BOB);
      view.save().click();
      await settle();
      expect(upsertAddressBookEntry).not.toHaveBeenCalled();
      yes().click();
      await settle();
      expect(upsertAddressBookEntry).toHaveBeenCalledWith(expect.objectContaining({ name: "\u0410lice", address: BOB }), expect.anything());
    });

    // Marek's: Dav1d (a digit 1) and Wendv (a v for the y) went by beside David and Wendy.
    it("asks about a name with a digit for a letter, or a v for a y, as it asks of other look-alikes", () => {
      const view = edit({ items: [{ id: "d", name: "David", address: ACCOUNT, type: "account" }, { id: "w", name: "Wendy", address: ADDRESS, type: "address" }] });
      const name = view.field("Name");
      typeInto(name, "Dav1d");
      expect(shownNote()).toEqual([naming("David", shortAddress(ACCOUNT))]);
      typeInto(name, "Wendv");
      expect(shownNote()).toEqual([naming("Wendy", shortAddress(ADDRESS))]);
      typeInto(name, "Davina");
      expect(shownNote()).toEqual([]);
    });

    // Marek's, the round after: "Davld" (a small L for the i) and "Dav!d" were saved silently beside David.
    it("asks about a name with an l, a 1, a ! or a | for an i, as it asks of other look-alikes", () => {
      const view = edit({ items: [{ id: "d", name: "David", address: ACCOUNT, type: "account" }] });
      const name = view.field("Name");
      for (const typed of ["Davld", "Dav!d", "Dav|d", "DAV!D"]) {
        typeInto(name, typed);
        expect(shownNote(), typed).toEqual([naming("David", shortAddress(ACCOUNT))]);
      }
    });

    it("refuses a name with hidden characters, as it's typed and on Save", async () => {
      // Marek's: an override at the start reads as "Profile 2" and "Alice", and a space that takes no room.
      const view = edit();
      const name = view.field("Name");
      for (const typed of ["\u202e2 eliforP", "\u202eecilA", "Ali\u200bce"]) {
        typeInto(name, typed);
        expect(view.error("Name"), typed).toBe(NAME_HIDES);
        expect(shownNote(), typed).toEqual([]);
      }
      typeInto(view.field("Address"), BOB);
      view.save().click();
      await settle();
      expect(view.error("Name")).toBe(NAME_HIDES);
      expect(upsertAddressBookEntry).not.toHaveBeenCalled();

      typeInto(name, "Alicia");
      expect(view.error("Name")).toBe("");
      view.save().click();
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
      expect(shownNote()).toEqual([naming("Savings")]);
      typeInto(view.field("Address"), ADDRESS_SECOND);
      expect(shownNote()).toEqual([naming("Savings")]);
      typeInto(view.field("Address"), CAROL);
      expect(shownNote()).toEqual([naming("Wallet 2", "Profile 1")]);
      view.save().click();
      await settle();
      expect(upsertAddressBookEntry).toHaveBeenCalledWith(expect.objectContaining({ name: "Rainy day", address: CAROL }), expect.anything());
    });

    it("won't save a contact named like a profile of yours, as Review would read it as that profile, but for that profile's own address", async () => {
      // Marek's: "Profile 2" with someone else's address read "To Profile 2" on Review, as his own did.
      const ov = { nodeUrl: NODE, accounts: [OWN, BOB], addresses: [ADDRESS_OWN, ADDRESS_SECOND], selectedAccountIndex: 0, txs: [] };
      const view = edit({}, ov);
      typeInto(view.field("Address"), CAROL);
      typeInto(view.field("Name"), "Profile 2");
      expect(view.error("Name")).toMatch(/\bProfile 2\b/);
      typeInto(view.field("Name"), "ProfiIe  2");
      expect(view.error("Name")).toMatch(/\bProfile 2\b/);
      view.save().click();
      await settle();
      expect(upsertAddressBookEntry).not.toHaveBeenCalled();

      // Profile 2's own account may be saved by its name.
      typeInto(view.field("Name"), "Profile 2");
      typeInto(view.field("Address"), BOB);
      expect(view.error("Name")).toBe("");
      view.save().click();
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
        expect([view.error("Name"), shownNote()], typed).toEqual(["", [naming("Lucas")]]);
      }
      // Not a whole word of it: nothing to ask.
      typeInto(view.field("Name"), "Lucastor");
      expect(shownNote()).toEqual([]);
      typeInto(view.field("Name"), "Lucas (petit-fils)");
      view.save().click();
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
      expect(view.error("Address")).not.toBe("");
      typeInto(view.field("Address"), ADDRESS_OWN);
      expect(view.error("Address")).not.toBe("");
      view.save().click();
      await settle();
      expect(upsertAddressBookEntry).not.toHaveBeenCalled();
    });

    it("says it of an address a .dusk name points to", async () => {
      const ov = { nodeUrl: NODE, accounts: [OWN, ACCOUNT], addresses: [ADDRESS_OWN], selectedAccountIndex: 0, accountNames: { 1: "Savings" }, txs: [] };
      const view = edit({}, ov);
      typeInto(view.field("Name"), "Shop");
      typeInto(view.field("Address"), "alice-shop.dusk");
      await settle();
      expect(shownNote()).toEqual([naming("Savings")]);
    });
  });

  it("shows a contact saved with hidden characters by their codes, says so, and lets it be deleted", async () => {
    // Marek's, saved before such names were refused: it read as "Alice", over a stranger's address.
    const stranger = { id: "9", name: "\u202eecilA", address: ADDRESS, type: "address" };
    const view = mount({ items: [ALICE, stranger] });
    const [, row] = dom.document.body.querySelectorAll(".contact-row");
    expect(row.querySelector(".row-title").textContent).toBe("\\u202eecilA");
    expect(row.querySelectorAll(".row-sub").map((el) => el.textContent)).toEqual([expect.stringContaining(shortAddress(ADDRESS)), HIDDEN_NAME_ROW]);
    expect(visibleText(dom.document.body)).not.toContain("\u202e");

    row.click();
    expect(dom.document.body.querySelector(".tx-hero-name").textContent).toBe("\\u202eecilA");
    expect(visibleText(dom.document.body.querySelector(".contact-hidden-name"))).toBe(HIDDEN_NAME_NOTE);
    expect(visibleText(dom.document.body)).not.toContain("\u202e");

    // Edit, beside Send: the name refused as it is. Then Delete.
    dom.document.body.querySelector(".contact-actions .btn-outline").click();
    expect(view.error("Name")).toBe(NAME_HIDES);
    vi.stubGlobal("confirm", () => true);
    removeAddressBookEntry.mockClear();
    dom.document.body.querySelector(".contacts-delete").click();
    await settle();
    expect(removeAddressBookEntry).toHaveBeenCalledWith("9", expect.anything());
  });

  it("says an address is saved already by its contact's name, hidden characters as codes", async () => {
    const view = mount({ view: "edit", editId: null, items: [{ id: "9", name: "\u202eecilA", address: ACCOUNT, type: "account" }] });
    typeInto(view.field("Name"), "Alice");
    typeInto(view.field("Address"), ACCOUNT);
    view.save().click();
    await settle();
    expect(view.error("Address")).toContain("\\u202eecilA");
    expect(view.error("Address")).not.toContain("\u202e");
  });

  it("lists the token approvals that let the contact spend, in its Activity, and one taken back as a revoke", () => {
    const approval = {
      hash: "ef".repeat(32),
      kind: TX_KIND.CONTRACT_CALL,
      status: "executed",
      submittedAt: 3,
      profileIndex: 0,
      asset: { type: "DRC20", op: "approve", symbol: "TKN", decimals: 0, valueUnits: "5", spender: ACCOUNT },
    };
    // One that lets another spend, not Alice's; and Alice's allowance taken back, an approval of 0.
    const other = { ...approval, hash: "aa".repeat(32), asset: { ...approval.asset, spender: OWN } };
    const revoke = { ...approval, hash: "bb".repeat(32), submittedAt: 4, asset: { ...approval.asset, valueUnits: "0" } };
    mount({ view: "detail", detailId: "1", items: [ALICE] }, { nodeUrl: NODE, accounts: [OWN], selectedAccountIndex: 0, txs: [approval, other, revoke] });
    const rows = dom.document.body.querySelectorAll(".contact-detail .tx-row").map((row) => ({
      name: visibleText(row.querySelector(".tx-name")),
      amount: visibleText(row.querySelector(".tx-amount")),
      kind: visibleText(row.querySelector(".tx-sub")),
    }));
    // Alice's two, under her name, each with what it allows her: 5 TKN, and none.
    expect(rows.map(({ name, amount }) => [name, amount]).sort()).toEqual([
      ["Alice", "0 TKN"],
      ["Alice", "5 TKN"],
    ]);
    // What she may spend said as an approval, and the one taken back as a revoke, each refusing the other's word.
    const granted = rows.find((row) => row.amount === "5 TKN").kind;
    const revoked = rows.find((row) => row.amount === "0 TKN").kind;
    expect(granted).toMatch(/approv/i);
    expect(granted).not.toMatch(/revok/i);
    expect(revoked).toMatch(/revok/i);
    expect(revoked).not.toMatch(/approv/i);
  });

  it("saves, checks and deletes a contact for the wallet the page was drawn for", async () => {
    const shown = { walletId: OWN };
    const view = mount({ view: "edit", editId: null, editReturnView: "list" }, { isUnlocked: true, nodeUrl: NODE, accounts: [OWN], selectedAccountIndex: 0, txs: [] });
    typeInto(view.field("Name"), "Shop");
    typeInto(view.field("Address"), ADDRESS);
    view.save().click();
    await settle();
    expect(upsertAddressBookEntry).toHaveBeenCalledWith(expect.objectContaining({ name: "Shop", address: ADDRESS }), shown);
  });

  describe("a name read through a node the wallet doesn't know", () => {
    const CUSTOM = "https://my-node.example:8443";
    // Whose word it is: the node it was read through, whole (not my-node.example:84430).
    const NODE_SAID = /(?<![\w.-])my-node\.example:8443(?!\d)/;
    const onCustom = { nodeUrl: CUSTOM, accounts: [OWN], selectedAccountIndex: 0, txs: [] };
    const notes = () => dom.document.body.querySelectorAll('[role="note"]').map(visibleText);

    beforeEach(() => noteChainId(CUSTOM, 2));
    afterEach(() => noteChainId(CUSTOM, null));

    it("says whose word it is on the contact form, and leaves it due for a check", async () => {
      const view = mount({ view: "edit" }, onCustom);
      typeInto(view.field("Name"), "Shop");
      typeInto(view.field("Address"), "alice-shop.dusk");
      await settle();
      expect(notes()).toContainEqual(expect.stringMatching(NODE_SAID));
      view.save().click();
      await settle();
      expect(upsertAddressBookEntry).toHaveBeenCalledWith(expect.objectContaining({ duskName: "alice-shop.dusk", checkedAt: 0 }), expect.anything());
    });

    it("says nothing on a network's own node, where saving counts as a check", async () => {
      const view = mount({ view: "edit" });
      typeInto(view.field("Name"), "Shop");
      typeInto(view.field("Address"), "alice-shop.dusk");
      await settle();
      expect(notes()).toEqual([]);
      view.save().click();
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
      const check = visibleText(dom.document.body.querySelector(".contact-name-check"));
      expect(check).toMatch(SHOP_NAMED);
      expect(check).toMatch(NODE_SAID);
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
    ["expired", true],
    ["not_registered", true],
    ["no_account", true],
    ["lookup_failed", false],
  ])("says so when an hour-old .dusk name no longer resolves (%s), not when the lookup failed", async (reason, says) => {
    lookupDuskName.mockImplementation((name) => {
      const result = { ok: false, name, reason };
      return { result, promise: Promise.resolve(result) };
    });
    const shop = { id: "2", name: "Shop", address: ACCOUNT, type: "account", duskName: "alice-shop.dusk", checkedAt: Date.now() - NAME_RECHECK_MS - 1 };
    mount({ view: "detail", detailId: "2", items: [shop] });
    await settle();
    const check = dom.document.body.querySelector(".contact-name-check");
    // Why, as a lookup's answer is said anywhere.
    expect(isShown(check) ? visibleText(check) : null).toEqual(says ? expect.stringContaining(duskNameErrorText({ name: "alice-shop.dusk", reason })) : null);
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
    expect(visibleText(dom.document.body.querySelector(".contact-name-check"))).toMatch(SHOP_NAMED);
    // The contact as saved, each in its place: its name, its .dusk name, and the address it has, not the one the
    // name points to now, as shown (short, as the page shows it) and as its Copy gives it, whole.
    const hero = dom.document.body.querySelector(".contact-hero");
    expect([hero.querySelector(".tx-hero-name").textContent, hero.querySelector(".tx-hero-lead").textContent, hero.querySelector(".tx-hero-addr .mono").textContent]).toEqual([
      "Shop",
      "alice-shop.dusk",
      shortAddress(ACCOUNT),
    ]);
    hero.querySelector(".tx-hero-addr button").click();
    await settle();
    expect(dom.clipboard.writeText).toHaveBeenLastCalledWith(ACCOUNT);
  });
});

// Round 40's review: from Review, Save to Contacts under another address than the payment's kept what a link put in,
// its amount and memo, and went straight back to Review and Confirm.
describe("a contact saved from Review", () => {
  const saveAs = async (draft, address) => {
    const view = mount({ mode: "pick", fromRoute: "confirm", pickReturnRoute: "confirm", view: "edit", editId: null, prefillAddress: ACCOUNT, editAddress: ACCOUNT });
    view.state.draft = { ...draft };
    typeInto(view.field("Name"), "Landlord");
    typeInto(view.field("Address"), address);
    view.save().click();
    await settle();
    const { route, draft: d } = view.state;
    return [route, d.to, d.amountDusk, d.amountLux, d.memo, d.filledIn ?? ""];
  };

  it("under another address than a link's goes back to Send, without what the link put in", async () => {
    const link = { to: ACCOUNT, privacy: "public", amountLux: "150000000", amountDusk: "0.15", memo: "r40 link", filledFrom: "link", filledIn: "link", carried: ["amount", "memo"], carriedTo: ACCOUNT };
    expect(await saveAs(link, ACCOUNT)).toEqual(["confirm", ACCOUNT, "0.15", "150000000", "r40 link", "link"]);
    expect(await saveAs(link, ADDRESS)).toEqual(["send", ADDRESS, "", undefined, "", ""]);
    // What the person typed is theirs, for whichever recipient: Review, for the address saved.
    const typed = { to: ACCOUNT, privacy: "public", amountLux: "150000000", amountDusk: "0.15", memo: "rent" };
    expect(await saveAs(typed, ADDRESS)).toEqual(["confirm", ADDRESS, "0.15", "150000000", "rent", ""]);
  });
});
