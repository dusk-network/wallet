import { decodeBase58, encodeBase58 } from "@duskdomains/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { shortAddress } from "./lib/strings.js";
import { fakeEvent, installFakeDom, screenReaderText, settle, visibleText } from "./testing/fakeDom.js";

const mocks = vi.hoisted(() => ({ pending: null, sent: [], answers: {} }));

vi.mock("./components/GasEditor.js", () => ({}));
vi.mock("../platform/extensionApi.js", () => ({
  runtimeGetURL: (path) => `chrome-extension://wallet/${path}`,
  runtimeSendMessage: vi.fn(async (message) => {
    mocks.sent.push(message);
    if (message?.type === "DUSK_GET_PENDING") return mocks.pending;
    return mocks.answers[message?.type] ? mocks.answers[message.type](message) : { ok: true };
  }),
  tabsCreate: vi.fn(async () => ({})),
}));

// Two profiles' public accounts and the second one's shielded address.
const MAIN = "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927";
const SAVINGS = "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";
const ADDRESS = "4QpZhL54DtNrCpXRK54BhfF8WYsgvPbfVTfeNf2ePSRPTCnuZYMk988Es2NMbwCXMPTKGTLfYunZ4mbFc7i743QE";
// Others' accounts and a shielded address of the same shapes, told apart by their last byte.
const vary = (value, n) => encodeBase58(decodeBase58(value).map((b, i, all) => (i === all.length - 1 ? b ^ n : b)));
const CAROL = vary(MAIN, 2);
const BOB = vary(MAIN, 3);
const STRANGER_ADDRESS = vary(ADDRESS, 1);

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
  mocks.answers = {};
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// What the background sends for a request: the profiles, their labels, the
// .dusk names the wallet checked lately and the saved contacts.
async function render(kind, params = {}, over = {}) {
  mocks.pending = {
    rid: "r1",
    kind,
    origin: "https://dapp.example",
    params,
    hasVault: true,
    isUnlocked: true,
    accounts: [MAIN, SAVINGS],
    addresses: [vary(ADDRESS, 2), ADDRESS],
    accountCount: 2,
    selectedAccountIndex: 0,
    accountNames: { 0: "Main" },
    duskNames: { [MAIN]: "alice.dusk" },
    contacts: [{ name: "Bob", address: BOB }],
    permissionAccountIndex: 0,
    ...over,
  };
  const { renderNotification } = await import("./notification/app.js");
  await renderNotification();
}

// The value box under a row's muted label.
const box = (label) =>
  app.querySelectorAll(".row").find((row) => row.children[0]?.textContent === label)?.children[1];

const TESTNET = "https://testnet.nodes.dusk.network";

// A site's public transfer of 1 DUSK to `to` on Testnet, as rpc.js passes it on.
const transfer = (to, over = {}) => ({
  kind: "transfer",
  privacy: "public",
  to,
  amount: "1000000000",
  chainId: "dusk:2",
  nodeUrl: TESTNET,
  ...over,
});

// The To box's full address, and the line under it: null when there is none.
function recipient() {
  const to = box("To");
  const line = to.querySelector(".recipient-line");
  return { address: to.querySelector("code").textContent, line: line && visibleText(line) };
}

