import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TX_KIND } from "../shared/constants.js";
// The fake DOM goes before the views: it defines HTMLElement for the gas editor.
import { accessibleName, fieldNames, installFakeDom, settle, typeInto, visibleText } from "./testing/fakeDom.js";
import { addressBookView } from "./popup/views/addressbook.js";
import { assetAddNftView, assetAddTokenView, assetsOwner, assetTokenView } from "./popup/views/assets.js";
import { convertFormView } from "./popup/views/convert.js";
import { lockedView } from "./popup/views/locked.js";
import {
  onboardingCreateConfirmView,
  onboardingCreatePasswordView,
  onboardingImportView,
} from "./popup/views/onboarding.js";
import { optionsView } from "./popup/views/options.js";
import { receiveView } from "./popup/views/receive.js";
import { sendConfirmView, sendFormView } from "./popup/views/send.js";
import { stakeFormView } from "./popup/views/stake.js";

vi.mock("../shared/duskNames.js", async (importOriginal) => ({
  ...(await importOriginal()),
  lookupPrimaryName: vi.fn(async () => null),
  lookupShieldedName: vi.fn(async () => null),
}));
vi.mock("../shared/addressBook.js", () => ({
  listAddressBook: vi.fn(async () => []),
  clearAddressBook: vi.fn(async () => {}),
  removeAddressBookEntry: vi.fn(async () => {}),
  upsertAddressBookEntry: vi.fn(async (entry) => entry),
}));
vi.mock("../shared/accountNames.js", () => ({ setAccountName: vi.fn(async () => {}) }));

const ACCOUNT =
  "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927";
const ADDRESS =
  "2Ana1pUpv2ZbMVkwF5FXapYeBEjdxDatLn7nvJkhgTSXbs59SyZSx866bXirPgj8QQVB57uxHJBG1YFvkRbFj4T";
const TOKEN = `0x${"cd".repeat(32)}`;
const NODE = "https://testnet.nodes.dusk.network";
const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const ov = {
  hasVault: true,
  isUnlocked: true,
  nodeUrl: NODE,
  accounts: [ACCOUNT, ACCOUNT.replace("26", "27")],
  addresses: [ADDRESS],
  accountCount: 2,
  selectedAccountIndex: 0,
  balance: { value: "177986500000" },
  shieldedBalance: { value: "25000000000", spendable: "25000000000" },
  txs: [],
};

let dom;

