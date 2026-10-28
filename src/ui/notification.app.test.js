import { hashTypedDataHex } from "@dusk/typed-data";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BRIDGE_CONTRACTS } from "../shared/bridge.js";
import fixtures from "../shared/fixtures/duskevm-bridge-calls.json";
import { installFakeDom, settle, typeInto, visibleText } from "./testing/fakeDom.js";

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

const MAIN = "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927";
const SHOP = "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";
const TESTNET = "https://testnet.nodes.dusk.network";

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

async function render(kind, params = {}, over = {}) {
  mocks.pending = {
    rid: "r1",
    kind,
    origin: "https://shop.example",
    params,
    nodeUrl: TESTNET,
    networkName: "Testnet",
    hasVault: true,
    isUnlocked: true,
    accounts: [MAIN],
    addresses: ["addr0"],
    accountCount: 1,
    selectedAccountIndex: 0,
    accountNames: {},
    duskNames: { [MAIN]: "alice.dusk" },
    contacts: [],
    permissionAccountIndex: 0,
    ...over,
  };
  const { renderNotification } = await import("./notification/app.js");
  await renderNotification();
}

const bar = () => dom.document.getElementById("approval-actions");
const button = (text) => bar().querySelectorAll("button").find((b) => b.textContent === text);
const title = () => app.querySelector(".ap-head h1")?.textContent;

describe("a site's request while the wallet is locked", () => {
  const locked = { isUnlocked: false, accounts: [], duskNames: {} };
  const pay = { kind: "transfer", privacy: "public", to: SHOP, amount: "1000000000", chainId: "dusk:2", nodeUrl: TESTNET };

  it.each([
    ["connect", { requestedProfiles: true }, "Connect this site?", "It asks to see your public address, .dusk name and balance."],
    ["connect", { requestedProfiles: true, shieldedReceiveAddress: true, currentAccountIndex: 0 }, "Share your shielded address?", "It asks for your shielded receive address."],
    ["sign_message", { messageLen: 25, messagePreview: { kind: "text", text: "I agree to the shop terms" } }, "Sign a message?", "I agree to the shop terms"],
    ["sign_message", { messageLen: 3, messagePreview: { kind: "opaque" } }, "Sign a message?", "3 bytes, not readable text"],
    ["switch_network", { to: { networkName: "Mainnet" } }, "Switch to Mainnet?", null],
    ["watch_asset", { type: "DRC721" }, "Import an NFT?", null],
  ])("shows what %s asks before the password", async (kind, params, heading, sub) => {
    await render(kind, params, locked);
    expect(title()).toBe(heading);
    expect(app.querySelector(".ap-head .ap-sub")?.textContent ?? null).toBe(sub);
    expect(bar().querySelectorAll("button").map((b) => b.textContent)).toEqual(["Reject", "Unlock"]);
  });

  it("shows a payment's amount and recipient, named once checked", async () => {
    mocks.answers.DUSK_UI_RECIPIENT_NAME = async () => ({ ok: true, result: "wallet-both.dusk" });
    await render("send_tx", pay, locked);
    expect(title()).toBe("Pay");
    expect(visibleText(app.querySelector(".ap-amount"))).toBe("1 DUSK");
    await vi.waitFor(() => expect(app.querySelector(".ap-recipient__lead").textContent).toBe("wallet-both.dusk"));
  });

  it("shows a known bridge deposit's amount and DuskEVM recipient", async () => {
    const deposit = fixtures.calls.find((c) => c.name === "deposit-shoot");
    await render(
      "send_tx",
      { kind: "contract_call", contractId: BRIDGE_CONTRACTS.testnet.bridge, fnName: deposit.fnName, fnArgs: deposit.args, deposit: "100000000", chainId: "dusk:2", nodeUrl: TESTNET },
      locked
    );
    expect(title()).toBe("Bridge to DuskEVM");
    expect(visibleText(app.querySelector(".ap-amount"))).toBe("0.1 DUSK");
    expect(visibleText(app.querySelector(".ap-recipient"))).toBe("to 0x96BA…893e on DuskEVM");
  });

  it("rejects without unlocking", async () => {
    await render("send_tx", pay, locked);
    button("Reject").click();
    await vi.waitFor(() => expect(mocks.sent).toContainEqual({ type: "DUSK_PENDING_DECISION", rid: "r1", decision: "reject" }));
    expect(mocks.sent.some((m) => m.type === "DUSK_UI_UNLOCK")).toBe(false);
    await vi.waitFor(() => expect(dom.window.close).toHaveBeenCalled());
  });

  it("keeps the form retryable after a wrong password, the error under the field", async () => {
    await render("send_tx", pay, locked);
    const pwd = app.querySelector("input[type=password]");
    const unlock = button("Unlock");
    mocks.answers.DUSK_UI_UNLOCK = async () => ({ error: { message: "Incorrect password" } });

    typeInto(pwd, "wrong password");
    unlock.click();
    await vi.waitFor(() => expect(app.querySelector("#approval-unlock-error").hidden).toBe(false));
    expect(app.querySelector("#approval-unlock-error").textContent).toBe("Incorrect password");
    expect(pwd.getAttribute("aria-invalid")).toBe("true");
    expect([pwd.value, pwd.disabled, unlock.disabled, unlock.textContent]).toEqual(["", false, false, "Unlock"]);
    expect(dom.document.activeElement).toBe(pwd);

    // Typing again clears the error; the right password shows the approval.
    typeInto(pwd, "right password");
    expect(app.querySelector("#approval-unlock-error").hidden).toBe(true);
    mocks.answers.DUSK_UI_UNLOCK = async () => {
      mocks.pending = { ...mocks.pending, isUnlocked: true, accounts: [MAIN], duskNames: { [MAIN]: "alice.dusk" } };
      return { ok: true };
    };
    unlock.click();
    await vi.waitFor(() => expect(button("Approve")).toBeTruthy());
    expect(mocks.sent.filter((m) => m.type === "DUSK_UI_UNLOCK").map((m) => m.password)).toEqual(["wrong password", "right password"]);
    expect(visibleText(app.querySelector(".kv-value"))).toBe("alice.dusk · Public");
  });

  it("asks to set up a wallet that has none, with Reject beside it", async () => {
    await render("connect", {}, { hasVault: false });
    expect(title()).toBe("Set up Dusk Wallet first");
    expect(bar().querySelectorAll("button").map((b) => b.textContent)).toEqual(["Reject", "Set up wallet"]);
  });
});

