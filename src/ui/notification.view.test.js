import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { shortAddress } from "./lib/strings.js";
import { fakeEvent, installFakeDom, screenReaderText, visibleText } from "./testing/fakeDom.js";

const mocks = vi.hoisted(() => ({ pending: null, sent: [] }));

vi.mock("./components/GasEditor.js", () => ({}));
vi.mock("../platform/extensionApi.js", () => ({
  runtimeGetURL: (path) => `chrome-extension://wallet/${path}`,
  runtimeSendMessage: vi.fn(async (message) => {
    mocks.sent.push(message);
    return message?.type === "DUSK_GET_PENDING" ? mocks.pending : { ok: true };
  }),
  tabsCreate: vi.fn(async () => ({})),
}));

// Two profiles' public accounts and the second one's shielded address.
const MAIN = "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927";
const SAVINGS = "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";
const ADDRESS = "4QpZhL54DtNrCpXRK54BhfF8WYsgvPbfVTfeNf2ePSRPTCnuZYMk988Es2NMbwCXMPTKGTLfYunZ4mbFc7i743QE";

let dom;
let app;

beforeEach(() => {
  dom = installFakeDom({
    elements: {
      "dusk-gas-editor": (el) => Object.assign(el, { setGas: vi.fn(), readOverrideGas: () => null }),
    },
  });
  Object.assign(dom.window, {
    location: { href: "chrome-extension://wallet/notification.html?rid=r1" },
    close: vi.fn(),
  });
  // The approval's activity heartbeat.
  vi.stubGlobal("setInterval", vi.fn(() => 1));
  vi.stubGlobal("clearInterval", vi.fn());
  app = dom.document.createElement("div");
  app.id = "app";
  dom.document.body.appendChild(app);
  mocks.sent = [];
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// What the background sends for a request: the profiles, their labels and the
// .dusk names the wallet checked lately.
async function render(kind, params = {}, over = {}) {
  mocks.pending = {
    rid: "r1",
    kind,
    origin: "https://dapp.example",
    params,
    hasVault: true,
    isUnlocked: true,
    accounts: [MAIN, SAVINGS],
    accountCount: 2,
    selectedAccountIndex: 0,
    accountNames: { 0: "Main" },
    duskNames: { [MAIN]: "alice.dusk" },
    permissionAccountIndex: 0,
    ...over,
  };
  const { renderNotification } = await import("./notification/app.js");
  await renderNotification();
}

// The value box under a row's muted label.
const box = (label) =>
  app.querySelectorAll(".row").find((row) => row.children[0]?.textContent === label)?.children[1];

// A name over its account, the account short (6…6) with the full one in its
// tooltip and, for screen readers, in place of the short one.
function expectNamedAccount(el, name, account) {
  expect(el.classList.contains("named-address")).toBe(true);
  expect(el.querySelector(".dusk-name").textContent).toBe(name);
  const code = el.querySelector("code");
  expect([visibleText(code), code.title, screenReaderText(code)]).toEqual([shortAddress(account), account, account]);
  expect(visibleText(el)).toBe(`${name}${shortAddress(account)}`);
}

describe("connect approval", () => {
  it("offers each profile as a card with its label, its checked .dusk name and its short account", async () => {
    await render("connect", { requestedProfiles: true });

    const group = app.querySelector("[role=radiogroup]");
    expect(app.querySelector(`#${group.getAttribute("aria-labelledby")}`).textContent).toBe("Profile");
    expect(app.querySelector("select")).toBeNull();

    const [main, savings] = group.querySelectorAll(".profile-option");
    expect(main.querySelector(".name-option__label").textContent).toBe("Main");
    expect(main.querySelector(".dusk-name").textContent).toBe("alice.dusk");
    const code = main.querySelector("code");
    expect([visibleText(code), code.title]).toEqual([shortAddress(MAIN), MAIN]);
    expect(visibleText(main)).toBe(`Mainalice.dusk${shortAddress(MAIN)}`);
    // A radio's label is the whole card, the full account included.
    expect(screenReaderText(main)).toBe(`Mainalice.dusk${MAIN}`);

    // A profile without a checked name shows its label and short account.
    expect(savings.querySelector(".dusk-name")).toBeNull();
    expect(visibleText(savings)).toBe(`Profile 2${shortAddress(SAVINGS)}`);
  });

  it("picks the connected profile with native radios and connects the one picked", async () => {
    await render("connect", { requestedProfiles: true }, { permissionAccountIndex: 1 });

    const cards = app.querySelectorAll(".profile-option");
    const radios = cards.map((card) => card.querySelector("input"));
    expect(cards.map((card) => card.localName)).toEqual(["label", "label"]);
    expect(radios.map((radio) => [radio.getAttribute("type"), radio.getAttribute("name"), radio.value])).toEqual([
      ["radio", "connect-profile", "0"],
      ["radio", "connect-profile", "1"],
    ]);
    expect(radios.map((radio) => radio.checked)).toEqual([false, true]);
    expect(cards.map((card) => card.classList.contains("is-checked"))).toEqual([false, true]);

    // Arrow keys or a click check the other radio, which reports a change.
    radios[0].checked = true;
    radios[0].dispatchEvent(fakeEvent("change"));
    expect(radios.map((radio) => radio.checked)).toEqual([true, false]);
    expect(cards.map((card) => card.classList.contains("is-checked"))).toEqual([true, false]);

    app.querySelector(".btn-primary").click();
    await vi.waitFor(() =>
      expect(mocks.sent).toContainEqual({
        type: "DUSK_PENDING_DECISION",
        rid: "r1",
        decision: "approve",
        approvedParams: { accountIndex: 0, shieldedReceiveAddress: false },
      })
    );
  });

  it("keeps the shielded disclosure with the profile that has the grant", async () => {
    await render(
      "connect",
      { requestedProfiles: true, currentAccountIndex: 1, currentGrants: { shieldedReceiveAddress: true } },
      { permissionAccountIndex: 1 }
    );
    const disclosure = () => box("Profile").parentNode.children[2].textContent;
    expect(disclosure()).toContain("shareable shielded receive address");

    const radio = app.querySelectorAll(".profile-option input")[0];
    radio.checked = true;
    radio.dispatchEvent(fakeEvent("change"));
    expect(disclosure()).toBe("The site will only be able to use the selected profile's public account.");
  });

  it("shows a single profile as its card, with nothing to pick", async () => {
    await render("connect", { requestedProfiles: true }, { accounts: [MAIN], accountCount: 1 });

    expect(app.querySelector("[role=radiogroup]")).toBeNull();
    expect(app.querySelector("input")).toBeNull();
    const card = app.querySelector(".profile-option");
    expect(card.classList.contains("is-checked")).toBe(true);
    expect(visibleText(card)).toBe(`Mainalice.dusk${shortAddress(MAIN)}`);
  });
});

describe("sign and send approvals", () => {
  it("shows the signing profile's checked .dusk name over its short account", async () => {
    await render("sign_message", { chainId: "dusk:2", messageHash: `0x${"ab".repeat(32)}`, messageLen: 2 });
    expectNamedAccount(box("Account"), "alice.dusk", MAIN);
  });

  it("shows the account alone, in full, while no checked name is known", async () => {
    await render("sign_auth", { chainId: "dusk:2", nonce: "n-1" }, { duskNames: {} });
    const account = box("Account");
    expect(account.classList.contains("named-address")).toBe(false);
    expect(visibleText(account)).toBe(MAIN);
  });

  it("names the profile that pays a public transfer, but never the recipient", async () => {
    // The recipient is the wallet's other profile, whose name is known.
    await render(
      "send_tx",
      { kind: "transfer", privacy: "public", to: SAVINGS, amount: "1000000000", chainId: "dusk:2" },
      { duskNames: { [MAIN]: "alice.dusk", [SAVINGS]: "bob.dusk" } }
    );
    expectNamedAccount(box("From"), "alice.dusk", MAIN);
    expect(visibleText(box("To"))).toBe(SAVINGS);
    expect(app.textContent).not.toContain("bob.dusk");
  });

  it("names no one for a shielded transfer, which the shielded balance pays", async () => {
    await render("send_tx", { kind: "transfer", privacy: "shielded", to: ADDRESS, amount: "1", chainId: "dusk:2" });
    expect(visibleText(box("From"))).toBe("Phoenix shielded balance");
    expect(app.textContent).not.toContain("alice.dusk");
  });

  it("names the profile that pays a contract call", async () => {
    await render("send_tx", {
      kind: "contract_call",
      contractId: `0x${"11".repeat(32)}`,
      fnName: "stake",
      fnArgs: "0x00",
      chainId: "dusk:2",
    });
    expectNamedAccount(box("From"), "alice.dusk", MAIN);
    expect(visibleText(box("Contract"))).toBe(`0x${"11".repeat(32)}`);
  });
});
