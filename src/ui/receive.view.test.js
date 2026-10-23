import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { lookupPrimaryName, lookupShieldedName } from "../shared/duskNames.js";
import { iconSvg } from "./components/ActionIcon.js";
import { installFakeDom, isShown, screenReaderText, settle, visibleText } from "./testing/fakeDom.js";
import { receiveView } from "./popup/views/receive.js";

vi.mock("../shared/duskNames.js", async (importOriginal) => ({
  ...(await importOriginal()),
  lookupPrimaryName: vi.fn(),
  lookupShieldedName: vi.fn(),
}));

const ACCOUNT =
  "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927";
const ADDRESS =
  "2Ana1pUpv2ZbMVkwF5FXapYeBEjdxDatLn7nvJkhgTSXbs59SyZSx866bXirPgj8QQVB57uxHJBG1YFvkRbFj4T";

const overview = {
  nodeUrl: "https://testnet.nodes.dusk.network",
  accounts: [ACCOUNT],
  addresses: [ADDRESS],
  selectedAccountIndex: 0,
};

const PUBLIC_NOTE = "People who send to alice.dusk reach this public account.";
const SHIELDED_NOTE =
  "People who pay alice.dusk choose public or shielded. Anyone can see this address belongs to alice.dusk.";

let dom;

