import { decodeBase58, encodeBase58 } from "@duskdomains/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BRIDGE_CONTRACTS } from "../shared/bridge.js";
import fixtures from "../shared/fixtures/duskevm-bridge-calls.json";
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
    nodeUrl: TESTNET,
    networkName: "Testnet",
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

// A key-value row's value, by its label.
const row = (label) =>
  app.querySelectorAll(".kv").find((kv) => kv.querySelector(".kv-label")?.textContent === label)?.querySelector(".kv-value");
// The bar with Reject and the approve button, under the page.
const bar = () => dom.document.getElementById("approval-actions");
const buttons = () => bar().querySelectorAll("button").map((b) => b.textContent);
const approve = () => bar().querySelector(".btn-primary");
const head = () => app.querySelector(".ap-head");
const decision = (decision) => mocks.sent.find((m) => m.type === "DUSK_PENDING_DECISION" && m.decision === decision);

const TESTNET = "https://testnet.nodes.dusk.network";

// A site's public transfer of 1 DUSK to `to` on Testnet, as rpc.js passes it on.
const transfer = (to, over = {}) => ({
  kind: "transfer",
  privacy: "public",
  to,
  amount: "1000000000",
  chainId: "dusk:2",
  nodeUrl: TESTNET,
  networkName: "Testnet",
  ...over,
});

// Whom the head says it pays: the name or short address that leads, and your
// label for it (null without one).
function recipient() {
  const lead = head().querySelector(".ap-recipient__lead");
  const tag = head().querySelector(".ap-recipient__tag");
  return { lead: lead.textContent, tag: tag && visibleText(tag) };
}

// The recipients whose .dusk name the approval asked the background for.
const nameAsks = () => mocks.sent.filter((m) => m.type === "DUSK_UI_RECIPIENT_NAME").map((m) => m.recipient);

// A name over its account, the account short (6…6) with the full one in its
// tooltip and, for screen readers, in place of the short one.
function expectNamedAccount(el, name, account) {
  const named = el.querySelector(".named-address");
  expect(named.querySelector(".dusk-name").textContent).toBe(name);
  const code = named.querySelector("code");
  expect([visibleText(code), code.title, screenReaderText(code)]).toEqual([shortAddress(account), account, account]);
  expect(visibleText(named)).toBe(`${name}${shortAddress(account)}`);
}

