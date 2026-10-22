import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installFakeDom, settle } from "../testing/fakeDom.js";
import { createAccountMenuController } from "./AccountMenu.js";

const ACCOUNTS = [
  "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927",
  "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz",
];

// Devnet: no name lookups, so the rows hold the profile and its account only.
const overview = {
  nodeUrl: "https://devnet.nodes.dusk.network",
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

describe("profile switcher", () => {
  it("gives each profile's row a copy button beside the row that selects it", () => {
    menu.open(anchor, overview);
    expect(rows()).toHaveLength(2);
    for (const [i, row] of rows().entries()) {
      const [select, copy] = row.children;
      expect(select.className).toContain("net-menu-item");
      expect(select.querySelector("button")).toBeNull();
      expect(copy.className).toBe("acct-menu-copy");
      expect(copy.title).toBe("Copy account");
      expect(copy.getAttribute("aria-label")).toBe(`Copy ${i ? "Spending" : "Profile 1"} account`);
    }
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