beforeEach(() => {
  dom = installFakeDom();
  lookupPrimaryName.mockReset();
  lookupShieldedName.mockReset();
  lookupPrimaryName.mockResolvedValue(null);
  lookupShieldedName.mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Renders Receive as the popup does, and finds the parts the tests read.
async function receive(tab, { state = { receive: { tab } }, ov = overview } = {}) {
  const actions = { render: vi.fn(async () => {}), showToast: vi.fn() };
  dom.document.body.replaceChildren(...receiveView(ov, { state, actions }));
  await settle();
  const $ = (selector) => dom.document.body.querySelector(selector);
  const [nameField, addressField] = dom.document.body.querySelectorAll(".receive-fields > .receive-field");
  const note = $(".receive-name-note");
  const button = (text) => dom.document.body.querySelectorAll("button").find((b) => b.textContent === text);
  // Clicks the copy button labelled `label`; what it copied and the toast.
  const copy = async (label) => {
    dom.clipboard.writeText.mockClear();
    $(`button[aria-label="${label}"]`).click();
    await settle();
    return [dom.clipboard.writeText.mock.calls.at(-1)?.[0], actions.showToast.mock.calls.at(-1)?.[0]];
  };
  return {
    state,
    nameField,
    addressField,
    name: () => (isShown(nameField) ? visibleText(nameField.querySelector(".receive-field__name")) : ""),
    address: addressField.querySelector(".receive-field__address"),
    info: $(".receive-info"),
    note,
    shownNote: () => (isShown(note) ? note.textContent : ""),
    button,
    copy,
  };
}

describe("receive", () => {
  it("shows the name and the short account under the QR, each copying its own", async () => {
    lookupPrimaryName.mockResolvedValue("alice.dusk");
    const view = await receive("public");
    const row = dom.document.body.querySelector(".row").children;
    const fields = view.addressField.parentNode;
    expect(row.indexOf(fields)).toBe(row.indexOf(dom.document.body.querySelector(".receive-qr-card")) + 1);

    expect(view.name()).toBe("alice.dusk");
    expect(view.nameField.querySelector(".receive-field__name").title).toBe("alice.dusk");
    expect(visibleText(view.address)).toBe("26FCH7…Tck927");
    expect([view.address.title, screenReaderText(view.address)]).toEqual([ACCOUNT, ACCOUNT]);

    expect(await view.copy("Copy name")).toEqual(["alice.dusk", "Copied name"]);
    expect(await view.copy("Copy address")).toEqual([ACCOUNT, "Copied account"]);

    // No big copy button: the fields copy, the row below downloads the QR.
    for (const text of ["Copy account", "Copy address"]) expect(view.button(text)).toBeUndefined();
    expect(dom.document.body.querySelector(".btn-primary")).toBeNull();
    expect(dom.document.body.querySelector(".btnrow").children.map((b) => b.textContent)).toEqual(["Download QR PNG"]);
  });

  it("draws the ⓘ and the copy buttons as SVG icons, centered in their buttons", async () => {
    lookupPrimaryName.mockResolvedValue("alice.dusk");
    await receive("public");
    const icons = ["About alice.dusk", "Copy name", "Copy address"].map((label) => {
      const button = dom.document.body.querySelector(`button[aria-label="${label}"]`);
      return [button.innerHTML, button.textContent];
    });
    // No glyph text, which shows as an empty box without a font that has it.
    expect(icons).toEqual([
      [iconSvg("info"), ""],
      [iconSvg("copy"), ""],
      [iconSvg("copy"), ""],
    ]);
    expect(iconSvg("info")).toMatch(/^<svg viewBox="0 0 24 24" aria-hidden="true"><circle /);

    // The button centers the icon and gives it its colour, the switcher's copy buttons too.
    const css = await readFile(path.resolve(process.cwd(), "public", "ui.css"), "utf8");
    const buttons = String.raw`button\.acct-menu-copy,\s*button\.receive-copy,\s*button\.receive-info`;
    expect(css).toMatch(new RegExp(`${buttons} \\{\\s*display: inline-grid;\\s*place-items: center;\\s*\\}`));
    expect(css).toMatch(/button\.receive-info svg \{\s*width: 16px;\s*height: 16px;\s*fill: none;\s*stroke: currentColor;/);
  });

  it("keeps what the name reaches behind the ⓘ, open across redraws", async () => {
    lookupPrimaryName.mockResolvedValue("alice.dusk");
    const view = await receive("public");
    expect(view.shownNote()).toBe("");
    expect(view.info.getAttribute("type")).toBe("button");
    expect(view.info.getAttribute("aria-label")).toBe("About alice.dusk");
    expect(view.info.getAttribute("aria-expanded")).toBe("false");
    expect(dom.document.getElementById(view.info.getAttribute("aria-controls"))).toBe(view.note);

    view.info.click();
    expect(view.shownNote()).toBe(PUBLIC_NOTE);
    expect(view.info.getAttribute("aria-expanded")).toBe("true");

    // A redraw, such as the copy toast's, keeps it open; a second press closes it.
    const again = await receive("public", { state: view.state });
    expect(again.shownNote()).toBe(PUBLIC_NOTE);
    again.info.click();
    expect(again.shownNote()).toBe("");
    expect(again.info.getAttribute("aria-expanded")).toBe("false");
  });

  it("names the shielded address only when the name's record is that address", async () => {
    // The account has a name, but its phoenix_payment_endpoint is not this address.
    lookupPrimaryName.mockResolvedValue("alice.dusk");
    let view = await receive("shielded", { state: { receive: { tab: "shielded", infoOpen: true } } });
    expect(lookupShieldedName).toHaveBeenCalledWith(ACCOUNT, ADDRESS, { nodeUrl: overview.nodeUrl });
    expect([view.name(), isShown(view.info), view.shownNote()]).toEqual(["", false, ""]);
    expect(visibleText(view.address)).toBe("2Ana1p…RbFj4T");
    expect(await view.copy("Copy address")).toEqual([ADDRESS, "Copied address"]);

    lookupShieldedName.mockResolvedValue("alice.dusk");
    view = await receive("shielded");
    expect(view.name()).toBe("alice.dusk");
    view.info.click();
    expect(view.shownNote()).toBe(SHIELDED_NOTE);
    expect(await view.copy("Copy address")).toEqual([ADDRESS, "Copied address"]);
  });

  it("shows the address alone without a name, and says when a copy fails", async () => {
    const view = await receive("public", { state: { receive: { tab: "public", infoOpen: true } } });
    expect([view.name(), isShown(view.info), view.shownNote()]).toEqual(["", false, ""]);
    expect(isShown(view.addressField)).toBe(true);

    dom.clipboard.writeText.mockRejectedValueOnce(new Error("denied"));
    expect((await view.copy("Copy address"))[1]).toBe("Copy failed");

    // Nothing to show or copy without an account.
    const empty = await receive("public", { ov: { ...overview, accounts: [] } });
    expect(visibleText(empty.address)).toBe("—");
    expect(dom.document.body.querySelector('button[aria-label="Copy address"]').disabled).toBe(true);
  });

  it("copies the request link from Request payment once the QR holds a request", async () => {
    const state = { receive: { tab: "public", requestOpen: true, amountDusk: "", memo: "" } };
    let view = await receive("public", { state });
    expect(view.button("Copy request link").disabled).toBe(true);

    state.receive.amountDusk = "1.5";
    view = await receive("public", { state });
    expect(view.button("Copy request link").disabled).toBe(false);
    view.button("Copy request link").click();
    await settle();
    const [link] = dom.clipboard.writeText.mock.calls.at(-1);
    expect(link).toMatch(/^dusk:/);
    expect(link).toContain(ACCOUNT);
  });
});
