import { readFile } from "node:fs/promises";
import path from "node:path";
import { decodeBase58, encodeBase58 } from "@duskdomains/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { networks, routes } from "@dusk-network/networks";
import { parsePaymentLink } from "@dusk-network/app-core/payment-links";
import { TX_KIND } from "../shared/constants.js";
import { isAccount } from "@dusk-network/networks/account";
import { lookupDuskName, lookupPrimaryName } from "../shared/duskNames.js";
import fixtures from "../shared/fixtures/duskevm-bridge-calls.json";
import { noteChainId } from "../shared/nodeNetwork.js";
import { shortAddress } from "./lib/strings.js";
import { clockText } from "./lib/time.js";
import { fakeEvent, installFakeDom, isShown, pastClickGuard, settle, typeInto, visibleText } from "./testing/fakeDom.js";
import { iconSvg } from "./components/ActionIcon.js";
import { parseDuskQrPayload } from "./components/QrScanModal.js";
import { sendConfirmView, sendFormView } from "./popup/views/send.js";
import { reviewOf } from "./popup/views/sent.js";

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

  it("uses shared recipient badges for send contact and privacy indicators", async () => {
    const sendView = await readFile(
      path.resolve(process.cwd(), "src", "ui", "popup", "views", "send.js"),
      "utf8"
    );
    const badgeComponent = await readFile(
      path.resolve(process.cwd(), "src", "ui", "components", "RecipientBadge.js"),
      "utf8"
    );
    const css = await readFile(path.resolve(process.cwd(), "public", "ui.css"), "utf8");

    expect(sendView).toContain("RecipientBadge.js");
    expect(sendView).toContain("recipientTypeBadgeOptions");
    expect(sendView).toContain('kind: "contact"');
    expect(sendView).toContain('className: "to-chip"');

    expect(badgeComponent).toContain("recipientBadge");
    expect(badgeComponent).toContain('label: "Public"');
    expect(badgeComponent).toContain('label: "Shielded"');
    expect(badgeComponent).toContain('icon: "public"');
    expect(badgeComponent).toContain('icon: "shielded"');
    expect(badgeComponent).not.toContain('icon: "P"');
    expect(badgeComponent).not.toContain('icon: "S"');

    expect(css).toContain(".recipient-badge--contact");
    // Calm chips: neither a saved contact nor Public/Shielded takes a colour.
    expect(css).toMatch(/\.recipient-badge--contact\s*\{[^}]*var\(--surface-2\)/s);
    expect(css).toContain(".recipient-badge--rail");
    expect(css).toMatch(/\.recipient-badge--rail\s*\{[^}]*var\(--surface-2\)/s);
    expect(css).not.toMatch(/\.recipient-badge--(contact|rail)\s*\{[^}]*var\(--(ok|primary)\)/s);
    expect(css).toContain(".recipient-badge__glyph--svg svg");
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
const ALICE = { account: vary(ACCOUNT, 2), address: vary(ADDRESS, 2) };
const BOB = { account: vary(ACCOUNT, 3), address: vary(ADDRESS, 3) };

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

let dom;

beforeEach(() => {
  dom = installFakeDom();
  lookupPrimaryName.mockReset();
  lookupPrimaryName.mockImplementation(async () => null);
  isAccount.mockReset();
  isAccount.mockReturnValue(true);
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
    review: $("button.btn-primary"),
    radios,
    picked: () => radios().map((r) => r.getAttribute("aria-checked")),
    pill: () => {
      const pill = $(".row > .recipient-type-badge");
      return isShown(pill) ? pill.textContent : "";
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
    reviewTo: () => visibleText($(".review-to")),
  };
}

describe("send form", () => {
  it("labels its scan and contacts icons and its Max, and its placeholders don't repeat the labels", () => {
    const form = mount(newState());
    const body = dom.document.body;
    expect(
      body.querySelectorAll(".input-row .icon-only").map((b) => [b.getAttribute("aria-label"), b.innerHTML, b.textContent])
    ).toEqual([
      ["Scan QR", iconSvg("qr"), ""],
      ["Contacts", iconSvg("contacts"), ""],
    ]);
    expect(body.querySelector(".amount-avail button").textContent).toBe("Max");
    expect(body.querySelectorAll("label").map((l) => l.textContent)).toEqual(["To", "Amount", "Memo"]);
    expect([form.to, form.amount, body.querySelector(".row > input")].map((i) => i.getAttribute("placeholder"))).toEqual([
      "Account, shielded address or .dusk name",
      "0",
      "Optional",
    ]);

    // Without .dusk names on the network, the field takes an account or an address.
    mount(newState(), overview({ nodeUrl: "http://127.0.0.1:8080" }));
    expect(body.querySelector(".to-input-wrap textarea").getAttribute("placeholder")).toBe("Account or shielded address");
  });
});

describe("send to a .dusk name with both addresses", () => {
  it("shows option cards under the name, on the public account by default", () => {
    const form = mount(newState());
    typeInto(form.to, "alice.dusk");

    expect(dom.document.body.querySelector(".name-points-to").textContent).toBe("alice.dusk points to");
    expect(dom.document.body.querySelector("[role=radiogroup]")).not.toBeNull();
    expect(form.radios().map((r) => r.querySelector(".name-option__line").textContent)).toEqual([
      "Visible on chain",
      "Private",
    ]);
    expect(form.picked()).toEqual(["true", "false"]);
    // The cards make the choice: no pill, and no balances or full address with them.
    expect(form.pill()).toBe("");
    expect(visibleText(form.nameBox())).toBe(
      `alice.dusk points toPublic account${shortAddress(ALICE.account)}Visible on chain` +
        `Shielded address${shortAddress(ALICE.address)}Private`
    );
    expect(form.balanceLine()).toBe("Available after fees 177.984 DUSK");
    expect(form.review.disabled).toBe(false);
    // The old Public account | Shielded address switch is gone.
    expect(dom.document.body.querySelector(".name-address-toggle")).toBeNull();
  });

  it("says what's really missing when the balance is below the fee", () => {
    const form = mount(newState(), overview({ balance: { value: "0" } }));
    typeInto(form.to, ALICE.account);
    typeInto(form.amount, "1");

    // Sending that much more must be enough: the amount and the whole fee.
    expect(form.amountError()).toBe("That's 1.0025 DUSK more than your public balance, with the network fee.");
  });

  it("follows the picked card in the balance line", () => {
    const state = newState();
    const form = mount(state);
    typeInto(form.to, "alice.dusk");
    form.radios()[1].click();

    expect(form.picked()).toEqual(["false", "true"]);
    expect(form.pill()).toBe("");
    expect(form.balanceLine()).toBe("Available after fees 24.95 DUSK");
    expect(state.draft.nameChoices).toEqual({ "alice.dusk": true });

    form.radios()[0].click();
    expect(form.picked()).toEqual(["true", "false"]);
    expect(form.balanceLine()).toBe("Available after fees 177.984 DUSK");
  });

  it("shows the pill for a pasted account or address, where it is the only sign of the transfer type", () => {
    const form = mount(newState());
    typeInto(form.to, ALICE.account);
    expect(form.pill()).toBe("Public");
    typeInto(form.to, "alice.dusk");
    expect(form.pill()).toBe("");
    typeInto(form.to, ALICE.address);
    expect(form.pill()).toBe("Shielded");
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
    expect(form.balanceLine()).toBe("Available after fees 24.95 DUSK");

    typeInto(form.to, "bob.dusk");
    expect(form.picked()).toEqual(["true", "false"]);
    expect(form.balanceLine()).toBe("Available after fees 177.984 DUSK");

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
    expect([review.kind(), review.visibleLine()]).toEqual(["Shielded transfer", null]);
    dom.document.body.querySelector(".subnav-back").click();
    expect(state.route).toBe("send");

    form = mount(state);
    expect(form.to.value).toBe("alice.dusk");
    expect(form.picked()).toEqual(["false", "true"]);
    expect(form.balanceLine()).toBe("Available after fees 24.95 DUSK");
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
    expect(hint.textContent).toBe("Not enough shielded DUSK · Shield first");
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

    // As with two addresses, but one card, picked, with nothing to choose.
    const carol = NAMES["carol.dusk"].address;
    expect(form.radios()).toEqual([]);
    expect(form.pill()).toBe("");
    expect(visibleText(form.nameBox())).toBe(
      `carol.dusk points toShielded address${shortAddress(carol)}Not enough shielded DUSK · Shield first`
    );
    expect(form.nameBox().querySelector(".name-option.is-checked")).not.toBeNull();
    expect(form.review.disabled).toBe(true);

    form.shortfall().querySelector("button").click();
    expect(state.route).toBe("convert");

    const funded = mount(newState());
    typeInto(funded.to, "carol.dusk");
    expect(visibleText(funded.nameBox())).toBe(`carol.dusk points toShielded address${shortAddress(carol)}Private`);
    expect(funded.balanceLine()).toBe("Available after fees 24.95 DUSK");
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
    expect(visibleText(form.nameBox())).toBe(`dave.dusk points toPublic account${shortAddress(dave)}Visible on chain`);
    // The full account shows on Review, not here.
    expect(form.nameBox().querySelector(".box")).toBeNull();
    expect(form.review.disabled).toBe(false);

    typeInto(form.amount, "1");
    form.review.click();
    await settle();
    expect(state.draft).toMatchObject({ to: dave, privacy: "public", duskName: { name: "dave.dusk" } });
    const review = mount(state, ov);
    expect(review.visibleLine()).toBe("Visible to everyone: amount, your account, and the recipient's account.");
    expect(review.reviewTo()).toBe(`dave.dusk${dave}`);
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
    const confirm = () => dom.document.body.querySelectorAll("button").find((b) => b.textContent === "Confirm");
    const offline = () => [...dom.document.body.querySelectorAll(".offline-note")].filter(isShown).map((n) => n.textContent);
    expect(confirm().disabled).toBe(true);
    expect(offline()).toEqual(["You're offline. Confirm once you're back online."]);
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
    expect(visibleText(dom.document.body.querySelector(".gas-total-value"))).toBe("up to •••• DUSK");
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
    expect(visibleText(form.nameBox())).toBe("Not a valid address. Check it and try again.");
    expect(form.pill()).toBe("");
    expect(form.review.disabled).toBe(true);

    // Corrected, it's an account again.
    isAccount.mockReturnValue(true);
    typeInto(form.to, ALICE.account);
    expect(visibleText(form.nameBox())).toBe("");
    expect(form.pill()).toBe("Public");
    expect(form.review.disabled).toBe(false);
  });

  it("says the same of what's too long to be a name and is no address either", () => {
    const form = mount(newState());
    for (const typo of [`${ALICE.account}x`, ALICE.account.slice(0, 70), `${ALICE.account.slice(0, 60)}0${ALICE.account.slice(61)}`]) {
      typeInto(form.to, typo);
      expect(visibleText(form.nameBox())).toBe("Not a valid address. Check it and try again.");
      expect(form.pill()).toBe("");
      expect(form.review.disabled).toBe(true);
    }
  });

  it("drops what Review said once the recipient changes, in plain words", async () => {
    const form = mount(newState());
    typeInto(form.amount, "1");
    typeInto(form.to, "someone new");
    form.review.click();
    await settle();
    expect(visibleText(dom.document.body.querySelector(".err"))).toBe("Not a valid address. Check it and try again.");
    typeInto(form.to, ALICE.account);
    expect(dom.document.body.querySelector(".err").textContent).toBe("");
  });

  it("joins up an address that a chat app broke with spaces", () => {
    const form = mount(newState());
    typeInto(form.to, `${ALICE.account.slice(0, 40)} ${ALICE.account.slice(40, 80)}\n${ALICE.account.slice(80)}`);
    expect(form.to.value).toBe(ALICE.account);
    expect(form.pill()).toBe("Public");
    expect(form.review.disabled).toBe(false);
  });

  it("offers a contact by name before any .dusk name, which would be somebody else's", () => {
    const state = newState();
    state.addressBook.items = [
      { name: "Alice", address: BOB.account },
      { name: "Jan (flour)", address: BOB.address },
    ];
    const form = mount(state);

    typeInto(form.to, "alice");
    expect(visibleText(form.nameBox())).toBe(`Your contact Alice · ${shortAddress(BOB.account)}`);

    typeInto(form.to, "flour");
    expect(visibleText(form.nameBox())).toBe(`Your contact Jan (flour) · ${shortAddress(BOB.address)}`);

    // Nothing by that name in Contacts: the guess is still offered.
    typeInto(form.to, "bob");
    expect(visibleText(form.nameBox())).toBe("Did you mean bob.dusk?");

    typeInto(form.to, "alice");
    form.nameBox().querySelector("button").click();
    expect(form.to.value).toBe(BOB.account);
    expect(form.pill()).toBe("Public");
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
    expect(form.nameBox().querySelectorAll("button").map((b) => b.textContent)).toEqual([
      `Your contact Estudio Marta · ${shortAddress(ALICE.account)} · looks like another contact`,
      `Your contact Estudio M\u0430rta · ${shortAddress(BOB.account)} · looks like another contact`,
      `Your contact Estudio Sol · ${shortAddress(BOB.address)}`,
    ]);
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
    expect(note()).toBe("Looks like another contact. Check the address.");
    typeInto(form.to, BOB.address);
    expect(note()).toBe("");

    state.route = "confirm";
    state.draft = { to: BOB.account, privacy: "public", amountDusk: "1", amountLux: "1000000000", memo: "" };
    form = mount(state);
    expect(form.reviewTo()).toBe(`Estudio M\u0430rta · looks like another contact${BOB.account}`);
  });
});

describe("a memo too long for the network", () => {
  it("says so under the field and stays on the form, counting bytes", async () => {
    const state = newState();
    const form = mount(state);
    const memo = dom.document.body.querySelectorAll("input").find((i) => i.getAttribute("placeholder") === "Optional");
    const error = () => {
      const el = dom.document.body.querySelector(".memo-error");
      return isShown(el) ? el.textContent : "";
    };
    typeInto(form.to, ALICE.account);
    typeInto(form.amount, "1");

    typeInto(memo, "x".repeat(513));
    expect(error()).toBe("That memo is too long: 512 bytes at most.");
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
    expect(form.feeNote()).toBe("Network fee up to 0.005 DUSK");
    expect(form.balanceLine()).toBe("Available after fees 177.9815 DUSK");

    // Its Review: the same fee.
    typeInto(form.amount, "1");
    state.route = "confirm";
    Object.assign(state.draft, { privacy: "public", amountLux: "1000000000" });
    mount(state, overview(), async (message) => (message.type === "DUSK_UI_GET_CACHED_GAS_PRICE" ? { min: "1", median: "2", max: "5" } : {}));
    await settle();
    expect(visibleText(dom.document.body.querySelector("dusk-gas-editor .gas-fee"))).toBe("Network feeup to 0.005 DUSKTotalup to 1.005 DUSK");
  });

  it("says what's available after fees, fills Max, and says under the field what's wrong", () => {
    const state = newState();
    const form = mount(state);
    // No recipient yet: nothing to measure against.
    expect(isShown(dom.document.body.querySelector(".amount-avail"))).toBe(false);
    typeInto(form.to, ALICE.account);
    expect(form.balanceLine()).toBe("Available after fees 177.984 DUSK");
    expect(form.feeNote()).toBe("Network fee up to 0.0025 DUSK");

    dom.document.body.querySelector(".amount-avail button").click();
    expect(form.amount.value).toBe("177.984");
    expect(form.amountError()).toBe("");

    typeInto(form.amount, "500");
    expect(form.amountError()).toBe("That's 322.016 DUSK more than your public balance, with the network fee.");
    expect(form.amount.getAttribute("aria-invalid")).toBe("true");
    typeInto(form.amount, "0");
    expect(form.amountError()).toBe("Enter an amount greater than 0.");

    // Review asks for an amount instead of going on without one.
    typeInto(form.amount, "");
    form.review.click();
    expect(form.amountError()).toBe("Enter an amount.");
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
      expect(next.amountError()).toBe("Enter an amount such as 1 or 0.5.");
    }
    const last = mount(newState());
    typeInto(last.to, ALICE.account);
    typeInto(last.amount, "0,1234567891234");
    expect(last.amountError()).toBe("DUSK has 9 decimals at most.");
    typeInto(last.amount, "0.0000000001");
    expect(last.amountError()).toBe("DUSK has 9 decimals at most.");
    typeInto(last.amount, "1,234");
    expect(last.amountError()).toBe("Is that 1234 or 1.234? Write the one you mean.");
  });

  // Lena's: "1,000" asked and "1.000" didn't. In English the point is the
  // decimal; where the comma is, "1.000" asks, in the web wallet's words.
  it.each([
    ["de-DE", "1.000", "Is that 1000 or 1,000? Write the one you mean."],
    ["nl-NL", "1.000", "Is that 1000 or 1,000? Write the one you mean."],
    ["en-GB", "1,000", "Is that 1000 or 1.000? Write the one you mean."],
    ["es-ES", "1 234,5", "Leave out the space: 1234,5."],
  ])("asks which amount is meant where it could be two, in the language's reading: %s %s", (language, typed, asked) => {
    vi.stubGlobal("navigator", { ...globalThis.navigator, language });
    const form = mount(newState());
    typeInto(form.to, ALICE.account);
    typeInto(form.amount, typed);
    expect([form.amountError(), form.review.disabled]).toEqual([asked, true]);
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
    expect([form.balanceLine(), form.feeNote()]).toEqual(["Available after fees 177.979 DUSK", "Network fee up to 0.0075 DUSK"]);
    form.radios()[1].click();
    expect([form.balanceLine(), form.feeNote()]).toEqual(["Available after fees 24.85 DUSK", "Network fee up to 0.15 DUSK"]);
    form.radios()[0].click();
    typeInto(form.amount, "177.98");
    expect(form.amountError()).toBe("That's 0.001 DUSK more than your public balance, with the network fee.");
    dom.document.body.querySelector(".amount-avail button").click();
    expect(form.amount.value).toBe("177.979");

    // Review asks that fee: Max and the fee make up the whole balance.
    form.review.click();
    await settle();
    expect(state.route).toBe("confirm");
    mount(state, ov);
    await settle();
    expect(visibleText(dom.document.body.querySelector(".gas-fee"))).toBe("Network feeup to 0.0075 DUSKTotalup to 177.9865 DUSK");
  });

  it("hides what's available with Hide balances, while Max still fills in the real amount", () => {
    const form = mount(newState(), overview({ hideBalances: true }));
    typeInto(form.to, ALICE.account);
    expect(form.balanceLine()).toBe("Available after fees •••• DUSK");
    // The fee isn't a balance.
    expect(form.feeNote()).toBe("Network fee up to 0.0025 DUSK");
    dom.document.body.querySelector(".amount-avail button").click();
    expect(form.amount.value).toBe("177.984");
  });
});

describe("names on Send and Review", () => {
  it("shows a pasted public account's verified .dusk name", async () => {
    lookupPrimaryName.mockImplementation(async (account) => (account === BOB.account ? "bob.dusk" : null));
    const form = mount(newState());
    typeInto(form.to, BOB.account);
    await settle();
    expect(visibleText(form.nameBox())).toBe("bob.dusk · its verified .dusk name");

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
    const rows = () => dom.document.body.querySelectorAll(".send-review > .group > .kv").map(visibleText);
    expect(rows()).toEqual([`ToBobby · bob.dusk${BOB.account}`, "Fromme.dusk · Public"]);
    expect(view.visibleLine()).toBe("Visible to everyone: amount, your name me.dusk, and the recipient's account.");
    // Saved already: no Save to Contacts.
    expect(isShown(dom.document.body.querySelector(".review-save-contact"))).toBe(false);
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
    const from = () => visibleText(dom.document.body.querySelectorAll(".send-review > .group > .kv")[1]);
    const state = { route: "confirm", addressBook: { loaded: true, items: [] }, draft: draft(BOB.account, "public") };
    mount(state, overview({ wallets }));
    await settle();
    expect(from()).toBe("FromWallet 2 · me.dusk · Public");
    // A name given to the wallet, on a shielded send.
    mount({ ...state, draft: draft(BOB.address, "shielded") }, overview({ wallets: [wallets[0], { ...wallets[1], name: "Savings" }] }));
    await settle();
    expect(from()).toBe("FromSavings · me.dusk · Shielded");
    // One wallet: the profile alone.
    mount(state, overview({ wallets: [{ ...wallets[1], n: 1 }] }));
    await settle();
    expect(from()).toBe("Fromme.dusk · Public");
  });

  it("names your other profile, on the form and on Review, and offers no Save to Contacts", async () => {
    const ov = overview({ accountNames: { 1: "Savings" } });
    const form = mount(newState(), ov);
    typeInto(form.to, OTHER_PROFILE);
    await settle();
    expect(visibleText(dom.document.body.querySelector(".to-chip"))).toBe("Savings");

    mount(
      {
        route: "confirm",
        addressBook: { loaded: true, items: [] },
        draft: { to: OTHER_PROFILE, privacy: "public", amountDusk: "1", amountLux: "1000000000", memo: "" },
      },
      ov
    );
    await settle();
    expect(visibleText(dom.document.body.querySelector(".review-to__names"))).toBe("Your profile Savings");
    expect(isShown(dom.document.body.querySelector(".review-save-contact"))).toBe(false);

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
    expect(visibleText(dom.document.body.querySelector(".review-to__names"))).toBe("Savings · looks like your profile's name");
  });

  it("offers no Save to Contacts for this wallet's own account or address", () => {
    for (const to of [OWN.account, OWN.address]) {
      mount({
        route: "confirm",
        addressBook: { loaded: true, items: [] },
        draft: { to, privacy: to === OWN.address ? "shielded" : "public", amountDusk: "1", amountLux: "1000000000", memo: "" },
      });
      expect(isShown(dom.document.body.querySelector(".review-save-contact"))).toBe(false);
    }
    mount({
      route: "confirm",
      addressBook: { loaded: true, items: [] },
      draft: { to: ALICE.account, privacy: "public", amountDusk: "1", amountLux: "1000000000", memo: "" },
    });
    expect(isShown(dom.document.body.querySelector(".review-save-contact"))).toBe(true);
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
    typeInto(form.to, "dav.dusk");
    expect(visibleText(form.nameBox())).toBe("dav.dusk isn't registered.Did you mean dave.dusk?");
    typeInto(form.to, "alcie.dusk");
    expect(visibleText(form.nameBox())).toBe("alcie.dusk isn't registered.Did you mean alice.dusk?");
    // Only the typed names were looked up.
    expect(lookupDuskName.mock.calls.map(([name]) => name)).toEqual(["dav.dusk", "alcie.dusk"]);

    form.nameBox().querySelector("button.name-suggestion").click();
    expect(form.to.value).toBe("alice.dusk");
    expect(state.draft.to).toBe("alice.dusk");
    expect(visibleText(dom.document.body.querySelector(".name-points-to"))).toBe("alice.dusk points to");

    // A recent counterparty's name, and nothing when no known name is close.
    typeInto(form.to, "bbo.dusk");
    expect(visibleText(form.nameBox())).toBe("bbo.dusk isn't registered.Did you mean bob.dusk?");
    typeInto(form.to, "zed.dusk");
    expect(visibleText(form.nameBox())).toBe("zed.dusk isn't registered.");
  });
});

describe("a name typed without .dusk", () => {
  it("offers the .dusk name it likely means, for a bare name or one with a dot after it, and looks it up once taken", () => {
    const state = newState();
    const form = mount(state);
    for (const typed of ["alice", "alice.dusk."]) {
      typeInto(form.to, typed);
      expect([visibleText(form.nameBox()), form.pill()]).toEqual(["Did you mean alice.dusk?", ""]);
    }
    expect(lookupDuskName).not.toHaveBeenCalled();

    form.nameBox().querySelector("button.name-suggestion").click();
    expect([form.to.value, state.draft.to]).toEqual(["alice.dusk", "alice.dusk"]);
    expect(lookupDuskName.mock.calls.map(([name]) => name)).toEqual(["alice.dusk"]);
    expect(visibleText(dom.document.body.querySelector(".name-points-to"))).toBe("alice.dusk points to");

    // An address in the making, or anything else, is no name.
    typeInto(form.to, "26FCH745");
    expect([visibleText(form.nameBox()), form.pill()]).toEqual(["", "?Unknown"]);
  });

  it("offers none on a network without names", () => {
    const form = mount(newState(), overview({ nodeUrl: "http://127.0.0.1:8080" }));
    typeInto(form.to, "alice");
    expect([visibleText(form.nameBox()), form.pill()]).toEqual(["", "?Unknown"]);
  });
});

describe("an EVM address", () => {
  it("says it's an EVM address, not a Dusk account, and keeps Review off", () => {
    for (const nodeUrl of [undefined, "http://127.0.0.1:8080"]) {
      const form = mount(newState(), overview(nodeUrl ? { nodeUrl } : {}));
      typeInto(form.to, "0xAB84EDFFd745AF9420ac74FeC73121FBEE9fC86F");
      expect([visibleText(form.nameBox()), form.pill(), form.review.disabled]).toEqual([
        "That's an EVM address, not a Dusk account.",
        "",
        true,
      ]);
      // In any case.
      typeInto(form.to, "0xab84edffd745af9420ac74fec73121fbee9fc86f");
      expect(visibleText(form.nameBox())).toBe("That's an EVM address, not a Dusk account.");
      // Anything shorter isn't one.
      typeInto(form.to, "0xAB84EDFF");
      expect([visibleText(form.nameBox()), form.pill(), form.review.disabled]).toEqual(["", "?Unknown", false]);
    }
  });
});

describe("sending to yourself", () => {
  const ACCOUNT_NOTE = "This is your own account. Sending to yourself only costs a fee.";
  const ADDRESS_NOTE = "This is your own address. Sending to yourself only costs a fee.";

  it("warns for your own pasted account or shielded address and still allows Review", () => {
    const form = mount(newState());
    typeInto(form.to, OWN.account);
    expect(form.selfNote()).toBe(ACCOUNT_NOTE);
    expect(form.review.disabled).toBe(false);

    typeInto(form.to, OWN.address);
    expect(form.selfNote()).toBe(ADDRESS_NOTE);

    // Another profile of this wallet, someone else, or nothing: no warning.
    for (const value of [OTHER_PROFILE, ALICE.account, ALICE.address, ""]) {
      typeInto(form.to, value);
      expect(form.selfNote()).toBe("");
    }
  });

  it("warns for a name that points to you, following the picked address", () => {
    const form = mount(newState());
    typeInto(form.to, "me.dusk");
    expect(form.selfNote()).toBe(ACCOUNT_NOTE);
    form.radios()[1].click();
    expect(form.selfNote()).toBe(ADDRESS_NOTE);
    expect(form.review.disabled).toBe(false);

    typeInto(form.to, "alice.dusk");
    expect(form.selfNote()).toBe("");
  });
});

describe("a recipient the network's file blocks", () => {
  it("says why under the field, as the web wallet does, and keeps Review off", async () => {
    const form = mount(newState());
    const banner = () => dom.document.body.querySelector(".send-blocked");
    for (const { account, reason } of networks.testnet.display.blocklist) {
      typeInto(form.to, account);
      expect(isShown(banner())).toBe(true);
      expect(visibleText(banner())).toBe(
        `Blocked recipient address${
          reason === "scam"
            ? "Transfer restricted: this recipient address is associated with reported fraud/scam activity."
            : "Transfer restricted: this recipient address has been reported as compromised."
        }`
      );
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
    const confirm = body.querySelectorAll("button").find((b) => b.textContent === "Confirm");
    const guard = body.querySelector(".pay-guard");
    expect([isShown(guard), confirm.disabled]).toEqual([false, false]);

    const editor = body.querySelector("dusk-gas-editor");
    editor.setGas({ limit: "2500000", price: "10" });
    await settle();
    expect(guard.textContent).toBe("That's 0.015 DUSK more than your public balance, with the network fee.");
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
    expect(body.querySelector(".pay-guard").textContent).toContain("more than your shielded balance, with the network fee.");
    review({ to: ALICE.account, privacy: "public" }, overview({ balance: null }), send);
    await settle();
    expect(isShown(body.querySelector(".pay-guard"))).toBe(false);
    expect(body.querySelectorAll("button").find((b) => b.textContent === "Confirm").disabled).toBe(false);
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
    body.querySelectorAll("button").find((b) => b.textContent === "Confirm").click();
    await settle();
    expect(sent[0].params.memo).toBe(memo);
  });

  it("says on Review when a memo's number may not read as its digits do", async () => {
    // Marek's memo, from a link: an Arabic-Indic zero in 105.
    review({ to: ALICE.account, privacy: "public", memo: "Invoice 1\u06605" }, overview());
    await settle();
    const row = dom.document.body.querySelectorAll(".kv").find((kv) => kv.querySelector(".kv-label")?.textContent === "Memo");
    expect(row.querySelectorAll(".safe-text__flag").map((el) => el.textContent)).toEqual(["A number here mixes digits of different scripts. Check it digit by digit."]);
  });

  it("shows the fee at the network's price and the total with Back and Confirm, and Custom fee for gas of your own", async () => {
    // The node asks 2 LUX; a transfer returns its hash.
    const send = async (message) =>
      message.type === "DUSK_UI_GET_CACHED_GAS_PRICE"
        ? { min: "1", median: "2", max: "5" }
        : { ok: true, result: { hash: "ab".repeat(32) } };
    const view = review({ to: ALICE.account, privacy: "public" }, overview(), send);
    await settle();
    const body = dom.document.body;
    const shownButtons = () => body.querySelectorAll("button").filter(isShown).map((b) => b.textContent);

    // Back is the way back to Send, so there is no Cancel; no presets either.
    expect(shownButtons()).toEqual(["← Back", "Save to Contacts", "Confirm"]);
    expect(visibleText(body.querySelector("dusk-gas-editor .gas-fee"))).toBe("Network feeup to 0.005 DUSKTotalup to 1.005 DUSK");
    expect(visibleText(body.querySelector("details.gas-custom summary"))).toBe("Custom fee");

    // A gas price of your own, under Custom fee, is what Confirm sends.
    const price = body.querySelectorAll("dusk-gas-editor input")[1];
    typeInto(price, "1");
    const button = (text) => body.querySelectorAll("button").find((b) => b.textContent === text);
    button("Confirm").click();
    await settle();
    expect(view.actions.send).toHaveBeenLastCalledWith({
      type: "DUSK_UI_SEND_TX",
      params: expect.objectContaining({ to: ALICE.account, privacy: "public", gas: { limit: "2500000", price: "1" } }),
      walletId: overview().accounts[0],
    });
  });

  it("hides Use the network's price while the fee is the network's, custom gas from Settings that equals it too", async () => {
    // The node asks 2 LUX.
    const send = async (message) => (message.type === "DUSK_UI_GET_CACHED_GAS_PRICE" ? { min: "1", median: "2", max: "5" } : {});
    const reset = () => dom.document.body.querySelector("button.gas-reset");
    review({ to: ALICE.account, privacy: "public" }, overview({ customGas: { limit: "2500000", price: "2" } }), send);
    await settle();
    expect([reset().textContent, reset().hidden]).toEqual(["Use the network's price", true]);
    // Hidden is hidden in the popup: no class's display shows it anyway.
    const css = await readFile(path.resolve(process.cwd(), "public", "ui.css"), "utf8");
    expect(css).toMatch(/\n\[hidden\] \{\s*display: none !important;\s*\}/);

    // Gas of your own shows it, and the network's price typed back hides it again.
    review({ to: ALICE.account, privacy: "public" }, overview({ customGas: { limit: "2500000", price: "3" } }), send);
    await settle();
    expect(reset().hidden).toBe(false);
    typeInto(dom.document.body.querySelectorAll("dusk-gas-editor input")[1], "2");
    expect(reset().hidden).toBe(true);
  });

  it("says what a public send shows everyone, with only the parts that apply, and nothing for a shielded one", async () => {
    let view = review({ to: ALICE.account, privacy: "public" });
    expect([view.kind(), view.visibleLine()]).toEqual(["Public transfer", "Visible to everyone: amount, your account, and the recipient's account."]);

    // With a memo, and the profile's verified name.
    lookupPrimaryName.mockImplementation(async (account) => (account === OWN.account ? "me.dusk" : null));
    view = review({ to: ALICE.account, privacy: "public", memo: "Lunch" });
    await settle();
    expect(view.visibleLine()).toBe("Visible to everyone: amount, memo, your name me.dusk, and the recipient's account.");

    view = review({ to: ALICE.address, privacy: "shielded", memo: "Lunch" });
    await settle();
    expect([view.kind(), view.visibleLine()]).toEqual(["Shielded transfer", null]);

    // A name shows over the full address it resolved to.
    view = review({
      to: ALICE.address,
      privacy: "shielded",
      duskName: { name: "alice.dusk", nodeUrl: overview().nodeUrl, to: ALICE.address },
    });
    expect(view.reviewTo()).toBe(`alice.dusk${ALICE.address}`);
  });

  describe("a name read through a node the wallet doesn't know", () => {
    const CUSTOM = "https://my-node.example:8443";
    const NOTE = "Checked by my-node.example:8443, a node the wallet doesn't know. Check the address too.";
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
      expect(visibleText(form.nameBox())).toContain(NOTE);
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
      expect(visibleText(form.nameBox().querySelector(".name-verified"))).toBe("bob.dusk · its .dusk name");
      expect(form.nameBox().querySelector(".name-verified .btn-ico")).toBeNull();
      expect(noted()).toEqual([NOTE]);

      // Verified, on a network's own node.
      const own = mount(newState(), overview());
      typeInto(own.to, BOB.account);
      await settle();
      expect(visibleText(own.nameBox().querySelector(".name-verified"))).toBe("bob.dusk · its verified .dusk name");
      expect(noted()).toEqual([]);
    });

    it("says so on Review under To, for a typed name and a pasted account's, and not with no name", async () => {
      const ov = custom();
      let view = review({ to: ALICE.address, privacy: "shielded", duskName: { name: "alice.dusk", nodeUrl: CUSTOM, to: ALICE.address } }, ov);
      await settle();
      expect(view.reviewTo()).toBe(`alice.dusk${ALICE.address}`);
      expect(noted()).toContain(NOTE);

      lookupPrimaryName.mockImplementation(async (account) => (account === BOB.account ? "bob.dusk" : null));
      view = review({ to: BOB.account, privacy: "public" }, ov);
      await settle();
      expect(view.reviewTo()).toBe(`bob.dusk${BOB.account}`);
      expect(noted()).toContain(NOTE);

      lookupPrimaryName.mockImplementation(async () => null);
      view = review({ to: ALICE.account, privacy: "public" }, ov);
      await settle();
      expect(view.reviewTo()).toBe(ALICE.account);
      expect(noted()).not.toContain(NOTE);
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
      dom.document.body.querySelectorAll("button").find((b) => b.textContent === "Confirm").click();
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
  const review = (draft, ov = MAINNET, send) =>
    mount(
      {
        route: "confirm",
        addressBook: { loaded: true, items: [] },
        draft: { amountDusk: "2", amountLux: "2000000000", privacy: "public", to: mainnet.account, memo: EVM, ...draft },
      },
      ov,
      send
    );
  const body = () => dom.document.body;
  const text = (selector) => visibleText(body().querySelector(selector));
  const callouts = () => body().querySelectorAll(".callout.warn .callout-title").map((t) => t.textContent);
  const confirm = () => body().querySelectorAll("button").find((b) => b.textContent === "Confirm");

  it("shows the memo that carries the recipient's address exactly, unflagged", async () => {
    review();
    await settle();
    const row = body().querySelectorAll(".kv").find((kv) => kv.querySelector(".kv-label")?.textContent === "Recipient on BNB Smart Chain");
    expect(visibleText(row)).toBe(`Recipient on BNB Smart Chain${EVM}`);
    expect(row.querySelector(".safe-text__flag")).toBeNull();
  });

  it("says what arrives on BNB Smart Chain once the bridge takes its 1 DUSK fee, and to whom", async () => {
    const view = review();
    await settle();
    expect(view.kind()).toBe("Bridge to BNB Smart Chain");
    expect(text(".review-bridge-fee")).toBe("2 DUSK sent · 1 DUSK bridge fee · 1 DUSK arrives on BNB Smart Chain");
    expect(view.reviewTo()).toBe(`The bridge's account for BNB Smart Chain${mainnet.account}`);
    expect(view.visibleLine()).toBe("Visible to everyone: amount, the recipient on BNB Smart Chain, and your account.");
    expect(body().querySelectorAll(".row > .group .kv").map(visibleText)).toContain(`Recipient on BNB Smart Chain${EVM}`);
    expect(callouts()).toEqual([]);
    expect(confirm().disabled).toBe(false);
    // No name to look up for the bridge's account.
    expect(lookupPrimaryName.mock.calls.map(([account]) => account)).not.toContain(mainnet.account);
  });

  it("keeps Confirm off when the fee takes the whole amount, as nothing would arrive", async () => {
    const view = review({ amountDusk: "1", amountLux: "1000000000" });
    await settle();
    expect(text(".review-bridge-fee")).toBe("1 DUSK sent · 1 DUSK bridge fee · Nothing arrives on BNB Smart Chain");
    expect(body().querySelector(".review-actions > .field-error").textContent).toBe("Send more than the 1 DUSK bridge fee.");
    expect(confirm().disabled).toBe(true);
    confirm().click();
    await settle();
    expect(view.actions.send.mock.calls.some(([m]) => m.type === "DUSK_UI_SEND_TX")).toBe(false);
  });

  it.each([
    ["isn't an address on BNB Smart Chain", { memo: "Order 1042" }, MAINNET, "Nothing arrives without a BNB Smart Chain address in the memo."],
    ["is missing", { memo: "" }, MAINNET, "Nothing arrives without a BNB Smart Chain address in the memo."],
    ["isn't an address on Sepolia", { to: testnet.account, memo: "Order 1042" }, overview(), "Nothing arrives without a Sepolia address in the memo."],
  ])("keeps Confirm off when the memo %s, as nothing would arrive", async (_, draft, ov, reason) => {
    const view = review(draft, ov);
    await settle();
    expect(body().querySelectorAll(".review-actions > .field-error").filter(isShown).map((e) => e.textContent)).toEqual([reason]);
    expect(confirm().disabled).toBe(true);
    confirm().click();
    await settle();
    expect(view.actions.send.mock.calls.some(([m]) => m.type === "DUSK_UI_SEND_TX")).toBe(false);
  });

  it("says the testnet bridge to Sepolia isn't running right now, and checks the memo is an address there", async () => {
    review({ to: testnet.account }, overview());
    await settle();
    expect(callouts()).toEqual(["Not running on testnet right now"]);
    expect(body().querySelector(".callout.warn .muted").textContent).toBe(
      "The bridge isn't paying out on Sepolia at the moment, so DUSK sent to it doesn't arrive there."
    );
    expect(text(".review-bridge-fee")).toBe("2 DUSK sent · 1 DUSK bridge fee · Nothing arrives on Sepolia");

    review({ memo: "Order 1042" });
    await settle();
    expect(callouts()).toEqual(["The memo isn't an address on BNB Smart Chain"]);
    // Nothing arrives there without one: the line doesn't say it does.
    expect(text(".review-bridge-fee")).toBe("2 DUSK sent · 1 DUSK bridge fee · Nothing arrives without a BNB Smart Chain address in the memo");
  });

  it("is a plain transfer to another network's bridge account", async () => {
    const view = review({}, overview());
    await settle();
    expect(view.kind()).toBe("Public transfer");
    expect(body().querySelector(".review-bridge-fee")).toBeNull();
  });
});

describe("a name and the recipient Contacts sets", () => {
  // Contacts sets the recipient as addressbook.js does: the rest of the draft stays.
  const setFromContacts = (state, address) => {
    state.draft = { ...state.draft, to: address };
    state.route = "confirm";
  };
  const reviewTo = () => visibleText(dom.document.body.querySelector(".review-to"));

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
    expect(reviewTo()).toBe(`alice.dusk${ALICE.account}`);
    expect(dom.document.body.querySelector(".review-to__names").textContent).toBe("alice.dusk");

    setFromContacts(state, address);
    mount(state);
    expect(reviewTo()).toBe(address);

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
    expect([review.kind(), review.visibleLine()]).toEqual(["Public transfer", "Visible to everyone: amount, your account, and the recipient's account."]);

    dom.document.body.querySelectorAll("button").find((b) => b.textContent === "Confirm").click();
    await settle();
    expect(review.actions.send).toHaveBeenCalledWith({
      type: "DUSK_UI_SEND_TX",
      params: expect.objectContaining({ privacy: "public", to: BOB.account }),
      walletId: overview().accounts[0],
    });
  });
});

describe("a new contact from a name", () => {
  it("gets the address the name sends to, not the name", () => {
    const state = newState();
    const form = mount(state);
    const contacts = dom.document.body.querySelector('button[title="Contacts"]');

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
    const contacts = dom.document.body.querySelector('button[title="Contacts"]');
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
    expect(visibleText(form.nameBox())).toMatch(/^alice\.dusk points to/);
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

  it("fills in nothing: the whole form empties, and it says why", async () => {
    // A Mainnet request link put in To on Testnet, over a form being filled in: nothing of it stays to read as the link's.
    const state = newState();
    const form = mount(state);
    typeInto(form.to, BOB.account);
    typeInto(form.amount, "0.5");
    form.to.value = `dusk:public-${ALICE.account}@dusk:1?amount=1&memo=Invoice+9`;
    form.to.dispatchEvent(fakeEvent("blur"));
    await settle();

    expect(note()?.textContent).toBe("This request is for Mainnet. You are on Testnet.");
    expect([form.to.value, form.amount.value]).toEqual(["", ""]);
    expect(state.draft).toMatchObject({ to: "", amountDusk: "", memo: "" });
    expect(filled()).toBe("");

    // Review goes nowhere, and Send drawn again still says why.
    form.review.click();
    await settle();
    expect(state.route).toBe("send");
    const again = mount(state);
    expect(note()?.textContent).toBe("This request is for Mainnet. You are on Testnet.");

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
    expect(note()?.textContent).toBe("This request is for Mainnet. You are on Testnet.");

    // Filled in on Testnet, then the wallet went to Mainnet.
    const filledIn = newState();
    filledIn.draft = { to: ALICE.account, amountDusk: "2.5", memo: "Rent", requestChainId: "dusk:2", filledFrom: "link" };
    expect(mount(filledIn).to.value).toBe(ALICE.account);
    const moved = mount(filledIn, overview({ nodeUrl: "https://nodes.dusk.network" }));
    expect([moved.to.value, moved.amount.value, filledIn.draft.memo]).toEqual(["", "", ""]);
    expect(note()?.textContent).toBe("This request is for Testnet. You are on Mainnet.");
    expect(filled()).toBe("");
  });

  it("can't be confirmed, however it reached Review", () => {
    mount({ route: "confirm", draft: { to: ALICE.account, privacy: "public", amountLux: "1000000000", amountDusk: "1", memo: "", requestChainId: "dusk:1" } });
    const body = dom.document.body;
    expect(body.querySelectorAll("button").find((b) => b.textContent === "Confirm").disabled).toBe(true);
    expect(visibleText(body.querySelector(".review-actions"))).toContain("This request is for Mainnet. You are on Testnet.");
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
    expect(note()?.textContent).toBe("This request is for Mainnet. You are on Custom · node.example.");
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
    const confirm = () => body.querySelectorAll("button").find((b) => b.textContent === "Confirm");
    const dialog = () => body.querySelector(".send-password");
    const password = () => dialog().querySelector("input[type=password]");
    const press = (name) => dialog().querySelectorAll("button").find((b) => b.textContent === name).click();
    const sends = () => sent.filter((m) => m.type === "DUSK_UI_SEND_TX");
    return { ...view, state, sent, answers, body, confirm, dialog, password, press, sends };
  };
  const pressConfirm = async (view) => {
    pastClickGuard();
    view.confirm().click();
    await settle();
  };

  it("asks over the Review before anything of it goes, and sends with what the wallet gave for it", async () => {
    const view = reviewAt("6000000000");
    await pressConfirm(view);
    expect(visibleText(view.dialog())).toContain("Enter your password");
    expect(visibleText(view.dialog())).toContain("This is above the 5 DUSK you set in Settings.");
    expect(view.sends()).toEqual([]);
    // The Review stays under it: no Sent screen yet.
    expect(view.state.route).toBe("confirm");
    expect(view.dialog().getAttribute("role")).toBe("dialog");
    expect(dom.document.activeElement).toBe(view.password());

    typeInto(view.password(), "the password");
    view.press("Confirm");
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
    view.press("Confirm");
    await settle();
    expect(visibleText(view.dialog())).toContain("Wrong password.");
    expect(view.password().value).toBe("");
    expect(view.sends()).toEqual([]);
    // Nothing typed says so too.
    view.press("Confirm");
    await settle();
    expect(visibleText(view.dialog())).toContain("Enter your password.");
    expect(view.sent.filter((m) => m.type === "DUSK_UI_SEND_PASSWORD_PROVE")).toHaveLength(1);
  });

  it("goes back to the Review on Cancel or Escape, with nothing sent and Confirm on again", async () => {
    const view = reviewAt("6000000000");
    await pressConfirm(view);
    view.press("Cancel");
    await settle();
    expect(view.dialog()).toBeNull();
    expect(view.sends()).toEqual([]);
    expect(view.state.route).toBe("confirm");
    expect(view.actions.showToast).toHaveBeenCalledWith("It waits for your password, so nothing was sent.");
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
    expect(visibleText(again.dialog())).toContain("Your password changed, so fingerprint unlock is off. Enter your password.");
    expect(again.sends()).toEqual([]);
    typeInto(again.password(), "the password");
    again.press("Confirm");
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
    dom.document.body.querySelectorAll("button").find((b) => b.textContent === "Confirm").click();
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

  it("fills Send in when it's pasted, the https link as the dusk: one, in the browser's separators", async () => {
    vi.stubGlobal("navigator", { ...globalThis.navigator, language: "nl-NL" });
    const state = newState();
    const form = mount(state);
    paste(form, ` ${httpsLink(`to=${ALICE.account}&amount=0.15&memo=Factura+33&network=testnet`)} `);
    await settle();
    expect(state.draft).toMatchObject({ to: ALICE.account, amountDusk: "0,15", memo: "Factura 33", requestChainId: "dusk:2" });
    expect(form.to.value).toBe(ALICE.account);
    expect(form.amount.value).toBe("0,15");
    // Said under the recipient, in words, and covering nothing.
    const filled = () => visibleText(dom.document.body.querySelector(".send-filled-note"));
    expect(filled()).toBe("Filled in from the link, to pay on Testnet. Check it before you send.");
    expect(form.actions.showToast).not.toHaveBeenCalled();
    typeInto(form.to, BOB.account);
    expect(filled()).toBe("");

    const again = mount(newState());
    paste(again, `dusk:public-${ALICE.account}@dusk:2?amount=1.5&memo=Rent`);
    await settle();
    expect(again.to.value).toBe(ALICE.account);
    expect(again.amount.value).toBe("1,5");
  });

  it("refuses one for another network, and goes as far as Review only with what Send takes", async () => {
    const state = newState();
    const form = mount(state);
    paste(form, `https://apps.dusk.network/wallet/dashboard/send?to=${ALICE.account}&amount=1&network=mainnet`);
    await settle();
    const note = dom.document.body.querySelectorAll(".field-error").find((el) => isShown(el));
    expect(note?.textContent).toBe("This request is for Mainnet. You are on Testnet.");
    expect([form.to.value, form.amount.value]).toEqual(["", ""]);

    // An amount in the link that isn't one is said under the field.
    const typo = mount(newState());
    paste(typo, httpsLink(`to=${ALICE.account}&amount=lots`));
    await settle();
    expect(typo.amountError()).toBe("Enter an amount such as 1 or 0.5.");
    expect(typo.review.disabled).toBe(true);
  });

  const refusal = () => dom.document.body.querySelectorAll(".field-error").filter((el) => isShown(el)).map((el) => el.textContent);
  const errLine = () => {
    const el = dom.document.body.querySelector(".err");
    return el && el.style.display !== "none" ? el.textContent : "";
  };

  it("refuses a link that says a field twice, or has a user part before its host, saying which", async () => {
    // Marek's: each would fill in its first value without a word. Sofia's: say what's wrong, for its sender to fix.
    for (const [link, why] of [
      [httpsLink(`to=${ALICE.account}&amount=0.001&network=testnet&network=mainnet`), "This link says the network twice. Ask for a new one."],
      [httpsLink(`to=${ALICE.account}&to=${BOB.account}&amount=0.001`), "This link says the recipient twice. Ask for a new one."],
      [httpsLink(`to=${ALICE.account}&amount=0.01&amount=0.01`), "This link says the amount twice. Ask for a new one."],
      [httpsLink(`to=${ALICE.account}&memo=One&memo=One`), "This link says the memo twice. Ask for a new one."],
      [`https://apps.dusk.network@apps.testnet.dusk.network/wallet/dashboard/send?to=${ALICE.account}&amount=0.001`, "This link has something before the site's address. Ask for a new one."],
    ]) {
      const state = newState();
      const form = mount(state);
      paste(form, link);
      await settle();
      expect(refusal(), link).toEqual([why]);
      expect([form.to.value, form.amount.value, state.draft.to]).toEqual(["", "", ""]);
    }

    const twice = mount(newState());
    paste(twice, httpsLink(`to=${ALICE.account}&amount=0.001&amount=0.15`));
    await settle();
    expect(refusal()).toEqual(["This link asks for two different amounts. Ask for a new one."]);
  });

  it("refuses one for another network the moment it's put in, saying that alone, before and at Review", async () => {
    // Nandini's: put in whole, not pasted, it sat in To until Review, which said "Recipient is required" too.
    const state = newState();
    const form = mount(state);
    typeInto(form.to, `https://apps.dusk.network/wallet/dashboard/send?to=${ALICE.account}&amount=0.0013&memo=Order+1044&network=mainnet`);
    await settle();
    expect(refusal()).toEqual(["This request is for Mainnet. You are on Testnet."]);
    expect(form.to.value).toBe("");

    form.to.dispatchEvent(fakeEvent("blur"));
    form.review.click();
    await settle();
    expect(state.route).toBe("send");
    expect(refusal()).toEqual(["This request is for Mainnet. You are on Testnet."]);
    expect(errLine()).toBe("");
  });

  it("says the same of a QR code's request as of the link pasted", async () => {
    // Chen's: a mainnet request's QR said it couldn't be read.
    const { openQrScanModal } = await import("./components/QrScanModal.js");
    const state = newState();
    const form = mount(state);
    openQrScanModal.mockResolvedValueOnce(`dusk:public-${ALICE.account}@dusk:1?amount=1&memo=Rent`);
    dom.document.body.querySelector("button[aria-label='Scan QR']").click();
    await settle();
    expect(refusal()).toEqual(["This request is for Mainnet. You are on Testnet."]);
    expect(errLine()).toBe("");

    // A QR code of the recipient alone fills in To, and says where it came from.
    openQrScanModal.mockResolvedValueOnce(BOB.account);
    dom.document.body.querySelector("button[aria-label='Scan QR']").click();
    await settle();
    expect(form.to.value).toBe(BOB.account);
    expect(refusal()).toEqual([]);
    expect(visibleText(dom.document.body.querySelector(".send-filled-note"))).toBe("Filled in from the QR code, to pay on Testnet. Check it before you send.");
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
    expect(dom.document.body.querySelector(".err").textContent).toBe("Not a valid address. Check it and try again.");

    // One to the wallet's Send that names no recipient says so.
    const empty = mount(newState());
    empty.to.value = httpsLink("amount=1");
    empty.to.dispatchEvent(fakeEvent("blur"));
    await settle();
    expect(empty.amount.value).toBe("");
    expect(refusal()).toEqual(["This link doesn't say who to pay. Ask for a new one."]);
  });

  const memoField = () => dom.document.body.querySelectorAll("input").find((i) => i.getAttribute("placeholder") === "Optional");

  it("clears the whole form when a link is refused, what an earlier link filled in too", async () => {
    // Chen's: a mainnet QR after a testnet one cleared To and kept the testnet one's amount and memo.
    const { openQrScanModal } = await import("./components/QrScanModal.js");
    const state = newState();
    const form = mount(state);
    openQrScanModal.mockResolvedValueOnce(`dusk:public-${ALICE.account}@dusk:2?amount=0.03&memo=Chicken+rice+Sat`);
    dom.document.body.querySelector("button[aria-label='Scan QR']").click();
    await settle();
    expect([form.to.value, form.amount.value, memoField().value]).toEqual([ALICE.account, "0.03", "Chicken rice Sat"]);

    openQrScanModal.mockResolvedValueOnce(`dusk:public-${BOB.account}@dusk:1?amount=1&memo=Rent`);
    dom.document.body.querySelector("button[aria-label='Scan QR']").click();
    await settle();
    expect(refusal()).toEqual(["This request is for Mainnet. You are on Testnet."]);
    expect([form.to.value, form.amount.value, memoField().value]).toEqual(["", "", ""]);
    expect(state.draft).toMatchObject({ to: "", amountDusk: "", memo: "" });

    // So does one that can't be read, after what was typed.
    typeInto(form.amount, "5");
    typeInto(memoField(), "Typed");
    paste(form, httpsLink(`to=${ALICE.account}&memo=One&memo=Two`));
    await settle();
    expect(refusal()).toEqual(["This link says the memo twice. Ask for a new one."]);
    expect([form.to.value, form.amount.value, memoField().value]).toEqual(["", "", ""]);
  });

  it("refuses a dusk: link for another network by the network its query names, as an https link", async () => {
    // Marek's: a link that said Testnet filled in a Mainnet send, and one that said Mainnet a Testnet send.
    const onTestnet = mount(newState());
    paste(onTestnet, `dusk:public-${ALICE.account}?amount=0.001&network=mainnet`);
    await settle();
    expect(refusal()).toEqual(["This request is for Mainnet. You are on Testnet."]);
    expect([onTestnet.to.value, onTestnet.amount.value]).toEqual(["", ""]);

    const onMainnet = mount(newState(), overview({ nodeUrl: "https://nodes.dusk.network" }));
    paste(onMainnet, `dusk:public-${ALICE.account}?amount=0.001&network=testnet`);
    await settle();
    expect(refusal()).toEqual(["This request is for Testnet. You are on Mainnet."]);
    expect([onMainnet.to.value, onMainnet.amount.value]).toEqual(["", ""]);
  });

  it("refuses a link whose memo has a line break, saying so, rather than sending it on one line", async () => {
    // Marek's: "line one\nline two" became "line oneline two", which matches no request made with the break.
    const state = newState();
    const form = mount(state);
    paste(form, httpsLink(`to=${ALICE.account}&amount=0.001&memo=line%20one%0Aline%20two`));
    await settle();
    expect(refusal()).toEqual(["This link's memo has a line break, which Send can't take. Ask for a new one."]);
    expect([form.to.value, form.amount.value, memoField().value]).toEqual(["", "", ""]);
  });

  // Chen's: a plain dusk: link on Mainnet filled Send in without a word of the network.
  it("says the network it pays on, for a plain link that names none", async () => {
    const state = newState();
    const form = mount(state, overview({ nodeUrl: "https://nodes.dusk.network", chainId: 1, networkName: "Mainnet" }));
    paste(form, `dusk:${ALICE.account}?amount=0.01&memo=Lunch`);
    await settle();
    expect(form.to.value).toBe(ALICE.account);
    expect(visibleText(dom.document.body.querySelector(".send-filled-note"))).toBe("Filled in from the link, to pay on Mainnet. Check it before you send.");
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
    expect(visibleText(dom.document.body.querySelector(".send-filled-note"))).toBe("Filled in from the link, to pay on Testnet. Check it before you send.");

    // Marek's: a testnet link that says mainnet opened an empty Send without a word.
    vi.stubGlobal("location", { pathname: "/full.html", search: `?route=send&link=${encodeURIComponent(httpsLink(`to=${ALICE.account}&amount=0.001&network=mainnet`))}` });
    vi.resetModules();
    const refused = (await import("./popup/state.js")).state;
    const unread = mount(refused);
    expect([unread.to.value, unread.amount.value]).toEqual(["", ""]);
    expect(refusal()).toEqual(["This link names two networks, Testnet and Mainnet. Ask for a new one."]);

    // A network written as no network is: never "two networks, Testnet and Testnet".
    vi.stubGlobal("location", { pathname: "/full.html", search: `?route=send&link=${encodeURIComponent(`dusk:public-${ALICE.account}@dusk:2?amount=0.001&network=dusk:02`)}` });
    vi.resetModules();
    mount((await import("./popup/state.js")).state);
    expect(refusal()).toEqual(["This link's network can't be read. Ask for a new one."]);

    // No link, or a page opened with something that isn't one: an empty form.
    vi.stubGlobal("location", { pathname: "/full.html", search: "?route=send" });
    vi.resetModules();
    expect((await import("./popup/state.js")).state.draft).toBeNull();
    vi.stubGlobal("location", { pathname: "/full.html", search: `?route=send&link=${encodeURIComponent("https://phish.example/x")}` });
    vi.resetModules();
    expect((await import("./popup/state.js")).state.draft).toBeNull();
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
    expect(again()).toBe(`You sent 0.013 DUSK to Alice with this memo at ${clockText(at)}.`);
    const button = dom.document.body.querySelectorAll("button").find((b) => b.textContent === "Send 0.013 DUSK again");
    expect(button.disabled).toBe(false);
    expect(dom.document.body.querySelectorAll("button").find((b) => b.textContent === "Confirm")).toBeUndefined();
    // Not made before: Confirm.
    confirm(draft({ memo: "Order 1045" }), [sentRecord({ submittedAt: at })]);
    expect(dom.document.body.querySelectorAll("button").find((b) => b.textContent === "Confirm")).toBeTruthy();
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
    expect(note()).toBe(`You sent 0.013 DUSK to Alice with this memo at ${clockText(at)}.`);
    typeInto(form.amount, "0.014");
    expect(note()).toBe("");
    typeInto(form.amount, "0.013");
    expect(note()).toBe(`You sent 0.013 DUSK to Alice with this memo at ${clockText(at)}.`);
  });

  it("is said of the same memo whenever it went, and of the same payment without one only moments after", () => {
    const yesterday = Date.now() - 24 * 60 * 60_000;
    confirm(draft(), [sentRecord({ submittedAt: yesterday })]);
    expect(again()).toMatch(/^You sent 0\.013 DUSK to Alice with this memo (yesterday at|on .+ at) /);

    confirm(draft({ memo: "" }), [sentRecord({ memo: undefined, submittedAt: Date.now() - 30_000 })]);
    expect(again()).toBe(`You sent 0.013 DUSK to Alice at ${clockText(Date.now() - 30_000)}.`);
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
    expect(visibleText(dom.document.body.querySelector(".review-self-note"))).toBe("This is your own account. Sending to yourself only costs a fee.");
    mount({ route: "confirm", addressBook: { loaded: true, items: [] }, draft: { to: ALICE.account, privacy: "public", amountDusk: "1", amountLux: "1000000000", memo: "" } });
    expect(dom.document.body.querySelector(".review-self-note")).toBeNull();
  });
});
