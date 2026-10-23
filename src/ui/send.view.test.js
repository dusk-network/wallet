import { readFile } from "node:fs/promises";
import path from "node:path";
import { decodeBase58, encodeBase58 } from "@duskdomains/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TX_KIND } from "../shared/constants.js";
import { lookupDuskName } from "../shared/duskNames.js";
import { installFakeDom, isShown, settle, typeInto } from "./testing/fakeDom.js";
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

    const sendBlock = source.match(/type: "DUSK_UI_SEND_TX"([\s\S]*?)memo: d\.memo/);
    expect(sendBlock?.[1]).toContain("privacy:");
    expect(sendBlock?.[1]).toContain('"shielded"');
    expect(sendBlock?.[1]).toContain('"public"');
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
    fullAddress: () => $(".name-box .box code")?.textContent,
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
      "From your public balance (177.9865 DUSK). Amount and both accounts are visible on chain.",
      "From your shielded balance (25 DUSK). Amount and both parties stay private.",
    ]);
    expect(form.picked()).toEqual(["true", "false"]);
    expect(form.pill()).toBe("Public");
    expect(dom.document.body.querySelector(".name-full-label").textContent).toBe("Full address");
    expect(form.fullAddress()).toBe(ALICE.account);
    expect(form.balanceLine()).toBe("Available (public): 177.9845 DUSK");
    expect(form.review.disabled).toBe(false);
    // The old Public account | Shielded address switch is gone.
    expect(dom.document.body.querySelector(".name-address-toggle")).toBeNull();
  });

  it("follows the picked card: pill, full address and balance line", () => {
    const state = newState();
    const form = mount(state);
    typeInto(form.to, "alice.dusk");
    form.radios()[1].click();

    expect(form.picked()).toEqual(["false", "true"]);
    expect(form.pill()).toBe("Shielded");
    expect(form.fullAddress()).toBe(ALICE.address);
    expect(form.balanceLine()).toBe("Spendable (shielded): 24.985 DUSK");
    expect(state.draft.nameChoice).toEqual({ name: "alice.dusk", shielded: true });

    form.radios()[0].click();
    expect(form.pill()).toBe("Public");
    expect(form.fullAddress()).toBe(ALICE.account);
  });

  it("keeps the pick while the same name is typed again, and starts any other name on public", () => {
    const form = mount(newState());
    typeInto(form.to, "alice.dusk");
    form.radios()[1].click();

    typeInto(form.to, "alice.dus");
    expect(form.radios()).toEqual([]);
    typeInto(form.to, "alice.dusk");
    expect(form.picked()).toEqual(["false", "true"]);
    // The same name, as resolved.
    typeInto(form.to, " Alice.DUSK");
    expect(form.picked()).toEqual(["false", "true"]);
    expect(form.fullAddress()).toBe(ALICE.address);

    typeInto(form.to, "bob.dusk");
    expect(form.picked()).toEqual(["true", "false"]);
    expect(form.fullAddress()).toBe(BOB.account);
    expect(form.pill()).toBe("Public");

    // The pick stays with alice.dusk.
    typeInto(form.to, "alice.dusk");
    expect(form.picked()).toEqual(["false", "true"]);
  });

  it("keeps the pick through a redraw and Back from Review, and Review shows the paying balance", async () => {
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
      nameChoice: { name: "alice.dusk", shielded: true },
    });

    const review = mount(state);
    expect(review.transferLine()).toBe("Shielded transfer from your shielded balance (25 DUSK). Private.");
    dom.document.body.querySelector(".subnav-back").click();
    expect(state.route).toBe("send");

    form = mount(state);
    expect(form.to.value).toBe("alice.dusk");
    expect(form.picked()).toEqual(["false", "true"]);
    expect(form.pill()).toBe("Shielded");
    expect(form.fullAddress()).toBe(ALICE.address);
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
    expect(hint.textContent).toBe("Not enough shielded DUSK. Shield DUSK first");
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
  it("sends a name with only a shielded address shielded, and holds Review while that balance can't pay", () => {
    const state = newState();
    const form = mount(state, overview({ shieldedBalance: { value: "0", spendable: "0" } }));
    typeInto(form.to, "carol.dusk");

    expect(form.radios()).toEqual([]);
    expect(form.pill()).toBe("Shielded");
    expect(form.fullAddress()).toBe(NAMES["carol.dusk"].address);
    expect(form.shortfall().textContent).toBe("Not enough shielded DUSK. Shield DUSK first");
    expect(form.review.disabled).toBe(true);

    form.shortfall().querySelector("button").click();
    expect(state.route).toBe("convert");

    const funded = mount(newState());
    typeInto(funded.to, "carol.dusk");
    expect(funded.shortfall()).toBeNull();
    expect(funded.review.disabled).toBe(false);
  });

  it("sends a name with only a public account to it, as before", () => {
    const form = mount(newState(), overview({ shieldedBalance: { value: "0", spendable: "0" } }));
    typeInto(form.to, "dave.dusk");
    expect(form.radios()).toEqual([]);
    expect(form.pill()).toBe("Public");
    expect(dom.document.body.querySelector(".name-box .box").textContent).toBe(
      `dave.dusk${NAMES["dave.dusk"].account}`
    );
    expect(form.shortfall()).toBeNull();
    expect(form.review.disabled).toBe(false);
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

  it("names the paying balance under the pill for every transfer", () => {
    let view = review({ to: ALICE.account, privacy: "public" });
    expect(view.transferLine()).toBe(
      "Public transfer from your public balance (177.9865 DUSK). Visible on chain."
    );
    expect(dom.document.body.querySelector(".recipient-type-badge").textContent).toBe("Public");

    view = review({ to: ALICE.address, privacy: "shielded" });
    expect(view.transferLine()).toBe("Shielded transfer from your shielded balance (25 DUSK). Private.");

    // The spendable shielded balance pays, not notes held for a pending transfer.
    view = review(
      {
        to: ALICE.address,
        privacy: "shielded",
        duskName: { name: "alice.dusk", nodeUrl: overview().nodeUrl, to: ALICE.address },
      },
      overview({ shieldedBalance: { value: "25000000000", spendable: "10000000000" } })
    );
    expect(view.transferLine()).toBe("Shielded transfer from your shielded balance (10 DUSK). Private.");
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

    setFromContacts(state, address);
    mount(state);
    expect(toBox(address).textContent).toBe(address);

    // Back from Review shows the contact's address, not the name.
    dom.document.body.querySelector(".subnav-back").click();
    form = mount(state);
    expect(form.to.value).toBe(address);
    expect(dom.document.body.querySelector(".name-points-to")).toBeNull();
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
