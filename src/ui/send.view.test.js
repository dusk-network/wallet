import { readFile } from "node:fs/promises";
import path from "node:path";
import { decodeBase58, encodeBase58 } from "@duskdomains/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TX_KIND } from "../shared/constants.js";
import { lookupDuskName } from "../shared/duskNames.js";
import { shortAddress } from "./lib/strings.js";
import { installFakeDom, isShown, settle, typeInto, visibleText } from "./testing/fakeDom.js";
import { sendConfirmView, sendFormView } from "./popup/views/send.js";

vi.mock("./components/GasEditor.js", () => ({}));
vi.mock("./components/QrScanModal.js", () => ({
  openQrScanModal: vi.fn(),
  parseDuskQrPayload: vi.fn(() => null),
}));
vi.mock("../shared/addressBook.js", () => ({ listAddressBook: vi.fn(async () => []) }));
vi.mock("../shared/duskNames.js", async (importOriginal) => ({
  ...(await importOriginal()),
  lookupDuskName: vi.fn(),
}));

describe("send view", () => {
  it("keeps the amount input visually separate from the slider helper", async () => {
    const component = await readFile(
      path.resolve(process.cwd(), "src", "ui", "components", "AmountSliderCard.js"),
      "utf8"
    );
    const css = await readFile(path.resolve(process.cwd(), "public", "ui.css"), "utf8");

    expect(component).toContain('class: "input-row amount-input-row"');
    expect(component).toContain('class: "amount-range-wrap amount-slider-helper"');
    expect(css).toContain(".amount-input-row");
    expect(css).toContain(".amount-card .amount-range-wrap");
    expect(css).not.toMatch(
      /\.amount-card \.amount-input\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent;/s
    );
  });

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
    expect(css).toMatch(/\.recipient-badge--contact\s*\{[^}]*var\(--ok\)/s);
    expect(css).toContain(".recipient-badge--rail");
    expect(css).toMatch(/\.recipient-badge--rail\s*\{[^}]*var\(--primary\)/s);
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
};

// 177.9865 DUSK public, 25 DUSK shielded; the fee caps are 0.002 and 0.015 DUSK.
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
  dom = installFakeDom({
    elements: {
      "dusk-gas-editor": (el) => Object.assign(el, { setGas: vi.fn(), readFinalGas: () => null }),
    },
  });
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
function mount(state, ov = overview()) {
  const actions = {
    send: vi.fn(async () => ({})),
    render: vi.fn(async () => {}),
    showToast: vi.fn(),
  };
  const view = state.route === "confirm" ? sendConfirmView : sendFormView;
  dom.document.body.replaceChildren(...view(ov, { state, actions }));
  const $ = (selector) => dom.document.body.querySelector(selector);
  const radios = () => dom.document.body.querySelectorAll("[role=radio]");
  return {
    actions,
    to: $(".to-input-wrap input"),
    amount: $("input.amount-input"),
    review: $("button.btn-primary"),
    radios,
    picked: () => radios().map((r) => r.getAttribute("aria-checked")),
    pill: () => {
      const pill = $(".row > .recipient-type-badge");
      return isShown(pill) ? pill.textContent : "";
    },
    nameBox: () => $(".name-box"),
    balanceLine: () => $(".amount-meta__main").textContent,
    shortfall: () => $(".name-box .name-shortfall"),
    selfNote: () => {
      const note = $(".send-self-note");
      return isShown(note) ? note.textContent : "";
    },
    transferLine: () => $(".transfer-line")?.textContent,
  };
}

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
    expect(form.balanceLine()).toBe("Available (public): 177.9845 DUSK");
    expect(form.review.disabled).toBe(false);
    // The old Public account | Shielded address switch is gone.
    expect(dom.document.body.querySelector(".name-address-toggle")).toBeNull();
  });

  it("follows the picked card in the balance line", () => {
    const state = newState();
    const form = mount(state);
    typeInto(form.to, "alice.dusk");
    form.radios()[1].click();

    expect(form.picked()).toEqual(["false", "true"]);
    expect(form.pill()).toBe("");
    expect(form.balanceLine()).toBe("Spendable (shielded): 24.985 DUSK");
    expect(state.draft.nameChoices).toEqual({ "alice.dusk": true });

    form.radios()[0].click();
    expect(form.picked()).toEqual(["true", "false"]);
    expect(form.balanceLine()).toBe("Available (public): 177.9845 DUSK");
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
    expect(form.balanceLine()).toBe("Spendable (shielded): 24.985 DUSK");

    typeInto(form.to, "bob.dusk");
    expect(form.picked()).toEqual(["true", "false"]);
    expect(form.balanceLine()).toBe("Available (public): 177.9845 DUSK");

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
    expect(review.transferLine()).toBe("Private");
    dom.document.body.querySelector(".subnav-back").click();
    expect(state.route).toBe("send");

    form = mount(state);
    expect(form.to.value).toBe("alice.dusk");
    expect(form.picked()).toEqual(["false", "true"]);
    expect(form.balanceLine()).toBe("Spendable (shielded): 24.985 DUSK");
  });

  it.each([
    ["covers only the fee cap", { value: "15000000", spendable: "15000000" }],
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
    const form = mount(newState(), overview({ shieldedBalance: { value: "15000001", spendable: "15000001" } }));
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
    expect(funded.balanceLine()).toBe("Spendable (shielded): 24.985 DUSK");
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
    expect(review.transferLine()).toBe("Visible on chain");
    expect(visibleText(dom.document.body.querySelector(".named-address"))).toBe(`dave.dusk${dave}`);
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

describe("review", () => {
  const review = (draft, ov) =>
    mount(
      {
        route: "confirm",
        addressBook: { loaded: true, items: [] },
        draft: { amountDusk: "1", amountLux: "1000000000", memo: "", ...draft },
      },
      ov
    );

  it("says under the pill whether the transfer is visible on chain", () => {
    let view = review({ to: ALICE.account, privacy: "public" });
    expect(view.transferLine()).toBe("Visible on chain");
    expect(dom.document.body.querySelector(".recipient-type-badge").textContent).toBe("Public");

    view = review({ to: ALICE.address, privacy: "shielded" });
    expect(view.transferLine()).toBe("Private");
    expect(dom.document.body.querySelector(".recipient-type-badge").textContent).toBe("Shielded");

    // A name shows over the full address it resolved to.
    view = review({
      to: ALICE.address,
      privacy: "shielded",
      duskName: { name: "alice.dusk", nodeUrl: overview().nodeUrl, to: ALICE.address },
    });
    expect(view.transferLine()).toBe("Private");
    expect(visibleText(dom.document.body.querySelector(".named-address"))).toBe(`alice.dusk${ALICE.address}`);
  });
});

describe("a name and the recipient Contacts sets", () => {
  // Contacts sets the recipient as addressbook.js does: the rest of the draft stays.
  const setFromContacts = (state, address) => {
    state.draft = { ...state.draft, to: address };
    state.route = "confirm";
  };
  const toBox = (address) =>
    dom.document.body.querySelectorAll(".box code").find((code) => code.textContent === address).parentNode;

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
    expect(toBox(ALICE.account).textContent).toBe(`alice.dusk${ALICE.account}`);
    expect(toBox(ALICE.account).querySelector(".dusk-name").textContent).toBe("alice.dusk");

    setFromContacts(state, address);
    mount(state);
    expect(toBox(address).textContent).toBe(address);

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
    expect([review.pill(), review.transferLine()]).toEqual(["Public", "Visible on chain"]);

    dom.document.body.querySelectorAll("button").find((b) => b.textContent === "Confirm").click();
    await settle();
    expect(review.actions.send).toHaveBeenCalledWith({
      type: "DUSK_UI_SEND_TX",
      params: expect.objectContaining({ privacy: "public", to: BOB.account }),
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
  ])("changes nothing when %s first", async (_label, leave, after) => {
    const state = newState();
    const form = mount(state);
    typeInto(form.to, "alice.dusk");
    typeInto(form.amount, "1");
    let finish;
    const pending = new Promise((resolve) => (finish = resolve));
    lookupDuskName.mockImplementation(() => ({ result: undefined, promise: pending }));

    form.review.click();
    leave(state);
    finish(NAMES["alice.dusk"]);
    await settle();

    expect(state).toMatchObject(after);
    if (after.route === "send") expect(state.draft.duskName).toBeUndefined();
  });
});
