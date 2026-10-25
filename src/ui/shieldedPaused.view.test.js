import { readFile } from "node:fs/promises";
import path from "node:path";
import { decodeBase58, encodeBase58 } from "@duskdomains/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { lookupDuskName } from "../shared/duskNames.js";
import { installFakeDom, isShown, settle, typeInto, visibleText } from "./testing/fakeDom.js";
import { syncShieldNavItem } from "./components/ShieldedPausedNotice.js";
import { h } from "./lib/dom.js";
import { convertConfirmView, convertFormView } from "./popup/views/convert.js";
import { homeView } from "./popup/views/home.js";
import { receiveView } from "./popup/views/receive.js";
import { sendConfirmView, sendFormView } from "./popup/views/send.js";

vi.mock("./components/QrScanModal.js", () => ({
  openQrScanModal: vi.fn(),
  parseDuskQrPayload: vi.fn(() => null),
}));
vi.mock("../shared/addressBook.js", () => ({ listAddressBook: vi.fn(async () => []) }));
vi.mock("../shared/duskNames.js", async (importOriginal) => ({
  ...(await importOriginal()),
  lookupDuskName: vi.fn(),
  lookupPrimaryName: vi.fn(async () => null),
  lookupShieldedName: vi.fn(async () => null),
}));

// The profile's own account and address, and others of the same shapes told apart by their last byte.
const ACCOUNT =
  "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927";
const ADDRESS =
  "2Ana1pUpv2ZbMVkwF5FXapYeBEjdxDatLn7nvJkhgTSXbs59SyZSx866bXirPgj8QQVB57uxHJBG1YFvkRbFj4T";
const vary = (value, n) =>
  encodeBase58(decodeBase58(value).map((b, i, all) => (i === all.length - 1 ? b ^ n : b)));
const PAYEE = { account: vary(ACCOUNT, 1), address: vary(ADDRESS, 1) };

const NAMES = {
  "both.dusk": { ok: true, name: "both.dusk", account: vary(ACCOUNT, 2), address: vary(ADDRESS, 2) },
  "hidden.dusk": { ok: true, name: "hidden.dusk", address: vary(ADDRESS, 3) },
};

const PAUSED = "Shielded transactions are paused on Testnet.";
const STAYS = "Your shielded DUSK stays where it is until they're back.";

// 5 DUSK public and 2 DUSK shielded on Testnet, with shielded transactions paused.
function overview(patch = {}) {
  return {
    hasVault: true,
    isUnlocked: true,
    nodeUrl: "https://testnet.nodes.dusk.network",
    networkName: "Testnet",
    accounts: [ACCOUNT],
    addresses: [ADDRESS],
    selectedAccountIndex: 0,
    balance: { nonce: "0", value: "5000000000" },
    shieldedBalance: { value: "2000000000", spendable: "2000000000" },
    shieldedSync: { state: "done", notes: 3 },
    txs: [],
    phoenixPaused: true,
    ...patch,
  };
}

let dom;
let state;
let actions;

const show = (nodes) => dom.document.body.replaceChildren(...nodes);
const $ = (selector) => dom.document.body.querySelector(selector);
const $$ = (selector) => dom.document.body.querySelectorAll(selector);
const button = (text) => $$("button").find((b) => b.textContent.trim() === text);
const notices = () => $$(".shielded-paused").filter(isShown);