describe("connect approval", () => {
  it("offers each profile as a card with its label, its checked .dusk name and its short account", async () => {
    await render("connect", { requestedProfiles: true });

    expect(head().querySelector("h1").textContent).toBe("Connect this site?");
    const group = app.querySelector("[role=radiogroup]");
    expect(app.querySelector(`#${group.getAttribute("aria-labelledby")}`).textContent).toBe("Choose a profile");
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

  it("says plainly what the site sees, that it can't move funds, and until when", async () => {
    await render("connect", { requestedProfiles: true });

    const facts = app.querySelectorAll(".ap-facts .list-row").map(visibleText);
    expect(facts).toEqual([
      `Sees your public address, .dusk name and balancealice.dusk · ${shortAddress(MAIN)}, until you disconnect it`,
      "Can't move funds without your approvalEvery payment and signature asks you here first.",
    ]);
    expect(app.textContent).not.toContain("only be able to use");
    expect(buttons()).toEqual(["Reject", "Connect"]);
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

    // Arrow keys or a click check the other radio, which reports a change, and
    // the facts follow the profile picked.
    radios[0].checked = true;
    radios[0].dispatchEvent(fakeEvent("change"));
    expect(radios.map((radio) => radio.checked)).toEqual([true, false]);
    expect(cards.map((card) => card.classList.contains("is-checked"))).toEqual([true, false]);
    expect(visibleText(app.querySelector(".ap-facts"))).toContain(`alice.dusk · ${shortAddress(MAIN)}`);

    approve().click();
    await vi.waitFor(() =>
      expect(mocks.sent).toContainEqual({
        type: "DUSK_PENDING_DECISION",
        rid: "r1",
        decision: "approve",
        approvedParams: { accountIndex: 0, shieldedReceiveAddress: false },
      })
    );
  });

  it("gives a request for the shielded address its own title, facts and button", async () => {
    // A connected site asks for more.
    await render("connect", { requestedProfiles: true, shieldedReceiveAddress: true, currentAccountIndex: 0, currentGrants: {} });
    expect(head().querySelector("h1").textContent).toBe("Share your shielded address?");
    const facts = () => app.querySelectorAll(".ap-facts .row-title").map((t) => t.textContent);
    expect(facts()).toEqual(["Gets your shielded address", "Can't move funds without your approval"]);
    expect(buttons()).toEqual(["Reject", "Share"]);
    approve().click();
    await vi.waitFor(() => expect(decision("approve")?.approvedParams).toEqual({ accountIndex: 0, shieldedReceiveAddress: true }));

    // A site that isn't connected yet asks for both.
    await render("connect", { requestedProfiles: true, shieldedReceiveAddress: true, currentAccountIndex: null }, { permissionAccountIndex: null });
    expect(head().querySelector("h1").textContent).toBe("Connect and share your shielded address?");
    expect(facts()).toEqual([
      "Sees your public address, .dusk name and balance",
      "Gets your shielded address",
      "Can't move funds without your approval",
    ]);
    expect(buttons()).toEqual(["Reject", "Connect"]);
  });

  it("keeps the shielded address with the profile that has the grant", async () => {
    await render(
      "connect",
      { requestedProfiles: true, currentAccountIndex: 1, currentGrants: { shieldedReceiveAddress: true } },
      { permissionAccountIndex: 1 }
    );
    const facts = () => app.querySelectorAll(".ap-facts .row-title").map((t) => t.textContent);
    expect(facts()).toContain("Gets your shielded address");

    const radio = app.querySelectorAll(".profile-option input")[0];
    radio.checked = true;
    radio.dispatchEvent(fakeEvent("change"));
    expect(facts()).not.toContain("Gets your shielded address");
    approve().click();
    await vi.waitFor(() => expect(decision("approve")?.approvedParams).toEqual({ accountIndex: 0, shieldedReceiveAddress: false }));
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

describe("sign approvals", () => {
  it("shows a readable message as text and the signing profile's checked .dusk name", async () => {
    await render("sign_message", {
      chainId: "dusk:2",
      messageHash: `0x${"ab".repeat(32)}`,
      messageLen: 25,
      messagePreview: { kind: "text", text: "I agree to the shop terms", truncated: false },
    });
    expect(app.querySelector(".ap-message").textContent).toBe("I agree to the shop terms");
    expectNamedAccount(row("Account"), "alice.dusk", MAIN);
    expect(row("Message hash").textContent).toBe(`25 bytes · sha256=0x${"ab".repeat(5)}…${"ab".repeat(4)}`);
    expect(buttons()).toEqual(["Reject", "Sign"]);
    // The chain sits under Details.
    expect(app.querySelector("details").textContent).toContain("dusk:2");
  });

  it("says bytes that aren't text are bytes", async () => {
    await render("sign_message", { chainId: "dusk:2", messageLen: 3, messagePreview: { kind: "opaque", reason: "invalid_utf8" } });
    expect(visibleText(app.querySelector(".ap-message"))).toBe("3 bytesIt isn't readable text. Only sign it if you trust this site.");
  });

  it("shows the account alone, in full, while no checked name is known", async () => {
    await render("sign_auth", { chainId: "dusk:2", nonce: "n-1" }, { duskNames: {} });
    const account = row("Account");
    expect(account.querySelector(".dusk-name")).toBeNull();
    expect(visibleText(account)).toBe(MAIN);
    expect(buttons()).toEqual(["Reject", "Sign in"]);
  });
});

describe("a site's request to pay", () => {
  it("leads with the amount, whom it pays and Approve; the chain and node sit under Details", async () => {
    await render("send_tx", transfer(BOB, { amount: "1500000000", memo: "Order 1042" }));

    expect(app.children[0].classList.contains("ap-site")).toBe(true);
    expect(app.children[1]).toBe(head());
    expect(head().querySelector("h1").textContent).toBe("Pay");
    expect(visibleText(head().querySelector(".ap-amount"))).toBe("1.5 DUSK");
    expect(buttons()).toEqual(["Reject", "Approve"]);
    // dusk:2 and the node's URL only under Details.
    const details = app.querySelector("details");
    expect(details.open).toBe(false);
    for (const technical of ["dusk:2", TESTNET]) {
      expect(details.textContent).toContain(technical);
      expect(app.textContent.split(technical)).toHaveLength(2);
    }
  });

  it("shows exactly the amount asked, every decimal", async () => {
    await render("send_tx", transfer(BOB, { amount: "1000090001" }));
    expect(visibleText(head().querySelector(".ap-amount"))).toBe("1.000090001 DUSK");
  });

  // What a public transfer makes visible to everyone: only what applies, under
  // the profile's verified name or else its account. A shielded one: nothing.
  it.each([
    ["with a memo, under its verified name", transfer(BOB, { memo: "Order 1042" }), {}, "Visible to everyone: amount, memo, and your name alice.dusk."],
    ["without a memo, under its verified name", transfer(BOB), {}, "Visible to everyone: amount and your name alice.dusk."],
    ["with a memo, for a profile without a name", transfer(BOB, { memo: "Order 1042" }), { duskNames: {} }, "Visible to everyone: amount, memo, and your account."],
    ["without a memo, for a profile without a name", transfer(BOB), { duskNames: {} }, "Visible to everyone: amount and your account."],
    ["for a shielded transfer", transfer(ADDRESS, { privacy: "shielded", memo: "Order 1042" }), {}, null],
  ])("says what becomes visible to everyone %s", async (_label, params, over, line) => {
    await render("send_tx", params, over);
    expect(app.querySelector(".ap-visible")?.textContent ?? null).toBe(line);
  });

  it("names the paying profile and the rail in plain words", async () => {
    await render("send_tx", transfer(BOB));
    expect(visibleText(row("From"))).toBe("alice.dusk · Public");
    await render("send_tx", transfer(ADDRESS, { privacy: "shielded" }));
    expect(visibleText(row("From"))).toBe("Your shielded balance");
    expect(app.textContent).not.toMatch(/Moonlight|Phoenix/);
  });

  it("gives the fee editor the transaction's minimum and, once the node answers, the network's price", async () => {
    mocks.answers.DUSK_UI_GET_CACHED_GAS_PRICE = async () => ({ ok: true, result: { average: "2", max: "5", median: "1", min: "1" } });
    // The site set its own price; the network's is 1 LUX.
    await render("send_tx", transfer(BOB, { gas: { limit: "2600000", price: "3" } }));
    const editor = app.querySelector("dusk-gas-editor");
    expect(editor.setGas).toHaveBeenCalledWith({ limit: "2600000", price: "3" });
    expect(editor.minLimit).toBe("2000000");
    await vi.waitFor(() => expect(editor.networkGas).toEqual({ limit: "2600000", price: "1" }));

    // A shielded contract call has its own minimum; a public one has none.
    await render("send_tx", { kind: "contract_call", privacy: "shielded", contractId: `0x${"11".repeat(32)}`, fnName: "x", fnArgs: "0x00", gas: { limit: "100000000", price: "1" }, nodeUrl: TESTNET });
    expect(app.querySelector("dusk-gas-editor").minLimit).toBe("100000000");
    await render("send_tx", { kind: "contract_call", privacy: "public", contractId: `0x${"11".repeat(32)}`, fnName: "x", fnArgs: "0x00", gas: { limit: "5000000", price: "1" }, nodeUrl: TESTNET });
    expect(app.querySelector("dusk-gas-editor").minLimit).toBeNull();
  });

  it("refuses a gas edit that won't do under the buttons, and sends nothing", async () => {
    await render("send_tx", transfer(BOB));
    const editorError = new Error("Provide both gas limit and gas price (or clear both to use wallet defaults).");
    app.querySelector("dusk-gas-editor").readOverrideGas = () => {
      throw editorError;
    };
    approve().click();
    await settle();
    const error = bar().querySelector(".field-error");
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe(editorError.message);
    expect(decision("approve")).toBeUndefined();
    expect(globalThis.alert).not.toHaveBeenCalled();
  });
});

describe("the recipient of a site's request to send", () => {
  const answerName = (result) => {
    mocks.answers.DUSK_UI_RECIPIENT_NAME = async () => ({ ok: true, result });
  };

  it("leads with the .dusk name the recipient set, once checked, and shows the full address under To", async () => {
    answerName("carol.dusk");
    await render("send_tx", transfer(CAROL));

    await vi.waitFor(() => expect(recipient()).toEqual({ lead: "carol.dusk", tag: null }));
    expect(mocks.sent).toContainEqual({ type: "DUSK_UI_RECIPIENT_NAME", rid: "r1", recipient: CAROL });
    expect(head().querySelector(".ap-recipient__lead").title).toBe(`carol.dusk · ${CAROL}`);
    expect(row("To").textContent).toBe(CAROL);
    expect(app.textContent.split("carol.dusk")).toHaveLength(2);
  });

  it("shows the short address until the name comes, in the same line, and Approve doesn't wait", async () => {
    let answer;
    mocks.answers.DUSK_UI_RECIPIENT_NAME = () => new Promise((resolve) => (answer = resolve));
    await render("send_tx", transfer(CAROL));
    const lead = head().querySelector(".ap-recipient__lead");
    expect(recipient()).toEqual({ lead: shortAddress(CAROL), tag: null });
    expect(lead.classList.contains("mono")).toBe(true);

    approve().click();
    await vi.waitFor(() => expect(decision("approve")).toBeTruthy());

    answer({ ok: true, result: "carol.dusk" });
    await settle();
    expect(head().querySelector(".ap-recipient__lead")).toBe(lead);
    expect(lead.textContent).toBe("carol.dusk");
    expect(lead.classList.contains("mono")).toBe(false);
  });

  it.each([
    ["finds no checked name", async () => ({ ok: true, result: null })],
    ["fails", async () => ({ ok: false, error: { message: "Engine call timed out" } })],
    ["gets no answer", async () => undefined],
    ["can't reach the background", async () => Promise.reject(new Error("Could not establish connection"))],
  ])("keeps the short address when the lookup %s", async (_label, reply) => {
    mocks.answers.DUSK_UI_RECIPIENT_NAME = reply;
    await render("send_tx", transfer(CAROL));
    await settle();
    expect(nameAsks()).toEqual([CAROL]);
    expect(recipient()).toEqual({ lead: shortAddress(CAROL), tag: null });
  });

  it("shows a saved contact's label beside the name the recipient set, never instead of it", async () => {
    answerName("bob-shop.dusk");
    await render("send_tx", transfer(BOB));
    await vi.waitFor(() => expect(recipient()).toEqual({ lead: "bob-shop.dusk", tag: "Bob · saved contact" }));
    expect(nameAsks()).toEqual([BOB]);

    // Without a name, the label still shows beside the short address.
    answerName(null);
    await render("send_tx", transfer(BOB));
    await settle();
    expect(recipient()).toEqual({ lead: shortAddress(BOB), tag: "Bob · saved contact" });
  });

  it("names one of your profiles by its checked name and label, and looks it up nowhere", async () => {
    answerName("carol.dusk");
    const contacts = [
      { name: "Bob", address: ` ${BOB} ` },
      { name: "Old savings", address: SAVINGS },
    ];
    for (const [params, expected] of [
      [transfer(SAVINGS), { lead: "bob.dusk", tag: "Profile 2 · your profile" }],
      [transfer(MAIN), { lead: "alice.dusk", tag: "Main · your profile" }],
      [transfer(ADDRESS, { privacy: "shielded" }), { lead: shortAddress(ADDRESS), tag: "Profile 2 · your profile" }],
    ]) {
      await render("send_tx", params, { contacts, duskNames: { [MAIN]: "alice.dusk", [SAVINGS]: "bob.dusk" } });
      expect(recipient()).toEqual(expected);
    }
    await settle();
    expect(nameAsks()).toEqual([]);

    // A site picks the address: one that differs from a contact's in case only is not that contact.
    await render("send_tx", transfer(CAROL), { contacts: [{ name: "Carol", address: CAROL.toLowerCase() }] });
    await vi.waitFor(() => expect(recipient()).toEqual({ lead: "carol.dusk", tag: null }));
  });

  it("asks for no name for a shielded address or off Mainnet and Testnet", async () => {
    answerName("carol.dusk");
    for (const params of [
      transfer(STRANGER_ADDRESS, { privacy: "shielded" }),
      transfer(CAROL, { nodeUrl: "http://127.0.0.1:8080" }),
    ]) {
      await render("send_tx", params);
      expect(recipient().tag).toBeNull();
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
    await vi.waitFor(() => expect(recipient()).toEqual({ lead: "carol.dusk", tag: null }));
    expect(row("To").textContent).toBe(CAROL);
  });

  it("shows a token amount exactly, every decimal the token has", async () => {
    Object.assign(mocks.answers, {
      DUSK_UI_DRC20_DECODE_INPUT: async () => ({ ok: true, result: { to: { External: CAROL }, value: "1234567891234" } }),
      DUSK_UI_DRC20_GET_METADATA: async () => ({ ok: true, result: { name: "Token", symbol: "TKN", decimals: 9 } }),
    });
    await render("send_tx", { kind: "contract_call", contractId: `0x${"11".repeat(32)}`, fnName: "transfer", fnArgs: "0x00", chainId: "dusk:2", nodeUrl: TESTNET });
    expect(visibleText(head().querySelector(".ap-amount"))).toBe("1,234.567891234 TKN");
  });

  it("asks for no name for a token spender, which receives nothing", async () => {
    const { params, answers } = call("approve", { drc20: { spender: { External: CAROL }, value: "5" } });
    Object.assign(mocks.answers, answers);
    answerName("carol.dusk");
    await render("send_tx", params);
    await settle();
    expect(row("Spender").textContent).toBe(CAROL);
    expect(nameAsks()).toEqual([]);
  });
});

describe("contract calls", () => {
  const { bridge, portal } = BRIDGE_CONTRACTS.testnet;
  const fixture = (name) => fixtures.calls.find((c) => c.name === name);
  const contractCall = (contractId, name, over = {}) => ({
    kind: "contract_call",
    privacy: "public",
    contractId: `0x${contractId}`,
    fnName: fixture(name).fnName,
    fnArgs: fixture(name).args,
    amount: "0",
    deposit: "0",
    chainId: "dusk:2",
    nodeUrl: TESTNET,
    networkName: "Testnet",
    ...over,
  });
  const order = (...els) => els.map((el) => app.children.indexOf(el.closest("#app > *")));

  it("says the wallet can't read an unknown call's arguments, and shows their size and hash", async () => {
    await render("send_tx", {
      kind: "contract_call",
      privacy: "public",
      contractId: `0x${"11".repeat(32)}`,
      fnName: "stake",
      fnArgs: "0x00",
      deposit: "10000000000",
      chainId: "dusk:2",
      nodeUrl: TESTNET,
    });
    expect(head().querySelector("h1").textContent).toBe("Contract call");
    expect(visibleText(head().querySelector(".ap-amount"))).toBe("10 DUSK");
    expect(visibleText(row("From"))).toBe("alice.dusk · Public");
    expect(row("Contract").querySelector(".mono").title).toBe(`0x${"11".repeat(32)}`);
    expect(row("Call data").textContent).toMatch(/^1 bytes · sha256=6e340b9cffb3…/);
    expect(app.querySelector(".ap-opaque").textContent).toBe("The wallet can't read this call's arguments. Check them on the site before you approve.");
    expect(app.textContent).not.toContain("Known DuskEVM bridge call");
  });

  it("reads a DuskEVM deposit: its recipient and amount above the call, with the call data's hash in view", async () => {
    const shoot = fixture("deposit-shoot");
    await render(
      "send_tx",
      contractCall(bridge, "deposit-shoot", { deposit: "100000000", display: { label: "Bridge 0.1 DUSK to DuskEVM", recipient: "0x96BA8D18dBa0a9B933c2e733EA07F47767dc893e" } })
    );

    expect(head().querySelector("h1").textContent).toBe("Bridge to DuskEVM");
    expect(visibleText(head().querySelector(".ap-amount"))).toBe("0.1 DUSK");
    expect(head().querySelector(".ap-tag").textContent).toBe("Known DuskEVM bridge call");
    expect(row("DuskEVM recipient").textContent).toBe(shoot.expected.to);
    expect(row("Amount").textContent).toBe("0.1 DUSK");
    // The line the bridge's review page shows, to match against.
    expect(row("Call data").textContent).toBe(`40 bytes · sha256=${shoot.sha256.slice(0, 12)}…${shoot.sha256.slice(-8)}`);
    expect(row("Call data").textContent).toBe("40 bytes · sha256=2f64b19f5ac0…731c7c2a");
    // Decoded fields first, the raw bytes after them; the site's own words apart.
    const raw = app.querySelectorAll("details").find((d) => d.querySelector("summary").textContent === "Raw call data");
    expect(raw.querySelector("code").textContent).toBe(shoot.args);
    const [decoded, callData, rawAt] = order(row("DuskEVM recipient"), row("Call data"), raw);
    expect(decoded).toBeLessThan(callData);
    expect(callData).toBeLessThan(rawAt);
    expect(app.querySelector(".ap-site-details pre").textContent).toContain('"label": "Bridge 0.1 DUSK to DuskEVM"');
    expect(app.querySelector(".ap-visible").textContent).toBe(
      "Visible to everyone: the amount, the DuskEVM recipient, and your name alice.dusk."
    );
  });

  it("warns when a deposit sends other DUSK than it bridges, and doesn't call it known", async () => {
    await render("send_tx", contractCall(bridge, "deposit", { deposit: "200000000" }));
    expect(head().querySelector(".ap-tag")).toBeNull();
    expect(app.querySelector(".callout.warn").textContent).toBe(
      "The amounts don't matchThis call sends 0.2 DUSK but bridges 0.1 DUSK. Reject it unless the site told you why."
    );
  });

  it.each([
    ["prove-account", "Prove a DuskEVM withdrawal", "Proving moves no DUSK. You claim it once the waiting period ends."],
    ["claim-external-account", "Claim a DuskEVM withdrawal", "Claiming pays this DUSK to the account above. You pay only the network fee."],
  ])("reads %s: the withdrawal's amount and whom it pays on Dusk", async (name, title, noteText) => {
    // It pays the wallet's second profile.
    await render("send_tx", contractCall(portal, name), { duskNames: { [MAIN]: "alice.dusk", [SAVINGS]: "bob.dusk" } });
    expect(head().querySelector("h1").textContent).toBe(title);
    expect(visibleText(head().querySelector(".ap-amount"))).toBe("1,008 DUSK");
    expect(recipient()).toEqual({ lead: "bob.dusk", tag: "Profile 2 · your profile" });
    expect(row("Pays to").textContent).toBe(SAVINGS);
    expect(row("Sent from DuskEVM").textContent).toBe(fixture(name).expected.from);
    expect(app.textContent).toContain(noteText);
    expect(head().querySelector(".ap-tag").textContent).toBe("Known DuskEVM bridge call");
  });

  it("shows a withdrawal off the bridge's route as the call it is, with a warning, never as known", async () => {
    // Its target is another contract than Dusk's messenger.
    const fnArgs = fixture("prove-account").args.replace(fixtures.route.l1Messenger.slice(2).toLowerCase(), "11".repeat(20));
    expect(fnArgs).not.toBe(fixture("prove-account").args);
    await render("send_tx", contractCall(portal, "prove-account", { fnArgs }));
    expect(head().querySelector("h1").textContent).toBe("Contract call");
    expect(head().querySelector(".ap-tag")).toBeNull();
    expect(app.textContent).not.toContain("Known DuskEVM bridge call");
    expect(app.querySelector(".callout.warn").textContent).toBe(
      "The wallet can't check this bridge callIt goes to the DuskEVM bridge, but it isn't a transfer the wallet knows for this network. Reject it unless you know why the site sent it."
    );
    expect(app.querySelector(".ap-opaque")).toBeNull();
  });

  it("names a withdrawal that pays a contract", async () => {
    await render("send_tx", contractCall(portal, "claim-contract"));
    expect(row("Pays to contract").textContent).toBe(fixture("claim-contract").expected.recipient);
    expect(visibleText(head().querySelector(".ap-amount"))).toBe("1 DUSK");
  });

  it("leaves the same call undecoded on Mainnet, where no bridge is configured", async () => {
    await render("send_tx", contractCall(bridge, "deposit", { deposit: "100000000", chainId: "dusk:1", nodeUrl: "https://nodes.dusk.network", networkName: "Mainnet" }));
    expect(head().querySelector("h1").textContent).toBe("Contract call");
    expect(app.textContent).not.toContain("Known DuskEVM bridge call");
    expect(app.querySelector(".ap-opaque")).not.toBeNull();
  });
});
