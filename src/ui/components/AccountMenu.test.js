import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { lookupPrimaryName } from "../../shared/duskNames.js";
import { installFakeDom, isShown, screenReaderText, settle, visibleText } from "../testing/fakeDom.js";
import { iconSvg } from "./ActionIcon.js";
import { createAccountMenuController } from "./AccountMenu.js";

vi.mock("../../shared/duskNames.js", async (importOriginal) => ({
  ...(await importOriginal()),
  lookupPrimaryName: vi.fn(),
}));

const ACCOUNTS = [
  "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927",
  "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz",
];

const overview = {
  nodeUrl: "https://testnet.nodes.dusk.network",
  accounts: ACCOUNTS,
  accountCount: 2,
  selectedAccountIndex: 0,
  accountNames: { 1: "Spending" },
};

let dom;
let anchor;
let onSelectAccountIndex;
let onCopy;
let menu;

beforeEach(() => {
  dom = installFakeDom();
  lookupPrimaryName.mockReset();
  lookupPrimaryName.mockResolvedValue(null);
  anchor = dom.document.createElement("button");
  dom.document.body.appendChild(anchor);
  onSelectAccountIndex = vi.fn();
  onCopy = vi.fn();
  menu = createAccountMenuController({ onSelectAccountIndex, onOpenOptions: vi.fn(), onCopy });
});

afterEach(() => {
  menu.close();
  vi.unstubAllGlobals();
});

const rows = () => dom.document.body.querySelectorAll(".acct-menu .acct-menu-row");
// The lines a row shows, and their text.
const lines = (row) => row.querySelector(".net-menu-item-left").children.filter(isShown);
const shownLines = (row) => lines(row).map(visibleText);

describe("profile switcher", () => {
  it("gives each profile's row a copy button beside the row that selects it", () => {
    menu.open(anchor, overview);
    expect(rows()).toHaveLength(2);
    for (const row of rows()) {
      const [select, copy] = row.children;
      expect(select.className).toContain("net-menu-item");
      expect(select.querySelector("button")).toBeNull();
      expect(copy.className).toBe("acct-menu-copy");
      // An SVG icon rather than a glyph a font may lack, named for what it copies.
      expect([copy.innerHTML, copy.textContent, copy.title, copy.getAttribute("aria-label")]).toEqual([
        iconSvg("copy"),
        "",
        "Copy public account",
        "Copy public account",
      ]);
    }
  });

  it("shows two lines: the label, then the verified name or else the short account", async () => {
    lookupPrimaryName.mockImplementation(async (acct) => (acct === ACCOUNTS[0] ? "a-rather-long-name.dusk" : null));
    menu.open(anchor, overview);
    expect(lookupPrimaryName).toHaveBeenCalledWith(ACCOUNTS[0], { nodeUrl: overview.nodeUrl });
    // The short account shows until the lookup gives a name.
    expect(shownLines(rows()[0])).toEqual(["Profile 1", "26FCH7…Tck927"]);

    await settle();
    const [named, unnamed] = rows();
    expect(shownLines(named)).toEqual(["Profile 1", "a-rather-long-name.dusk"]);
    expect(lines(named)[1].title).toBe("a-rather-long-name.dusk");
    expect(screenReaderText(named.querySelector(".net-menu-item"))).not.toContain(ACCOUNTS[0]);

    expect(shownLines(unnamed)).toEqual(["Spending", "21n5nc…fMMLNz"]);
    expect(lines(unnamed)[1].querySelector("[title]").title).toBe(ACCOUNTS[1]);
    expect(screenReaderText(lines(unnamed)[1])).toBe(ACCOUNTS[1]);

    // A named row still copies its full account.
    named.querySelector(".acct-menu-copy").click();
    await settle();
    expect(dom.clipboard.writeText).toHaveBeenCalledWith(ACCOUNTS[0]);
  });

  it("copies the row's account, says so and closes, without switching profile", async () => {
    menu.open(anchor, overview);
    rows()[1].querySelector(".acct-menu-copy").click();
    await settle();
    expect(dom.clipboard.writeText).toHaveBeenCalledWith(ACCOUNTS[1]);
    expect(onCopy).toHaveBeenCalledWith("Copied account");
    expect(onSelectAccountIndex).not.toHaveBeenCalled();
    expect(menu.isOpen).toBe(false);
  });

  it("reports a failed copy", async () => {
    dom.clipboard.writeText.mockRejectedValueOnce(new Error("denied"));
    menu.open(anchor, overview);
    rows()[0].querySelector(".acct-menu-copy").click();
    await settle();
    expect(onCopy).toHaveBeenCalledWith("Copy failed");
  });

  it("still selects a profile from its row, and marks the chip open while it shows", async () => {
    menu.open(anchor, overview);
    expect(anchor.getAttribute("aria-expanded")).toBe("true");
    rows()[1].querySelector(".net-menu-item").click();
    await settle();
    expect(onSelectAccountIndex).toHaveBeenCalledWith(1, { ov: overview });
    expect(menu.isOpen).toBe(false);
    expect(anchor.getAttribute("aria-expanded")).toBe("false");
  });
});