beforeEach(() => {
  dom = installFakeDom();
  state = {
    route: "home",
    draft: null,
    addressBook: { loaded: true, items: [] },
    receive: { tab: "public", amountDusk: "", memo: "" },
  };
  actions = {
    render: vi.fn(async () => {}),
    showToast: vi.fn(),
    send: vi.fn(async () => ({ result: { tokens: [], nfts: [] } })),
  };
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

// --- Home -----------------------------------------------------------------------

describe("home while shielded transactions are paused", () => {
  const shieldAction = () => $$(".action-btn").find((b) => b.textContent === "Shield");

  it("shows the notice under the balances and turns Shield off", () => {
    show(homeView(overview(), { state, actions }));

    const hero = $(".home-hero");
    const notice = hero.querySelector(".shielded-paused");
    expect(visibleText(notice)).toBe(PAUSED + STAYS);
    expect(hero.children.indexOf(notice)).toBe(hero.children.indexOf(hero.querySelector(".balance-split")) + 1);

    expect(shieldAction().disabled).toBe(true);
    expect(shieldAction().title).toBe(PAUSED);
    shieldAction().click();
    expect(state.route).toBe("home");
    expect($$(".action-btn").filter((b) => b.disabled).map((b) => b.textContent)).toEqual(["Shield"]);
  });

  it("leaves out the balance line without a shielded balance", () => {
    for (const shieldedBalance of [{ value: "0", spendable: "0" }, null]) {
      show(homeView(overview({ shieldedBalance }), { state, actions }));
      expect(visibleText($(".shielded-paused"))).toBe(PAUSED);
    }
  });

  it("leaves out the balance line while balances are hidden, so it doesn't give one away", () => {
    show(homeView(overview({ hideBalances: true }), { state, actions }));
    expect(visibleText($(".shielded-paused"))).toBe(PAUSED);
    expect(dom.document.body.textContent).not.toContain(STAYS);

    state.receive.tab = "shielded";
    show(receiveView(overview({ hideBalances: true }), { state, actions }));
    expect(notices().map(visibleText)).toEqual([PAUSED]);
  });

  it("is unchanged while shielded transactions run", () => {
    show(homeView(overview({ phoenixPaused: false }), { state, actions }));

    expect($(".shielded-paused")).toBeNull();
    expect(shieldAction().disabled).toBe(false);
    expect(shieldAction().hasAttribute("title")).toBe(false);
    shieldAction().click();
    expect(state.route).toBe("convert");
  });
});

// --- Send -----------------------------------------------------------------------

function sendForm(ov = overview()) {
  state.route = "send";
  show(sendFormView(ov, { state, actions }));
  return {
    to: $(".to-input-wrap input"),
    amount: $("input.amount-input"),
    review: $("button.btn-primary"),
    radios: () => $$("[role=radio]"),
    picked: () => $$("[role=radio]").map((r) => r.getAttribute("aria-checked")),
  };
}

describe("send while shielded transactions are paused", () => {
  it("stops a send to a shielded address with the message instead of Review", async () => {
    const form = sendForm();
    expect(notices()).toEqual([]);

    typeInto(form.to, PAYEE.address);
    typeInto(form.amount, "1");
    expect(notices().map(visibleText)).toEqual([PAUSED]);

    form.review.click();
    await settle();
    expect(state.route).toBe("send");
    expect(actions.render).not.toHaveBeenCalled();
    expect(notices()).toHaveLength(1);
  });

  it("keeps sends to a public account going to Review", async () => {
    const form = sendForm();

    typeInto(form.to, PAYEE.address);
    typeInto(form.to, PAYEE.account);
    typeInto(form.amount, "1");
    expect(notices()).toEqual([]);

    form.review.click();
    await settle();
    expect(state.route).toBe("confirm");
    expect(state.draft).toMatchObject({ to: PAYEE.account, privacy: "public", amountLux: "1000000000" });
  });

  it("sends a shielded draft back from Review to the form", () => {
    state.route = "confirm";
    state.draft = { to: PAYEE.address, privacy: "shielded", amountLux: "1000000000", amountDusk: "1" };
    show(sendConfirmView(overview(), { state, actions }));

    expect(state.route).toBe("send");
    expect(button("Confirm")).toBeUndefined();
    expect(notices()).toHaveLength(1);
  });

  it("lets shielded sends through while they run", async () => {
    const form = sendForm(overview({ phoenixPaused: false }));

    typeInto(form.to, PAYEE.address);
    typeInto(form.amount, "1");
    expect(notices()).toEqual([]);

    form.review.click();
    await settle();
    expect(state.route).toBe("confirm");
    expect(state.draft).toMatchObject({ to: PAYEE.address, privacy: "shielded" });
  });
});

describe("send to a .dusk name while shielded transactions are paused", () => {
  it("turns the shielded card off, with the paused sentence under it", async () => {
    const form = sendForm();
    typeInto(form.to, "both.dusk");

    const [publicCard, shieldedCard] = $$(".name-option");
    expect(publicCard.classList.contains("is-disabled")).toBe(false);
    expect(shieldedCard.classList.contains("is-disabled")).toBe(true);
    expect(form.radios()[1].getAttribute("aria-disabled")).toBe("true");
    expect(visibleText(shieldedCard.querySelector(".name-shortfall"))).toBe(PAUSED);
    expect(dom.document.body.textContent).not.toContain("Shield first");
    // The card says it; no second notice above the cards.
    expect(notices()).toEqual([]);

    form.radios()[1].click();
    expect(form.picked()).toEqual(["true", "false"]);
    expect(form.review.disabled).toBe(false);

    typeInto(form.amount, "1");
    form.review.click();
    await settle();
    expect(state.route).toBe("confirm");
    expect(state.draft).toMatchObject({ to: NAMES["both.dusk"].account, privacy: "public" });
  });

  it("keeps Review blocked if the shielded card was picked", async () => {
    state.draft = { to: "both.dusk", nameChoices: { "both.dusk": true }, amountDusk: "1" };
    const form = sendForm();

    expect(form.picked()).toEqual(["false", "true"]);
    expect(form.review.disabled).toBe(true);

    // Even if Review were pressed, the form keeps it from going on.
    form.review.disabled = false;
    form.review.click();
    await settle();
    expect(state.route).toBe("send");
    expect(form.review.disabled).toBe(true);
    expect(actions.render).not.toHaveBeenCalled();
  });

  it("blocks a name that only has a shielded address", () => {
    const form = sendForm();
    typeInto(form.to, "hidden.dusk");

    const card = $(".name-option");
    expect(card.classList.contains("is-disabled")).toBe(true);
    expect(visibleText(card.querySelector(".name-shortfall"))).toBe(PAUSED);
    expect(form.review.disabled).toBe(true);
  });

  it("offers the shielded card while shielded transactions run", () => {
    const form = sendForm(overview({ phoenixPaused: false }));
    typeInto(form.to, "both.dusk");

    expect($$(".name-option.is-disabled")).toEqual([]);
    form.radios()[1].click();
    expect(form.picked()).toEqual(["false", "true"]);
    expect(form.review.disabled).toBe(false);
  });
});

// --- Receive ----------------------------------------------------------------------

describe("receive while shielded transactions are paused", () => {
  it("shows the notice on the Shielded tab instead of the address and QR", () => {
    state.receive.tab = "shielded";
    show(receiveView(overview(), { state, actions }));

    expect(notices().map(visibleText)).toEqual([PAUSED + STAYS]);
    expect($(".receive-qr-card")).toBeNull();
    expect($(".receive-fields")).toBeNull();
    expect($$(".receive-copy")).toEqual([]);
    expect(button("Download QR PNG")).toBeUndefined();

    expect($$(".tabs .tab").map((t) => t.textContent)).toEqual(["Public", "Shielded"]);
    button("Public").click();
    expect(state.receive.tab).toBe("public");
    expect(actions.render).toHaveBeenCalled();
  });

  it("keeps the Public tab as it was", () => {
    show(receiveView(overview(), { state, actions }));

    expect(notices()).toEqual([]);
    expect($(".receive-qr-card")).not.toBeNull();
    expect($(".receive-field__address")).not.toBeNull();
  });

  it("shows the shielded address while shielded transactions run", () => {
    state.receive.tab = "shielded";
    show(receiveView(overview({ phoenixPaused: false }), { state, actions }));

    expect(notices()).toEqual([]);
    expect($(".receive-qr-card")).not.toBeNull();
    expect($(".receive-field__address")).not.toBeNull();
  });
});

// --- Shield and Unshield ------------------------------------------------------------

describe("shield and unshield while shielded transactions are paused", () => {
  it("shows only the notice", () => {
    state.route = "convert";
    state.draft = { kind: "unshield", amountDusk: "" };
    show(convertFormView(overview(), { state, actions }));

    expect(notices().map(visibleText)).toEqual([PAUSED + STAYS]);
    expect(button("Shield")).toBeUndefined();
    expect(button("Unshield")).toBeUndefined();
    expect(button("Review")).toBeUndefined();
    expect($$("input")).toEqual([]);

    button("← Back").click();
    expect(state.route).toBe("home");
  });

  it("sends a review back to the notice", () => {
    state.route = "convert_confirm";
    state.draft = { kind: "shield", amountLux: "1000000000", amountDusk: "1" };
    show(convertConfirmView(overview(), { state, actions }));

    expect(state.route).toBe("convert");
    expect(button("Confirm")).toBeUndefined();
    expect(notices()).toHaveLength(1);
  });

  it("shows the Shield and Unshield form while shielded transactions run", () => {
    state.route = "convert";
    state.draft = { kind: "shield", amountDusk: "" };
    show(convertFormView(overview({ phoenixPaused: false }), { state, actions }));

    expect(notices()).toEqual([]);
    expect(button("Shield")).toBeTruthy();
    expect(button("Unshield")).toBeTruthy();
    expect(button("Review")).toBeTruthy();
  });
});

// --- Full view navigation -------------------------------------------------------------

describe("full view navigation while shielded transactions are paused", () => {
  it("turns the Shield item off, and back on once they run", () => {
    const item = h("button", { class: "full-nav-item", "data-route": "convert", text: "Shield" });

    syncShieldNavItem(item, overview());
    expect(item.disabled).toBe(true);
    expect(item.title).toBe(PAUSED);

    syncShieldNavItem(item, overview({ phoenixPaused: false }));
    expect(item.disabled).toBe(false);
    expect(item.hasAttribute("title")).toBe(false);
  });

  it("is applied to the Shield item on every render", async () => {
    const source = await readFile(path.resolve(process.cwd(), "src", "ui", "popup", "app.js"), "utf8");
    const navBlock = source.match(/function updateFullNav\(\) \{([\s\S]*?)\n\}/)?.[1] ?? "";

    expect(navBlock).toContain('if (itemRoute === "convert") syncShieldNavItem(item, state.overview);');
    expect(source).toMatch(/renderHeader\(ov\);\s*updateFullNav\(\);/);
  });
});
