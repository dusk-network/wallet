import { readFile } from "node:fs/promises";
import path from "node:path";
import { decodeBase58, encodeBase58 } from "@duskdomains/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { networks, routes } from "@dusk-network/networks";
import { GAS_PRICE_BUSY } from "@dusk-network/app-core/gas";
import {
  LINK_BAD_ADDRESS,
  LINK_BAD_AMOUNT,
  LINK_MEMO_LINE_BREAK,
  LINK_SEVERAL,
  LINK_TWO_AMOUNTS,
  LINK_UNCLEAR,
  LINK_UNREADABLE,
  parsePaymentLink,
} from "@dusk-network/app-core/payment-links";
import { bridgeServiceLine, bridgeServiceTransfer, bridgeServiceWarnings, noBridgeRecipientText } from "../shared/bridgeCalls.js";
import { TX_KIND } from "../shared/constants.js";
import { isAccount } from "@dusk-network/networks/account";
import { duskNamesOwners, lookupDuskName, lookupPrimaryName } from "../shared/duskNames.js";
import fixtures from "../shared/fixtures/duskevm-bridge-calls.json";
import { entryOf } from "../shared/fixtures/rows.js";
import { noteChainId } from "../shared/nodeNetwork.js";
import { blockedRecipient } from "../shared/recipientBlocklist.js";
import { walletLabel } from "../shared/wallets.js";
import { lookAlikeText } from "./lib/contactNames.js";
import { readPastedRequest, readRequestLink } from "./lib/requestLink.js";
import { shortfallText } from "./lib/shortfall.js";
import { shortAddress } from "./lib/strings.js";
import { clockText } from "./lib/time.js";
import { fakeEvent, installFakeDom, isShown, pastClickGuard, settle, typeInto, visibleText } from "./testing/fakeDom.js";
import { parseDuskQrPayload } from "./components/QrScanModal.js";
import { recipientTypeBadgeOptions } from "./components/RecipientBadge.js";
import { numbersText } from "./components/SafeText.js";
import { sendPasswordWhy } from "./components/SendPasswordDialog.js";
import { EVM_ADDRESS_TEXT, chainMismatchText, sendConfirmView, sendFormView } from "./popup/views/send.js";
import { reviewOf } from "./popup/views/sent.js";
import { whenAtText } from "./popup/views/txRow.js";
import { activityKey } from "./popup/activity.js";
import { asKept, keepOpenSend, takeOpenSend } from "./lib/sendDraft.js";

vi.mock("./components/QrScanModal.js", () => ({
  openQrScanModal: vi.fn(),
  parseDuskQrPayload: vi.fn(() => null),
}));
vi.mock("../shared/addressBook.js", () => ({ listAddressBook: vi.fn(async () => []) }));
// The accounts here are made up, so none is a key: a test says when it matters.
vi.mock("@dusk-network/networks/account", async (importOriginal) => ({
  ...(await importOriginal()),
  isAccount: vi.fn(() => true),
}));
vi.mock("../shared/duskNames.js", async (importOriginal) => ({
  ...(await importOriginal()),
  duskNamesOwners: vi.fn(async () => new Map()),
  lookupDuskName: vi.fn(),
  lookupPrimaryName: vi.fn(async () => null),
}));