describe("the request's network", () => {
  it("shows the network in the header: a transaction's own, a signature's chain, or the wallet's", async () => {
    const chip = dom.document.createElement("div");
    chip.id = "approval-network";
    chip.hidden = true;
    dom.document.body.appendChild(chip);

    await render("send_tx", { kind: "transfer", privacy: "public", to: SHOP, amount: "1", networkName: "Testnet", nodeUrl: TESTNET });
    expect([chip.textContent, chip.hidden]).toEqual(["Testnet", false]);
    await render("sign_message", { chainId: "dusk:1", messageLen: 1 }, { networkName: "Testnet" });
    expect(chip.textContent).toBe("Mainnet");
    await render("connect", { requestedProfiles: true }, { networkName: "Devnet" });
    expect(chip.textContent).toBe("Devnet");
  });

  it("says at the top that test DUSK has no value on a test network, and nothing on Mainnet", async () => {
    // The window's panel, its header first, as notification.html has it.
    const panel = dom.document.createElement("div");
    panel.className = "panel";
    const header = dom.document.createElement("div");
    header.className = "panel-header";
    panel.append(header, app);
    dom.document.body.appendChild(panel);
    const strips = () => dom.document.body.querySelectorAll(".testnet-strip");

    await render("send_tx", { kind: "transfer", privacy: "public", to: SHOP, amount: "1", networkName: "Testnet", nodeUrl: TESTNET });
    expect(strips().map((s) => s.textContent)).toEqual(["Testnet · Test DUSK has no value"]);
    expect(panel.children[0]).toBe(strips()[0]);
    // A locked wallet's window says it too.
    await render("connect", { requestedProfiles: true }, { isUnlocked: false, accounts: [], duskNames: {} });
    expect(strips()).toHaveLength(1);

    await render("sign_message", { chainId: "dusk:1", messageLen: 1 }, { networkName: "Testnet" });
    expect(strips()).toHaveLength(0);
  });
});

describe("contract-call decoding", () => {
  it("asks the background to decode token calls with serializable 0x-hex arguments", async () => {
    mocks.answers.DUSK_UI_DRC20_DECODE_INPUT = async () => ({ ok: false, error: "Not a DRC20 call" });
    mocks.answers.DUSK_UI_DRC721_DECODE_INPUT = async () => ({ ok: false, error: "Not a DRC721 call" });
    await render("send_tx", {
      kind: "contract_call",
      contractId: `0x${"11".repeat(32)}`,
      fnName: "transfer_from",
      fnArgs: [1, 2, 255],
      chainId: "dusk:2",
      nodeUrl: TESTNET,
    });
    const asks = mocks.sent.filter((m) => /DECODE_INPUT$/.test(m.type));
    expect(asks.map((m) => [m.type, m.fnArgs, m.driver ?? ""])).toEqual([
      ["DUSK_UI_DRC20_DECODE_INPUT", "0x0102ff", ""],
      ["DUSK_UI_DRC20_DECODE_INPUT", "0x0102ff", "sozu_staked_dusk"],
      ["DUSK_UI_DRC721_DECODE_INPUT", "0x0102ff", ""],
    ]);
    expect(app.querySelector(".ap-opaque")).not.toBeNull();
  });

  it("makes no driver call for a known bridge call, which the wallet reads itself", async () => {
    const claim = fixtures.calls.find((c) => c.name === "claim-account");
    await render("send_tx", { kind: "contract_call", contractId: BRIDGE_CONTRACTS.testnet.portal, fnName: claim.fnName, fnArgs: claim.args, chainId: "dusk:2", nodeUrl: TESTNET });
    expect(title()).toBe("Claim a DuskEVM withdrawal");
    expect(mocks.sent.some((m) => /DECODE_INPUT$/.test(m.type))).toBe(false);
  });
});

