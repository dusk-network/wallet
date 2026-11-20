import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { lookupPrimaryName } from "../../shared/duskNames.js";
import { walletLabel } from "../../shared/wallets.js";
import { installFakeDom, settle, visibleText } from "../testing/fakeDom.js";
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

describe("profile switcher", () => {
  it("copies the row's account and says Copied on its button, without switching profile or closing", async () => {
    menu.open(anchor, overview);
    const copy = rows()[1].querySelector(".acct-menu-copy");
    copy.click();
    await settle();
    // That row's whole account, exactly, and nothing else.
    expect(dom.clipboard.writeText.mock.calls).toEqual([[ACCOUNTS[1]]]);
    // Said on the button, where the eye is, and not in a toast.
    expect(copy.hasAttribute("data-copied")).toBe(true);
    expect(onCopy).not.toHaveBeenCalled();
    expect(onSelectAccountIndex).not.toHaveBeenCalled();
    expect(menu.isOpen).toBe(true);
  });

  describe("with more than one wallet", () => {
    const OTHER = ["w2acct0LongEnoughToShortenAtTheEnd000000", "w2acct1LongEnoughToShortenAtTheEnd111111"];
    const two = {
      ...overview,
      wallets: [
        { key: "k2", n: 2, name: "Savings", walletId: OTHER[0], accounts: OTHER, accountNames: { 0: "Rainy day" }, active: false },
        { key: "k1", n: 1, name: "", walletId: ACCOUNTS[0], accounts: ACCOUNTS, accountNames: {}, active: true },
      ],
    };
    let onSelectWalletProfile;

    beforeEach(() => {
      onSelectWalletProfile = vi.fn();
      menu = createAccountMenuController({ onSelectAccountIndex, onSelectWalletProfile, onAddWallet: vi.fn(), onOpenOptions: vi.fn(), onCopy });
    });

    // A wallet's profiles in the menu, by the wallet's name over them.
    const profilesOf = (wallet) =>
      dom.document.body
        .querySelectorAll(".acct-menu [role=group]")
        .find((group) => visibleText(group.querySelector(".acct-menu-wallet-title")) === walletLabel(wallet))
        .querySelectorAll(".net-menu-item");

    it("switches to another wallet's profile, and picks the open one's by its wallet too", async () => {
      const [savings, open] = two.wallets;
      menu.open(anchor, two);
      profilesOf(savings)[1].click();
      await settle();
      expect(onSelectWalletProfile.mock.calls).toEqual([["k2", 1, { ov: two }]]);

      // Another window may have opened another wallet by the click: the row names its own.
      menu.open(anchor, two);
      profilesOf(open)[1].click();
      await settle();
      expect(onSelectWalletProfile.mock.calls).toEqual([
        ["k2", 1, { ov: two }],
        ["k1", 1, { ov: two }],
      ]);
      expect(onSelectAccountIndex).not.toHaveBeenCalled();
    });
  });
});
