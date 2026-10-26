import { readFile } from "node:fs/promises";
import path from "node:path";
import { createLensReader } from "@duskdomains/sdk/lens-reader";
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
vi.mock("@duskdomains/sdk/lens-reader", async (importOriginal) => ({
  ...(await importOriginal()),
  createLensReader: vi.fn(),
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
  vi.useRealTimers();
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
    note,
    shownNote: () => (isShown(note) ? note.textContent : ""),
    button,
    copy,
  };
}

describe("receive", () => {
  it("opens on the public account, first of the two tabs, as the web wallet does", async () => {
    const view = await receive(undefined, { state: {} });
    const tabs = dom.document.body.querySelector(".tabs").children;
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Public", "Shielded"]);
    expect(tabs.map((tab) => tab.classList.contains("is-active"))).toEqual([true, false]);
    // Screen readers hear which is picked.
    expect(dom.document.body.querySelector(".tabs").getAttribute("role")).toBe("tablist");
    expect(tabs.map((tab) => [tab.getAttribute("role"), tab.getAttribute("aria-selected")])).toEqual([
      ["tab", "true"],
      ["tab", "false"],
    ]);
    expect(view.state.receive.tab).toBe("public");
    expect(view.address.title).toBe(ACCOUNT);

    tabs[1].click();
    expect(view.state.receive.tab).toBe("shielded");
    const shielded = await receive(undefined, { state: view.state });
    expect(shielded.address.title).toBe(ADDRESS);
  });

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

  it("draws the copy buttons as SVG icons, centered in their buttons", async () => {
    lookupPrimaryName.mockResolvedValue("alice.dusk");
    await receive("public");
    const icons = ["Copy name", "Copy address"].map((label) => {
      const button = dom.document.body.querySelector(`button[aria-label="${label}"]`);
      return [button.innerHTML, button.textContent];
    });
    // No glyph text, which shows as an empty box without a font that has it.
    expect(icons).toEqual([
      [iconSvg("copy"), ""],
      [iconSvg("copy"), ""],
    ]);

    // The button centers the icon, the switcher's copy buttons too.
    const css = await readFile(path.resolve(process.cwd(), "public", "ui.css"), "utf8");
    expect(css).toMatch(/button\.acct-menu-copy,\s*button\.receive-copy \{\s*display: inline-grid;\s*place-items: center;\s*\}/);
  });

  it("says what the name reaches right under it, with no ⓘ to press", async () => {
    lookupPrimaryName.mockResolvedValue("alice.dusk");
    const view = await receive("public");
    expect(view.shownNote()).toBe(PUBLIC_NOTE);
    expect(dom.document.body.querySelector(".receive-info")).toBeNull();
    // It follows the fields it speaks of.
    const row = dom.document.body.querySelector(".row").children;
    expect(row.indexOf(view.note)).toBe(row.indexOf(view.addressField.parentNode) + 1);
  });

  it("names the shielded address only when the name's record is that address", async () => {
    // The account has a name, but its phoenix_payment_endpoint is not this address.
    lookupPrimaryName.mockResolvedValue("alice.dusk");
    let view = await receive("shielded", { state: { receive: { tab: "shielded" } } });
    expect(lookupShieldedName).toHaveBeenCalledWith(ACCOUNT, ADDRESS, { nodeUrl: overview.nodeUrl });
    expect([view.name(), view.shownNote()]).toEqual(["", ""]);
    expect(visibleText(view.address)).toBe("2Ana1p…RbFj4T");
    expect(await view.copy("Copy address")).toEqual([ADDRESS, "Copied address"]);

    lookupShieldedName.mockResolvedValue("alice.dusk");
    view = await receive("shielded");
    expect(view.name()).toBe("alice.dusk");
    expect(view.shownNote()).toBe(SHIELDED_NOTE);
    expect(await view.copy("Copy address")).toEqual([ADDRESS, "Copied address"]);
  });

  it("shows and copies no name once a lookup a minute on finds it cleared", async () => {
    // The real lookups, with the lens reader standing in for the node.
    const real = await vi.importActual("../shared/duskNames.js");
    lookupPrimaryName.mockImplementation(real.lookupPrimaryName);
    const verifyPrimary = vi.fn(async () => ({ primary: { spelling: "alice.dusk" } }));
    createLensReader.mockResolvedValue({ verifyPrimary });
    vi.useFakeTimers({ toFake: ["Date"] });

    let view = await receive("public");
    await vi.waitFor(() => expect(view.name()).toBe("alice.dusk"));

    // A minute on, the account has no primary name any more.
    vi.advanceTimersByTime(61_000);
    verifyPrimary.mockResolvedValue(null);
    view = await receive("public");
    await vi.waitFor(() => expect(verifyPrimary).toHaveBeenCalledTimes(2));
    await settle();
    expect([view.name(), view.shownNote()]).toEqual(["", ""]);
    expect(await view.copy("Copy name")).toEqual([undefined, undefined]);
  });

  it("shows the address alone without a name, and says when a copy fails", async () => {
    const view = await receive("public", { state: { receive: { tab: "public" } } });
    expect([view.name(), view.shownNote()]).toEqual(["", ""]);
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

  it("says no more than the QR, the fields and Request payment show", async () => {
    const state = { receive: { tab: "public", requestOpen: false, amountDusk: "", memo: "" } };
    await receive("public", { state });
    const body = dom.document.body;
    const summary = () => visibleText(body.querySelector("details.receive-request > summary"));

    // No note that Send reads the QR, no "Optional" beside Request payment or its labels:
    // the placeholders say both fields are optional.
    expect(visibleText(body)).not.toMatch(/Send can read|Optional|optional/);
    expect(summary()).toBe("Request payment");
    expect(body.querySelectorAll(".receive-request .advanced-body label").map((l) => l.textContent)).toEqual(["Amount", "Memo"]);
    expect(body.querySelectorAll(".receive-request .advanced-body input").map((i) => i.getAttribute("placeholder"))).toEqual([
      "Optional, e.g. 1.25 DUSK",
      "Optional",
    ]);
    expect(body.querySelector(".tabs").hasAttribute("title")).toBe(false);

    // Once the QR holds a request, Request payment says what it asks for.
    Object.assign(state.receive, { requestOpen: true, amountDusk: "1.5" });
    await receive("public", { state });
    expect(summary()).toBe("Request payment1.5 DUSK");
    Object.assign(state.receive, { amountDusk: "", memo: "Lunch" });
    await receive("public", { state });
    expect(summary()).toBe("Request paymentWith memo");
  });
});