// The recipients whose .dusk name the approval asked the background for.
const nameAsks = () => mocks.sent.filter((m) => m.type === "DUSK_UI_RECIPIENT_NAME").map((m) => m.recipient);

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

  it("names the profile that pays a public transfer, and a recipient of yours by its label", async () => {
    // The recipient is the wallet's other profile, whose name is known.
    await render("send_tx", transfer(SAVINGS), { duskNames: { [MAIN]: "alice.dusk", [SAVINGS]: "bob.dusk" } });
    expectNamedAccount(box("From"), "alice.dusk", MAIN);
    expect(recipient()).toEqual({ address: SAVINGS, line: "Profile 2 · your profile" });
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

describe("the recipient of a site's request to send", () => {
  const setByRecipient = (name) => `${name} · name set by the recipient`;
  const answerName = (result) => {
    mocks.answers.DUSK_UI_RECIPIENT_NAME = async () => ({ ok: true, result });
  };

  it("shows the .dusk name the recipient set, once checked, under its full address and nowhere else", async () => {
    answerName("carol.dusk");
    await render("send_tx", transfer(CAROL));

    await vi.waitFor(() => expect(recipient()).toEqual({ address: CAROL, line: setByRecipient("carol.dusk") }));
    expect(mocks.sent).toContainEqual({ type: "DUSK_UI_RECIPIENT_NAME", rid: "r1", recipient: CAROL });
    expect(box("To").querySelector(".recipient-line__label").title).toBe("carol.dusk");
    expect(app.textContent.split("carol.dusk")).toHaveLength(2);
  });

  it("keeps the name's line from the first paint, so nothing moves when it comes and Approve doesn't wait", async () => {
    let answer;
    mocks.answers.DUSK_UI_RECIPIENT_NAME = () => new Promise((resolve) => (answer = resolve));
    await render("send_tx", transfer(CAROL));
    const to = box("To");
    const line = to.querySelector(".recipient-line");
    expect(recipient()).toEqual({ address: CAROL, line: "" });

    app.querySelector(".btn-primary").click();
    await vi.waitFor(() =>
      expect(mocks.sent).toContainEqual(expect.objectContaining({ type: "DUSK_PENDING_DECISION", decision: "approve" }))
    );

    answer({ ok: true, result: "carol.dusk" });
    await settle();
    expect(to.children).toEqual([to.querySelector("code"), line]);
    expect(visibleText(line)).toBe(setByRecipient("carol.dusk"));
  });

  it.each([
    ["finds no checked name", async () => ({ ok: true, result: null })],
    ["fails", async () => ({ ok: false, error: { message: "Engine call timed out" } })],
    ["gets no answer", async () => undefined],
    ["can't reach the background", async () => Promise.reject(new Error("Could not establish connection"))],
  ])("shows no name when the lookup %s", async (_label, reply) => {
    mocks.answers.DUSK_UI_RECIPIENT_NAME = reply;
    await render("send_tx", transfer(CAROL));
    await settle();
    expect(nameAsks()).toEqual([CAROL]);
    expect(recipient()).toEqual({ address: CAROL, line: "" });
  });

  it("names one of your profiles, then a saved contact, and looks neither up", async () => {
    answerName("carol.dusk");
    // SAVINGS is saved as a contact too, and goes by its profile's label.
    const contacts = [
      { name: "Bob", address: ` ${BOB} ` },
      { name: "Old savings", address: SAVINGS },
    ];
    for (const [params, line] of [
      [transfer(SAVINGS), "Profile 2 · your profile"],
      [transfer(MAIN), "Main · your profile"],
      [transfer(ADDRESS, { privacy: "shielded" }), "Profile 2 · your profile"],
      [transfer(BOB), "Bob · saved contact"],
    ]) {
      await render("send_tx", params, { contacts });
      expect(recipient().line).toBe(line);
    }
    expect(nameAsks()).toEqual([]);

    // A site picks the address: one that differs from a contact's in case only is not that contact.
    await render("send_tx", transfer(CAROL), { contacts: [{ name: "Carol", address: CAROL.toLowerCase() }] });
    await vi.waitFor(() => expect(recipient().line).toBe(setByRecipient("carol.dusk")));
  });

  it("asks for no name for a shielded address or off Mainnet and Testnet", async () => {
    answerName("carol.dusk");
    for (const params of [
      transfer(STRANGER_ADDRESS, { privacy: "shielded" }),
      transfer(CAROL, { nodeUrl: "http://127.0.0.1:8080" }),
    ]) {
      await render("send_tx", params);
      expect(recipient().line).toBeNull();
    }
    await settle();
    expect(nameAsks()).toEqual([]);
  });

  // A token or NFT contract call, decoded as the approval decodes it.
  const call = (fnName, decoded) => ({
    params: { kind: "contract_call", contractId: `0x${"11".repeat(32)}`, fnName, fnArgs: "0x00", chainId: "dusk:2", nodeUrl: TESTNET },
    answers: decoded.drc20
      ? {
          DUSK_UI_DRC20_DECODE_INPUT: async () => ({ ok: true, result: decoded.drc20 }),
          DUSK_UI_DRC20_GET_METADATA: async () => ({ ok: true, result: { name: "Token", symbol: "TKN", decimals: 0 } }),
        }
      : {
          DUSK_UI_DRC20_DECODE_INPUT: async () => ({ ok: false, error: "Not a DRC20 call" }),
          DUSK_UI_DRC721_DECODE_INPUT: async () => ({ ok: true, result: decoded.drc721 }),
          DUSK_UI_DRC721_GET_METADATA: async () => ({ ok: true, result: { name: "Art", symbol: "ART" } }),
        },
  });

  it.each([
    ["a DRC20 transfer", call("transfer", { drc20: { to: { External: CAROL }, value: "5" } })],
    ["a DRC721 transfer", call("transfer_from", { drc721: { from: { External: MAIN }, to: { External: CAROL }, token_id: "7" } })],
  ])("names the recipient of %s the same way", async (_label, { params, answers }) => {
    Object.assign(mocks.answers, answers);
    answerName("carol.dusk");
    await render("send_tx", params);
    await vi.waitFor(() => expect(recipient()).toEqual({ address: CAROL, line: setByRecipient("carol.dusk") }));
  });

  it("asks for no name for a token spender, which receives nothing", async () => {
    const { params, answers } = call("approve", { drc20: { spender: { External: CAROL }, value: "5" } });
    Object.assign(mocks.answers, answers);
    answerName("carol.dusk");
    await render("send_tx", params);
    await settle();
    expect(visibleText(box("Spender"))).toBe(CAROL);
    expect(nameAsks()).toEqual([]);
  });
});