describe("typed-data approval", () => {
  const input = {
    origin: "https://shop.example",
    domain: { name: "Shop", version: "1", chainId: "dusk:2" },
    types: {
      DuskTypedDataDomain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "string" },
        { name: "verifyingContract", type: "bytes32" },
      ],
      Order: [
        { name: "item", type: "string" },
        { name: "quantity", type: "uint64" },
      ],
    },
    primaryType: "Order",
    message: { item: "Dusk hoodie", quantity: "2" },
  };
  const params = (over = {}) => ({ domain: input.domain, types: input.types, primaryType: input.primaryType, message: input.message, digestHex: hashTypedDataHex(input), ...over });
  const value = (label) =>
    app.querySelectorAll(".kv").find((kv) => kv.querySelector(".kv-label")?.textContent === label)?.querySelector("code")?.textContent;

  it("shows the domain, the fields and the digest-checked full request, in that order", async () => {
    await render("sign_typed_data", params());
    expect(title()).toBe("Sign typed data?");
    expect(
      ["Request from", "Domain name", "Domain version", "Chain ID", "Verifying contract", "Primary type", "item · string", "quantity · uint64"].map(value)
    ).toEqual(["https://shop.example", "Shop", "1", "dusk:2", "32 zero bytes (default)", "Order", "Dusk hoodie", "2"]);
    const summaries = app.querySelectorAll("details summary").map((s) => s.textContent);
    expect(summaries).toEqual(["Full signing request (escaped JSON)", "Digest (verify against the dApp)"]);
    expect(JSON.parse(app.querySelector("textarea").textContent)).toEqual(input);
    expect(app.querySelector(".ap-digest").textContent).toBe(hashTypedDataHex(input));
    expect(button("Sign").disabled).toBe(false);
    expect(app.textContent).not.toContain("Text needs review");
  });

  it("disables Sign but keeps Reject when the request doesn't match its digest", async () => {
    await render("sign_typed_data", params({ message: { item: "Changed after hashing", quantity: "2" } }));
    expect(app.querySelector("[role=alert]").textContent).toContain("Cannot safely disclose the full signing request");
    expect(button("Sign").disabled).toBe(true);
    expect(app.querySelector("textarea")).toBeNull();
    button("Reject").click();
    await settle();
    expect(mocks.sent).toContainEqual({ type: "DUSK_PENDING_DECISION", rid: "r1", decision: "reject" });
  });

  it("flags text that needs review", async () => {
    const tricky = { ...input, message: { item: "Dusk‮hoodie", quantity: "2" } };
    await render("sign_typed_data", { ...params(), message: tricky.message, digestHex: hashTypedDataHex(tricky) });
    expect(app.querySelector(".callout.warn .callout-title").textContent).toBe("Text needs review");
  });
});

describe("decisions", () => {
  it("says so when an answer doesn't reach the wallet, and stays open to try again", async () => {
    // Firefox's runtime rejects when the background is gone.
    mocks.answers.DUSK_PENDING_DECISION = async () => {
      throw new Error("Receiving end does not exist.");
    };
    const failed = "Couldn't send your answer to the wallet: Receiving end does not exist.";
    await render("connect", { requestedProfiles: true });
    const error = () => bar().querySelector(".ap-actions__error");
    button("Connect").click();
    await vi.waitFor(() => expect(error().hidden).toBe(false));
    expect(error().textContent).toBe(failed);
    button("Reject").click();
    await settle();
    expect(error().textContent).toBe(failed);
    expect(dom.window.close).not.toHaveBeenCalled();

    // Locked, Reject says it under the password.
    await render("connect", { requestedProfiles: true }, { isUnlocked: false, accounts: [], duskNames: {} });
    button("Reject").click();
    await vi.waitFor(() => expect(app.querySelector("#approval-unlock-error").hidden).toBe(false));
    expect(app.querySelector("#approval-unlock-error").textContent).toBe(failed);
  });

  it("sends the approval with what the window collected, then closes", async () => {
    await render("connect", { requestedProfiles: true });
    button("Connect").click();
    await vi.waitFor(() =>
      expect(mocks.sent).toContainEqual({
        type: "DUSK_PENDING_DECISION",
        rid: "r1",
        decision: "approve",
        approvedParams: { accountIndex: 0, shieldedReceiveAddress: false },
      })
    );
    await vi.waitFor(() => expect(dom.window.close).toHaveBeenCalled());
  });

  it("says a request that's gone is gone", async () => {
    mocks.pending = null;
    const { renderNotification } = await import("./notification/app.js");
    await renderNotification();
    expect(app.querySelector(".err").textContent).toBe("This request is no longer waiting: it was handled or it expired. You can close this window.");
    expect(bar().hidden).toBe(true);
  });
});