describe("send view", () => {
  it("passes explicit privacy for wallet-initiated transfers", async () => {
    const source = await readFile(
      path.resolve(process.cwd(), "src", "ui", "popup", "views", "send.js"),
      "utf8"
    );

    const draftBlock = source.match(/state\.draft = \{([\s\S]*?)state\.route = "confirm"/);
    expect(draftBlock?.[1]).toContain("privacy,");

    // Review sends one of the two, the one its recipient has.
    const review = source.slice(source.indexOf("export function sendConfirmView"));
    expect(review).toContain('const privacy = recType === "address" ? "shielded" : "public";');
    const sendBlock = review.match(/type: "DUSK_UI_SEND_TX"([\s\S]*?)memo: d\.memo/);
    expect(sendBlock?.[1]).toContain("privacy,");
  });
});

// Public accounts and shielded addresses of the right shapes, told apart by their last byte.
const ACCOUNT =
  "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927";
const ADDRESS =
  "2Ana1pUpv2ZbMVkwF5FXapYeBEjdxDatLn7nvJkhgTSXbs59SyZSx866bXirPgj8QQVB57uxHJBG1YFvkRbFj4T";
const vary = (value, n) =>
  encodeBase58(decodeBase58(value).map((b, i, all) => (i === all.length - 1 ? b ^ n : b)));

// The current profile's own account and address, and another profile's account.
const OWN = { account: ACCOUNT, address: ADDRESS };
const OTHER_PROFILE = vary(ACCOUNT, 1);
// Others' accounts as keys: a link to one that isn't is refused, as Send can't pay it.
const ALICE = {
  account: "26JfWKvhYdVY71bdSPVLNJ51Buy4GjimCT7zcsoxNQtydDbdoH2AwZaH8W7rjcAc9riAu39Vw9Lx1w7yrkBgotSjWmUdkSyQuaTKDZWVCKp9g1GxiEnnksv3W3onToB5NsNi",
  address: vary(ADDRESS, 2),
};
const BOB = {
  account: "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz",
  address: vary(ADDRESS, 3),
};

const NAMES = {
  "alice.dusk": { ok: true, name: "alice.dusk", ...ALICE },
  "bob.dusk": { ok: true, name: "bob.dusk", ...BOB },
  "carol.dusk": { ok: true, name: "carol.dusk", address: vary(ADDRESS, 4) },
  "dave.dusk": { ok: true, name: "dave.dusk", account: vary(ACCOUNT, 5) },
  "me.dusk": { ok: true, name: "me.dusk", ...OWN },
  "listed.dusk": { ok: true, name: "listed.dusk", account: networks.testnet.display.blocklist[0].account },
};

// 177.9865 DUSK public, 25 DUSK shielded; the fee caps are 0.0025 and 0.05 DUSK.
const overview = (over = {}) => ({
  hasVault: true,
  isUnlocked: true,
  nodeUrl: "https://testnet.nodes.dusk.network",
  accounts: [OWN.account, OTHER_PROFILE],
  addresses: [OWN.address, vary(ADDRESS, 1)],
  selectedAccountIndex: 0,
  balance: { value: "177986500000" },
  shieldedBalance: { value: "25000000000", spendable: "25000000000" },
  ...over,
});

// What a request for Mainnet says on Testnet, where these tests' wallet is.
const FOR_MAINNET = chainMismatchText("dusk:1", overview().nodeUrl);

// DUSK's price now as CoinGecko gives it, the one place a mainnet screen reads it from (app-core's /prices):
// nothing in these tests leaves the machine.
const coingecko = vi.fn(async (url) => {
  if (!String(url).startsWith("https://api.coingecko.com/api/v3/coins/dusk-network?")) throw new TypeError("Nothing else answers in this test");
  const market_data = { current_price: { eur: 0.060722, gbp: 0.0529, usd: 0.0703 }, last_updated: new Date().toISOString() };
  return { ok: true, status: 200, text: async () => JSON.stringify({ market_data }) };
});

let dom;

beforeEach(() => {
  dom = installFakeDom();
  vi.stubGlobal("fetch", coingecko);
  lookupPrimaryName.mockReset();
  lookupPrimaryName.mockImplementation(async () => null);
  isAccount.mockReset();
  isAccount.mockReturnValue(true);
  duskNamesOwners.mockReset();
  duskNamesOwners.mockImplementation(async () => new Map());
  lookupDuskName.mockReset();
  lookupDuskName.mockImplementation((input) => {
    const key = String(input).trim().toLowerCase();
    const result = NAMES[key] ?? { ok: false, name: key, reason: "not_registered" };
    return { result, promise: Promise.resolve(result) };
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function newState() {
  // Contacts are loaded, so the form doesn't redraw itself when they come in.
  return { route: "send", draft: null, addressBook: { loaded: true, items: [] } };
}

// What a refused paste leaves in To: the text, on its one line.
const oneLine = (text) => text.replace(/\s*[\r\n]+\s*/g, " ").trim();

// What a note, an error or a refusal says, in whatever words: something, with each of `values` in it whole. A value
// is never part of a longer word or number: "1 DUSK" isn't "21 DUSK" or "0.1 DUSK", "1.0025" isn't "11.0025",
// "Profile 2" isn't "Profile 22", "bob.dusk" isn't "abob.dusk".
const saying = (...values) => {
  const whole = (value) =>
    `${/^[\p{L}\p{N}]/u.test(value) ? "(?<![\\p{L}\\p{N}_.,])" : ""}${RegExp.escape(value)}${/[\p{L}\p{N}]$/u.test(value) ? "(?![\\p{L}\\p{N}_]|[.,]\\d)" : ""}`;
  return expect.stringMatching(new RegExp(`^(?=[\\s\\S]*\\S)${values.map((value) => `(?=[\\s\\S]*${whole(value)})`).join("")}`, "u"));
};

// The pill's word for a public account and for a shielded address, as the form has them.
const [PUBLIC, SHIELDED] = ["account", "address"].map((type) => recipientTypeBadgeOptions(type).label);
// What says one thing and never the other, in whatever words: a transfer, or the balance that pays, public and not
// shielded, or shielded and not public.
const only = (is, isnt) => expect.stringMatching(new RegExp(`^(?![\\s\\S]*${isnt})[\\s\\S]*${is}`, "i"));
const [ONLY_PUBLIC, ONLY_SHIELDED] = [only("public", "shielded"), only("shielded", "public")];
// What a name that looks like another contact's ("contact") or one of your profiles' ("profile") says of it.
const looksLike = (kind) => new RegExp(RegExp.escape(lookAlikeText({ kind })), "i");

// Review's Confirm, by where it sits (reviewActions) rather than by what it says.
const confirmButton = () => dom.document.body.querySelector(".review-actions .btnrow > button");
// A Review row's value, by its row's label (To, From, Memo).
const reviewField = (label) => dom.document.body.querySelectorAll(".send-review .kv").find((kv) => visibleText(kv.querySelector(".kv-label")) === label)?.querySelector(".kv-value");
// Review's From, each part in its place: the wallet it's in where there's more than one (the words before the
// profile), the profile's name, and which balance pays.
const reviewFrom = () => {
  const value = reviewField("From");
  const wallet = value.querySelector(".review-wallet");
  return {
    wallet: wallet ? wallet.childNodes.filter((node) => node.nodeType === 3).map((node) => node.data).join("") : "",
    profile: visibleText(value.querySelector(".profile-name")),
    balance: visibleText(value.querySelector(".kv-muted")),
  };
};
// Review's fee and total, as its gas editor shows them.
const feeAndTotal = () => ["gas-fee-value", "gas-total-value"].map((name) => visibleText(dom.document.body.querySelector(`dusk-gas-editor .${name}`)));
// The amounts an amount that reads two ways asks between, as its buttons give them.
const readings = () => dom.document.body.querySelectorAll(".amount-question__choice").map((b) => b.textContent);
// The two buttons beside To: scan a QR code, then Contacts.
const scanButton = () => dom.document.body.querySelectorAll(".input-row .icon-only")[0];
const contactsButton = () => dom.document.body.querySelectorAll(".input-row .icon-only")[1];

// Renders the current route as the popup does, and finds the parts the tests read.
function mount(state, ov = overview(), send = async () => ({})) {
  const actions = {
    send: vi.fn(send),
    render: vi.fn(async () => {}),
    showToast: vi.fn(),
    // What the screen is drawn for, as render() gives it.
    review: reviewOf(ov, state),
  };
  const view = state.route === "confirm" ? sendConfirmView : sendFormView;
  dom.document.body.replaceChildren(...view(ov, { state, actions }));
  const $ = (selector) => dom.document.body.querySelector(selector);
  const radios = () => dom.document.body.querySelectorAll("[role=radio]");
  return {
    actions,
    to: $(".to-input-wrap textarea"),
    amount: $("input.amount-field__input"),
    memo: $(".send-form > input"),
    review: $("button.btn-primary"),
    radios,
    picked: () => radios().map((r) => r.getAttribute("aria-checked")),
    pill: () => {
      const pill = $(".row > .recipient-type-badge");
      return isShown(pill) ? pill.textContent : "";
    },
    // The pill's kind as it's drawn (RecipientBadge.js): "rail" for an account's or an address's, "unknown" for
    // what's neither.
    pillKind: () => {
      const pill = $(".row > .recipient-type-badge");
      return isShown(pill) ? (/\brecipient-badge--([\w-]+)/.exec(pill.className)?.[1] ?? "") : "";
    },
    nameBox: () => $(".name-box"),
    balanceLine: () => visibleText($(".amount-avail__text")),
    amountError: () => {
      const error = $(".amount-field__error");
      return isShown(error) ? error.textContent : "";
    },
    feeNote: () => $(".amount-fee-note").textContent,
    shortfall: () => $(".name-box .name-shortfall"),
    selfNote: () => {
      const note = $(".send-self-note");
      return isShown(note) ? note.textContent : "";
    },
    // Review: the kind of transfer, and what a public one shows everyone.
    kind: () => $(".review-kind")?.textContent,
    visibleLine: () => $(".review-visible")?.textContent ?? null,
    // Review's To: the names it goes by, and its address.
    toNames: () => visibleText($(".review-to__names")),
    toAddress: () => visibleText($(".review-to__address")),
  };
}

describe("send to a .dusk name with both addresses", () => {
  it("shows option cards under the name, on the public account by default", () => {
    const form = mount(newState());
    typeInto(form.to, "alice.dusk");

    expect(visibleText(dom.document.body.querySelector(".name-points-to"))).toEqual(saying("alice.dusk"));
    // A card for each address, the public account's first and picked.
    expect(form.radios().map((r) => visibleText(r.querySelector(".name-option__addr")))).toEqual([shortAddress(ALICE.account), shortAddress(ALICE.address)]);
    expect(form.picked()).toEqual(["true", "false"]);
    // The cards make the choice: no pill.
    expect(form.pill()).toBe("");
    expect(form.balanceLine()).toEqual(saying("177.984 DUSK"));
    expect(form.review.disabled).toBe(false);
  });

  it("says what's really missing when the balance is below the fee", () => {
    const form = mount(newState(), overview({ balance: { value: "0" } }));
    typeInto(form.to, ALICE.account);
    typeInto(form.amount, "1");

    // Sending that much more must be enough: the amount and the whole fee.
    expect(form.amountError()).toBe(shortfallText({ missingLux: 1_002_500_000n }));
    expect(form.amountError()).toEqual(saying("1.0025 DUSK"));
  });

  it("follows the picked card in the balance line", () => {
    const state = newState();
    const form = mount(state);
    typeInto(form.to, "alice.dusk");
    form.radios()[1].click();

    expect(form.picked()).toEqual(["false", "true"]);
    expect(form.pill()).toBe("");
    expect(form.balanceLine()).toEqual(saying("24.95 DUSK"));
    expect(state.draft.nameChoices).toEqual({ "alice.dusk": true });

    form.radios()[0].click();
    expect(form.picked()).toEqual(["true", "false"]);
    expect(form.balanceLine()).toEqual(saying("177.984 DUSK"));
  });

  // Lena's and Chen's: opened with no signal, the shielded balance said 0 where it couldn't be read.
  it("says no Available for a shielded address while the shielded balance can't be read now, never 0", () => {
    const form = mount(newState(), overview({ shieldedBalance: { value: "0", spendable: "0" }, shieldedStale: true, shieldedError: "Failed to fetch" }));
    typeInto(form.to, ALICE.address);
    expect(form.pill()).toBe(SHIELDED);
    expect(isShown(dom.document.body.querySelector(".amount-avail"))).toBe(false);
    typeInto(form.to, ALICE.account);
    expect(form.balanceLine()).toEqual(saying("177.984 DUSK"));
  });

  it("shows the pill for a pasted account or address, where it is the only sign of the transfer type", () => {
    // The pill's words say which: public for an account, shielded for an address, never the other.
    expect([PUBLIC, SHIELDED]).toEqual([ONLY_PUBLIC, ONLY_SHIELDED]);
    const form = mount(newState());
    typeInto(form.to, ALICE.account);
    expect(form.pill()).toBe(PUBLIC);
    typeInto(form.to, "alice.dusk");
    expect(form.pill()).toBe("");
    typeInto(form.to, ALICE.address);
    expect(form.pill()).toBe(SHIELDED);
  });

  it("keeps each name's pick while it is typed again, and starts a name without one on public", () => {
    const state = newState();
    let form = mount(state);
    typeInto(form.to, "alice.dusk");
    form.radios()[1].click();

    typeInto(form.to, "alice.dus");
    expect(form.radios()).toEqual([]);
    typeInto(form.to, "alice.dusk");
    expect(form.picked()).toEqual(["false", "true"]);
    // The same name, as resolved.
    typeInto(form.to, " Alice.DUSK");
    expect(form.picked()).toEqual(["false", "true"]);
    expect(form.balanceLine()).toEqual(saying("24.95 DUSK"));

    typeInto(form.to, "bob.dusk");
    expect(form.picked()).toEqual(["true", "false"]);
    expect(form.balanceLine()).toEqual(saying("177.984 DUSK"));

    // A pick for bob.dusk doesn't take alice.dusk's place.
    form.radios()[1].click();
    form.radios()[0].click();
    typeInto(form.to, "alice.dusk");
    expect(form.picked()).toEqual(["false", "true"]);
    typeInto(form.to, "bob.dusk");
    expect(form.picked()).toEqual(["true", "false"]);
    form.radios()[1].click();

    // Both stay through a redraw from the draft.
    form = mount(state);
    expect(state.draft.nameChoices).toEqual({ "alice.dusk": true, "bob.dusk": true });
    expect(form.picked()).toEqual(["false", "true"]);
    typeInto(form.to, "alice.dusk");
    expect(form.picked()).toEqual(["false", "true"]);
  });

  it("keeps the pick through a redraw and Back from Review, and Review says the transfer is private", async () => {
    const state = newState();
    let form = mount(state);
    typeInto(form.to, "alice.dusk");
    form.radios()[1].click();
    typeInto(form.amount, "1");

    // A redraw (a toast, say) rebuilds the form from the draft.
    form = mount(state);
    expect(form.to.value).toBe("alice.dusk");
    expect(form.picked()).toEqual(["false", "true"]);

    form.review.click();
    await settle();
    expect(state.route).toBe("confirm");
    expect(state.draft).toMatchObject({
      to: ALICE.address,
      privacy: "shielded",
      duskName: { name: "alice.dusk" },
      nameChoices: { "alice.dusk": true },
    });

    const review = mount(state);
    // A shielded send shows no one anything: no line says what's visible.
    expect([review.kind(), review.visibleLine()]).toEqual([ONLY_SHIELDED, null]);
    dom.document.body.querySelector(".subnav-back").click();
    expect(state.route).toBe("send");

    form = mount(state);
    expect(form.to.value).toBe("alice.dusk");
    expect(form.picked()).toEqual(["false", "true"]);
    expect(form.balanceLine()).toEqual(saying("24.95 DUSK"));
  });

  it.each([
    ["covers only the fee cap", { value: "50000000", spendable: "50000000" }],
    ["is empty", { value: "0", spendable: "0" }],
    ["can't be read", null],
  ])("disables the shielded card when the shielded balance %s, and links to Shield", (_label, shieldedBalance) => {
    const state = newState();
    const form = mount(state, overview({ shieldedBalance }));
    typeInto(form.to, "alice.dusk");

    const shielded = form.radios()[1];
    expect(shielded.getAttribute("aria-disabled")).toBe("true");
    shielded.click();
    expect(form.picked()).toEqual(["true", "false"]);
    expect(form.review.disabled).toBe(false);

    const hint = shielded.parentNode.querySelector(".name-shortfall");
    expect(hint.textContent).toEqual(saying());
    hint.querySelector("button").click();
    expect(state.route).toBe("convert");
    expect(state.draft).toEqual({ kind: TX_KIND.SHIELD, amountDusk: "", amountLux: "" });
  });

  it("enables the shielded card once the balance covers a transfer and its fee", () => {
    const form = mount(newState(), overview({ shieldedBalance: { value: "50000001", spendable: "50000001" } }));
    typeInto(form.to, "alice.dusk");
    expect(form.radios()[1].hasAttribute("aria-disabled")).toBe(false);
    expect(form.shortfall()).toBeNull();
  });
});

describe("send to a .dusk name with one address", () => {
  it("shows a name with only a shielded address as its one card, and holds Review while that balance can't pay", () => {
    const state = newState();
    const form = mount(state, overview({ shieldedBalance: { value: "0", spendable: "0" } }));
    typeInto(form.to, "carol.dusk");

    // As with two addresses, but one card, with nothing to choose, and the shortfall's way to Shield.
    const carol = NAMES["carol.dusk"].address;
    const card = () => [visibleText(dom.document.body.querySelector(".name-points-to")), dom.document.body.querySelectorAll(".name-box .name-option__addr").map(visibleText)];
    expect(form.radios()).toEqual([]);
    expect(form.pill()).toBe("");
    expect(card()).toEqual([saying("carol.dusk"), [shortAddress(carol)]]);
    expect(form.shortfall()).not.toBeNull();
    expect(form.review.disabled).toBe(true);

    form.shortfall().querySelector("button").click();
    expect(state.route).toBe("convert");

    const funded = mount(newState());
    typeInto(funded.to, "carol.dusk");
    expect(card()).toEqual([saying("carol.dusk"), [shortAddress(carol)]]);
    expect(funded.shortfall()).toBeNull();
    expect(funded.balanceLine()).toEqual(saying("24.95 DUSK"));
    expect(funded.review.disabled).toBe(false);
  });

  it("shows a name with only a public account as its one card, and Review shows the name over it", async () => {
    const state = newState();
    const ov = overview({ shieldedBalance: { value: "0", spendable: "0" } });
    const form = mount(state, ov);
    typeInto(form.to, "dave.dusk");

    const dave = NAMES["dave.dusk"].account;
    expect(form.radios()).toEqual([]);
    expect(form.pill()).toBe("");
    expect(visibleText(dom.document.body.querySelector(".name-points-to"))).toEqual(saying("dave.dusk"));
    expect(form.nameBox().querySelectorAll(".name-option__addr").map(visibleText)).toEqual([shortAddress(dave)]);
    expect(form.review.disabled).toBe(false);

    typeInto(form.amount, "1");
    form.review.click();
    await settle();
    expect(state.draft).toMatchObject({ to: dave, privacy: "public", duskName: { name: "dave.dusk" } });
    const review = mount(state, ov);
    // A public send says what everyone sees of it.
    expect(review.visibleLine()).toEqual(saying());
    expect([review.toNames(), review.toAddress()]).toEqual(["dave.dusk", dave]);
  });
});

describe("a Review when who pays changes", () => {
  it("goes back to the filled form on another wallet or profile, and stays through a redraw of the same", async () => {
    const state = newState();
    const ov = overview();
    const form = mount(state, ov);
    typeInto(form.to, ALICE.account);
    typeInto(form.amount, "1");
    form.review.click();
    await settle();
    expect(state.route).toBe("confirm");

    mount(state, ov);
    expect(state.route).toBe("confirm");

    const again = mount(state, { ...ov, selectedAccountIndex: 1 });
    expect(state.route).toBe("send");
    expect(again.to.value).toBe(ALICE.account);
    expect(again.amount.value).toBe("1");
  });
});

describe("a Review while offline", () => {
  // Chen's and Sofía's: the dot said nothing and Confirm went, offline.
  it("says so and holds Confirm, and lets it go once the connection is back", async () => {
    const state = newState();
    const ov = overview();
    const form = mount(state, ov);
    typeInto(form.to, ALICE.account);
    typeInto(form.amount, "1");
    form.review.click();
    await settle();
    expect(state.route).toBe("confirm");

    vi.stubGlobal("navigator", { ...globalThis.navigator, onLine: false });
    const review = mount(state, ov);
    await settle();
    const confirm = confirmButton;
    const offline = () => [...dom.document.body.querySelectorAll(".offline-note")].filter(isShown).map((n) => n.textContent);
    expect(confirm().disabled).toBe(true);
    expect(offline()).toEqual([saying()]);
    confirm().click();
    await settle();
    expect(review.actions.send.mock.calls.filter(([m]) => m.type === "DUSK_UI_SEND_TX")).toEqual([]);

    vi.stubGlobal("navigator", { ...globalThis.navigator, onLine: true });
    dom.window.dispatchEvent(new Event("online"));
    expect(confirm().disabled).toBe(false);
    expect(offline()).toEqual([]);

    // Off again for the connection, and what else holds it stays held once back.
    vi.stubGlobal("navigator", { ...globalThis.navigator, onLine: false });
    dom.window.dispatchEvent(new Event("offline"));
    confirm().disabled = true;
    vi.stubGlobal("navigator", { ...globalThis.navigator, onLine: true });
    dom.window.dispatchEvent(new Event("online"));
    expect(confirm().disabled).toBe(true);
  });
});

describe("what Max fills in, with Hide balances", () => {
  const shown = () => [...dom.document.body.querySelectorAll(".amount-field input")].find((input) => !input.hidden);

  it("shows as dots on the form and on Review, and is what gets sent", async () => {
    const state = newState();
    const ov = overview({ hideBalances: true });
    const form = mount(state, ov);
    typeInto(form.to, ALICE.account);
    dom.document.body.querySelector(".amount-avail .mini-btn").click();
    expect(shown().value).toBe("••••");
    expect(form.amount.value).not.toBe("");

    form.review.click();
    await settle();
    expect(state.route).toBe("confirm");
    expect(BigInt(state.draft.amountLux) > 0n).toBe(true);
    mount(state, ov);
    expect(visibleText(dom.document.body.querySelector(".balance-amount"))).toBe("•••• DUSK");
    expect(feeAndTotal()[1]).toEqual(saying("•••• DUSK"));
  });

  it("shows what's typed over it", () => {
    const state = newState();
    const form = mount(state, overview({ hideBalances: true }));
    typeInto(form.to, ALICE.account);
    dom.document.body.querySelector(".amount-avail .mini-btn").click();
    typeInto(shown(), "1");
    expect(shown().value).toBe("1");
    expect(state.draft.amountMasked).toBe(false);
    expect(state.draft.amountDusk).toBe("1");
  });

  it("clears the amount when the dots are deleted", () => {
    const state = newState();
    const form = mount(state, overview({ hideBalances: true }));
    typeInto(form.to, ALICE.account);
    dom.document.body.querySelector(".amount-avail .mini-btn").click();
    typeInto(shown(), "•••");
    expect(shown().value).toBe("");
    expect(state.draft.amountDusk).toBe("");
  });
});

describe("what the To field says about what's typed", () => {
  it("says a mistyped account isn't an address, and Review stays off", () => {
    isAccount.mockReturnValue(false);
    const form = mount(newState());
    typeInto(form.to, ALICE.account);
    expect(visibleText(form.nameBox())).toEqual(saying());
    expect(form.pill()).toBe("");
    expect(form.review.disabled).toBe(true);

    // Corrected, it's an account again.
    isAccount.mockReturnValue(true);
    typeInto(form.to, ALICE.account);
    expect(visibleText(form.nameBox())).toBe("");
    expect(form.pill()).toBe(PUBLIC);
    expect(form.review.disabled).toBe(false);
  });

  // R12, Sofía's, Lena's, Nandini's: a .dusk name with a dot-like point in To got "? Unknown" in the extension, which
  // in its font read like her own name; never which name it looked like.
  it("says a .dusk name written with another point or a look-alike letter looks like the real one, at once, and Review stays off", () => {
    const form = mount(newState());
    for (const typed of ["sofiadesign\u00b7dusk", "sofiadesign\uff0edusk", "sofiadesign\u3002dusk", "sofiadesign\u2027dusk", "sofiadesign\u02d9dusk", "sofiadesign \u00b7 dusk", "\u0455ofiadesign.dusk"]) {
      typeInto(form.to, typed);
      expect([visibleText(form.nameBox()), form.pill(), form.review.disabled], typed).toEqual([saying("sofiadesign.dusk"), "", true]);
    }
    // None of them is looked up; the name itself is, as ever.
    expect(lookupDuskName).not.toHaveBeenCalled();
    typeInto(form.to, "sofiadesign.dusk");
    expect(lookupDuskName.mock.calls.map(([name]) => name)).toEqual(["sofiadesign.dusk"]);
  });

  it("says the same of what's too long to be a name and is no address either", () => {
    const form = mount(newState());
    for (const typo of [`${ALICE.account}x`, ALICE.account.slice(0, 70), `${ALICE.account.slice(0, 60)}0${ALICE.account.slice(61)}`]) {
      typeInto(form.to, typo);
      expect(visibleText(form.nameBox())).toEqual(saying());
      expect(form.pill()).toBe("");
      expect(form.review.disabled).toBe(true);
    }
  });

  it("drops what Review said once the recipient changes", async () => {
    const form = mount(newState());
    typeInto(form.amount, "1");
    typeInto(form.to, "someone new");
    form.review.click();
    await settle();
    expect(visibleText(dom.document.body.querySelector(".err"))).toEqual(saying());
    typeInto(form.to, ALICE.account);
    expect(dom.document.body.querySelector(".err").textContent).toBe("");
  });

  it("joins up an address that a chat app broke with spaces", () => {
    const form = mount(newState());
    typeInto(form.to, `${ALICE.account.slice(0, 40)} ${ALICE.account.slice(40, 80)}\n${ALICE.account.slice(80)}`);
    expect(form.to.value).toBe(ALICE.account);
    expect(form.pill()).toBe(PUBLIC);
    expect(form.review.disabled).toBe(false);
  });

  it("offers a contact by name before any .dusk name, which would be somebody else's", () => {
    const state = newState();
    state.addressBook.items = [
      { name: "Alice", address: BOB.account },
      { name: "Jan (flour)", address: BOB.address },
    ];
    const form = mount(state);
    const offered = () => form.nameBox().querySelectorAll("button").map((b) => b.textContent);

    typeInto(form.to, "alice");
    expect(offered()).toEqual([saying("Alice", shortAddress(BOB.account))]);

    typeInto(form.to, "flour");
    expect(offered()).toEqual([saying("Jan (flour)", shortAddress(BOB.address))]);

    // Nothing by that name in Contacts: the guess is still offered.
    typeInto(form.to, "bob");
    expect(offered()).toEqual([saying("bob.dusk")]);

    typeInto(form.to, "alice");
    form.nameBox().querySelector("button").click();
    expect(form.to.value).toBe(BOB.account);
    expect(form.pill()).toBe(PUBLIC);
  });

  // Sofía's: "Profile" in To said "Did you mean profile.dusk?", not her own Profile 2. Registered by someone, it
  // would have taken her own transfer to a stranger.
  it("offers your own profiles first, then contacts, and guesses at no .dusk name for one of your own names", () => {
    const state = newState();
    state.addressBook.items = [{ name: "Profit & Co", address: BOB.account }];
    const savings = { key: "wb", n: 2, name: "Savings", accounts: [ALICE.account], accountNames: {}, active: false };
    const form = mount(state, overview({ wallets: [{ key: "wa", n: 1, name: "", accounts: [OWN.account, OTHER_PROFILE], accountNames: {}, active: true }, savings] }));
    const offered = () => form.nameBox().querySelectorAll("button").map((b) => b.textContent);

    // Profile 2, then the other wallet's Savings, by their own addresses.
    const PROFILE_2 = saying("Profile 2", shortAddress(OTHER_PROFILE));
    const SAVINGS = saying("Savings", "Profile 1", shortAddress(ALICE.account));
    typeInto(form.to, "Profile");
    expect(offered()).toEqual([PROFILE_2, SAVINGS]);
    typeInto(form.to, "profile 2");
    expect(offered()).toEqual([PROFILE_2]);
    typeInto(form.to, "prof");
    expect(offered()).toEqual([PROFILE_2, SAVINGS, saying("Profit & Co", shortAddress(BOB.account))]);
    // Another wallet's profile, by that wallet's name.
    typeInto(form.to, "savings");
    expect(offered()).toEqual([SAVINGS]);
    // The profile it goes from: offered as nothing, and no name guessed at for it.
    typeInto(form.to, "Profile 1");
    expect(visibleText(form.nameBox())).toBe("");
    // A name that's none of yours: the guess is still offered.
    typeInto(form.to, "xyz");
    expect(offered()).toEqual([saying("xyz.dusk")]);

    typeInto(form.to, "Profile");
    form.nameBox().querySelector("button").click();
    expect([form.to.value, form.pill()]).toEqual([OTHER_PROFILE, PUBLIC]);
  });

  it("says which contacts' names look like another's, with each one's address", () => {
    // Sofia's: two "Estudio Marta", one in a Cyrillic а, told apart only by the address.
    const state = newState();
    state.addressBook.items = [
      { name: "Estudio Marta", address: ALICE.account },
      { name: "Estudio M\u0430rta", address: BOB.account },
      { name: "Estudio Sol", address: BOB.address },
    ];
    const form = mount(state);
    typeInto(form.to, "estudio");
    const offered = form.nameBox().querySelectorAll("button").map((b) => b.textContent);
    expect(offered).toEqual([
      saying("Estudio Marta", shortAddress(ALICE.account)),
      saying("Estudio M\u0430rta", shortAddress(BOB.account)),
      saying("Estudio Sol", shortAddress(BOB.address)),
    ]);
    // The first two say they look like another contact; the third doesn't.
    expect(offered.map((text) => looksLike("contact").test(text))).toEqual([true, true, false]);
  });

  // Sofia's: picked, the one in a Cyrillic а read as plain "Estudio Marta" on Send and on Review.
  it("marks a contact whose name looks like another's once it's picked, on Send and on Review, beside its address", () => {
    const state = newState();
    state.addressBook.items = [
      { name: "Estudio Marta", address: ALICE.account },
      { name: "Estudio M\u0430rta", address: BOB.account },
      { name: "Estudio Sol", address: BOB.address },
    ];
    const note = () => {
      const el = dom.document.body.querySelector(".send-alike-note");
      return isShown(el) ? el.textContent : "";
    };
    let form = mount(state);
    typeInto(form.to, BOB.account);
    expect(note()).toMatch(looksLike("contact"));
    typeInto(form.to, BOB.address);
    expect(note()).toBe("");

    state.route = "confirm";
    state.draft = { to: BOB.account, privacy: "public", amountDusk: "1", amountLux: "1000000000", memo: "" };
    form = mount(state);
    expect([form.toNames(), form.toAddress()]).toEqual([saying("Estudio M\u0430rta"), BOB.account]);
    expect(form.toNames()).toMatch(looksLike("contact"));
  });
});

describe("a memo too long for the network", () => {
  it("says so under the field and stays on the form, counting bytes", async () => {
    const state = newState();
    const form = mount(state);
    const memo = form.memo;
    const error = () => {
      const el = dom.document.body.querySelector(".memo-error");
      return isShown(el) ? el.textContent : "";
    };
    typeInto(form.to, ALICE.account);
    typeInto(form.amount, "1");

    typeInto(memo, "x".repeat(513));
    expect(error()).toEqual(saying("512"));
    form.review.click();
    await settle();
    expect(state.route).toBe("send");

    typeInto(memo, "€".repeat(171));
    expect(error()).not.toBe("");

    typeInto(memo, "x".repeat(512));
    expect(error()).toBe("");
    form.review.click();
    await settle();
    expect(state.route).toBe("confirm");
    expect(state.draft.memo).toHaveLength(512);
  });
});

describe("send's amount", () => {
  // Amélie's and Lena's: Send said up to 0.0025, its Review up to 0.005, the node asking 2 LUX.
  it("says the fee its Review will, at the node's gas price, and keeps it from Max", async () => {
    const state = newState();
    const form = mount(state, overview(), async (message) => (message.type === "DUSK_UI_GET_CACHED_GAS_PRICE" ? { min: "1", median: "2", max: "5" } : {}));
    typeInto(form.to, ALICE.account);
    await settle();
    expect(form.feeNote()).toEqual(saying("0.005 DUSK"));
    expect(form.balanceLine()).toEqual(saying("177.9815 DUSK"));

    // Its Review: the same fee.
    typeInto(form.amount, "1");
    state.route = "confirm";
    Object.assign(state.draft, { privacy: "public", amountLux: "1000000000" });
    mount(state, overview(), async (message) => (message.type === "DUSK_UI_GET_CACHED_GAS_PRICE" ? { min: "1", median: "2", max: "5" } : {}));
    await settle();
    expect(feeAndTotal()).toEqual([saying("0.005 DUSK"), saying("1.005 DUSK")]);
  });

  it("says what's available after fees, fills Max, and says under the field what's wrong", () => {
    const state = newState();
    const form = mount(state);
    // No recipient yet: nothing to measure against.
    expect(isShown(dom.document.body.querySelector(".amount-avail"))).toBe(false);
    typeInto(form.to, ALICE.account);
    expect(form.balanceLine()).toEqual(saying("177.984 DUSK"));
    expect(form.feeNote()).toEqual(saying("0.0025 DUSK"));

    // Max fills a fourth decimal where three would ask "1 or 1000?", so the field reads it back as it is.
    dom.document.body.querySelector(".amount-avail button").click();
    expect(form.amount.value).toBe("177.9840");
    expect(form.amountError()).toBe("");

    typeInto(form.amount, "500");
    expect(form.amountError()).toBe(shortfallText({ missingLux: 322_016_000_000n }));
    expect(form.amountError()).toEqual(saying("322.016 DUSK"));
    typeInto(form.amount, "0");
    expect(form.amountError()).toEqual(saying());

    // Review asks for an amount instead of going on without one.
    typeInto(form.amount, "");
    form.review.click();
    expect(form.amountError()).toEqual(saying());
    expect(state.route).toBe("send");
  });

  it("reads a decimal comma, and says when what's typed isn't an amount instead of changing it", async () => {
    const state = newState();
    const form = mount(state);
    typeInto(form.to, ALICE.account);

    typeInto(form.amount, "0,1");
    expect(form.amount.value).toBe("0,1");
    expect(form.amountError()).toBe("");
    form.review.click();
    await settle();
    expect(state.route).toBe("confirm");
    expect(state.draft.amountLux).toBe("100000000");

    for (const bad of ["-1", "1e1", "0.25.1", "1,2,3", "1 DUSK"]) {
      const next = mount(newState());
      typeInto(next.to, ALICE.account);
      typeInto(next.amount, bad);
      expect(next.amount.value).toBe(bad);
      expect(next.amountError()).toEqual(saying());
    }
    const last = mount(newState());
    typeInto(last.to, ALICE.account);
    typeInto(last.amount, "0,1234567891234");
    expect(last.amountError()).toEqual(saying("9"));
    typeInto(last.amount, "0.0000000001");
    expect(last.amountError()).toEqual(saying("9"));
    typeInto(last.amount, "1,234");
    expect([readings(), last.review.disabled]).toEqual([["1.2340 DUSK", "1234 DUSK"], true]);
  });

  // Lena's: "1,000" asked and "1.000" didn't. In English the point is the
  // decimal; where the comma is, "1.000" asks, in the web wallet's words. And
  // the question's "1.000" read as a thousand to her: it names 1 and 1000.
  // Nandini's and Chen's: the question had no buttons, and asked to retype.
  it.each([
    ["de-DE", "1.000", ["1 DUSK", "1000 DUSK"], []],
    ["nl-NL", "1.000", ["1 DUSK", "1000 DUSK"], []],
    ["en-GB", "1,000", ["1 DUSK", "1000 DUSK"], []],
    // Not two amounts: the one it is, written without the space.
    ["es-ES", "1 234,5", [], ["1234,5"]],
  ])("asks which amount is meant where it could be two, in the language's reading: %s %s", (language, typed, asked, said) => {
    vi.stubGlobal("navigator", { ...globalThis.navigator, language });
    const form = mount(newState());
    typeInto(form.to, ALICE.account);
    typeInto(form.amount, typed);
    expect([readings(), form.amountError(), form.review.disabled]).toEqual([asked, saying(...said), true]);
  });

  it("puts the reading tapped in the field, which reads it then, with Review on; typing stays as it was", () => {
    vi.stubGlobal("navigator", { ...globalThis.navigator, language: "en-SG" });
    const form = mount(newState());
    typeInto(form.to, ALICE.account);
    typeInto(form.amount, "2.125");
    const choices = () => dom.document.body.querySelectorAll(".amount-question__choice");
    expect(choices().map((b) => b.textContent)).toEqual(["2.1250 DUSK", "2125 DUSK"]);
    // 2125: read as that, which is more than there is.
    choices()[1].click();
    expect([form.amount.value, choices().length]).toEqual(["2125", 0]);
    expect(form.amountError()).toBe(shortfallText({ missingLux: 1_947_016_000_000n }));
    expect(form.amountError()).toEqual(saying("1,947.016 DUSK"));
    typeInto(form.amount, "2.125");
    choices()[0].click();
    expect([form.amount.value, form.amountError(), form.review.disabled]).toEqual(["2.1250", "", false]);
  });

  it("keeps Review off while an amount typed won't do, and on for an empty one to say what's missing", () => {
    const form = mount(newState());
    typeInto(form.to, ALICE.account);
    expect(form.review.disabled).toBe(false);
    for (const bad of ["abc", "0,1234567891234", "0", "99999"]) {
      typeInto(form.amount, bad);
      expect(form.amountError()).not.toBe("");
      expect(form.review.disabled).toBe(true);
    }
    typeInto(form.amount, "1");
    expect([form.amountError(), form.review.disabled]).toEqual(["", false]);
    typeInto(form.amount, "");
    expect(form.review.disabled).toBe(false);
  });

  it("keeps Review off for a recipient that won't do, whatever the amount does", () => {
    const form = mount(newState());
    isAccount.mockReturnValue(false);
    typeInto(form.to, ALICE.account);
    typeInto(form.amount, "1");
    expect(form.review.disabled).toBe(true);
    typeInto(form.amount, "abc");
    typeInto(form.amount, "1");
    expect(form.review.disabled).toBe(true);
    isAccount.mockReturnValue(true);
    typeInto(form.to, ALICE.account);
    expect(form.review.disabled).toBe(false);
    typeInto(form.amount, "abc");
    typeInto(form.to, BOB.account);
    expect(form.review.disabled).toBe(true);
  });

  it("sets aside the fee Review starts from, with custom gas from Settings", async () => {
    // Price 3: a public transfer keeps the custom 2.5M limit; a shielded one
    // its own 50M, as 2.5M is under its minimum.
    const ov = overview({ customGas: { limit: "2500000", price: "3" } });
    const state = newState();
    const form = mount(state, ov);
    typeInto(form.to, "alice.dusk");
    expect([form.balanceLine(), form.feeNote()]).toEqual([saying("177.979 DUSK"), saying("0.0075 DUSK")]);
    form.radios()[1].click();
    expect([form.balanceLine(), form.feeNote()]).toEqual([saying("24.85 DUSK"), saying("0.15 DUSK")]);
    form.radios()[0].click();
    typeInto(form.amount, "177.98");
    expect(form.amountError()).toBe(shortfallText({ missingLux: 1_000_000n }));
    expect(form.amountError()).toEqual(saying("0.001 DUSK"));
    dom.document.body.querySelector(".amount-avail button").click();
    expect(form.amount.value).toBe("177.9790");

    // Review asks that fee: Max and the fee make up the whole balance.
    form.review.click();
    await settle();
    expect(state.route).toBe("confirm");
    mount(state, ov);
    await settle();
    expect(feeAndTotal()).toEqual([saying("0.0075 DUSK"), saying("177.9865 DUSK")]);
  });

  it("hides what's available with Hide balances, while Max still fills in the real amount", () => {
    const form = mount(newState(), overview({ hideBalances: true }));
    typeInto(form.to, ALICE.account);
    expect(form.balanceLine()).toEqual(saying("•••• DUSK"));
    // The fee isn't a balance.
    expect(form.feeNote()).toEqual(saying("0.0025 DUSK"));
    dom.document.body.querySelector(".amount-avail button").click();
    expect(form.amount.value).toBe("177.9840");
  });
});

describe("names on Send and Review", () => {
  it("shows a pasted public account's verified .dusk name", async () => {
    lookupPrimaryName.mockImplementation(async (account) => (account === BOB.account ? "bob.dusk" : null));
    const form = mount(newState());
    typeInto(form.to, BOB.account);
    await settle();
    expect(visibleText(form.nameBox().querySelector(".name-verified__name"))).toBe("bob.dusk");

    // Not for one without a name, nor once the field holds something else.
    typeInto(form.to, ALICE.account);
    await settle();
    expect(isShown(form.nameBox())).toBe(false);
  });

  it("names the profile that pays, and a contact by its label and its verified name both", async () => {
    lookupPrimaryName.mockImplementation(async (account) => ({ [OWN.account]: "me.dusk", [BOB.account]: "bob.dusk" })[account] ?? null);
    const state = {
      route: "confirm",
      addressBook: { loaded: true, items: [{ name: "Bobby", address: BOB.account }] },
      draft: { to: BOB.account, privacy: "public", amountDusk: "1", amountLux: "1000000000", memo: "" },
    };
    const view = mount(state);
    await settle();
    // To: the contact's label and its verified name, over its whole account. From: the profile, by its verified name.
    expect([view.toNames(), view.toAddress()]).toEqual([saying("Bobby", "bob.dusk"), BOB.account]);
    expect(reviewFrom()).toEqual({ wallet: "", profile: "me.dusk", balance: ONLY_PUBLIC });
    expect(view.visibleLine()).toEqual(saying("me.dusk"));
  });

  it("names a contact saved with hidden characters by their codes, on the form and on Review", async () => {
    // Marek's: an override at the start made a stranger's account read as "Profile 2".
    const items = [{ name: "\u202e2 eliforP", address: ALICE.account }];
    const form = mount({ ...newState(), addressBook: { loaded: true, items } });
    typeInto(form.to, ALICE.account);
    await settle();
    expect(visibleText(dom.document.body.querySelector(".to-chip"))).toBe("\\u202e2 eliforP");

    mount({ route: "confirm", addressBook: { loaded: true, items }, draft: { to: ALICE.account, privacy: "public", amountDusk: "1", amountLux: "1000000000", memo: "" } });
    await settle();
    expect(visibleText(dom.document.body.querySelector(".review-to__names"))).toBe("\\u202e2 eliforP");
    expect(visibleText(dom.document.body)).not.toContain("\u202e");
  });

  it("names the wallet beside the profile with more than one wallet, the one the Review was drawn for", async () => {
    lookupPrimaryName.mockImplementation(async (account) => (account === OWN.account ? "me.dusk" : null));
    const draft = (to, privacy) => ({ to, privacy, amountDusk: "1", amountLux: "1000000000", memo: "" });
    const wallets = [
      { key: "w1", n: 1, name: "", active: false },
      { key: "w2", n: 2, name: "", active: true },
    ];
    const state = { route: "confirm", addressBook: { loaded: true, items: [] }, draft: draft(BOB.account, "public") };
    mount(state, overview({ wallets }));
    await settle();
    expect(reviewFrom()).toEqual({ wallet: saying(walletLabel(wallets[1])), profile: "me.dusk", balance: ONLY_PUBLIC });
    // A name given to the wallet, on a shielded send.
    mount({ ...state, draft: draft(BOB.address, "shielded") }, overview({ wallets: [wallets[0], { ...wallets[1], name: "Savings" }] }));
    await settle();
    expect(reviewFrom()).toEqual({ wallet: saying("Savings"), profile: "me.dusk", balance: ONLY_SHIELDED });
    // One wallet: the profile alone.
    mount(state, overview({ wallets: [{ ...wallets[1], n: 1 }] }));
    await settle();
    expect(reviewFrom()).toEqual({ wallet: "", profile: "me.dusk", balance: ONLY_PUBLIC });
  });

  it("names your other profile, on the form and on Review", async () => {
    const ov = overview({ accountNames: { 1: "Savings" } });
    const form = mount(newState(), ov);
    typeInto(form.to, OTHER_PROFILE);
    await settle();
    expect(visibleText(dom.document.body.querySelector(".to-chip"))).toBe("Savings");

    const names = () => visibleText(dom.document.body.querySelector(".review-to__names"));
    mount(
      {
        route: "confirm",
        addressBook: { loaded: true, items: [] },
        draft: { to: OTHER_PROFILE, privacy: "public", amountDusk: "1", amountLux: "1000000000", memo: "" },
      },
      ov
    );
    await settle();
    const yours = names();
    expect(yours).toEqual(saying("Savings"));
    expect(yours).not.toMatch(looksLike("profile"));

    // Marek's: a contact named like it, for someone else, never reads the same on Review.
    mount(
      {
        route: "confirm",
        addressBook: { loaded: true, items: [{ name: "Savings", address: ALICE.account }] },
        draft: { to: ALICE.account, privacy: "public", amountDusk: "1", amountLux: "1000000000", memo: "" },
      },
      ov
    );
    await settle();
    expect(names()).toEqual(saying("Savings"));
    expect(names()).toMatch(looksLike("profile"));
  });
});

describe("a typed name that isn't registered", () => {
  it("offers the closest name from contacts and past transfers, from this device alone", () => {
    const state = newState();
    state.addressBook.items = [
      { name: "alice.dusk", address: ALICE.account },
      // Saved from dave.dusk, under a name of its own.
      { name: "Dave's shop", address: vary(ACCOUNT, 5), duskName: "dave.dusk" },
    ];
    state.activity = { names: new Map([[BOB.account, "bob.dusk"]]) };
    const form = mount(state);
    // What's said of the name typed, and the names offered for it.
    const said = () => [visibleText(form.nameBox().querySelector(".err")), form.nameBox().querySelectorAll("button.name-suggestion").map((b) => b.textContent)];
    typeInto(form.to, "dav.dusk");
    expect(said()).toEqual([saying("dav.dusk"), [saying("dave.dusk")]]);
    typeInto(form.to, "alcie.dusk");
    expect(said()).toEqual([saying("alcie.dusk"), [saying("alice.dusk")]]);
    // Only the typed names were looked up.
    expect(lookupDuskName.mock.calls.map(([name]) => name)).toEqual(["dav.dusk", "alcie.dusk"]);

    form.nameBox().querySelector("button.name-suggestion").click();
    expect(form.to.value).toBe("alice.dusk");
    expect(state.draft.to).toBe("alice.dusk");
    expect(visibleText(dom.document.body.querySelector(".name-points-to"))).toEqual(saying("alice.dusk"));

    // A recent counterparty's name, and nothing when no known name is close.
    typeInto(form.to, "bbo.dusk");
    expect(said()).toEqual([saying("bbo.dusk"), [saying("bob.dusk")]]);
    typeInto(form.to, "zed.dusk");
    expect(said()).toEqual([saying("zed.dusk"), []]);
  });
});

describe("a name typed without .dusk", () => {
  it("offers the .dusk name it likely means, for a bare name or one with a dot after it, and looks it up once taken", () => {
    const state = newState();
    const form = mount(state);
    for (const typed of ["alice", "alice.dusk."]) {
      typeInto(form.to, typed);
      expect([visibleText(form.nameBox()), form.pill()]).toEqual([saying("alice.dusk"), ""]);
    }
    expect(lookupDuskName).not.toHaveBeenCalled();

    form.nameBox().querySelector("button.name-suggestion").click();
    expect([form.to.value, state.draft.to]).toEqual(["alice.dusk", "alice.dusk"]);
    expect(lookupDuskName.mock.calls.map(([name]) => name)).toEqual(["alice.dusk"]);
    expect(visibleText(dom.document.body.querySelector(".name-points-to"))).toEqual(saying("alice.dusk"));

    // An address in the making, or anything else, is no name.
    typeInto(form.to, "26FCH745");
    expect([visibleText(form.nameBox()), form.pillKind()]).toEqual(["", "unknown"]);
  });

  it("offers none on a network without names", () => {
    const form = mount(newState(), overview({ nodeUrl: "http://127.0.0.1:8080" }));
    typeInto(form.to, "alice");
    expect([visibleText(form.nameBox()), form.pillKind()]).toEqual(["", "unknown"]);
  });
});

describe("an EVM address", () => {
  it("says it's an EVM address, not a Dusk account, and keeps Review off", () => {
    for (const nodeUrl of [undefined, "http://127.0.0.1:8080"]) {
      const form = mount(newState(), overview(nodeUrl ? { nodeUrl } : {}));
      typeInto(form.to, "0xAB84EDFFd745AF9420ac74FeC73121FBEE9fC86F");
      expect([visibleText(form.nameBox()), form.pill(), form.review.disabled]).toEqual([EVM_ADDRESS_TEXT, "", true]);
      // In any case.
      typeInto(form.to, "0xab84edffd745af9420ac74fec73121fbee9fc86f");
      expect(visibleText(form.nameBox())).toBe(EVM_ADDRESS_TEXT);
      // Anything shorter isn't one.
      typeInto(form.to, "0xAB84EDFF");
      expect([visibleText(form.nameBox()), form.pillKind(), form.review.disabled]).toEqual(["", "unknown", false]);
    }
  });
});

describe("sending to yourself", () => {
  // What the form says of your own account, never an address, and of your own address, never an account.
  const [OWN_ACCOUNT, OWN_ADDRESS] = [only("account", "address"), only("address", "account")];

  it("warns for your own pasted account or shielded address and still allows Review", () => {
    const form = mount(newState());
    typeInto(form.to, OWN.account);
    expect(form.selfNote()).toEqual(OWN_ACCOUNT);
    expect(form.review.disabled).toBe(false);

    typeInto(form.to, OWN.address);
    expect(form.selfNote()).toEqual(OWN_ADDRESS);

    // Another profile of this wallet, someone else, or nothing: no warning.
    for (const value of [OTHER_PROFILE, ALICE.account, ALICE.address, ""]) {
      typeInto(form.to, value);
      expect(form.selfNote()).toBe("");
    }
  });

  it("warns for a name that points to you, following the picked address", () => {
    const form = mount(newState());
    typeInto(form.to, "me.dusk");
    expect(form.selfNote()).toEqual(OWN_ACCOUNT);
    form.radios()[1].click();
    expect(form.selfNote()).toEqual(OWN_ADDRESS);
    expect(form.review.disabled).toBe(false);

    typeInto(form.to, "alice.dusk");
    expect(form.selfNote()).toBe("");
  });
});

describe("a recipient the network's file blocks", () => {
  it("says why under the field, as the web wallet does, and keeps Review off", async () => {
    const form = mount(newState());
    const banner = () => dom.document.body.querySelector(".send-blocked");
    for (const { account } of networks.testnet.display.blocklist) {
      typeInto(form.to, account);
      expect(isShown(banner())).toBe(true);
      // Why, for its reason in the file: reported fraud, or compromised.
      expect(visibleText(banner().querySelector(".muted"))).toBe(blockedRecipient(account));
      expect(form.review.disabled).toBe(true);
    }

    // Anyone else goes ahead.
    typeInto(form.to, ALICE.account);
    expect(isShown(banner())).toBe(false);
    expect(form.review.disabled).toBe(false);

    // A name pointing at one is blocked too.
    typeInto(form.to, "listed.dusk");
    await vi.waitFor(() => expect(isShown(banner())).toBe(true));
    expect(form.review.disabled).toBe(true);
  });
});

describe("review", () => {
  const review = (draft, ov, send) =>
    mount(
      {
        route: "confirm",
        addressBook: { loaded: true, items: [] },
        draft: { amountDusk: "1", amountLux: "1000000000", memo: "", ...draft },
      },
      ov,
      send
    );

  it("says how much is missing when the fee, as Custom fee changes it, takes it past the balance, and keeps Confirm off", async () => {
    const send = async (message) => (message.type === "DUSK_UI_GET_CACHED_GAS_PRICE" ? { min: "1", median: "1", max: "1" } : { ok: true, result: { hash: "ab".repeat(32) } });
    const ov = overview({ balance: { value: "1010000000", nonce: "0" } });
    review({ to: ALICE.account, privacy: "public" }, ov, send);
    await settle();
    const body = dom.document.body;
    const confirm = confirmButton();
    const guard = body.querySelector(".pay-guard");
    expect([isShown(guard), confirm.disabled]).toEqual([false, false]);

    const editor = body.querySelector("dusk-gas-editor");
    editor.setGas({ limit: "2500000", price: "10" });
    await settle();
    expect(guard.textContent).toBe(shortfallText({ missingLux: 15_000_000n }));
    expect(guard.textContent).toEqual(saying("0.015 DUSK"));
    expect(isShown(guard)).toBe(true);
    expect(confirm.disabled).toBe(true);

    // Back within it.
    editor.setGas({ limit: "2500000", price: "1" });
    await settle();
    expect([isShown(guard), confirm.disabled]).toEqual([false, false]);
  });

  it("checks a shielded send against what can be spent now, and checks nothing against a balance it couldn't read", async () => {
    const send = async () => ({ min: "1", median: "1", max: "1" });
    review({ to: ALICE.address, privacy: "shielded" }, overview({ shieldedBalance: { value: "5000000000", spendable: "1000" } }), send);
    await settle();
    const body = dom.document.body;
    // 1 DUSK and the 0.05 DUSK fee, from the 1000 Lux that can be spent now: of the shielded balance, rounded up.
    const guard = body.querySelector(".pay-guard").textContent;
    expect(guard).toBe(shortfallText({ missingLux: 1_049_999_000n, shielded: true }));
    expect(guard).toEqual(saying("1.05 DUSK"));
    expect(guard).toEqual(ONLY_SHIELDED);
    review({ to: ALICE.account, privacy: "public" }, overview({ balance: null }), send);
    await settle();
    expect(isShown(body.querySelector(".pay-guard"))).toBe(false);
    expect(confirmButton().disabled).toBe(false);
  });

  it("shows a memo in the order it was written, flags what it hides, and sends it as it is", async () => {
    const rlo = String.fromCodePoint(0x202e);
    const memo = `${rlo}gnp.exe claim your airdrop`;
    const sent = [];
    const send = async (message) => {
      if (message.type === "DUSK_UI_SEND_TX") sent.push(message);
      return message.type === "DUSK_UI_GET_CACHED_GAS_PRICE" ? { min: "1", median: "1", max: "1" } : { ok: true, result: { hash: "ab".repeat(32) } };
    };
    review({ to: ALICE.account, privacy: "public", memo }, overview(), send);
    await settle();
    const body = dom.document.body;
    const row = body.querySelectorAll(".kv").find((kv) => kv.querySelector(".kv-label")?.textContent === "Memo");
    expect(row.querySelector(".safe-text > span").textContent).toBe("\\u202egnp.exe claim your airdrop");
    expect(row.querySelector(".safe-text__flag")).not.toBeNull();
    expect(visibleText(body)).not.toContain(rlo);
    pastClickGuard();
    confirmButton().click();
    await settle();
    expect(sent[0].params.memo).toBe(memo);
  });

  // Chen's, Sofía's, Nandini's and Amélie's: Home's Send it now opens Review with the payment Home said wasn't sent,
  // and Confirm sends it in that one's place, which Home keeps saying till it's handed over.
  it("sends a payment from Home's Send it now in the place of the one Home said wasn't sent", async () => {
    const sent = [];
    const send = async (message) => {
      if (message.type === "DUSK_UI_SEND_TX") sent.push(message);
      return message.type === "DUSK_UI_GET_CACHED_GAS_PRICE" ? { min: "1", median: "1", max: "1" } : { ok: true, result: { hash: "ab".repeat(32) } };
    };
    const here = overview();
    const reviewedFor = `${here.accounts[0]} ${Number(here.selectedAccountIndex ?? 0)} ${here.nodeUrl}`;
    review({ to: ALICE.account, privacy: "public", memo: "Factura 141", replaces: "send-kept-1", reviewedFor }, here, send);
    await settle();
    pastClickGuard();
    confirmButton().click();
    await settle();
    expect(sent).toEqual([expect.objectContaining({ replaces: "send-kept-1", params: expect.objectContaining({ memo: "Factura 141" }) })]);
  });

  // Astra's: Send it now, Back to the form and Review again sent it, and Home kept saying the first wasn't sent.
  it("keeps sending it in the place of the one Home said wasn't sent after Back and Review, while it's that payment", async () => {
    const here = overview();
    const draft = { to: ALICE.account, privacy: "public", amountLux: "10000000", amountDusk: "0.01", memo: "Factura 141", replaces: "send-kept-1", reviewedFor: `${here.accounts[0]} ${Number(here.selectedAccountIndex ?? 0)} ${here.nodeUrl}` };
    const backAndReview = async (change) => {
      const state = { ...newState(), draft: { ...draft } };
      const form = mount(state, here);
      await settle();
      change?.(form);
      form.review.click();
      await settle();
      return state;
    };
    expect((await backAndReview()).draft).toMatchObject({ amountLux: "10000000", memo: "Factura 141", replaces: "send-kept-1" });
    // Another amount: another payment, sent as itself.
    const changed = await backAndReview((form) => typeInto(form.amount, "0.02"));
    expect([changed.route, changed.draft.amountLux, changed.draft.replaces]).toEqual(["confirm", "20000000", undefined]);
  });

  // Astra's: after Send it now, another profile, wallet or network chosen (here or in another window), its Review
  // sent it from there, in the place of the first, whose record went.
  it("sends a payment Home said wasn't sent again only from where it was made, else goes back to Home", async () => {
    const here = overview();
    const context = `${here.accounts[0]} ${Number(here.selectedAccountIndex ?? 0)} ${here.nodeUrl}`;
    const sent = [];
    const send = async (message) => {
      if (message.type === "DUSK_UI_SEND_TX") sent.push(message);
      return message.type === "DUSK_UI_GET_CACHED_GAS_PRICE" ? { min: "1", median: "1", max: "1" } : { ok: true, result: { hash: "ab".repeat(32) } };
    };
    const retry = { to: ALICE.account, privacy: "public", amountLux: "10000000", amountDusk: "0.01", memo: "Factura 141", replaces: "send-kept-1", reviewedFor: context };
    for (const elsewhere of [{ selectedAccountIndex: 1 }, { nodeUrl: "https://nodes.dusk.network" }, { accounts: ["another-wallet", ...here.accounts.slice(1)] }]) {
      const state = { ...newState(), route: "confirm", draft: { ...retry } };
      const view = mount(state, { ...here, ...elsewhere }, send);
      expect([state.route, state.draft], JSON.stringify(elsewhere)).toEqual(["home", null]);
      // It says so, and there's nothing to confirm.
      expect(view.actions.showToast).toHaveBeenCalledOnce();
      expect(confirmButton()).toBeNull();
    }
    expect(sent).toEqual([]);
    // Back to the form from its Review, then another profile: Review again sends it as a payment of its own.
    const state = { ...newState(), draft: { ...retry } };
    const form = mount(state, { ...here, selectedAccountIndex: 1 });
    await settle();
    form.review.click();
    await settle();
    expect([state.route, state.draft.replaces]).toEqual(["confirm", undefined]);
  });

  it("says on Review when a memo's number may not read as its digits do", async () => {
    // Marek's memo, from a link: an Arabic-Indic zero in 105.
    review({ to: ALICE.account, privacy: "public", memo: "Invoice 1\u06605" }, overview());
    await settle();
    const row = dom.document.body.querySelectorAll(".kv").find((kv) => kv.querySelector(".kv-label")?.textContent === "Memo");
    expect(row.querySelectorAll(".safe-text__flag").map((el) => el.textContent)).toEqual([numbersText({ mixedDigits: true })]);
  });

  it("shows the fee at the network's price and the total, and sends gas of your own from Custom fee", async () => {
    // The node asks 2 LUX; a transfer returns its hash.
    const send = async (message) =>
      message.type === "DUSK_UI_GET_CACHED_GAS_PRICE"
        ? { min: "1", median: "2", max: "5" }
        : { ok: true, result: { hash: "ab".repeat(32) } };
    const view = review({ to: ALICE.account, privacy: "public" }, overview(), send);
    await settle();
    const body = dom.document.body;
    expect(feeAndTotal()).toEqual([saying("0.005 DUSK"), saying("1.005 DUSK")]);

    // A gas price of your own, under Custom fee, is what Confirm sends.
    const price = body.querySelectorAll("dusk-gas-editor input")[1];
    typeInto(price, "1");
    confirmButton().click();
    await settle();
    expect(view.actions.send).toHaveBeenLastCalledWith({
      type: "DUSK_UI_SEND_TX",
      params: expect.objectContaining({ to: ALICE.account, privacy: "public", gas: { limit: "2500000", price: "1" } }),
      walletId: overview().accounts[0],
      // A payment that can wait for the network, called off by its ID, with the most its fee costs.
      sendId: expect.stringMatching(/^[\w-]{8,64}$/),
      feeCapLux: "2500000",
      toName: undefined,
    });
  });

  // Marek's: the default followed the mempool's median with no ceiling, so a spammed mempool could raise every
  // default fee; Lena's: the two wallets paid different prices for the same unstake. Both use app-core's one rule.
  it("starts from the network's median up to a ceiling, saying the network is busy while the price in use is under its median", async () => {
    const at = (median) => async (message) =>
      message.type === "DUSK_UI_GET_CACHED_GAS_PRICE" ? { min: "1", median, max: "1000" } : { ok: true, result: { hash: "ab".repeat(32) } };
    const busy = () => {
      const note = dom.document.body.querySelector("dusk-gas-editor .gas-busy");
      return note && isShown(note) ? note.textContent : "";
    };

    // A median of 900 over the ceiling of 5: the ceiling, and why.
    review({ to: ALICE.account, privacy: "public" }, overview(), at("900"));
    await settle();
    expect(feeAndTotal()).toEqual([saying("0.0125 DUSK"), saying("1.0125 DUSK")]);
    expect(busy()).toBe(GAS_PRICE_BUSY);
    // Raised to the median or over: the price is theirs, and nothing more is said.
    typeInto(dom.document.body.querySelectorAll("dusk-gas-editor input")[1], "900");
    expect(busy()).toBe("");

    // A median of 2: the median, nothing said.
    review({ to: ALICE.account, privacy: "public" }, overview(), at("2"));
    await settle();
    expect([...feeAndTotal(), busy()]).toEqual([saying("0.005 DUSK"), saying("1.005 DUSK"), ""]);
  });

  // Lena's, three rounds: a default worked out from the mempool's median made one waiting transaction everyone's
  // price, as Sozu's activation at 2 after a stake. What waits fits in a block: the minimum.
  it.each([
    ["a public transfer", () => ({ to: ALICE.account, privacy: "public" })],
    ["a shielded transfer", () => ({ to: ALICE.address, privacy: "shielded" })],
  ])("starts %s from the minimum with one transaction waiting at 2, and from the capped median with a full mempool", async (_, draft) => {
    const priceSent = async (stats) => {
      const sent = [];
      const send = async (message) => {
        if (message.type === "DUSK_UI_SEND_TX") sent.push(message);
        return message.type === "DUSK_UI_GET_CACHED_GAS_PRICE" ? stats : { ok: true, result: { hash: "ab".repeat(32) } };
      };
      review(draft(), overview({ shieldedBalance: { value: "5000000000", spendable: "5000000000" } }), send);
      await settle();
      const busy = visibleText(dom.document.body.querySelector("dusk-gas-editor .gas-busy") ?? { textContent: "" });
      pastClickGuard();
      confirmButton().click();
      await settle();
      return [sent[0]?.params.gas?.price, busy];
    };
    expect(await priceSent({ mempool: [{ gasPrice: "2", gasLimit: "6000000" }] })).toEqual(["1", ""]);
    const full = { mempool: Array.from({ length: 1000 }, () => ({ gasPrice: "900", gasLimit: "2500000" })) };
    expect(await priceSent(full)).toEqual(["5", GAS_PRICE_BUSY]);
  });

  it("says what a public send shows everyone, with only the parts that apply, and nothing for a shielded one", async () => {
    let view = review({ to: ALICE.account, privacy: "public" });
    expect([view.kind(), view.visibleLine()]).toEqual([ONLY_PUBLIC, saying()]);
    expect(view.visibleLine()).not.toMatch(/memo/i);

    // With a memo, and the profile's verified name.
    lookupPrimaryName.mockImplementation(async (account) => (account === OWN.account ? "me.dusk" : null));
    view = review({ to: ALICE.account, privacy: "public", memo: "Lunch" });
    await settle();
    expect(view.visibleLine()).toEqual(saying("me.dusk"));
    expect(view.visibleLine()).toMatch(/memo/i);

    view = review({ to: ALICE.address, privacy: "shielded", memo: "Lunch" });
    await settle();
    expect([view.kind(), view.visibleLine()]).toEqual([ONLY_SHIELDED, null]);

    // A name shows over the full address it resolved to.
    view = review({
      to: ALICE.address,
      privacy: "shielded",
      duskName: { name: "alice.dusk", nodeUrl: overview().nodeUrl, to: ALICE.address },
    });
    expect([view.toNames(), view.toAddress()]).toEqual(["alice.dusk", ALICE.address]);
  });

  describe("a name read through a node the wallet doesn't know", () => {
    const CUSTOM = "https://my-node.example:8443";
    // Whose word a name is: the node's, by its host.
    const NOTE = saying("my-node.example:8443");
    const custom = (over = {}) => overview({ nodeUrl: CUSTOM, ...over });
    const noted = () => dom.document.body.querySelectorAll('[role="note"]').filter(isShown).map(visibleText);

    beforeEach(() => {
      noteChainId(CUSTOM, 2);
    });
    afterEach(() => {
      noteChainId(CUSTOM, null);
    });

    it("says whose word it is under a typed name, and takes the address as it is", async () => {
      const form = mount(newState(), custom());
      typeInto(form.to, "alice.dusk");
      await settle();
      expect(visibleText(form.nameBox().querySelector('[role="note"]'))).toEqual(NOTE);
      expect(noted()).toEqual([NOTE]);
    });

    it("says nothing on a network's own node", async () => {
      const form = mount(newState(), overview());
      typeInto(form.to, "alice.dusk");
      await settle();
      expect(form.nameBox().querySelector(".name-option")).toBeTruthy();
      expect(noted()).toEqual([]);
    });

    it("doesn't call a pasted account's name verified, and says whose word it is", async () => {
      lookupPrimaryName.mockImplementation(async (account) => (account === BOB.account ? "bob.dusk" : null));
      const form = mount(newState(), custom());
      typeInto(form.to, BOB.account);
      await settle();
      // The name, and what it says of it.
      const name = (box) => [".name-verified__name", ".name-verified__note"].map((part) => visibleText(box.querySelector(part)));
      expect(name(form.nameBox())).toEqual(["bob.dusk", expect.not.stringMatching(/verified/i)]);
      expect(form.nameBox().querySelector(".name-verified .btn-ico")).toBeNull();
      expect(noted()).toEqual([NOTE]);

      // Verified, on a network's own node.
      const own = mount(newState(), overview());
      typeInto(own.to, BOB.account);
      await settle();
      expect(name(own.nameBox())).toEqual(["bob.dusk", expect.stringMatching(/verified/i)]);
      expect(noted()).toEqual([]);
    });

    it("says so on Review under To, for a typed name and a pasted account's, and not with no name", async () => {
      const ov = custom();
      let view = review({ to: ALICE.address, privacy: "shielded", duskName: { name: "alice.dusk", nodeUrl: CUSTOM, to: ALICE.address } }, ov);
      await settle();
      expect([view.toNames(), view.toAddress()]).toEqual(["alice.dusk", ALICE.address]);
      expect(noted()).toContainEqual(NOTE);

      lookupPrimaryName.mockImplementation(async (account) => (account === BOB.account ? "bob.dusk" : null));
      view = review({ to: BOB.account, privacy: "public" }, ov);
      await settle();
      expect([view.toNames(), view.toAddress()]).toEqual(["bob.dusk", BOB.account]);
      expect(noted()).toContainEqual(NOTE);

      lookupPrimaryName.mockImplementation(async () => null);
      view = review({ to: ALICE.account, privacy: "public" }, ov);
      await settle();
      expect([view.toNames(), view.toAddress()]).toEqual(["", ALICE.account]);
      expect(noted()).not.toContainEqual(NOTE);
    });
  });

  it("sends the .dusk name the recipient was typed as, for Activity, and none for a pasted address", async () => {
    const send = async (message) =>
      message.type === "DUSK_UI_GET_CACHED_GAS_PRICE"
        ? { min: "1", median: "1", max: "1" }
        : { ok: true, result: { hash: "ab".repeat(32) } };
    const confirm = async (draft) => {
      const view = review(draft, overview(), send);
      await settle();
      confirmButton().click();
      await settle();
      return view.actions.send.mock.calls.find(([m]) => m.type === "DUSK_UI_SEND_TX")[0];
    };
    const named = await confirm({
      to: ALICE.account,
      privacy: "public",
      duskName: { name: "alice.dusk", nodeUrl: overview().nodeUrl, to: ALICE.account },
    });
    expect(named.toName).toBe("alice.dusk");
    const pasted = await confirm({ to: ALICE.account, privacy: "public" });
    expect(pasted.toName).toBeUndefined();
  });
});

describe("a send to the bridge's account", () => {
  const MAINNET = overview({ nodeUrl: "https://nodes.dusk.network" });
  const [mainnet, testnet] = [networks.mainnet, networks.testnet].map((net) => routes(net).find((route) => route.kind === "service"));
  // A checksummed EVM address, as the bridge's own fixtures have it.
  const EVM = fixtures.calls.find((c) => c.name === "deposit-shoot").expected.to;
  const DRAFT = { amountDusk: "2", amountLux: "2000000000", privacy: "public", to: mainnet.account, memo: EVM };
  const review = (draft, ov = MAINNET, send) => mount({ route: "confirm", addressBook: { loaded: true, items: [] }, draft: { ...DRAFT, ...draft } }, ov, send);
  // The transfer as the wallet reads it (bridgeCalls.js): what's sent, the bridge's fee, what arrives, and where.
  const serviceOf = (draft, ov = MAINNET) => {
    const d = { ...DRAFT, ...draft };
    return bridgeServiceTransfer({ nodeUrl: ov.nodeUrl, to: d.to, memo: d.memo, amount: d.amountLux });
  };
  const body = () => dom.document.body;
  const text = (selector) => visibleText(body().querySelector(selector));
  // Each warning shown: its title, and its line.
  const warnings = () => body().querySelectorAll(".callout.warn").filter(isShown).map((note) => [visibleText(note.querySelector(".callout-title")), visibleText(note.querySelector(".muted"))]);
  // The row the memo shows in, named for what it is here: its label, and the address it holds.
  const memoRow = () => {
    const row = body().querySelectorAll(".send-review .kv").find((kv) => visibleText(kv.querySelector(".kv-value") ?? kv).includes(EVM));
    return [visibleText(row.querySelector(".kv-label")), visibleText(row.querySelector(".kv-value"))];
  };
  const confirm = confirmButton;

  it("shows the memo that carries the recipient's address exactly, unflagged", async () => {
    review();
    await settle();
    expect(memoRow()).toEqual([saying("BNB Smart Chain"), EVM]);
    expect(body().querySelector(".send-review .safe-text__flag")).toBeNull();
  });

  it("says what arrives on BNB Smart Chain once the bridge takes its 1 DUSK fee, and to whom", async () => {
    // 3 DUSK sent: the bridge's 1 DUSK fee, and the 2 DUSK that arrive on BNB Smart Chain, said as the wallet says it.
    const draft = { amountDusk: "3", amountLux: "3000000000" };
    const view = review(draft);
    await settle();
    const service = serviceOf(draft);
    expect([service.chain, service.feeLux, service.arrivesLux]).toEqual(["BNB Smart Chain", 1_000_000_000n, 2_000_000_000n]);
    expect(text(".review-bridge-fee")).toBe(bridgeServiceLine(service));
    expect(text(".review-bridge-fee")).not.toMatch(/nothing/i);
    expect(view.kind()).toEqual(saying("BNB Smart Chain"));
    expect([view.toNames(), view.toAddress()]).toEqual([saying("BNB Smart Chain"), mainnet.account]);
    expect(view.visibleLine()).toEqual(saying("BNB Smart Chain"));
    expect(memoRow()).toEqual([saying("BNB Smart Chain"), EVM]);
    expect(warnings()).toEqual([]);
    expect(confirm().disabled).toBe(false);
    // No name to look up for the bridge's account.
    expect(lookupPrimaryName.mock.calls.map(([account]) => account)).not.toContain(mainnet.account);
  });

  it("keeps Confirm off when the fee takes the whole amount, as nothing would arrive", async () => {
    const draft = { amountDusk: "1", amountLux: "1000000000" };
    const view = review(draft);
    await settle();
    // Its 1 DUSK fee takes it all: nothing arrives, and the line and the reason say so.
    const service = serviceOf(draft);
    expect([service.feeLux, service.arrivesLux]).toEqual([1_000_000_000n, 0n]);
    expect(text(".review-bridge-fee")).toBe(bridgeServiceLine(service));
    expect(text(".review-bridge-fee")).toMatch(/nothing/i);
    expect(body().querySelector(".review-actions > .field-error").textContent).toEqual(saying("1 DUSK"));
    expect(confirm().disabled).toBe(true);
    confirm().click();
    await settle();
    expect(view.actions.send.mock.calls.some(([m]) => m.type === "DUSK_UI_SEND_TX")).toBe(false);
  });

  it.each([
    ["isn't an address on BNB Smart Chain", { memo: "Order 1042" }, MAINNET, "BNB Smart Chain"],
    ["is missing", { memo: "" }, MAINNET, "BNB Smart Chain"],
    ["isn't an address on Sepolia", { to: testnet.account, memo: "Order 1042" }, overview(), "Sepolia"],
  ])("keeps Confirm off when the memo %s, as nothing would arrive", async (_, draft, ov, chain) => {
    const view = review(draft, ov);
    await settle();
    // Why: no address on the chain it pays, by that chain.
    expect([serviceOf(draft, ov).chain, serviceOf(draft, ov).recipientOk]).toEqual([chain, false]);
    expect(body().querySelectorAll(".review-actions > .field-error").filter(isShown).map((e) => e.textContent)).toEqual([saying(noBridgeRecipientText(chain))]);
    expect(confirm().disabled).toBe(true);
    confirm().click();
    await settle();
    expect(view.actions.send.mock.calls.some(([m]) => m.type === "DUSK_UI_SEND_TX")).toBe(false);
  });

  it("says the testnet bridge to Sepolia isn't running right now, and checks the memo is an address there", async () => {
    review({ to: testnet.account }, overview());
    await settle();
    // Not running: its one warning, and a line where nothing arrives on Sepolia.
    const paused = serviceOf({ to: testnet.account }, overview());
    expect([paused.chain, paused.running]).toEqual(["Sepolia", false]);
    expect(bridgeServiceWarnings(paused).map((note) => note.kind)).toEqual(["off"]);
    expect(warnings()).toEqual(bridgeServiceWarnings(paused).map((note) => [note.title, note.text]));
    expect(text(".review-bridge-fee")).toBe(bridgeServiceLine(paused));
    expect(text(".review-bridge-fee")).toMatch(/nothing/i);

    review({ memo: "Order 1042" });
    await settle();
    // A memo that's no address on BNB Smart Chain: its warning names that chain, and the line doesn't say anything arrives.
    const unpaid = serviceOf({ memo: "Order 1042" });
    expect([unpaid.chain, unpaid.recipientOk]).toEqual(["BNB Smart Chain", false]);
    expect(warnings().map(([title]) => title)).toEqual([saying("BNB Smart Chain")]);
    expect(text(".review-bridge-fee")).toBe(bridgeServiceLine(unpaid));
    expect(text(".review-bridge-fee")).toMatch(/nothing/i);
  });

  it("is a plain transfer to another network's bridge account", async () => {
    const view = review({}, overview());
    await settle();
    expect(view.kind()).toEqual(ONLY_PUBLIC);
    expect(body().querySelector(".review-bridge-fee")).toBeNull();
  });
});

describe("a name and the recipient Contacts sets", () => {
  // Contacts sets the recipient as addressbook.js does: the rest of the draft stays.
  const setFromContacts = (state, address) => {
    state.draft = { ...state.draft, to: address };
    state.route = "confirm";
  };
  // Review's To: the names it goes by, and its address.
  const reviewTo = () => [".review-to__names", ".review-to__address"].map((part) => visibleText(dom.document.body.querySelector(part)));

  it.each([
    ["picking another contact", BOB.account],
    ["saving an edited address", vary(ACCOUNT, 7)],
  ])("drops the name after %s from Review", async (_label, address) => {
    const state = newState();
    let form = mount(state);
    typeInto(form.to, "alice.dusk");
    typeInto(form.amount, "1");
    form.review.click();
    await settle();
    expect(state.draft.duskName).toEqual({ name: "alice.dusk", nodeUrl: overview().nodeUrl, to: ALICE.account });
    mount(state);
    expect(reviewTo()).toEqual(["alice.dusk", ALICE.account]);

    setFromContacts(state, address);
    mount(state);
    expect(reviewTo()).toEqual(["", address]);

    // Back from Review shows the contact's address, not the name.
    dom.document.body.querySelector(".subnav-back").click();
    form = mount(state);
    expect(form.to.value).toBe(address);
    expect(dom.document.body.querySelector(".name-points-to")).toBeNull();
  });

  it("makes Review public when Contacts saves a shielded name's address as a public account", async () => {
    const state = newState();
    const form = mount(state);
    typeInto(form.to, "alice.dusk");
    form.radios()[1].click();
    typeInto(form.amount, "1");
    form.review.click();
    await settle();
    expect(state.draft).toMatchObject({ to: ALICE.address, privacy: "shielded" });

    // Save to Contacts, with the address edited to a public account.
    setFromContacts(state, BOB.account);
    const review = mount(state);
    expect([review.kind(), review.visibleLine()]).toEqual([ONLY_PUBLIC, saying()]);

    confirmButton().click();
    await settle();
    expect(review.actions.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "DUSK_UI_SEND_TX",
        params: expect.objectContaining({ privacy: "public", to: BOB.account }),
        walletId: overview().accounts[0],
      })
    );
  });
});

describe("a new contact from a name", () => {
  it("gets the address the name sends to, not the name", () => {
    const state = newState();
    const form = mount(state);
    const contacts = contactsButton();

    typeInto(form.to, "alice.dusk");
    contacts.click();
    expect(state.route).toBe("contacts");
    expect(state.addressBook).toMatchObject({ mode: "pick", prefillAddress: ALICE.account });

    // The picked card's address, which Send pays.
    form.radios()[1].click();
    contacts.click();
    expect(state.addressBook.prefillAddress).toBe(ALICE.address);

    // A pasted account goes as typed, and a name that didn't resolve gives no address.
    for (const [value, prefill] of [[BOB.account, BOB.account], ["nobody.dusk", ""]]) {
      typeInto(form.to, value);
      contacts.click();
      expect(state.addressBook.prefillAddress).toBe(prefill);
    }
  });

  it("gets no address while the name is still being looked up, and its address once it resolves", async () => {
    const state = newState();
    const form = mount(state);
    const contacts = contactsButton();
    let finish;
    const pending = new Promise((resolve) => (finish = resolve));
    lookupDuskName.mockImplementation(() => ({ result: undefined, promise: pending }));

    typeInto(form.to, "alice.dusk");
    contacts.click();
    expect(state.addressBook.prefillAddress).toBe("");

    finish(NAMES["alice.dusk"]);
    await settle();
    contacts.click();
    expect(state.addressBook.prefillAddress).toBe(ALICE.account);
  });
});

describe("going back to a name while it is looked up", () => {
  it("keeps the newer lookup's answer when the older one fails after it", async () => {
    const form = mount(newState());
    // Each lookup answers when the test says, in any order.
    const answers = [];
    lookupDuskName.mockImplementation(() => {
      let answer;
      const promise = new Promise((resolve) => (answer = resolve));
      answers.push(answer);
      return { result: null, promise };
    });

    // Back to alice.dusk after bob.dusk starts a second lookup of it.
    for (const name of ["alice.dusk", "bob.dusk", "alice.dusk"]) typeInto(form.to, name);
    expect(lookupDuskName.mock.calls.map(([name]) => name)).toEqual(["alice.dusk", "bob.dusk", "alice.dusk"]);
    answers[2](NAMES["alice.dusk"]);
    await settle();
    expect(form.picked()).toEqual(["true", "false"]);
    expect(form.review.disabled).toBe(false);

    // The first lookup fails after that, and bob.dusk's lookup answers last.
    answers[0]({ ok: false, name: "alice.dusk", reason: "lookup_failed" });
    answers[1](NAMES["bob.dusk"]);
    await settle();
    expect(visibleText(dom.document.body.querySelector(".name-points-to"))).toEqual(saying("alice.dusk"));
    expect(form.picked()).toEqual(["true", "false"]);
    expect(form.review.disabled).toBe(false);
  });
});

describe("a slow name lookup on Review", () => {
  it.each([
    [
      "the user leaves Send",
      (state) => {
        state.route = "home";
        state.draft = null;
        dom.document.body.replaceChildren();
      },
      { route: "home", draft: null },
    ],
    ["a redraw replaces the form", (state) => mount(state), { route: "send" }],
    [
      "the user goes to another name and back",
      (_state, form) => ["bob.dusk", "alice.dusk"].forEach((name) => typeInto(form.to, name)),
      { route: "send" },
    ],
  ])("changes nothing when %s first", async (_label, leave, after) => {
    const state = newState();
    const form = mount(state);
    typeInto(form.to, "alice.dusk");
    typeInto(form.amount, "1");
    let finish;
    const pending = new Promise((resolve) => (finish = resolve));
    lookupDuskName.mockImplementation(() => ({ result: undefined, promise: pending }));

    form.review.click();
    leave(state, form);
    finish(NAMES["alice.dusk"]);
    await settle();

    expect(state).toMatchObject(after);
    if (after.route === "send") expect(state.draft.duskName).toBeUndefined();
  });
});

describe("a request for another network", () => {
  const note = () => dom.document.body.querySelectorAll(".field-error").find((el) => isShown(el));
  const filled = () => {
    const el = dom.document.body.querySelector(".send-filled-note");
    return el && isShown(el) ? el.textContent : "";
  };

  it("fills in nothing, Amount and Memo emptied, To keeping what was put in it, and it says why", async () => {
    // A Mainnet request link put in To on Testnet, over a form being filled in: nothing of it stays to read as the link's.
    const state = newState();
    const form = mount(state);
    typeInto(form.to, BOB.account);
    typeInto(form.amount, "0.5");
    form.to.value = `dusk:public-${ALICE.account}@dusk:1?amount=1&memo=Invoice+9`;
    form.to.dispatchEvent(fakeEvent("blur"));
    await settle();

    expect(note()?.textContent).toBe(FOR_MAINNET);
    const link = `dusk:public-${ALICE.account}@dusk:1?amount=1&memo=Invoice+9`;
    expect([form.to.value, form.amount.value]).toEqual([link, ""]);
    expect(state.draft).toMatchObject({ to: link, amountDusk: "", memo: "" });
    expect(filled()).toBe("");

    // Review goes nowhere, and Send drawn again still says why.
    form.review.click();
    await settle();
    expect(state.route).toBe("send");
    const again = mount(state);
    expect(note()?.textContent).toBe(FOR_MAINNET);

    // A recipient typed instead takes it away, for good.
    typeInto(again.to, BOB.account);
    expect(note()).toBeUndefined();
    mount(state);
    expect(note()).toBeUndefined();
  });

  it("fills in nothing of the page a link opened, and nothing of a request once the network changes", async () => {
    vi.stubGlobal("location", { pathname: "/full.html", search: `?route=send&link=${encodeURIComponent(`https://apps.dusk.network/wallet/dashboard/send?to=${ALICE.account}&amount=0.001&memo=Rent`)}` });
    vi.resetModules();
    const { state } = await import("./popup/state.js");
    const opened = mount(state);
    expect([opened.to.value, opened.amount.value, state.draft.memo]).toEqual(["", "", ""]);
    expect(note()?.textContent).toBe(FOR_MAINNET);

    // Filled in on Testnet, then the wallet went to Mainnet.
    const filledIn = newState();
    filledIn.draft = { to: ALICE.account, amountDusk: "2.5", memo: "Rent", requestChainId: "dusk:2", filledFrom: "link" };
    expect(mount(filledIn).to.value).toBe(ALICE.account);
    const moved = mount(filledIn, overview({ nodeUrl: "https://nodes.dusk.network" }));
    expect([moved.to.value, moved.amount.value, filledIn.draft.memo]).toEqual(["", "", ""]);
    expect(note()?.textContent).toBe(chainMismatchText("dusk:2", "https://nodes.dusk.network"));
    expect(filled()).toBe("");
  });

  it("can't be confirmed, however it reached Review", () => {
    mount({ route: "confirm", draft: { to: ALICE.account, privacy: "public", amountLux: "1000000000", amountDusk: "1", memo: "", requestChainId: "dusk:1" } });
    const body = dom.document.body;
    expect(confirmButton().disabled).toBe(true);
    expect(visibleText(body.querySelector(".review-actions .send-chain-note"))).toBe(FOR_MAINNET);
  });

  it("goes by the chain a custom node signs for, and calls it by its node", async () => {
    const custom = { ...overview(), nodeUrl: "https://node.example", chainId: 2 };
    noteChainId(custom.nodeUrl, custom.chainId);
    const state = newState();
    state.draft = { to: ALICE.account, requestChainId: "dusk:2" };
    expect(mount(state, custom).to.value).toBe(ALICE.account);
    expect(note()).toBeUndefined();
    state.draft = { to: ALICE.account, requestChainId: "dusk:1" };
    expect(mount(state, custom).to.value).toBe("");
    expect(note()?.textContent).toBe(chainMismatchText("dusk:1", custom.nodeUrl));
    expect(note()?.textContent).toEqual(saying("node.example"));
  });
});

describe("the password on big sends", () => {
  const LIMIT = "5000000000";
  const reviewAt = (amountLux) => {
    const ov = overview({ sendPasswordLimit: LIMIT, balance: { value: "20000000000" } });
    const state = { route: "confirm", overview: ov, draft: { to: ALICE.account, privacy: "public", amountLux, amountDusk: "6", memo: "" } };
    const sent = [];
    const answers = {
      DUSK_UI_GET_CACHED_GAS_PRICE: () => ({}),
      DUSK_UI_SEND_PASSWORD_ASKS: () => ({ ok: true, result: { limit: LIMIT, moves: amountLux, always: false } }),
      DUSK_UI_SEND_PASSWORD_PROVE: ({ password }) => (password === "the password" ? { ok: true, result: "ticket-1" } : { error: { message: "Incorrect password" } }),
      DUSK_UI_SEND_TX: () => ({ ok: true, result: { hash: "ab".repeat(32) } }),
    };
    const view = mount(state, ov, async (message) => {
      sent.push(message);
      return answers[message.type]?.(message) ?? {};
    });
    const body = dom.document.body;
    const confirm = confirmButton;
    const dialog = () => body.querySelector(".send-password");
    const password = () => dialog().querySelector("input[type=password]");
    // What the dialog says is wrong, under the password.
    const error = () => {
      const el = dialog().querySelector(".field-error");
      return isShown(el) ? el.textContent : "";
    };
    // The dialog's Confirm, and its Cancel: the button that takes you back.
    const submit = () => dialog().querySelector(".btn-primary").click();
    const cancel = () => dialog().querySelector("[data-back]").click();
    const sends = () => sent.filter((m) => m.type === "DUSK_UI_SEND_TX");
    return { ...view, state, sent, answers, body, confirm, dialog, password, error, submit, cancel, sends };
  };
  const pressConfirm = async (view) => {
    pastClickGuard();
    view.confirm().click();
    await settle();
  };

  it("asks over the Review before anything of it goes, and sends with what the wallet gave for it", async () => {
    const view = reviewAt("6000000000");
    await pressConfirm(view);
    // It asks, saying the amount it's set to ask above.
    expect(view.password()).not.toBeNull();
    const why = visibleText(view.dialog().querySelector(".settings-note"));
    expect(why).toBe(sendPasswordWhy({ limit: LIMIT, always: false }));
    expect(why).toEqual(saying("5 DUSK"));
    expect(view.sends()).toEqual([]);
    // The Review stays under it: no Sent screen yet.
    expect(view.state.route).toBe("confirm");

    typeInto(view.password(), "the password");
    view.submit();
    await settle();
    await settle();
    expect(view.dialog()).toBeNull();
    expect(view.sends()).toHaveLength(1);
    expect(view.sends()[0].sendTicket).toBe("ticket-1");
    expect(JSON.stringify(view.sends()[0])).not.toContain("the password");
    expect(view.state.route).toBe("sent");
  });

  it("stays on a wrong password, says so, and sends nothing", async () => {
    const view = reviewAt("6000000000");
    await pressConfirm(view);
    typeInto(view.password(), "not it");
    view.submit();
    await settle();
    expect(view.error()).toEqual(saying());
    expect(view.password().value).toBe("");
    expect(view.sends()).toEqual([]);
    // Nothing typed says so too, and asks the wallet nothing.
    typeInto(view.password(), "");
    expect(view.error()).toBe("");
    view.submit();
    await settle();
    expect(view.error()).toEqual(saying());
    expect(view.sent.filter((m) => m.type === "DUSK_UI_SEND_PASSWORD_PROVE")).toHaveLength(1);
  });

  it("goes back to the Review on Cancel or Escape, with nothing sent and Confirm on again", async () => {
    const view = reviewAt("6000000000");
    await pressConfirm(view);
    view.cancel();
    await settle();
    expect(view.dialog()).toBeNull();
    expect(view.sends()).toEqual([]);
    expect(view.state.route).toBe("confirm");
    // It says nothing was sent.
    expect(view.actions.showToast).toHaveBeenCalledWith(saying());
    expect(view.confirm().disabled).toBe(false);

    await pressConfirm(view);
    dom.document.body.dispatchEvent(fakeEvent("keydown", { key: "Escape" }));
    await settle();
    expect(view.dialog()).toBeNull();
    expect(view.sends()).toEqual([]);
    expect(view.confirm().disabled).toBe(false);
  });

  // Chen's: fingerprint unlock on, and still a password box for the big send.
  it("takes a fingerprint for it in the app where fingerprint unlock is on, the password left to type", async () => {
    const asked = [];
    let kept = "the password";
    dom.window.__TAURI_INTERNALS__ = {
      invoke: vi.fn(async (cmd, args) => {
        if (cmd !== "fingerprint") return null;
        asked.push(args.action);
        if (args.action === "status") return { ok: true, available: true, on: true };
        if (args.action === "unlock") return { ok: true, secret: kept };
        return { ok: true };
      }),
    };
    const view = reviewAt("6000000000");
    await pressConfirm(view);
    await vi.waitFor(() => expect(view.sends()).toHaveLength(1));
    expect(view.sends()[0].sendTicket).toBe("ticket-1");
    expect(asked).toEqual(["status", "unlock"]);
    expect(view.dialog()).toBeNull();

    // The password kept is an old one: off, said, and the box to type in.
    kept = "an old password";
    const again = reviewAt("6000000000");
    await pressConfirm(again);
    await vi.waitFor(() => expect(asked.at(-1)).toBe("disable"));
    await settle();
    expect(again.error()).toEqual(saying());
    expect(again.sends()).toEqual([]);
    typeInto(again.password(), "the password");
    again.submit();
    await vi.waitFor(() => expect(again.sends()).toHaveLength(1));
  });

  it("asks nothing up to the amount, or with it off", async () => {
    const view = reviewAt("1000000000");
    view.answers.DUSK_UI_SEND_PASSWORD_ASKS = () => ({ ok: true, result: null });
    await pressConfirm(view);
    await settle();
    expect(view.dialog()).toBeNull();
    expect(view.sends()).toHaveLength(1);
    expect(view.sends()[0].sendTicket).toBeUndefined();

    const off = { route: "confirm", overview: overview(), draft: { to: ALICE.account, privacy: "public", amountLux: "6000000000", amountDusk: "6", memo: "" } };
    const sent = [];
    mount(off, off.overview, async (message) => {
      sent.push(message);
      return message.type === "DUSK_UI_SEND_TX" ? { ok: true, result: { hash: "ab".repeat(32) } } : {};
    });
    pastClickGuard();
    confirmButton().click();
    await settle();
    await settle();
    expect(sent.some((m) => m.type === "DUSK_UI_SEND_PASSWORD_ASKS")).toBe(false);
    expect(sent.filter((m) => m.type === "DUSK_UI_SEND_TX")).toHaveLength(1);
  });

  it("says why nothing went when the wallet refuses it all the same, as Not sent, with Back to review", async () => {
    const view = reviewAt("6000000000");
    view.answers.DUSK_UI_SEND_PASSWORD_ASKS = () => ({ ok: true, result: null });
    view.answers.DUSK_UI_SEND_TX = () => ({ error: { message: "It waits for your password, so nothing was sent." } });
    await pressConfirm(view);
    await settle();
    expect(view.state.sent.phase).toBe("not_sent");
    expect(view.state.sent.error).toBe("It waits for your password, so nothing was sent.");
  });
});

describe("an amount in the browser's language", () => {
  it("reads as French writes it, in Send's own field, with no error and Review on", async () => {
    vi.stubGlobal("navigator", { ...globalThis.navigator, language: "fr-FR" });
    const state = newState();
    const form = mount(state, overview({ balance: { value: "5000000000000" } }));
    typeInto(form.to, ALICE.account);
    for (const typed of ["1 000", "1\u00a0000", "1\u202f000", "1 000,5"]) {
      typeInto(form.amount, typed);
      expect(form.amountError()).toBe("");
      expect(form.review.disabled).toBe(false);
    }
    form.review.click();
    await settle();
    expect(state.draft.amountLux).toBe("1000500000000");
  });
});

describe("a request link", () => {
  const httpsLink = (query) => `https://apps.testnet.dusk.network/wallet/dashboard/send?${query}`;

  beforeEach(() => parseDuskQrPayload.mockImplementation(parsePaymentLink));
  afterEach(() => parseDuskQrPayload.mockImplementation(() => null));

  const paste = (form, text) => form.to.dispatchEvent(fakeEvent("paste", { clipboardData: { getData: () => text } }));

  // A paste refused for what its message says against its link (readPastedRequest: app-core's reading, for all three
  // wallets): that part, the message's value and the link's each in its place, and the words Send says it in.
  // What Send says of a link or a paste it refuses: app-core's words for it, as read for this wallet's network.
  const refusedAs = (text) => readPastedRequest(text, overview().nodeUrl)?.problem;
  const disagreement = (text, disagrees, owners) => {
    const read = readPastedRequest(text, overview().nodeUrl, owners ? { owners } : {});
    expect(read?.disagrees, text).toEqual(disagrees);
    return read.problem;
  };

  it("fills Send in when it's pasted, the https link as the dusk: one, in the browser's separators", async () => {
    vi.stubGlobal("navigator", { ...globalThis.navigator, language: "nl-NL" });
    const state = newState();
    const form = mount(state);
    paste(form, ` ${httpsLink(`to=${ALICE.account}&amount=0.15&memo=Factura+33&network=testnet`)} `);
    await settle();
    expect(state.draft).toMatchObject({ to: ALICE.account, amountDusk: "0,15", memo: "Factura 33", requestChainId: "dusk:2" });
    expect(form.to.value).toBe(ALICE.account);
    expect(form.amount.value).toBe("0,15");
    // Said under the recipient, with the network it pays on, and covering nothing.
    const filled = () => visibleText(dom.document.body.querySelector(".send-filled-note"));
    expect(filled()).toEqual(saying("Testnet"));
    expect(form.actions.showToast).not.toHaveBeenCalled();
    typeInto(form.to, BOB.account);
    expect(filled()).toBe("");

    const again = mount(newState());
    paste(again, `dusk:public-${ALICE.account}@dusk:2?amount=1.5&memo=Rent`);
    await settle();
    expect(again.to.value).toBe(ALICE.account);
    expect(again.amount.value).toBe("1,5");
  });

  // Sofía's, Amélie's, Marek's, Nandini's and Lena's: the wallet's own share message pasted into To said "Not a valid
  // address" in the extension and the app, where the web wallet reads it; copied from a chat page too, and on a phone,
  // whose one-line field drops its line break ("… Factura 2026-151Pay here: https://…").
  it("reads a shared request by its link, pasted or put in whole, its line break kept or dropped", async () => {
    const link = httpsLink(`to=${ALICE.account}&amount=0.01&memo=Factura+2026-151&network=testnet`);
    const message = `sofiadesign.dusk asks you to pay 0.01 DUSK on Testnet · Factura 2026-151\nPay here: ${link}`;
    const filled = (form, state) => [form.to.value, form.amount.value, state.draft?.memo, visibleText(dom.document.body.querySelector(".send-filled-note"))];
    const FILLED = [ALICE.account, "0.01", "Factura 2026-151", saying("Testnet")];
    for (const text of [message, message.replace("\n", ""), message.replace("\n", " "), `You're asked to pay 0.01 DUSK on Testnet · Factura 2026-151\nPay here: ${link}`]) {
      // Pasted, as the clipboard has it.
      const pastedState = newState();
      const pasted = mount(pastedState);
      paste(pasted, text);
      await settle();
      expect(filled(pasted, pastedState)).toEqual(FILLED);
      // Put in whole, as a phone's keyboard puts the clipboard in, with no paste to read.
      const typedState = newState();
      const typed = mount(typedState);
      typed.to.value = text.replace("\n", "");
      typed.to.dispatchEvent(fakeEvent("input", { inputType: "insertFromPaste" }));
      await settle();
      expect(filled(typed, typedState)).toEqual(FILLED);
    }
  });

  // Marek's: the same refusals as the web wallet's for two links, and for words after the link.
  it("refuses a message with two links, or words after its link, saying why, and fills in nothing", async () => {
    const a = httpsLink(`to=${ALICE.account}&amount=0.01&network=testnet`);
    const b = httpsLink(`to=${BOB.account}&amount=0.02&network=testnet`);
    for (const [text, said] of [
      [`Pay here: ${a} or here: ${b}`, LINK_SEVERAL],
      [`Marek asks you to pay 0.01 DUSK on Testnet\nPay here: ${a} thanks!`, LINK_UNCLEAR],
    ]) {
      const form = mount(newState());
      paste(form, text);
      await settle();
      expect(dom.document.body.querySelectorAll(".field-error").filter(isShown).map((el) => el.textContent)).toEqual([said]);
      expect([form.to.value, form.amount.value]).toEqual([oneLine(text), ""]);
    }
    // Plain words, a name or an address are a recipient, as ever.
    const form = mount(newState());
    paste(form, "sofiadesign.dusk");
    await settle();
    expect(dom.document.body.querySelectorAll(".field-error").filter(isShown)).toEqual([]);
  });

  // Lena's: her link and a word after it, as a chat line is copied whole, said "This link's network can't be read", or
  // with the memo last, took the word into the memo ("Lena r35 odd danke!", or glued on from the next line).
  it("refuses a link with a word after it, on its line or the next, whatever its last field, saying so", async () => {
    const networkLast = httpsLink(`to=${ALICE.account}&amount=0.01&memo=Lena+r35&network=testnet`);
    const memoLast = httpsLink(`to=${ALICE.account}&network=testnet&amount=0.01&memo=Lena+r35+odd`);
    for (const link of [networkLast, memoLast]) {
      for (const text of [`${link} danke!`, `${link}\ndanke!`, `${link}\r\ndanke!`]) {
        const state = newState();
        const form = mount(state);
        paste(form, text);
        await settle();
        expect(refusal(), JSON.stringify(text)).toEqual([LINK_UNCLEAR]);
        expect([form.to.value, form.amount.value, state.draft?.memo ?? ""], JSON.stringify(text)).toEqual([oneLine(text), "", ""]);
      }
    }
  });

  // Marek's: the wallet's own share message with only its link's amount changed (0.002 to 0.15) filled 0.15 without a
  // word, and a first line naming someone else, another amount or another memo was let by.
  // Then Amélie's, Sofía's, Lena's: it never said what didn't agree, and To emptied. It says what (app-core's words),
  // and keeps what was pasted in To.
  it("refuses a shared message whose line says another amount or memo than its link, says which, and fills in nothing", async () => {
    const link = (amount) => httpsLink(`to=${ALICE.account}&amount=${amount}&memo=r35+marek+T2&network=testnet`);
    for (const [text, disagrees] of [
      [`You're asked to pay 0.002 DUSK on Testnet · r35 marek T2\nPay here: ${link("0.15")}`, { part: "amount", message: "0.002 DUSK", link: "0.15 DUSK" }],
      [`Sofía asks you to pay 0.001 DUSK · coffee\nPay here: ${link("0.002")}`, { part: "amount", message: "0.001 DUSK", link: "0.002 DUSK" }],
      [`You're asked to pay 0.002 DUSK on Testnet · r35 marek T3\nPay here: ${link("0.002")}`, { part: "memo", message: "r35 marek T3", link: "r35 marek T2" }],
    ]) {
      const said = disagreement(text, disagrees);
      const state = newState();
      const form = mount(state);
      paste(form, text);
      await settle();
      expect(refusal(), text).toEqual([said]);
      expect([form.to.value, form.amount.value, state.draft?.memo ?? ""], text).toEqual([oneLine(text), "", ""]);
      // Drawn again, as a redraw does: the same.
      const again = mount(state);
      expect([refusal(), again.to.value, again.amount.value], text).toEqual([[said], oneLine(text), ""]);
    }
    // The message as the wallet wrote it: read, and filled in.
    const state = newState();
    const form = mount(state);
    paste(form, `You're asked to pay 0.002 DUSK on Testnet · r35 marek T2\nPay here: ${link("0.002")}`);
    await settle();
    expect([refusal(), form.to.value, form.amount.value, state.draft?.memo]).toEqual([[], ALICE.account, "0.002", "r35 marek T2"]);
  });

  // R02. Marek's: one invisible or look-alike character in the wallet's own line, or "You are asked", switched the check
  // off and the link's 0.15 filled in under a line saying 0.002; and the extension read only the line right before the
  // link, so a "Thanks!" or "Pay me here:" between them let it by. Both wallets read the whole message now (app-core).
  it("reads the whole pasted message, through what can't be seen and look-alike letters, and refuses one that says another amount", async () => {
    // The message's 0.002 DUSK, against its link's 0.15 DUSK.
    const DISAGREES = { part: "amount", message: "0.002 DUSK", link: "0.15 DUSK" };
    const link = (amount) => httpsLink(`to=${ALICE.account}&amount=${amount}&memo=r37+marek+T2&network=testnet`);
    const line = "You're asked to pay 0.002 DUSK on Testnet · r37 marek T2";
    for (const text of [
      `You\u200b're asked to pay 0.002 DUSK on Testnet · r37 marek T2\nPay here: ${link("0.15")}`,
      `You're asked t\u043e pay 0.002 DUSK on Testnet · r37 marek T2\nPay here: ${link("0.15")}`,
      `You're asked to pay 0.002 DUS\u041a on Testnet · r37 marek T2\nPay here: ${link("0.15")}`,
      `You are asked to pay 0.002 DUSK on Testnet · r37 marek T2\nPay here: ${link("0.15")}`,
      `${line}\nThanks!\nPay here: ${link("0.15")}`,
      `${line}\nPay me here: ${link("0.15")}`,
      `${line}\nPay here 👉 ${link("0.15")}`,
      `${line}\nYou're asked to pay 0.15 DUSK on Testnet · r37 marek T2\nPay here: ${link("0.15")}`,
    ]) {
      const state = newState();
      const form = mount(state);
      paste(form, text);
      await settle();
      expect(refusal(), JSON.stringify(text)).toEqual([disagreement(text, DISAGREES)]);
      expect([form.to.value, form.amount.value, state.draft?.memo ?? ""], JSON.stringify(text)).toEqual([oneLine(text), "", ""]);
    }
    // Words that state nothing else may be around its link: filled in.
    for (const text of [`${line}\nThanks!\nPay here: ${link("0.002")}`, `Hi Marek,\nPay me here: ${link("0.002")}`]) {
      const state = newState();
      const form = mount(state);
      paste(form, text);
      await settle();
      expect([refusal(), form.to.value, form.amount.value, state.draft?.memo], JSON.stringify(text)).toEqual([[], ALICE.account, "0.002", "r37 marek T2"]);
    }
  });

  // R02, Nandini's: "You're asked to pay 0.012 DUSK to alice.dusk on Testnet…" over a link to Amélie's account filled
  // Amélie in, and never said alice.dusk; "alice·dusk" too. A name anywhere in the message is the link's, or refused.
  it("looks up a .dusk name anywhere in a pasted message, and refuses one that isn't the link's recipient", async () => {
    // The name the message says, whose account is Bob's, against the account its link pays.
    const DISAGREES = { part: "name", message: "alice.dusk", link: ALICE.account };
    duskNamesOwners.mockImplementation(async (names) => new Map(names.map((name) => [name, { account: BOB.account }])));
    for (const name of ["alice.dusk", "alice\u00b7dusk"]) {
      const state = newState();
      const form = mount(state);
      const text = `You're asked to pay 0.012 DUSK to ${name} on Testnet · Invoice NOV-17c r37\nPay here: ${httpsLink(`to=${ALICE.account}&amount=0.012&memo=Invoice+NOV-17c+r37&network=testnet`)}`;
      paste(form, text);
      await settle();
      expect(duskNamesOwners.mock.lastCall?.[0], name).toEqual(["alice.dusk"]);
      const said = disagreement(text, DISAGREES, new Map([["alice.dusk", { account: BOB.account }]]));
      expect([refusal(), form.to.value, form.amount.value], name).toEqual([[said], oneLine(text), ""]);
    }
    // Without the name: filled in.
    const state = newState();
    const form = mount(state);
    paste(form, `You're asked to pay 0.012 DUSK on Testnet · Invoice NOV-17c r37\nPay here: ${httpsLink(`to=${ALICE.account}&amount=0.012&memo=Invoice+NOV-17c+r37&network=testnet`)}`);
    await settle();
    expect([refusal(), form.to.value, form.amount.value]).toEqual([[], ALICE.account, "0.012"]);
  });

  // Marek's, round 39, exact: a request line naming the payee with a spaced dot over a link to someone else; "Total
  // 0.15" with no unit over a 0.02 link; and someone else's raw address in the text. All filled in. Refused, saying
  // what disagrees, the paste kept in To.
  it("refuses Marek's pastes that say another amount, name or address than their link, saying what disagrees", async () => {
    const MAREK = "26dtBf5Lj7C6GccJMeU17JrSEhAarDB6Fvs3MBkCeKVrUXnzXR71MBBvZqih3SB5cwv8t76TWTi7AUMUWL8sBFEGkLabyF2VmALNuf1YYAiaiLitUcKdT4Hwg64pSzxSS93z";
    const SOFIA = "sEeMSo7oiV2rxo6aZD3H75XGFZD95BtrmgFD3AezyUkC5W9bUyRwqFr6VuybvuvmvX5kTRt4STaSKbE6FEeMGoPDZNaX1LL82rGzN6BDbajY8qJcweu1mp7m1budNv9kgd7";
    const toMarek = "https://apps.testnet.dusk.network/wallet/dashboard/send?to=" + MAREK + "&amount=0.02&memo=marek-r10-req&network=testnet";
    const own = `You're asked to pay 0.02 DUSK on Testnet · marek-r10-req\nPay here: ${toMarek}`;
    duskNamesOwners.mockImplementation(async (names) => new Map(names.filter((name) => name === "sofiadesign.dusk").map((name) => [name, { account: SOFIA }])));
    for (const [text, disagrees] of [
      [`Total 0.15\n${own}`, { part: "amount", message: "0.15", link: "0.02 DUSK" }],
      [`Pay to ${SOFIA}\n${own}`, { part: "address", message: SOFIA, link: MAREK }],
      [own.replace("You're asked", "sofiadesign . dusk asks you"), { part: "name", message: "sofiadesign.dusk", link: MAREK }],
    ]) {
      const said = disagreement(text, disagrees, new Map([["sofiadesign.dusk", { account: SOFIA }]]));
      const state = newState();
      const form = mount(state);
      paste(form, text);
      await settle();
      expect([refusal(), form.to.value, form.amount.value, state.draft?.memo ?? ""], text).toEqual([[said], oneLine(text), "", ""]);
    }
    // His own message as the wallet wrote it: filled in.
    const state = newState();
    const form = mount(state);
    paste(form, own);
    await settle();
    expect([refusal(), form.to.value, form.amount.value, state.draft?.memo]).toEqual([[], MAREK, "0.02", "marek-r10-req"]);
  });

  // Round 40's review: a paste refused stayed in To on its one line, and leaving To or pressing Review read it again
  // so, its lines run together: a memo on two lines then read as its link's, and filled in the payment just refused.
  it("keeps a refused paste refused as To is left, on Review, drawn again and kept, till To is edited", async () => {
    const text = `You're asked to pay 0.002 DUSK on Testnet · r35 marek T2\nThanks!\nPay here: ${httpsLink(`to=${ALICE.account}&amount=0.002&memo=r35+marek+T2+Thanks!&network=testnet`)}`;
    // The message's memo, against its link's, with the line after it.
    const SAID = disagreement(text, { part: "memo", message: "r35 marek T2", link: "r35 marek T2 Thanks!" });
    let state = newState();
    let form = mount(state);
    const shown = () => [refusal(), form.to.value, form.amount.value, state.draft?.memo ?? "", state.route];
    const REFUSED = [[SAID], oneLine(text), "", "", "send"];
    paste(form, text);
    await settle();
    expect(shown()).toEqual(REFUSED);
    form.to.dispatchEvent(fakeEvent("blur"));
    await settle();
    expect(shown()).toEqual(REFUSED);
    form.review.click();
    await settle();
    expect(shown()).toEqual(REFUSED);
    // Drawn again, then left.
    form = mount(state);
    form.to.dispatchEvent(fakeEvent("blur"));
    await settle();
    expect(shown()).toEqual(REFUSED);
    // Kept as a reload keeps Send, and opened on again.
    keepOpenSend(state.draft, overview());
    state = { ...newState(), draft: asKept(takeOpenSend(overview())) };
    form = mount(state);
    form.to.dispatchEvent(fakeEvent("blur"));
    form.review.click();
    await settle();
    expect(shown()).toEqual(REFUSED);
    // Edited, it's a recipient as typed.
    typeInto(form.to, ALICE.account);
    form.to.dispatchEvent(fakeEvent("blur"));
    await settle();
    expect(shown()).toEqual([[], ALICE.account, "", "", "send"]);
  });

  // Sofía's, as Marek tried it: "sofiadesign.dusk asks you…" over someone else's link filled in their account.
  describe("whose .dusk name a shared request's line says it's from", () => {
    // The name the line says, whose account is Bob's, against the account its link pays.
    const said = () => disagreement(message(ALICE.account), { part: "name", message: "sofiadesign.dusk", link: ALICE.account }, sofias);
    const LOOKING_UP = [saying("sofiadesign.dusk")];
    const message = (to) =>
      `sofiadesign.dusk asks you to pay 0.002 DUSK on Testnet · F-2026-102\nPay here: ${httpsLink(`to=${to}&amount=0.002&memo=F-2026-102&network=testnet`)}`;
    const sofias = new Map([["sofiadesign.dusk", { account: BOB.account }]]);
    const lookingUp = () => dom.document.body.querySelectorAll(".name-box [role=status]").filter((el) => isShown(el)).map((el) => el.textContent);
    const values = (form, state) => [form.to.value, form.amount.value, state.draft?.memo ?? ""];

    it("is looked up on the wallet's network before anything's filled in, and refused over another account's link", async () => {
      const answer = Promise.withResolvers();
      duskNamesOwners.mockImplementation(() => answer.promise);
      const state = newState();
      const form = mount(state);
      paste(form, message(ALICE.account));
      await settle();
      expect(duskNamesOwners.mock.calls).toEqual([[["sofiadesign.dusk"], { nodeUrl: "https://testnet.nodes.dusk.network" }]]);
      // Nothing filled in, nor said wrong, meanwhile; Review waits.
      expect([...values(form, state), refusal(), lookingUp(), form.review.disabled]).toEqual(["", "", "", [], LOOKING_UP, true]);
      answer.resolve(sofias);
      await settle();
      expect([...values(form, state), refusal(), lookingUp(), form.review.disabled]).toEqual([oneLine(message(ALICE.account)), "", "", [said()], [], false]);

      // Over the name's own account's link: filled in.
      duskNamesOwners.mockImplementation(async () => sofias);
      const own = newState();
      const ownForm = mount(own);
      paste(ownForm, message(BOB.account));
      await settle();
      expect([...values(ownForm, own), refusal()]).toEqual([BOB.account, "0.002", "F-2026-102", []]);
    });

    it("says nothing of a name whose lookup failed: the request's filled in", async () => {
      duskNamesOwners.mockImplementation(async () => new Map());
      const state = newState();
      const form = mount(state);
      paste(form, message(ALICE.account));
      await settle();
      expect([...values(form, state), refusal()]).toEqual([ALICE.account, "0.002", "F-2026-102", []]);
    });

    it("fills in nothing once To, Amount or Memo changes as it's looked up: what's typed comes first", async () => {
      for (const change of ["to", "amount", "memo"]) {
        const answer = Promise.withResolvers();
        duskNamesOwners.mockImplementation(() => answer.promise);
        const state = newState();
        const form = mount(state);
        paste(form, message(ALICE.account));
        await settle();
        const field = change === "to" ? form.to : change === "amount" ? form.amount : form.memo;
        typeInto(field, change === "amount" ? "0.5" : change === "to" ? "a" : "lunch");
        await settle();
        expect(lookingUp(), change).toEqual([]);
        answer.resolve(sofias);
        await settle();
        expect([refusal(), field.value], change).toEqual([[], change === "amount" ? "0.5" : change === "to" ? "a" : "lunch"]);
      }
    });

    it("is read still where Send is drawn again meanwhile, and not in a Send opened afresh", async () => {
      const answer = Promise.withResolvers();
      duskNamesOwners.mockImplementation(() => answer.promise);
      const state = newState();
      paste(mount(state), message(ALICE.account));
      await settle();
      // A refresh draws Send again from its draft.
      const again = mount(state);
      expect(lookingUp()).toEqual(LOOKING_UP);
      answer.resolve(sofias);
      await settle();
      expect([refusal(), again.to.value]).toEqual([[said()], oneLine(message(ALICE.account))]);

      // Left for Home and opened again: nothing of it.
      const later = Promise.withResolvers();
      duskNamesOwners.mockImplementation(() => later.promise);
      const left = newState();
      paste(mount(left), message(ALICE.account));
      await settle();
      left.draft = null;
      const fresh = mount(left);
      later.resolve(sofias);
      await settle();
      expect([refusal(), lookingUp(), fresh.to.value, fresh.review.disabled]).toEqual([[], [], "", false]);
    });

    it("isn't looked up for a request paid on another network, which says so", async () => {
      const state = newState();
      const form = mount(state, overview({ nodeUrl: "https://nodes.dusk.network" }));
      paste(form, message(ALICE.account));
      await settle();
      expect(duskNamesOwners).not.toHaveBeenCalled();
      expect(refusal()).toHaveLength(1);
      expect(form.to.value).toBe(oneLine(message(ALICE.account)));
    });
  });

  // Nandini's and Chen's: a link's amount=2.125 was filled in as 2.1250 without a question, where typing 2.125 asks.
  it("reads a link's amount as typing does: 2.125 asks, with a button for each reading; a wallet's 2.1250 doesn't", async () => {
    vi.stubGlobal("navigator", { ...globalThis.navigator, language: "en-SG" });
    const form = mount(newState());
    paste(form, httpsLink(`to=${ALICE.account}&amount=2.125&memo=laksa&network=testnet`));
    await settle();
    expect(form.amount.value).toBe("2.125");
    expect([readings(), form.review.disabled]).toEqual([["2.1250 DUSK", "2125 DUSK"], true]);

    const made = mount(newState());
    paste(made, httpsLink(`to=${ALICE.account}&amount=2.1250&memo=laksa&network=testnet`));
    await settle();
    expect([made.amount.value, made.amountError()]).toEqual(["2.1250", ""]);
  });

  // Lena's, in German: a link's amount=1.000 was filled in as "1,000". It asks which is meant, as typing 1.000 does,
  // pasted, opened with the wallet or scanned.
  it("asks of a link's amount that reads two ways in the browser's language what typing it asks", async () => {
    vi.stubGlobal("navigator", { ...globalThis.navigator, language: "de-DE" });
    const link = httpsLink(`to=${ALICE.account}&amount=1.000&memo=Rechnung&network=testnet`);
    const typed = mount(newState());
    typeInto(typed.to, ALICE.account);
    typeInto(typed.amount, "1.000");
    const asked = typed.amountError();
    expect(readings()).toEqual(["1 DUSK", "1000 DUSK"]);

    const pasted = mount(newState());
    paste(pasted, link);
    await settle();
    expect([pasted.amountError(), pasted.review.disabled]).toEqual([asked, true]);
    const { requestDraftOf } = await import("./lib/requestLink.js");
    const opened = mount({ ...newState(), draft: requestDraftOf(`?link=${encodeURIComponent(link)}`) });
    expect([opened.amountError(), opened.review.disabled]).toEqual([asked, true]);
    const { openQrScanModal } = await import("./components/QrScanModal.js");
    const scanned = mount(newState());
    openQrScanModal.mockResolvedValueOnce(link);
    scanButton().click();
    await settle();
    expect([scanned.amountError(), scanned.review.disabled]).toEqual([asked, true]);
  });

  // Sofía's, in the app: Chen picked from Contacts in place of the link's recipient, and the line stayed.
  // Amélie's: the 0,1 of a payment back to a stranger stayed in Send as she chose Chen from Contacts.
  it("stops saying it filled the recipient in once another is picked from Contacts, and clears the amount and memo it filled in", async () => {
    const state = newState();
    const form = mount(state);
    paste(form, httpsLink(`to=${ALICE.account}&amount=0.03&memo=Invoice+2026-120&network=testnet`));
    await settle();
    const filled = () => visibleText(dom.document.body.querySelector(".send-filled-note"));
    expect(filled()).toEqual(saying("Testnet"));

    contactsButton().click();
    await settle();
    expect([state.route, state.addressBook.mode]).toEqual(["contacts", "pick"]);
    Object.assign(state.addressBook, { loaded: true, loading: false, items: [{ id: "c", name: "Chen", address: BOB.account, type: "account" }] });
    const { addressBookView } = await import("./popup/views/addressbook.js");
    dom.document.body.replaceChildren(...addressBookView(overview(), { state, actions: { render: vi.fn(async () => {}), showToast: vi.fn() } }));
    dom.document.body.querySelectorAll(".contact-row").find((row) => row.textContent.includes("Chen")).click();
    expect(state.route).toBe("send");

    const picked = mount(state);
    expect([picked.to.value, picked.amount.value, picked.memo.value, state.draft.amountDusk, state.draft.memo]).toEqual([BOB.account, "", "", "", ""]);
    expect(filled()).toBe("");
    // The link's network went with its recipient, as when one is typed.
    expect(state.draft.requestChainId).toBeUndefined();

    // What's typed over the link's is yours: it stays with another recipient, and only the link's own goes.
    const again = mount(newState());
    paste(again, httpsLink(`to=${ALICE.account}&amount=0.03&memo=Invoice+2026-120&network=testnet`));
    await settle();
    typeInto(again.amount, "0.05");
    typeInto(again.to, BOB.account);
    expect([again.to.value, again.amount.value, again.memo.value]).toEqual([BOB.account, "0.05", ""]);
    // Its address half edited and put back as it was, nothing goes.
    const same = mount(newState());
    paste(same, httpsLink(`to=${ALICE.account}&amount=0.03&memo=Invoice+2026-120&network=testnet`));
    await settle();
    typeInto(same.to, ALICE.account.slice(0, -2));
    typeInto(same.to, ALICE.account);
    expect([same.to.value, same.amount.value, same.memo.value]).toEqual([ALICE.account, "0.03", "Invoice 2026-120"]);
  });

  // Round 40's review: a name with the link's shielded address and an account kept the link's amount and memo with its
  // account picked, as either address matched; and a card picked after was never checked.
  it("clears what a link filled in for one of a name's addresses once the name's other is picked", async () => {
    const values = (form) => [form.amount.value, form.memo.value];
    // The link's shielded address, then the name, its account picked as it opens.
    const shielded = mount(newState());
    paste(shielded, httpsLink(`to=${ALICE.address}&amount=0.03&memo=Invoice+2026-120&network=testnet`));
    await settle();
    expect(values(shielded)).toEqual(["0.03", "Invoice 2026-120"]);
    typeInto(shielded.to, "alice.dusk");
    await settle();
    expect(shielded.picked()).toEqual(["true", "false"]);
    expect(values(shielded)).toEqual(["", ""]);
    // The link's account, then the name: kept on its account, cleared once its shielded address is picked.
    const account = mount(newState());
    paste(account, httpsLink(`to=${ALICE.account}&amount=0.03&memo=Invoice+2026-120&network=testnet`));
    await settle();
    typeInto(account.to, "alice.dusk");
    await settle();
    expect(values(account)).toEqual(["0.03", "Invoice 2026-120"]);
    account.radios()[1].click();
    await settle();
    expect(values(account)).toEqual(["", ""]);
  });

  // Round 40's review: a link's payment with To cleared, kept as a reload keeps Send, opened on what it had for no one,
  // and whoever was chosen next kept the link's amount and memo.
  it("clears what a link filled in once another recipient is chosen after a reload, To cleared before it", async () => {
    let state = newState();
    let form = mount(state);
    paste(form, httpsLink(`to=${ALICE.account}&amount=0.03&memo=Invoice+2026-120&network=testnet`));
    await settle();
    typeInto(form.to, "");
    keepOpenSend(state.draft, overview());
    state = { ...newState(), draft: asKept(takeOpenSend(overview())) };
    form = mount(state);
    expect([form.to.value, form.amount.value, form.memo.value]).toEqual(["", "0.03", "Invoice 2026-120"]);
    typeInto(form.to, BOB.account);
    expect([form.to.value, form.amount.value, form.memo.value]).toEqual([BOB.account, "", ""]);
    // Its own recipient again: the link's payment, as it was.
    state = { ...newState(), draft: asKept({ to: "", amountDusk: "0.03", memo: "Invoice 2026-120", carried: ["amount", "memo"], carriedTo: ALICE.account }) };
    form = mount(state);
    typeInto(form.to, ALICE.account);
    expect([form.to.value, form.amount.value, form.memo.value]).toEqual([ALICE.account, "0.03", "Invoice 2026-120"]);
  });

  // Round 40's review: a link opened Send anew while the form before it still read Contacts; read, that older form took
  // its own recipient for the new link's, and cleared what the link filled in.
  it("keeps what a new link filled in from what the form it replaced still waited for", async () => {
    const { listAddressBook } = await import("../shared/addressBook.js");
    const { requestDraftOf } = await import("./lib/requestLink.js");
    let read;
    listAddressBook.mockImplementationOnce(() => new Promise((resolve) => (read = resolve)));
    const state = { route: "send", draft: null, addressBook: { loaded: false, items: null } };
    const old = mount(state);
    typeInto(old.to, BOB.account);
    // The link, opened: Send drawn anew for it.
    state.draft = requestDraftOf(`?link=${encodeURIComponent(httpsLink(`to=${ALICE.account}&amount=0.03&memo=Invoice+2026-120&network=testnet`))}`);
    const form = mount(state);
    expect([form.to.value, form.amount.value, form.memo.value]).toEqual([ALICE.account, "0.03", "Invoice 2026-120"]);
    read([]);
    await settle();
    expect([state.draft.to, state.draft.amountDusk, state.draft.memo]).toEqual([ALICE.account, "0.03", "Invoice 2026-120"]);
    const again = mount(state);
    expect([again.to.value, again.amount.value, again.memo.value]).toEqual([ALICE.account, "0.03", "Invoice 2026-120"]);
  });

  // Round 40's second review: a form drawn while a field was typed in, which the popup puts on the page only once the
  // typing stops, counted in place of the one on the page: there, another recipient kept the link's amount and memo.
  it("clears what a link filled in on the form on the page, another drawn meanwhile but not put there", async () => {
    const state = newState();
    const form = mount(state);
    paste(form, httpsLink(`to=${ALICE.account}&amount=0.03&memo=Invoice+2026-120&network=testnet`));
    await settle();
    // Drawn again as To is typed in, and not put on the page.
    sendFormView(overview(), { state, actions: form.actions });
    typeInto(form.to, BOB.account);
    await settle();
    expect([form.to.value, form.amount.value, form.memo.value, state.draft.amountDusk, state.draft.memo]).toEqual([BOB.account, "", "", "", ""]);
  });

  it("refuses one for another network, and goes as far as Review only with what Send takes", async () => {
    const state = newState();
    const form = mount(state);
    paste(form, `https://apps.dusk.network/wallet/dashboard/send?to=${ALICE.account}&amount=1&network=mainnet`);
    await settle();
    const note = dom.document.body.querySelectorAll(".field-error").find((el) => isShown(el));
    expect(note?.textContent).toBe(FOR_MAINNET);
    expect([form.to.value, form.amount.value]).toEqual([`https://apps.dusk.network/wallet/dashboard/send?to=${ALICE.account}&amount=1&network=mainnet`, ""]);

    // Marek's: an amount in the link that isn't a plain number, a hidden character in it
    // too, fills in nothing, and says why, as app-core's reader does for both wallets.
    for (const amount of ["lots", "0.0%E2%80%8B1", `0.001%23to=${BOB.account}`]) {
      const typo = mount(newState());
      paste(typo, httpsLink(`to=${ALICE.account}&amount=${amount}`));
      await settle();
      expect(refusal(), amount).toEqual([LINK_BAD_AMOUNT]);
      expect([typo.to.value, typo.amount.value], amount).toEqual([httpsLink(`to=${ALICE.account}&amount=${amount}`), ""]);
    }
    // Marek's, the round after: a tab in a pasted link's amount, as a chat or mail can put in, was taken out
    // ("0.001" + tab + "5" filled 0.0015); any space there, of any kind, refuses the link. Pasted, a space ends the
    // link, as one before a word after it does (Lena's), and is said so.
    for (const space of ["\t", "\u00a0", "\u2009", "\u202f", "\u3000"]) {
      const spaced = mount(newState());
      paste(spaced, httpsLink(`to=${ALICE.account}&amount=0.001${space}5&memo=x&network=testnet`));
      await settle();
      expect(refusal(), JSON.stringify(space)).toEqual([LINK_UNCLEAR]);
      expect([spaced.to.value, spaced.amount.value], JSON.stringify(space)).toEqual([httpsLink(`to=${ALICE.account}&amount=0.001${space}5&memo=x&network=testnet`), ""]);
    }
  });

  const refusal = () => dom.document.body.querySelectorAll(".field-error").filter((el) => isShown(el)).map((el) => el.textContent);
  const errLine = () => {
    const el = dom.document.body.querySelector(".err");
    return el && el.style.display !== "none" ? el.textContent : "";
  };

  // Marek's: a second recipient, a line break or a hidden character inside an https link's to= filled To, under
  // "Filled in from the link", where the web wallet refuses the link.
  it("refuses a link whose recipient it can't pay, as the web wallet does, filling in nothing", async () => {
    for (const to of [`${ALICE.account},${BOB.account}`, `${ALICE.account}%2C${BOB.account}`, `${ALICE.account.slice(0, 40)}%0A${ALICE.account.slice(40)}`, `${ALICE.account}%E2%80%AE`, `${ALICE.account}%EF%B8%8F`]) {
      const state = newState();
      const form = mount(state);
      typeInto(form.amount, "0.5");
      paste(form, httpsLink(`to=${to}&amount=0.001`));
      await settle();
      expect(refusal(), to).toEqual([LINK_BAD_ADDRESS]);
      expect([form.to.value, form.amount.value, state.draft.to, visibleText(dom.document.body.querySelector(".send-filled-note"))]).toEqual([oneLine(httpsLink(`to=${to}&amount=0.001`)), "", oneLine(httpsLink(`to=${to}&amount=0.001`)), ""]);
    }
  });

  // Marek's: a field whose name hid a character, had a space, or was written in other letters was dropped, and the
  // link taken without it: on mainnet's wallet, `…&amount=1000&ɴetwork=testnet` filled 1000 DUSK. So was a name
  // that only looks like a field's.
  it("refuses a link with a field name that hides something or only looks like a field's, filling in nothing", async () => {
    for (const fields of ["am%E2%80%8Fount=0.001", "amount%00=0.001", `to%20=${BOB.account}`, "amount=0.001&%C9%B4etwork=mainnet", "amount=0.001&%D0%B0mount=1000", "amountIux=1000", "amount=0.001&Iabel=Rent", `amount=0.001&t0=${BOB.account}`]) {
      const state = newState();
      const form = mount(state);
      paste(form, httpsLink(`to=${ALICE.account}&${fields}`));
      await settle();
      expect(refusal(), fields).toEqual([LINK_UNREADABLE]);
      expect([form.to.value, form.amount.value, state.draft.to], fields).toEqual([httpsLink(`to=${ALICE.account}&${fields}`), "", httpsLink(`to=${ALICE.account}&${fields}`)]);
    }
    // A name that's no field's is still left out.
    const form = mount(newState());
    paste(form, httpsLink(`to=${ALICE.account}&amount=0.001&utm_source=chat`));
    await settle();
    expect([refusal(), form.to.value, form.amount.value]).toEqual([[], ALICE.account, "0.001"]);
  });

  // Marek's: a dusk:shielded- link to a public account filled a public send, and what followed a # landed in Amount.
  it("refuses a link for one kind of payment to the other kind's recipient, and a dusk: link with a #", async () => {
    for (const [link, why] of [
      [`dusk:shielded-${ALICE.account}?amount=0.001`, refusedAs(`dusk:shielded-${ALICE.account}?amount=0.001`)],
      [`dusk:public-${ALICE.address}?amount=0.001`, refusedAs(`dusk:public-${ALICE.address}?amount=0.001`)],
      [`dusk:${ALICE.account}?amount=0.001#to=${BOB.account}`, LINK_UNREADABLE],
    ]) {
      const state = newState();
      const form = mount(state);
      paste(form, link);
      await settle();
      expect(refusal(), link).toEqual([why]);
      expect([form.to.value, form.amount.value, state.draft.to]).toEqual([link, "", link]);
    }
  });

  it("refuses a link that says a field twice, or has a user part before its host", async () => {
    // Marek's: each would fill in its first value without a word. Sofia's: say what's wrong, for its sender to fix.
    for (const link of [
      httpsLink(`to=${ALICE.account}&amount=0.001&network=testnet&network=mainnet`),
      httpsLink(`to=${ALICE.account}&to=${BOB.account}&amount=0.001`),
      httpsLink(`to=${ALICE.account}&amount=0.01&amount=0.01`),
      httpsLink(`to=${ALICE.account}&memo=One&memo=One`),
      `https://apps.dusk.network@apps.testnet.dusk.network/wallet/dashboard/send?to=${ALICE.account}&amount=0.001`,
    ]) {
      const state = newState();
      const form = mount(state);
      paste(form, link);
      await settle();
      expect(refusal(), link).toEqual([refusedAs(link)]);
      expect([form.to.value, form.amount.value, state.draft.to]).toEqual([link, "", link]);
    }

    const twice = mount(newState());
    paste(twice, httpsLink(`to=${ALICE.account}&amount=0.001&amount=0.15`));
    await settle();
    expect(refusal()).toEqual([LINK_TWO_AMOUNTS]);
  });

  it("refuses one for another network the moment it's put in, saying that alone, before and at Review", async () => {
    // Nandini's: put in whole, not pasted, it sat in To until Review, which said "Recipient is required" too.
    const state = newState();
    const form = mount(state);
    typeInto(form.to, `https://apps.dusk.network/wallet/dashboard/send?to=${ALICE.account}&amount=0.0013&memo=Order+1044&network=mainnet`);
    await settle();
    expect(refusal()).toEqual([FOR_MAINNET]);
    expect(form.to.value).toBe(`https://apps.dusk.network/wallet/dashboard/send?to=${ALICE.account}&amount=0.0013&memo=Order+1044&network=mainnet`);

    form.to.dispatchEvent(fakeEvent("blur"));
    form.review.click();
    await settle();
    expect(state.route).toBe("send");
    expect(refusal()).toEqual([FOR_MAINNET]);
    expect(errLine()).toBe("");
  });

  it("says the same of a QR code's request as of the link pasted", async () => {
    // Chen's: a mainnet request's QR said it couldn't be read.
    const { openQrScanModal } = await import("./components/QrScanModal.js");
    const state = newState();
    const form = mount(state);
    openQrScanModal.mockResolvedValueOnce(`dusk:public-${ALICE.account}@dusk:1?amount=1&memo=Rent`);
    scanButton().click();
    await settle();
    expect(refusal()).toEqual([FOR_MAINNET]);
    expect(errLine()).toBe("");

    // A QR code of the recipient alone fills in To, and says so, with the network it pays on.
    openQrScanModal.mockResolvedValueOnce(BOB.account);
    scanButton().click();
    await settle();
    expect(form.to.value).toBe(BOB.account);
    expect(refusal()).toEqual([]);
    expect(visibleText(dom.document.body.querySelector(".send-filled-note"))).toEqual(saying("Testnet"));
  });

  // Sofía's, in the app: a request scanned and left with Back came back, its
  // 0.03 and memo, "Filled in from the QR code", in a Send she started herself.
  it("keeps nothing of a scanned request once Send is left with Back, a recipient typed over it or not", async () => {
    const { openQrScanModal } = await import("./components/QrScanModal.js");
    const { keepSendDraft, keptSendDraft } = await import("./lib/sendDraft.js");
    // Back asks first; its Leave is the button that doesn't take you back to the form.
    const asked = () => dom.document.body.querySelector("[role=alertdialog]");
    const leave = () => asked().querySelectorAll("button").find((b) => !b.hasAttribute("data-back")).click();
    const state = newState();
    const form = mount(state);
    openQrScanModal.mockResolvedValueOnce(`dusk:public-${ALICE.account}@dusk:2?amount=0.03&memo=Invoice+2026-120`);
    scanButton().click();
    await settle();
    expect([form.to.value, form.amount.value]).toEqual([ALICE.account, "0.03"]);
    // Back asks first, the scan's: Leave goes.
    dom.document.body.querySelector(".subnav-back").click();
    expect(asked()).not.toBeNull();
    leave();
    await settle();
    expect(state.route).toBe("home");
    expect(keptSendDraft(overview())).toBeNull();

    // A recipient typed over it: nothing of the scan is left, and Back asks of what is.
    const over = newState();
    const typedOver = mount(over);
    openQrScanModal.mockResolvedValueOnce(`dusk:public-${ALICE.account}@dusk:2?amount=0.03&memo=Invoice+2026-120`);
    scanButton().click();
    await settle();
    typeInto(typedOver.to, BOB.account);
    expect([typedOver.to.value, typedOver.amount.value, typedOver.memo.value]).toEqual([BOB.account, "", ""]);
    dom.document.body.querySelector(".subnav-back").click();
    expect(asked()).not.toBeNull();
    leave();
    await settle();
    expect([over.route, keptSendDraft(overview())]).toEqual(["home", null]);

    // Amélie's: what's typed by hand, left with Back, isn't kept for the next Send either.
    keepSendDraft({ to: BOB.account, amountDusk: "0.02", memo: "satay" }, overview());
    const typed = { ...newState(), draft: keptSendDraft(overview()) };
    const again = mount(typed);
    expect([again.to.value, again.amount.value]).toEqual([BOB.account, "0.02"]);
    dom.document.body.querySelector(".subnav-back").click();
    leave();
    await settle();
    expect([typed.route, keptSendDraft(overview())]).toEqual(["home", null]);
  });

  it("is no request when it goes anywhere else, or names no recipient", async () => {
    const form = mount(newState());
    form.to.value = `https://phish.example/wallet/dashboard/send?to=${ALICE.account}&amount=1`;
    form.to.dispatchEvent(fakeEvent("blur"));
    await settle();
    expect(form.to.value).toContain("phish.example");
    expect(form.amount.value).toBe("");
    form.review.click();
    await settle();
    expect(dom.document.body.querySelector(".err").textContent).toEqual(saying());

    // One to the wallet's Send that names no recipient says so.
    const empty = mount(newState());
    empty.to.value = httpsLink("amount=1");
    empty.to.dispatchEvent(fakeEvent("blur"));
    await settle();
    expect(empty.amount.value).toBe("");
    expect(refusal()).toEqual([refusedAs(httpsLink("amount=1"))]);
  });

  const memoField = () => dom.document.body.querySelector(".send-form > input");

  it("clears the whole form when a link is refused, what an earlier link filled in too", async () => {
    // Chen's: a mainnet QR after a testnet one cleared To and kept the testnet one's amount and memo.
    const { openQrScanModal } = await import("./components/QrScanModal.js");
    const state = newState();
    const form = mount(state);
    openQrScanModal.mockResolvedValueOnce(`dusk:public-${ALICE.account}@dusk:2?amount=0.03&memo=Chicken+rice+Sat`);
    scanButton().click();
    await settle();
    expect([form.to.value, form.amount.value, memoField().value]).toEqual([ALICE.account, "0.03", "Chicken rice Sat"]);

    openQrScanModal.mockResolvedValueOnce(`dusk:public-${BOB.account}@dusk:1?amount=1&memo=Rent`);
    scanButton().click();
    await settle();
    expect(refusal()).toEqual([FOR_MAINNET]);
    expect([form.to.value, form.amount.value, memoField().value]).toEqual(["", "", ""]);
    expect(state.draft).toMatchObject({ to: "", amountDusk: "", memo: "" });

    // So does one that can't be read, after what was typed.
    typeInto(form.amount, "5");
    typeInto(memoField(), "Typed");
    paste(form, httpsLink(`to=${ALICE.account}&memo=One&memo=Two`));
    await settle();
    expect(refusal()).toEqual([refusedAs(httpsLink(`to=${ALICE.account}&memo=One&memo=Two`))]);
    expect([form.to.value, form.amount.value, memoField().value]).toEqual([httpsLink(`to=${ALICE.account}&memo=One&memo=Two`), "", ""]);
  });

  it("refuses a dusk: link for another network by the network its query names, as an https link", async () => {
    // Marek's: a link that said Testnet filled in a Mainnet send, and one that said Mainnet a Testnet send.
    const onTestnet = mount(newState());
    paste(onTestnet, `dusk:public-${ALICE.account}?amount=0.001&network=mainnet`);
    await settle();
    expect(refusal()).toEqual([FOR_MAINNET]);
    expect([onTestnet.to.value, onTestnet.amount.value]).toEqual([`dusk:public-${ALICE.account}?amount=0.001&network=mainnet`, ""]);

    const onMainnet = mount(newState(), overview({ nodeUrl: "https://nodes.dusk.network" }));
    paste(onMainnet, `dusk:public-${ALICE.account}?amount=0.001&network=testnet`);
    await settle();
    expect(refusal()).toEqual([chainMismatchText("dusk:2", "https://nodes.dusk.network")]);
    expect([onMainnet.to.value, onMainnet.amount.value]).toEqual([`dusk:public-${ALICE.account}?amount=0.001&network=testnet`, ""]);
  });

  it("refuses a link whose memo has a line break, saying so, rather than sending it on one line", async () => {
    // Marek's: "line one\nline two" became "line oneline two", which matches no request made with the break.
    const state = newState();
    const form = mount(state);
    paste(form, httpsLink(`to=${ALICE.account}&amount=0.001&memo=line%20one%0Aline%20two`));
    await settle();
    expect(refusal()).toEqual([LINK_MEMO_LINE_BREAK]);
    expect([form.to.value, form.amount.value, memoField().value]).toEqual([httpsLink(`to=${ALICE.account}&amount=0.001&memo=line%20one%0Aline%20two`), "", ""]);
  });

  // Chen's: a plain dusk: link on Mainnet filled Send in without a word of the network.
  it("says the network it pays on, for a plain link that names none", async () => {
    const state = newState();
    const form = mount(state, overview({ nodeUrl: "https://nodes.dusk.network", chainId: 1, networkName: "Mainnet" }));
    paste(form, `dusk:${ALICE.account}?amount=0.01&memo=Lunch`);
    await settle();
    expect(form.to.value).toBe(ALICE.account);
    expect(visibleText(dom.document.body.querySelector(".send-filled-note"))).toEqual(saying("Mainnet"));
  });

  it("fills in the page it opened, a tab of its own, as the form any request fills in", async () => {
    vi.stubGlobal("location", { pathname: "/full.html", search: `?route=send&link=${encodeURIComponent(httpsLink(`to=${ALICE.account}&amount=2.5&memo=Rent&network=testnet`))}` });
    vi.resetModules();
    const { state } = await import("./popup/state.js");
    expect(state.route).toBe("send");
    const form = mount(state);
    expect([form.to.value, form.amount.value]).toEqual([ALICE.account, "2.5"]);
    expect(state.draft.memo).toBe("Rent");
    expect(state.draft.requestChainId).toBe("dusk:2");
    expect(visibleText(dom.document.body.querySelector(".send-filled-note"))).toEqual(saying("Testnet"));

    // Marek's: a testnet link that says mainnet opened an empty Send without a word.
    const twoNetworks = httpsLink(`to=${ALICE.account}&amount=0.001&network=mainnet`);
    vi.stubGlobal("location", { pathname: "/full.html", search: `?route=send&link=${encodeURIComponent(twoNetworks)}` });
    vi.resetModules();
    const refused = (await import("./popup/state.js")).state;
    const unread = mount(refused);
    expect([unread.to.value, unread.amount.value]).toEqual(["", ""]);
    // As app-core reads a link the page opens with, on no network of its own.
    expect(refusal()).toEqual([readRequestLink(twoNetworks).problem]);

    // A network written as no network is: refused too.
    const noNetwork = `dusk:public-${ALICE.account}@dusk:2?amount=0.001&network=dusk:02`;
    vi.stubGlobal("location", { pathname: "/full.html", search: `?route=send&link=${encodeURIComponent(noNetwork)}` });
    vi.resetModules();
    mount((await import("./popup/state.js")).state);
    expect(refusal()).toEqual([readRequestLink(noNetwork).problem]);

    // No link, or a page opened with something that isn't one: an empty form.
    vi.stubGlobal("location", { pathname: "/full.html", search: "?route=send" });
    vi.resetModules();
    expect((await import("./popup/state.js")).state.draft).toBeNull();
    vi.stubGlobal("location", { pathname: "/full.html", search: `?route=send&link=${encodeURIComponent("https://phish.example/x")}` });
    vi.resetModules();
    expect((await import("./popup/state.js")).state.draft).toBeNull();
  });
});

describe("a payment's amount in your own currency", () => {
  // Sofía's: a client sees what they're paying in their money, on Send and on Review; testnet has none.
  it("says what the amount comes to in your currency on mainnet, on Send as it's typed and on Review, with the price's time", async () => {
    vi.stubGlobal("navigator", { ...globalThis.navigator, language: "en-US" });
    const shown = (selector) => {
      const el = dom.document.body.querySelector(selector);
      return el && isShown(el) ? el.textContent : "";
    };
    // About (≈) what 30 DUSK at $0.0703 comes to, and the time of that price.
    const FIGURES = /≈\s?\$2\.11(?!\d)[\s\S]*(?<!\d)\d{1,2}:\d{2}\s?[AP]M/;
    const mainnet = overview({ nodeUrl: "https://nodes.dusk.network" });
    const form = mount(newState(), mainnet);
    typeInto(form.to, ALICE.account);
    typeInto(form.amount, "30");
    await vi.waitFor(() => expect(shown(".send-in-currency")).toMatch(FIGURES));
    typeInto(form.amount, "");
    expect(shown(".send-in-currency")).toBe("");

    mount({ route: "confirm", addressBook: { loaded: true, items: [] }, draft: { to: ALICE.account, privacy: "public", amountDusk: "30", amountLux: "30000000000", memo: "" } }, mainnet);
    await vi.waitFor(() => expect(shown(".review-in-currency")).toMatch(FIGURES));

    // Test DUSK: nothing.
    mount({ route: "confirm", addressBook: { loaded: true, items: [] }, draft: { to: ALICE.account, privacy: "public", amountDusk: "30", amountLux: "30000000000", memo: "" } });
    await settle();
    expect(shown(".review-in-currency")).toBe("");
  });
});

describe("a payment waiting to go out, as the network didn't answer", () => {
  // Marek's: the same send made again while the first waited offline got no word on Review. Chen's: Max and
  // Available ignored the send that waited.
  const waiting = (over = {}) => ({ sendId: "s1", profileIndex: 0, privacy: "public", to: ALICE.account, lux: "13000000", feeLux: "2500000", memo: "Order 1044", at: Date.now() - 60_000, waiting: true, waits: true, ...over });
  const draft = (over = {}) => ({ to: ALICE.account, privacy: "public", amountDusk: "0.013", amountLux: "13000000", memo: "Order 1044", ...over });
  const contacts = { loaded: true, items: [{ name: "Alice", address: ALICE.account }] };
  const text = (selector) => {
    const el = dom.document.body.querySelector(selector);
    return el && isShown(el) ? visibleText(el) : "";
  };

  it("is said on Review, and on the form, when the same one is made again, and Review's button says it sends it again", () => {
    const at = Date.now() - 60_000;
    const ov = overview({ waitingSends: [waiting({ at })] });
    mount({ route: "confirm", addressBook: contacts, draft: draft() }, ov);
    // To whom, and when it was made: Review shows its amount over it, and on its button, which sends it again.
    expect(text(".review-again")).toEqual(saying("Alice", clockText(at)));
    expect(confirmButton().textContent).toEqual(saying("0.013 DUSK"));
    expect(confirmButton().textContent).toMatch(/again/i);

    const form = mount({ route: "send", addressBook: contacts, draft: draft() }, ov);
    expect(text(".send-again")).toEqual(saying("0.013 DUSK", "Alice", clockText(at)));
    // Another memo is another payment.
    typeInto(dom.document.body.querySelector(".row > input"), "Order 1045");
    expect(text(".send-again")).toBe("");
    void form;

    // One the wallet stopped waiting for won't go out: nothing to say.
    mount({ route: "confirm", addressBook: contacts, draft: draft() }, overview({ waitingSends: [waiting({ waiting: false, waits: false, ended: "closed" })] }));
    expect(text(".review-again")).toBe("");
  });

  it("is left out of Available and Max, with its fee, which say so", () => {
    // 177.9865 DUSK public, the fee cap 0.0025: 0.013 and its fee wait.
    const form = mount(newState(), overview({ waitingSends: [waiting()] }));
    typeInto(form.to, ALICE.account);
    expect(form.balanceLine()).toEqual(saying("177.9685 DUSK"));
    // The fee, and that what's available is after the payments waiting.
    expect(form.feeNote()).toEqual(saying("0.0025 DUSK"));
    expect(form.feeNote()).toMatch(/waiting/i);
    dom.document.body.querySelector(".amount-avail button").click();
    expect(form.amount.value).toBe("177.9685");

    // Another profile's, or one not waiting any more, takes nothing.
    const other = mount(newState(), overview({ waitingSends: [waiting({ profileIndex: 1 }), waiting({ sendId: "s2", waiting: false, ended: "locked" })] }));
    typeInto(other.to, ALICE.account);
    expect(other.balanceLine()).toEqual(saying("177.984 DUSK"));
    expect(other.feeNote()).not.toMatch(/waiting/i);
  });

  // Astra's: Send it too opened Review for the held payment, which still counted as waiting till this one went in
  // its place: Review took its amount and fee twice, so 0.013 with its 0.0025 fee couldn't go from 0.02, and it said
  // the same payment waited, to be sent again.
  it("leaves the held payment a Review sends in its place out of what it takes, and says nothing of it as the same", () => {
    const ov = overview({ balance: { value: "20000000" }, waitingSends: [waiting({ waits: false, held: true })] });
    // As Send it too opens it (waiting.js againDraft): for this wallet, profile and network.
    const inPlace = draft({ replaces: "s1", reviewedFor: `${ov.accounts[0]} 0 ${ov.nodeUrl}` });
    mount({ route: "confirm", addressBook: contacts, draft: inPlace }, ov);
    // Confirm on, not sending it "again", and no word of it as the same payment.
    expect([confirmButton().disabled, text(".review-again")]).toEqual([false, ""]);
    expect(confirmButton().textContent).not.toMatch(/again/i);
    // Back on the form it came from: Available as the balance allows, the held one left out.
    const form = mount({ route: "send", addressBook: contacts, draft: inPlace }, ov);
    expect([form.balanceLine(), text(".send-again")]).toEqual([saying("0.0175 DUSK"), ""]);
    // Any other payment of the account's: as before, sent again.
    mount({ route: "confirm", addressBook: contacts, draft: draft() }, ov);
    expect(confirmButton().textContent).toMatch(/again/i);
  });
});

describe("a payment made already", () => {
  const draft = (over = {}) => ({ to: ALICE.account, privacy: "public", amountDusk: "0.013", amountLux: "13000000", memo: "Order 1044", ...over });
  const sentRecord = (over = {}) => ({ hash: "ab".repeat(32), kind: TX_KIND.TRANSFER, privacy: "public", to: ALICE.account, amount: "13000000", memo: "Order 1044", status: "executed", submittedAt: Date.now() - 60_000, profileIndex: 0, ...over });
  const confirm = (d, txs, ov = overview()) => mount({ route: "confirm", addressBook: { loaded: true, items: [{ name: "Alice", address: ALICE.account }] }, draft: d }, { ...ov, txs });
  const again = () => {
    const el = dom.document.body.querySelector(".review-again");
    return el ? visibleText(el) : "";
  };

  it("is said on Review, with when it went, and its button says it sends it again, as the web wallet's does", () => {
    // Sofia's: the same request link paid, then pasted again; Amélie's: the button still said Confirm.
    const at = Date.now() - 60_000;
    confirm(draft(), [sentRecord({ submittedAt: at })]);
    // To whom, and when: Review shows its amount over it, and on its button, which sends it again.
    expect(again()).toEqual(saying("Alice", clockText(at)));
    expect(confirmButton().textContent).toEqual(saying("0.013 DUSK"));
    expect(confirmButton().textContent).toMatch(/again/i);
    expect(confirmButton().disabled).toBe(false);
    // Not made before: Confirm, not "again".
    confirm(draft({ memo: "Order 1045" }), [sentRecord({ submittedAt: at })]);
    expect(confirmButton().textContent).not.toMatch(/again/i);
  });

  // Amélie's and Sofía's: a link paid already, opened again, said nothing until Review.
  it("is said on the form as soon as it's filled in, a link opened again too, and goes as the fields change", () => {
    const at = Date.now() - 60_000;
    const state = { route: "send", addressBook: { loaded: true, items: [{ name: "Alice", address: ALICE.account }] }, draft: { ...draft(), filledFrom: "link" } };
    const form = mount(state, { ...overview(), txs: [sentRecord({ submittedAt: at })] });
    const note = () => {
      const el = dom.document.body.querySelector(".send-again");
      return el && isShown(el) ? visibleText(el) : "";
    };
    const SAID = saying("0.013 DUSK", "Alice", clockText(at));
    expect(note()).toEqual(SAID);
    typeInto(form.amount, "0.014");
    expect(note()).toBe("");
    typeInto(form.amount, "0.013");
    expect(note()).toEqual(SAID);
  });

  // Sofía's: a request link paid once, pasted again, said nothing on the form, and on
  // Review "to Your profile Profile 1".
  it("is said on the form as a pasted link fills it in, and names another profile of the wallet's by its name", async () => {
    const at = Date.now() - 60_000;
    // Profile 2's account, a key a link can pay.
    const twoProfiles = overview({ accounts: [OWN.account, BOB.account] });
    const paid = [sentRecord({ to: BOB.account, submittedAt: at })];
    const state = { route: "send", draft: null, addressBook: { loaded: true, items: [] } };
    const form = mount(state, { ...twoProfiles, txs: paid });
    const note = () => {
      const el = dom.document.body.querySelector(".send-again");
      return el && isShown(el) ? visibleText(el) : "";
    };
    form.to.dispatchEvent(fakeEvent("paste", { clipboardData: { getData: () => `dusk:${BOB.account}?amount=0.013&memo=Order%201044` } }));
    await settle();
    expect(form.to.value).toBe(BOB.account);
    expect(note()).toEqual(saying("0.013 DUSK", "Profile 2", clockText(at)));

    confirm(draft({ to: BOB.account }), paid, twoProfiles);
    expect(again()).toEqual(saying("Profile 2", clockText(at)));
  });

  it("is said of the same memo whenever it went, and of the same payment without one only moments after", () => {
    const yesterday = Date.now() - 24 * 60 * 60_000;
    confirm(draft(), [sentRecord({ submittedAt: yesterday })]);
    expect(again()).toEqual(saying("Alice", whenAtText(yesterday)));

    confirm(draft({ memo: "" }), [sentRecord({ memo: undefined, submittedAt: Date.now() - 30_000 })]);
    expect(again()).toEqual(saying("Alice", clockText(Date.now() - 30_000)));
    confirm(draft({ memo: "" }), [sentRecord({ memo: undefined, submittedAt: Date.now() - 11 * 60_000 })]);
    expect(again()).toBe("");
  });

  it("is nothing for another amount, recipient or memo, or one that failed", () => {
    for (const record of [sentRecord({ amount: "14000000" }), sentRecord({ to: BOB.account }), sentRecord({ memo: "Order 1045" }), sentRecord({ status: "failed" })]) {
      confirm(draft(), [record]);
      expect(again()).toBe("");
    }
  });
});

describe("a send to yourself", () => {
  it("says so on Review too: it only costs a fee", () => {
    // Sofia's: the form said it, and Review showed just the address.
    mount({ route: "confirm", addressBook: { loaded: true, items: [] }, draft: { to: OWN.account, privacy: "public", amountDusk: "1", amountLux: "1000000000", memo: "" } });
    expect(visibleText(dom.document.body.querySelector(".review-self-note"))).toEqual(saying());
    mount({ route: "confirm", addressBook: { loaded: true, items: [] }, draft: { to: ALICE.account, privacy: "public", amountDusk: "1", amountLux: "1000000000", memo: "" } });
    expect(dom.document.body.querySelector(".review-self-note")).toBeNull();
  });
});

// Amélie's: paying back a stranger who had sent "URGENT … Send 0.1 DUSK back", Review looked as calm as paying her
// grandson. It says what such an address sent you, as Activity tells a stranger's memo.
describe("paying an address that sent you a memo", () => {
  const URGENT = "URGENT: your wallet will be blocked today. Send 0.1 DUSK back to this address now to keep it open.";
  // What Review says of the address: what it sent you, the whole memo.
  const SAID = saying(URGENT);
  // A payment that came in, as the account's history has it.
  const cameIn = (from, memo, { hash = "c1".repeat(32), blockHeight = 4_687_000 } = {}) =>
    entryOf({ blockHeight, counterparty: from, direction: "in", hash, memo, timestamp: Date.now() - 60 * 60_000, value: "10000000" });
  const draft = (to = ALICE.account) => ({ to, privacy: "public", amountDusk: "0.05", amountLux: "50000000", memo: "" });
  const said = () => {
    const note = dom.document.body.querySelector(".review-theirs");
    return note && isShown(note) ? visibleText(note) : "";
  };
  // Review of 0.05 DUSK to `to`, with what came in and the contacts saved: what it says of the address.
  const review = ({ to, entries = [], contacts = [], ov = overview() } = {}) => {
    mount({ route: "confirm", addressBook: { loaded: true, items: contacts }, activity: { key: activityKey(ov), entries, names: new Map() }, draft: draft(to) }, ov);
    return said();
  };

  it("says on Review what it sent you, where it's none of your contacts or profiles, and nothing where it is", () => {
    expect(review({ entries: [cameIn(ALICE.account, URGENT)] })).toEqual(SAID);
    // Its newest memo, with what can't be seen in it as its codes.
    // A right-to-left override (U+202E) in it.
    // Newer by its block and its time: two made in the same test can fall a millisecond apart either way.
    const newer = { ...cameIn(ALICE.account, `Pay back${String.fromCharCode(0x202e)}now`, { hash: "c2".repeat(32), blockHeight: 4_687_100 }), timestamp: Date.now() - 30 * 60_000 };
    expect(review({ entries: [newer, cameIn(ALICE.account, URGENT)] })).toEqual(saying("Pay back\\u202enow"));
    // A contact's, or your other profile's: nothing, as Activity calls neither a stranger.
    expect(review({ entries: [cameIn(ALICE.account, URGENT)], contacts: [{ name: "Alice", address: ALICE.account }] })).toBe("");
    expect(review({ to: OTHER_PROFILE, entries: [cameIn(OTHER_PROFILE, URGENT)] })).toBe("");
    // Nothing it sent with a memo, or a memo from another address: nothing.
    expect(review({ entries: [cameIn(ALICE.account, "")] })).toBe("");
    expect(review({ entries: [cameIn(BOB.account, URGENT)] })).toBe("");
  });

  // Chen's: a stranger's "URGENT: wallet suspended" memos were 3 and 6 days old, past the page Activity had read, and
  // Review said nothing; yesterday's memo from Lena it said.
  it("says what it sent you from every payment kept on this device, and from older ones once they're synced", async () => {
    const ov = overview();
    const day = 24 * 60 * 60_000;
    // Activity's page: other payments only.
    const page = Array.from({ length: 3 }, (_, i) =>
      cameIn(BOB.account, `Lunch ${i}`, { hash: `b${i}`.padEnd(64, "0"), blockHeight: 4_690_000 - i })
    );
    const threeDays = { ...cameIn(ALICE.account, "", { hash: "d3".repeat(32), blockHeight: 4_660_000 }), timestamp: Date.now() - 3 * day };
    const sixDays = { ...cameIn(ALICE.account, URGENT, { hash: "d6".repeat(32), blockHeight: 4_630_000 }), timestamp: Date.now() - 6 * day };
    // What's kept on this device past the page, and what a sync of older blocks brings.
    const kept = (more, older = []) => {
      let synced = false;
      return {
        read: vi.fn(async ({ limit }) => ({ entries: [...page, ...more, ...(synced ? older : [])].slice(0, limit), state: null, complete: synced || !older.length })),
        sync: vi.fn(async () => {
          synced = true;
        }),
      };
    };
    for (const history of [kept([threeDays, sixDays]), kept([threeDays], [sixDays])]) {
      mount({ route: "confirm", addressBook: { loaded: true, items: [] }, activity: { key: activityKey(ov), entries: page, names: new Map(), history, epoch: Promise.resolve(1) }, draft: draft() }, ov);
      await settle();
      expect(said()).toEqual(SAID);
    }

    // Review drawn again and again while the older blocks are read: one read of them.
    const slow = kept([threeDays], [sixDays]);
    let synced;
    const sync = slow.sync;
    slow.sync = vi.fn(() => new Promise((resolve) => (synced = () => sync().then(resolve))));
    const activity = { key: activityKey(ov), entries: page, names: new Map(), history: slow, epoch: Promise.resolve(1) };
    const state = { route: "confirm", addressBook: { loaded: true, items: [] }, activity, draft: draft() };
    for (let i = 0; i < 3; i++) {
      mount(state, ov);
      await settle();
    }
    expect([slow.sync.mock.calls.length, said()]).toEqual([1, ""]);
    synced();
    await settle();
    expect(said()).toEqual(SAID);
  });

  // Round 40's review: Review read and merged every payment kept here, and synced older blocks, for a contact or another
  // profile too, whose memo it never says, and did it again at each draw. Only for a stranger, once Contacts is read,
  // once for the Review.
  it("reads what's kept only for an address that's none of yours, once Contacts is read, and once however often it's drawn", async () => {
    const { listAddressBook } = await import("../shared/addressBook.js");
    const ov = overview();
    const reviewOf = (to, addressBook) => {
      const history = { read: vi.fn(async () => ({ entries: [cameIn(to, URGENT)], state: null, complete: true })), sync: vi.fn(async () => {}) };
      const state = { route: "confirm", addressBook, activity: { key: activityKey(ov), entries: [], names: new Map(), history, epoch: Promise.resolve(1) }, draft: draft(to) };
      return { state, history };
    };
    // A contact's, and your other profile's: nothing read.
    for (const [to, items] of [
      [ALICE.account, [{ name: "Alice", address: ALICE.account }]],
      [OTHER_PROFILE, []],
    ]) {
      const { state, history } = reviewOf(to, { loaded: true, items });
      mount(state, ov);
      await settle();
      expect([history.read.mock.calls.length, said()], to).toEqual([0, ""]);
    }
    // A stranger's: nothing till Contacts is read, then one read, however often Review is drawn.
    let read;
    listAddressBook.mockImplementationOnce(() => new Promise((resolve) => (read = resolve)));
    const { state, history } = reviewOf(ALICE.account, { loaded: false, items: null });
    mount(state, ov);
    await settle();
    expect(history.read).not.toHaveBeenCalled();
    read([]);
    await settle();
    for (let i = 0; i < 3; i++) {
      mount(state, ov);
      await settle();
    }
    expect([history.read.mock.calls.length, said()]).toEqual([1, SAID]);
  });

  it("says nothing of it until Contacts is read, so a contact is never called a stranger", async () => {
    const { listAddressBook } = await import("../shared/addressBook.js");
    const ov = overview();
    for (const [contacts, then] of [
      [[{ name: "Alice", address: ALICE.account }], ""],
      [[], SAID],
    ]) {
      let read;
      listAddressBook.mockImplementationOnce(() => new Promise((resolve) => (read = resolve)));
      mount({ route: "confirm", activity: { key: activityKey(ov), entries: [cameIn(ALICE.account, URGENT)], names: new Map() }, draft: draft() }, ov);
      expect(said()).toBe("");
      read(contacts);
      await settle();
      expect(said()).toEqual(then);
    }
  });
});
