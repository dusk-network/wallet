import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearAddressBook } from "../shared/addressBook.js";
import { TX_KIND } from "../shared/constants.js";
import { truncateMiddle } from "./lib/strings.js";
import { installFakeDom, settle } from "./testing/fakeDom.js";
import { iconSvg } from "./components/ActionIcon.js";
import { addressBookView } from "./popup/views/addressbook.js";

vi.mock("../shared/addressBook.js", () => ({
  listAddressBook: vi.fn(async () => []),
  clearAddressBook: vi.fn(async () => {}),
  removeAddressBookEntry: vi.fn(async () => {}),
  upsertAddressBookEntry: vi.fn(async (entry) => entry),
}));

describe("address book contact detail view", () => {
  it("opens manage-mode contacts into detail with full address, actions, and filtered activity", async () => {
    const source = await readFile(
      path.resolve(process.cwd(), "src", "ui", "popup", "views", "addressbook.js"),
      "utf8"
    );
    const stateSource = await readFile(
      path.resolve(process.cwd(), "src", "ui", "popup", "state.js"),
      "utf8"
    );
    const css = await readFile(path.resolve(process.cwd(), "public", "ui.css"), "utf8");

    expect(stateSource).toContain('view: "list", // "list" | "detail" | "edit"');
    expect(source).toContain("const renderDetail = () =>");
    expect(source).toContain('ab.view = "detail"');
    expect(source).toContain("contactTxs(ov?.txs, addr)");
    expect(source).toContain("explorerAccountUrl(nodeUrl, addr)");
    expect(source).toContain('text: "History ↗"');
    expect(source).toContain('text: "Edit"');
    expect(source).toContain('text: "Send"');
    expect(source).toContain('state.txDetailFrom = "contacts"');
    expect(source).toContain("No local wallet activity for this contact.");
    expect(source).toContain("contact-address-line");
    expect(source).toContain("contact-detect-pill");
    expect(source).not.toContain("await startEdit(entry);");
    expect(css).toContain(".contact-detail-address code");
    expect(css).toContain(".contact-detect-pill");
    expect(css).toContain("align-self: flex-start");
    expect(css).toContain("overflow-wrap: anywhere");
  });
});

const ACCOUNT =
  "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927";
const ALICE = { id: "1", name: "Alice", address: ACCOUNT, type: "account" };

let dom;

beforeEach(() => {
  dom = installFakeDom();
  clearAddressBook.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Renders Contacts as the popup does, its list loaded with `items`.
function mount(addressBook = {}, ov = { txs: [] }) {
  const state = {
    route: "contacts",
    addressBook: { mode: "manage", view: "list", loaded: true, loading: false, items: [], ...addressBook },
  };
  const actions = { render: vi.fn(async () => {}), showToast: vi.fn() };
  dom.document.body.replaceChildren(...addressBookView(ov, { state, actions }));
  const buttons = () => dom.document.body.querySelectorAll("button").map((b) => b.textContent);
  return { state, actions, buttons };
}

describe("contacts", () => {
  it("searches under the title without a label of its own, and offers Delete all only with contacts", async () => {
    let view = mount();
    expect(dom.document.body.querySelectorAll("label")).toEqual([]);
    expect(dom.document.body.querySelector('input[type="search"]').getAttribute("aria-label")).toBe("Search contacts");
    expect(view.buttons()).toEqual(["← Back", "New contact"]);

    // With a contact, its row follows the buttons.
    view = mount({ items: [ALICE] });
    expect(view.buttons().slice(0, 3)).toEqual(["← Back", "Delete all", "New contact"]);
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    dom.document.body.querySelectorAll("button").find((b) => b.textContent === "Delete all").click();
    await settle();
    expect(confirm).toHaveBeenCalledWith("Delete all contacts?");
    expect(clearAddressBook).toHaveBeenCalledTimes(1);
    expect(view.actions.showToast).toHaveBeenCalledWith("Deleted all contacts");
  });

  it("shows a recent recipient as its address, with a labelled icon that saves it", () => {
    const view = mount(
      { mode: "pick", pickReturnRoute: "send" },
      { txs: [{ kind: TX_KIND.TRANSFER, to: ACCOUNT, hash: "ab".repeat(32) }] }
    );
    const row = dom.document.body.querySelector(".activity-item");
    expect(row.querySelector(".activity-main").textContent).toBe(truncateMiddle(ACCOUNT, 10, 8));
    expect(row.querySelector(".activity-sub")).toBeNull();

    const save = row.querySelector(".icon-only");
    expect([save.getAttribute("aria-label"), save.innerHTML, save.textContent]).toEqual([
      "Save to Contacts",
      iconSvg("plus"),
      "",
    ]);
    save.click();
    expect(view.state.addressBook).toMatchObject({ view: "edit", editAddress: ACCOUNT });
  });

  it("edits a contact with Save, Delete for a saved one, and Back to leave", () => {
    let view = mount({ view: "edit", editId: null, editReturnView: "list" });
    expect(view.buttons()).toEqual(["← Back", "Save"]);
    expect(dom.document.body.querySelectorAll("input").map((i) => i.getAttribute("placeholder"))).toEqual([
      "e.g. Alice",
      "Public account or shielded address",
    ]);

    view = mount({ view: "edit", editId: "1", editName: "Alice", editAddress: ACCOUNT, editReturnView: "detail" });
    expect(view.buttons()).toEqual(["← Back", "Delete", "Save"]);
    dom.document.body.querySelector(".subnav-back").click();
    expect(view.state.addressBook.view).toBe("detail");
  });
});