beforeEach(() => {
  dom = installFakeDom();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Draws `nodes` as the popup does; the fields' names are what screen readers say.
async function show(nodes) {
  dom.document.body.replaceChildren(...nodes);
  await settle();
  return dom.document.body;
}

const actions = () => ({ send: vi.fn(async () => ({})), render: vi.fn(async () => {}), showToast: vi.fn() });

// Every field is named by the label it shows, not by its short placeholder.
describe("field labels", () => {
  it("name Send's fields, and Review's gas fields under Edit", async () => {
    const state = { route: "send", draft: null, addressBook: { loaded: true, items: [] } };
    let body = await show(sendFormView(ov, { state, actions: actions() }));
    expect(fieldNames(body)).toEqual(["To", "Amount", "Memo"]);

    typeInto(body.querySelector(".to-input-wrap input"), ACCOUNT);
    expect(fieldNames(body)).toEqual(["To", "Amount", "Memo"]);

    // Review's gas fields wait under Custom fee, closed.
    state.route = "confirm";
    state.draft = { to: ACCOUNT, privacy: "public", amountDusk: "1", amountLux: "1000000000", memo: "" };
    body = await show(sendConfirmView(ov, { state, actions: actions() }));
    expect(body.querySelector("details.gas-custom").open).toBe(false);
    expect(fieldNames(body.querySelector("details.gas-custom"))).toEqual(["Gas limit", "Gas price (LUX)"]);
  });

  it("name Shield's and Receive's fields", async () => {
    let body = await show(convertFormView(ov, { state: { route: "convert", draft: { kind: TX_KIND.SHIELD } }, actions: actions() }));
    expect(fieldNames(body)).toEqual(["Amount"]);

    const state = { receive: { tab: "public", requestOpen: true, amountDusk: "", memo: "" } };
    body = await show(receiveView(ov, { state, actions: actions() }));
    expect(fieldNames(body)).toEqual(["Amount", "Memo"]);
  });

  it("name Contacts' search and the contact form's fields", async () => {
    const addressBook = { mode: "manage", view: "list", loaded: true, loading: false, items: [] };
    let body = await show(addressBookView(ov, { state: { route: "contacts", addressBook }, actions: actions() }));
    expect(fieldNames(body)).toEqual(["Search contacts"]);

    body = await show(
      addressBookView(ov, { state: { route: "contacts", addressBook: { ...addressBook, view: "edit" } }, actions: actions() })
    );
    expect(fieldNames(body)).toEqual(["Name", "Address"]);
  });

  it("name the fields that add a token or an NFT, and a token's send and approve fields", async () => {
    let body = await show(assetAddTokenView(ov, { state: {}, actions: actions() }));
    expect(fieldNames(body)).toEqual(["Contract ID"]);

    body = await show(assetAddNftView(ov, { state: {}, actions: actions() }));
    expect(fieldNames(body)).toEqual(["Contract ID", "Token ID"]);

    const state = {
      assetTokenContractId: TOKEN,
      assets: {
        loaded: true,
        loading: false,
        owner: assetsOwner(ov),
        updatedAt: Date.now(),
        tokens: [{ contractId: TOKEN, symbol: "TKN", name: "Token", decimals: 2 }],
        nfts: [],
        balances: { [TOKEN]: "100" },
        balancesAt: { [TOKEN]: Date.now() },
      },
    };
    body = await show(assetTokenView(ov, { state, actions: actions() }));
    expect(fieldNames(body)).toEqual(["Recipient", "Amount", "Spender", "Allowance"]);
  });

  it("name Settings' fields", async () => {
    const body = await show(optionsView(ov, { state: { route: "options" }, actions: actions() }));
    expect(fieldNames(body)).toEqual([
      "Active profile",
      "Profile 1 label",
      "Profile 2 label",
      "Auto-lock",
      "Network",
      "Node URL",
      "Prover URL",
      "Archiver URL",
      "Custom gas",
    ]);
    // Contacts is a row of its own.
    expect(visibleText(body.querySelector(".settings-row"))).toBe("Contacts");
  });

  it("name the setup fields, and the recovery phrase's words as one group", async () => {
    const onboard = { mode: "create", mnemonic: MNEMONIC, password: "x".repeat(8), reveal: false };
    let body = await show(onboardingCreatePasswordView({ state: { onboard }, actions: actions() }));
    expect(fieldNames(body)).toEqual([
      "Password",
      "Confirm password",
      "I understand that my recovery phrase is the only way to restore this wallet.",
    ]);

    const words = Array.from({ length: 12 }, (_, i) => `Word ${i + 1}`);
    body = await show(onboardingImportView({ state: { onboard }, actions: actions() }));
    expect(fieldNames(body)).toEqual([...words, "Password", "Confirm password"]);
    const group = body.querySelector(".mnemonic-input");
    expect([group.getAttribute("role"), accessibleName(group)]).toEqual(["group", "Recovery phrase"]);

    body = await show(onboardingCreateConfirmView({ state: { onboard }, actions: actions() }));
    expect(fieldNames(body)).toEqual(words);
    expect(accessibleName(body.querySelector(".mnemonic-input"))).toBe("Recovery phrase");

    body = await show(lockedView({ state: {}, actions: actions() }));
    expect(fieldNames(body)).toEqual(["Password"]);
  });

  it("name a new stake's owner and amount", async () => {
    const state = {
      route: "stake",
      staking: {
        loaded: true,
        loading: false,
        profileIndex: 0,
        minimumStakeLux: "1000000000000",
        actionKind: "topup",
        stakeAmountDusk: "",
        ownerProfileIndex: 0,
        ownerStatus: {
          profileIndex: 0,
          account: ACCOUNT,
          publicBalance: { value: "1482938300000" },
          hasStake: false,
          info: { amount: null, reward: "0", faults: 0, hardFaults: 0 },
          ownerKind: "none",
          ownerProfileIndex: 0,
          manageable: true,
          profiles: [{ profileIndex: 0 }, { profileIndex: 1 }],
          relatedStakes: [],
        },
      },
    };
    // Native staking: the amount, then the owner under Advanced.
    state.staking.screen = "native";
    const body = await show(stakeFormView({ selectedAccountIndex: 0 }, { state, actions: actions() }));
    expect(fieldNames(body)).toEqual(["Stake amount", "Owner"]);

    // Liquid staking names its amount the same way.
    state.staking.screen = "liquid";
    await show(stakeFormView({ selectedAccountIndex: 0, networkName: "Testnet" }, { state, actions: actions() }));
    expect(fieldNames(dom.document.body)).toEqual(["Stake amount"]);
  });

  it("stay unique when a view is drawn twice", async () => {
    const state = { route: "send", draft: null, addressBook: { loaded: true, items: [] } };
    const first = sendFormView(ov, { state, actions: actions() });
    const second = sendFormView(ov, { state, actions: actions() });
    const body = await show([...first, ...second]);
    const ids = body.querySelectorAll("label[for]").map((label) => label.getAttribute("for"));
    expect(new Set(ids).size).toBe(ids.length);
    expect(fieldNames(body)).toEqual(["To", "Amount", "Memo", "To", "Amount", "Memo"]);
  });
});
