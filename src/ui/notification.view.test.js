import { readFile } from "node:fs/promises";
import path from "node:path";
import { hashTypedDataHex } from "@dusk/typed-data";
import { dataDrivers } from "@dusk/w3sper";
import { decodeBase58, encodeBase58 } from "@duskdomains/sdk";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { networks, routes } from "@dusk-network/networks";
import { duskEvmContracts } from "@dusk-network/networks/duskevm";

import { bridgeServiceLine, bridgeServiceTransfer, bridgeServiceWarnings } from "../shared/bridgeCalls.js";
import { bytesToHex, toBytes } from "../shared/bytes.js";
import { readDrc20Call } from "../shared/drc20Calls.js";
import { blockedRecipient } from "../shared/recipientBlocklist.js";
import { describeSignMessagePreview } from "../shared/signMessagePreview.js";
import fixtures from "../shared/fixtures/duskevm-bridge-calls.json";
import { numbersText } from "./components/SafeText.js";
import { SWITCH_NODE_FACT } from "./notification/summary.js";
import { shortAddress } from "./lib/strings.js";
import { fakeEvent, installFakeDom, isShown, pastClickGuard, screenReaderText, settle, typeInto, visibleText } from "./testing/fakeDom.js";

const mocks = vi.hoisted(() => ({ pending: null, sent: [], answers: {}, heard: [] }));

vi.mock("./components/GasEditor.js", () => ({}));
vi.mock("../platform/extensionApi.js", () => ({
  // What the wallet tells its pages, as the approval's window hears it.
  getExtensionApi: () => ({ runtime: { onMessage: { addListener: (fn) => mocks.heard.push(fn) } } }),
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
  mocks.heard = [];
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
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
const approve = () => bar().querySelector(".btn-primary");
const head = () => app.querySelector(".ap-head");
const decision = (decision) => mocks.sent.find((m) => m.type === "DUSK_PENDING_DECISION" && m.decision === decision);

const TESTNET = "https://testnet.nodes.dusk.network";

// A figure exactly as written: not inside a longer number, not signed or bounded unless written so, and not followed by
// more digits, letters or a decimal part (1.0025 ≠ 11.0025, 0.005 ≠ −0.005, 2,000,000 ≠ 2,000,000.5, BNB ≠ BNBX).
const exactly = (text) => new RegExp(`(?<![\\d.,+\\-−<>≤≥~])(?<![+\\-−<>≤≥~]\\s)${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\dA-Za-z]|[.,]\\d)`);

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

describe("a request the wallet stopped for, as Firefox for Android stops it while Firefox is away", () => {
  it("says it isn't waiting any more when Approve finds it gone: never a dead Approve that closes on nothing", async () => {
    await render("send_tx", transfer(BOB));
    mocks.answers.DUSK_PENDING_DECISION = () => ({ ok: false, error: "Unknown request" });
    pastClickGuard();
    approve().click();
    // No Approve left to press, and the window stays to say so.
    await vi.waitFor(() => expect(bar()?.querySelector(".btn-primary") ?? null).toBeNull());
    expect(dom.window.close).not.toHaveBeenCalled();
  });

  it("takes the answer once its site has asked again, the wallet picking the request up meanwhile", async () => {
    await render("connect", { requestedProfiles: true });
    let tries = 0;
    mocks.answers.DUSK_PENDING_DECISION = () => (++tries < 3 ? { ok: false, error: { code: "waking", message: "The wallet is picking this request up again." } } : { ok: true });
    pastClickGuard();
    approve().click();
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    await vi.advanceTimersByTimeAsync(3_000);
    expect([tries, dom.window.close.mock.calls.length]).toEqual([3, 1]);
  });

  it("ends it for good when its site never asks again, so nothing takes it up later, and says so", async () => {
    await render("send_tx", transfer(BOB));
    mocks.answers.DUSK_PENDING_DECISION = (msg) => (msg.decision === "abandon" ? { ok: true } : { ok: false, error: { code: "waking", message: "The wallet is picking this request up again." } });
    pastClickGuard();
    approve().click();
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(decision("abandon")).toBeTruthy();
    expect(bar()?.querySelector(".btn-primary") ?? null).toBeNull();
  });

  it("says plainly that nothing went when the wallet couldn't note the approval, with nothing left to press", async () => {
    await render("connect", { requestedProfiles: true });
    mocks.answers.DUSK_PENDING_DECISION = () => ({ ok: false, error: { code: "ended", message: "The wallet couldn't note your approval, so nothing was signed or sent. Ask the site again." } });
    pastClickGuard();
    approve().click();
    await vi.waitFor(() => expect(visibleText(app)).toContain("The wallet couldn't note your approval, so nothing was signed or sent."));
    expect(dom.window.close).not.toHaveBeenCalled();
    expect(bar()?.querySelector(".btn-primary") ?? null).toBeNull();
  });

  it("rejects it with the phone's Back, once a press that counts put up its entry", async () => {
    vi.stubGlobal("navigator", { ...globalThis.navigator, userAgent: "Mozilla/5.0 (Android 15; Mobile; rv:144.0) Gecko/144.0 Firefox/159.0" });
    const pushState = vi.fn();
    dom.window.history = { pushState };
    await render("connect", { requestedProfiles: true });
    // Not as a finger lands: Firefox for Android marks the press after, and skips the entry.
    dom.document.dispatchEvent(fakeEvent("pointerdown"));
    expect(pushState).not.toHaveBeenCalled();
    dom.document.dispatchEvent(fakeEvent("click"));
    expect(pushState).toHaveBeenCalledTimes(1);
    dom.window.dispatchEvent(fakeEvent("popstate"));
    await vi.waitFor(() => expect(decision("reject")).toBeTruthy());
  });

  // Marek's and Amélie's: the first Back on a fresh approval left it waiting in a hidden tab.
  it("rejects it with the phone's first Back, no press needed, from the entry the wallet put under it", async () => {
    vi.stubGlobal("navigator", { ...globalThis.navigator, userAgent: "Mozilla/5.0 (Android 15; Mobile; rv:144.0) Gecko/144.0 Firefox/159.0" });
    const pushState = vi.fn();
    dom.window.history = { pushState };
    await render("connect", { requestedProfiles: true });
    // Drawn, it tells the wallet, which puts up "#back" under it.
    expect(mocks.sent).toContainEqual({ type: "DUSK_APPROVAL_SHOWN", rid: "r1", asked: expect.any(String) });
    globalThis.location.hash = "#back";
    dom.window.dispatchEvent(fakeEvent("popstate"));
    // A press now puts up nothing more: one Back answers.
    dom.document.dispatchEvent(fakeEvent("click"));
    expect(pushState).not.toHaveBeenCalled();
    expect(decision("reject")).toBeUndefined();
    globalThis.location.hash = "";
    dom.window.dispatchEvent(fakeEvent("popstate"));
    await vi.waitFor(() => expect(decision("reject")).toBeTruthy());
  });
});

describe("a site's send while offline", () => {
  // Marek's: approved offline, it closed as if done, and nothing went.
  it("says so and holds Approve until the connection is back", async () => {
    vi.stubGlobal("navigator", { ...globalThis.navigator, onLine: false });
    await render("send_tx", transfer(BOB));
    const offline = () => bar().querySelectorAll(".offline-note").filter(isShown).map((n) => n.textContent);
    expect(approve().disabled).toBe(true);
    expect(offline()).toHaveLength(1);
    vi.stubGlobal("navigator", { ...globalThis.navigator, onLine: true });
    dom.window.dispatchEvent(fakeEvent("online"));
    expect(approve().disabled).toBe(false);
    expect(offline()).toEqual([]);
  });

  it("asks nothing of a connection, which sends nothing", async () => {
    vi.stubGlobal("navigator", { ...globalThis.navigator, onLine: false });
    await render("connect", { requestedProfiles: true });
    expect(bar().querySelectorAll(".offline-note")).toEqual([]);
    pastClickGuard();
    approve().click();
    await vi.waitFor(() => expect(decision("approve")).toBeTruthy());
  });
});

describe("connect approval", () => {
  it("says how long it stays connected, as Settings has it", async () => {
    // The line under what the site sees, which says for how long.
    const seesLine = () => visibleText(app.querySelectorAll(".ap-facts .list-row")[0].querySelector(".row-sub"));
    // A day, as a day; a week, as 7 days: never 17, or a day for a week.
    await render("connect", { requestedProfiles: true, lastsMs: 86_400_000 });
    expect(seesLine()).toMatch(/\bfor a day\b/i);
    expect(seesLine()).not.toMatch(/\bdays\b/);
    await render("connect", { requestedProfiles: true, lastsMs: 7 * 86_400_000 });
    expect(seesLine()).toMatch(exactly("7 days"));
    // Connected already: until when, as it goes on, in UTC here.
    const zone = process.env.TZ;
    process.env.TZ = "UTC";
    try {
      const end = Date.UTC(2031, 0, 15, 12);
      await render("connect", { requestedProfiles: true, stays: true, lastsMs: 7 * 86_400_000, endsAt: end }, { permissionAccountIndex: 0 });
      expect(seesLine()).toContain("Wed 15 Jan 2031, 12:00 UTC");
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
    await render("connect", { requestedProfiles: true, stays: true, lastsMs: 7 * 86_400_000, endsAt: 0 }, { permissionAccountIndex: 0 });
    // Until it's disconnected: no date, nor a number of days.
    expect(seesLine()).not.toContain("2031");
    expect(seesLine()).not.toMatch(/\bdays?\b/);
    expect(seesLine()).toMatch(/until you disconnect/i);
  });

  // The copy audit's: a site's first connection looked like any other's, only its address said which it was.
  it("says when a site was never connected here, and never of one that was", async () => {
    const firstTime = /You haven't connected this site before/i;
    for (const params of [
      { requestedProfiles: true, firstConnection: true },
      { requestedProfiles: true, firstConnection: true, shieldedReceiveAddress: true },
    ]) {
      await render("connect", params);
      expect(visibleText(head())).toMatch(firstTime);
    }
    for (const params of [{ requestedProfiles: true, firstConnection: false }, { requestedProfiles: true }, { shieldedReceiveAddress: true, currentAccountIndex: 0 }]) {
      await render("connect", params);
      expect(visibleText(app)).not.toMatch(firstTime);
    }
  });

  it("says what the site sees: the public account, and the shielded address only where it asks for it", async () => {
    const facts = () => app.querySelectorAll(".ap-facts .row-title").map((t) => t.textContent).join("\n");
    // A connection alone: the public account, nothing of the shielded address.
    await render("connect", { requestedProfiles: true });
    expect(facts()).toMatch(/public/i);
    expect(facts()).not.toMatch(/shielded/i);
    // It can't move funds without your approval: said, and never the other way.
    expect(facts()).toMatch(/without your approval/i);
    expect(facts()).not.toMatch(/\bcan move\b/i);
    // The shielded address, asked for by a site connected already: that alone is new.
    await render("connect", { requestedProfiles: true, shieldedReceiveAddress: true, currentAccountIndex: 0, currentGrants: {} });
    expect(facts()).toMatch(/shielded/i);
    expect(facts()).not.toMatch(/public/i);
    // A site not connected yet asking for both: both.
    await render("connect", { requestedProfiles: true, shieldedReceiveAddress: true, currentAccountIndex: null }, { permissionAccountIndex: null });
    expect(facts()).toMatch(/public/i);
    expect(facts()).toMatch(/shielded/i);
  });

  it("picks the connected profile with native radios and connects the one picked", async () => {
    await render("connect", { requestedProfiles: true }, { permissionAccountIndex: 1 });

    const radios = app.querySelectorAll(".profile-option input");
    expect(radios.map((radio) => radio.value)).toEqual(["0", "1"]);
    // The one connected already starts picked.
    expect(radios.map((radio) => radio.checked)).toEqual([false, true]);

    // Arrow keys or a click check the other radio, which reports a change.
    radios[0].checked = true;
    radios[0].dispatchEvent(fakeEvent("change"));
    expect(radios.map((radio) => radio.checked)).toEqual([true, false]);

    pastClickGuard();
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

  it("grants the shielded address a site asks for on Approve, connected already or not", async () => {
    // A connected site asks for more.
    await render("connect", { requestedProfiles: true, shieldedReceiveAddress: true, currentAccountIndex: 0, currentGrants: {} });
    pastClickGuard();
    approve().click();
    await vi.waitFor(() => expect(decision("approve")?.approvedParams).toEqual({ accountIndex: 0, shieldedReceiveAddress: true }));

    // A site that isn't connected yet asks for both.
    mocks.sent = [];
    await render("connect", { requestedProfiles: true, shieldedReceiveAddress: true, currentAccountIndex: null }, { permissionAccountIndex: null });
    pastClickGuard();
    approve().click();
    await vi.waitFor(() => expect(decision("approve")?.approvedParams).toEqual({ accountIndex: 0, shieldedReceiveAddress: true }));
  });

  it("keeps the shielded address with the profile that has the grant", async () => {
    await render(
      "connect",
      { requestedProfiles: true, currentAccountIndex: 1, currentGrants: { shieldedReceiveAddress: true } },
      { permissionAccountIndex: 1 }
    );
    const facts = () => app.querySelectorAll(".ap-facts .row-title").map((t) => t.textContent).join("\n");
    expect(facts()).toMatch(/shielded/i);

    // Another profile: its facts go without the shielded address.
    const radio = app.querySelectorAll(".profile-option input")[0];
    radio.checked = true;
    radio.dispatchEvent(fakeEvent("change"));
    expect(facts()).not.toMatch(/shielded/i);
    expect(facts()).toMatch(/public/i);
    pastClickGuard();
    approve().click();
    await vi.waitFor(() => expect(decision("approve")?.approvedParams).toEqual({ accountIndex: 0, shieldedReceiveAddress: false }));
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
    expect(row("Message hash").textContent).toContain(`0x${"ab".repeat(5)}…${"ab".repeat(4)}`);
    expect(row("Message hash").textContent).toMatch(exactly("25 bytes"));
    // The chain sits under Details.
    expect(app.querySelector("details").textContent).toContain("dusk:2");
  });

  it("says bytes that aren't text are bytes", async () => {
    await render("sign_message", { chainId: "dusk:2", messageLen: 3, messagePreview: { kind: "opaque", reason: "invalid_utf8" } });
    // Shown as 3 bytes, not as text.
    expect(app.querySelector(".ap-message").classList.contains("ap-message--bytes")).toBe(true);
    expect(visibleText(app.querySelector(".ap-message__title"))).toMatch(exactly("3"));
  });

  it("shows the account alone, in full, while no checked name is known", async () => {
    await render("sign_auth", { chainId: "dusk:2", nonce: "n-1" }, { duskNames: {} });
    const account = row("Account");
    expect(account.querySelector(".dusk-name")).toBeNull();
    expect(visibleText(account)).toBe(MAIN);
  });

  it("says when a sign-in expires, with the time zone", async () => {
    const zone = process.env.TZ;
    process.env.TZ = "Europe/Amsterdam";
    try {
      await render("sign_auth", { chainId: "dusk:2", nonce: "n-1", expiresAt: "2026-10-26T12:22:00Z" });
      expect(visibleText(row("Expires"))).toBe("Mon 26 Oct 2026, 13:22 CET");
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });
});

describe("the password on big sends", () => {
  const LIMIT = "5000000000";
  const big = (over = {}) => transfer(BOB, { amount: "6000000000", gas: { limit: "2500000", price: "1" }, ...over });
  const field = () => bar().querySelector("#approval-send-password");
  const asked = () => isShown(bar().querySelector(".ap-send-password"));
  const passwordError = () => {
    const shown = bar().querySelector(".ap-send-password .field-error");
    return isShown(shown) ? shown.textContent : "";
  };
  const askedOf = (over = {}) => ({ sendPassword: { limit: LIMIT, moves: "6000000000", always: false, ...over } });

  it("asks in the bar with Approve, above the amount chosen, saying why, and sends what's typed to the wallet", async () => {
    await render("send_tx", big(), askedOf());
    expect(asked()).toBe(true);
    // Why: the amount set in Settings.
    expect(visibleText(bar().querySelector(".ap-send-password"))).toMatch(exactly("5 DUSK"));
    pastClickGuard();
    // Nothing typed: it says so, and asks the wallet nothing.
    approve().click();
    await settle();
    expect(decision("approve")).toBeUndefined();
    expect(passwordError()).not.toBe("");

    typeInto(field(), "the password");
    approve().click();
    await settle();
    expect(decision("approve").sendPassword).toBe("the password");
    expect(dom.window.close).toHaveBeenCalled();
  });

  it("stays open on a wrong password, says so, and takes another", async () => {
    await render("send_tx", big(), askedOf());
    mocks.answers.DUSK_PENDING_DECISION = () => ({ ok: false, error: { message: "Incorrect password" } });
    pastClickGuard();
    typeInto(field(), "not it");
    approve().click();
    await settle();
    expect(passwordError()).not.toBe("");
    expect(field().value).toBe("");
    expect(dom.window.close).not.toHaveBeenCalled();
    expect(approve().disabled).toBe(false);

    mocks.answers.DUSK_PENDING_DECISION = () => ({ ok: false, error: { message: "Too many attempts. Try again in 4s." } });
    typeInto(field(), "not it either");
    expect(passwordError()).toBe("");
    approve().click();
    await settle();
    expect(passwordError()).toBe("Too many attempts. Try again in 4s.");

    mocks.answers.DUSK_PENDING_DECISION = () => ({ ok: true });
    typeInto(field(), "the password");
    approve().click();
    await settle();
    expect(dom.window.close).toHaveBeenCalled();
  });

  it("asks nothing up to the amount, and nothing with it off", async () => {
    await render("send_tx", big({ amount: "1000000000" }), askedOf({ moves: "1000000000" }));
    expect(asked()).toBe(false);
    pastClickGuard();
    approve().click();
    await settle();
    expect(decision("approve").sendPassword).toBeUndefined();
    expect(dom.window.close).toHaveBeenCalled();

    await render("send_tx", big(), { sendPassword: null });
    expect(asked()).toBe(false);
  });

  it("follows the fee as it's changed: past the amount it asks, and back under it doesn't", async () => {
    await render("send_tx", big({ amount: "5000000000", gas: { limit: "1", price: "1" } }), askedOf({ moves: "5000000000" }));
    expect(asked()).toBe(true);
    await render("send_tx", big({ amount: "4000000000" }), askedOf({ moves: "4000000000" }));
    expect(asked()).toBe(false);
    const editor = app.querySelector("dusk-gas-editor");
    editor.dispatchEvent(new CustomEvent("dusk-gas-fee", { bubbles: true, detail: { feeLux: 2_000_000_000n } }));
    expect(asked()).toBe(true);
    typeInto(field(), "typed");
    editor.dispatchEvent(new CustomEvent("dusk-gas-fee", { bubbles: true, detail: { feeLux: 1n } }));
    expect(asked()).toBe(false);
    expect(field().value).toBe("");
  });

  it("says so of a call it can't count in DUSK, whatever the amount", async () => {
    await render("send_tx", { kind: "contract_call", privacy: "public", contractId: `0x${"ab".repeat(32)}`, fnName: "do_something", fnArgs: "0x00", amount: "0", deposit: "0", chainId: "dusk:2", nodeUrl: TESTNET, networkName: "Testnet", gas: { limit: "1", price: "1" } }, askedOf({ moves: "0", always: true }));
    expect(asked()).toBe(true);
  });

  it("asks once the wallet says it must, turned on since the window opened", async () => {
    await render("send_tx", big(), { sendPassword: null });
    expect(asked()).toBe(false);
    mocks.answers.DUSK_PENDING_DECISION = () => ({ ok: false, error: { message: "It waits for your password, so nothing was sent.", data: { sendPassword: { limit: LIMIT, moves: "6000000000", always: false } } } });
    pastClickGuard();
    approve().click();
    await settle();
    expect(asked()).toBe(true);
    expect(passwordError()).not.toBe("");
    expect(dom.window.close).not.toHaveBeenCalled();
  });

  it("rejects with nothing typed, in every window", async () => {
    await render("send_tx", big(), askedOf());
    bar().querySelector(".btn-outline").click();
    await settle();
    expect(decision("reject")).toBeTruthy();
    expect(decision("reject").sendPassword).toBeUndefined();
    expect(dom.window.close).toHaveBeenCalled();
  });

  it("asks nothing of a request that moves nothing", async () => {
    await render("connect", {}, { sendPassword: null });
    expect(bar().querySelector(".ap-send-password")).not.toBeNull();
    expect(asked()).toBe(false);
  });
});

describe("text that reads as something it isn't", () => {
  const [RLO, POP] = [0x202e, 0x202c].map((c) => String.fromCodePoint(c));
  const signRequest = () => {
    const bytes = new TextEncoder().encode(`I agree to pay ${RLO}0001${POP} DUSK`);
    return { chainId: "dusk:2", messageHash: `0x${"ab".repeat(32)}`, messageLen: bytes.length, messagePreview: describeSignMessagePreview(bytes) };
  };

  it("shows a message to sign in the order its bytes say, and flags it", async () => {
    await render("sign_message", signRequest());
    expect(app.querySelector(".ap-message").textContent).toBe("I agree to pay \\u202e0001\\u202c DUSK");
    expect(visibleText(app)).not.toContain(RLO);
    expect(app.querySelector(".callout.warn")).not.toBeNull();
  });

  it("says when a number may not read as its digits do, in a message to sign and a memo, and nothing of hidden characters", async () => {
    // Marek's: N'Ko's 0001 shows as "߁000", and an Arabic-Indic zero makes 105 look like 1·5.
    const bytes = new TextEncoder().encode("Pay \u07c0\u07c0\u07c0\u07c1 DUSK");
    await render("sign_message", { chainId: "dusk:2", messageHash: `0x${"ab".repeat(32)}`, messageLen: bytes.length, messagePreview: describeSignMessagePreview(bytes) });
    // Which check it asks for, in the words the wallet uses for it.
    expect(app.querySelector(".callout.warn .muted").textContent).toContain(numbersText({ rtlDigits: true }));

    await render("send_tx", transfer(BOB, { memo: "Invoice \u07c0\u07c0\u07c0\u07c1 paid 1\u06605" }));
    const flags = [...row("Memo").querySelectorAll(".safe-text__flag")].map((el) => el.textContent);
    expect(flags).toEqual([numbersText({ mixedDigits: true, rtlDigits: true })]);

    await render("sign_auth", { chainId: "dusk:2", nonce: "n1", statement: "Pay 1\u06605 DUSK" });
    expect(app.querySelector(".callout.warn .muted").textContent).toContain(numbersText({ mixedDigits: true }));
    expect(app.querySelector(".callout.warn .muted").textContent).not.toContain(numbersText({ mixedDigits: true, rtlDigits: true }));
  });

  it("says when a number's digits look like other digits, in a message to sign and a memo, in the web wallet's words", async () => {
    // Marek's: Bengali's 4 looks like 8, Gurmukhi's 44 like 88, Oriya's 2 and Malayalam's 7 like 9.
    const lookalike = numbersText({ lookalikeDigits: true });
    expect(lookalike).not.toBe("");
    for (const message of ["Pay \u09ea DUSK to unlock", "Pay \u0a6a\u0a6a DUSK", "Pay \u0b68 DUSK", "Pay \u0d6d DUSK"]) {
      const bytes = new TextEncoder().encode(message);
      await render("sign_message", { chainId: "dusk:2", messageHash: `0x${"ab".repeat(32)}`, messageLen: bytes.length, messagePreview: describeSignMessagePreview(bytes) });
      expect(app.querySelector(".callout.warn .muted").textContent, message).toContain(lookalike);
    }

    await render("send_tx", transfer(BOB, { memo: "Factura \u09ea, or 1\u06605" }));
    expect([...row("Memo").querySelectorAll(".safe-text__flag")].map((el) => el.textContent)).toEqual([numbersText({ mixedDigits: true, lookalikeDigits: true })]);
    await render("sign_auth", { chainId: "dusk:2", nonce: "n1", statement: "Pay \u09ea DUSK" });
    expect(app.querySelector(".callout.warn .muted").textContent).toContain(lookalike);
  });

  it("shows it so before the wallet is unlocked too", async () => {
    await render("sign_message", signRequest(), { isUnlocked: false, accounts: [], duskNames: {} });
    expect(visibleText(head())).toContain("I agree to pay \\u202e0001\\u202c DUSK");
    expect(visibleText(app)).not.toContain(RLO);
  });

  it("flags no plain message, line breaks and all", async () => {
    const bytes = new TextEncoder().encode("Sign in to the shop\nNonce: 12");
    await render("sign_message", { chainId: "dusk:2", messageHash: `0x${"ab".repeat(32)}`, messageLen: bytes.length, messagePreview: describeSignMessagePreview(bytes) });
    expect(app.querySelector(".ap-message").textContent).toBe("Sign in to the shop\nNonce: 12");
    expect(app.querySelector(".callout.warn")).toBeNull();
  });

  it("neutralizes and flags a site's statement and nonce on a sign-in", async () => {
    await render("sign_auth", { chainId: "dusk:2", nonce: `n${RLO}1`, statement: `Pay ${RLO}0001${POP}` });
    expect(app.querySelector(".ap-message").textContent).toBe("Pay \\u202e0001\\u202c");
    expect(row("Nonce").textContent).toBe("n\\u202e1");
    expect(visibleText(app)).not.toContain(RLO);
    expect(app.querySelector(".callout.warn")).not.toBeNull();
  });

  it("neutralizes and flags a memo in a request to pay, and approves it as the site sent it", async () => {
    const memo = `${RLO}gnp.exe claim your airdrop https://evil.example`;
    await render("send_tx", transfer(BOB, { memo, gas: { limit: "2500000", price: "1" } }));
    expect(visibleText(app)).not.toContain(RLO);
    expect(row("Memo").querySelector(".safe-text > span").textContent).toBe("\\u202egnp.exe claim your airdrop https://evil.example");
    expect(row("Memo").querySelector(".safe-text__flag")).not.toBeNull();
    pastClickGuard();
    approve().click();
    await settle();
    // The window only answers: the memo sent is the request's, untouched.
    expect(decision("approve").approvedParams ?? null).toBeNull();
    expect(mocks.pending.params.memo).toBe(memo);
  });

  it("shows a call's function as a memo is: what reorders it as its code, and flagged", async () => {
    await render("send_tx", {
      kind: "contract_call",
      privacy: "public",
      contractId: `0x${"11".repeat(32)}`,
      fnName: `pay${RLO}evol_ot${POP}`,
      fnArgs: "0x00",
      chainId: "dusk:2",
      nodeUrl: TESTNET,
    });
    expect(row("Method").querySelector(".safe-text > span").textContent).toBe("pay\\u202eevol_ot\\u202c");
    expect(row("Method").querySelector(".safe-text__flag")).not.toBeNull();
    expect(visibleText(app)).not.toContain(RLO);
  });

  it("shows a message and a memo with right-to-left words in the order of their bytes", async () => {
    const [line, open, close] = ["\u2066", "\u2068", "\u2069"];
    const bytes = new TextEncoder().encode("Pay \u05d0 10 \u05d0 1000 \u05d0 DUSK");
    await render("sign_message", { chainId: "dusk:2", messageHash: `0x${"ab".repeat(32)}`, messageLen: bytes.length, messagePreview: describeSignMessagePreview(bytes) });
    // Each word set apart, so neither number moves: nothing's hidden, nothing to flag.
    expect(app.querySelector(".ap-message").textContent).toBe(`${line}Pay ${open}\u05d0${close} 10 ${open}\u05d0${close} 1000 ${open}\u05d0${close} DUSK${close}`);
    expect(app.querySelector(".callout.warn")).toBeNull();

    await render("send_tx", transfer(BOB, { memo: "=HYPERLINK(1) pay \u05d0 10 \u05d0 1000" }));
    expect(row("Memo").querySelector(".safe-text > span").textContent).toBe(`${line}=HYPERLINK(1) pay ${open}\u05d0${close} 10 ${open}\u05d0${close} 1000${close}`);
  });

  it("says when a message goes on past its box, for as long as there's more below", async () => {
    const bytes = new TextEncoder().encode(`Login to site${"\n".repeat(60)}I transfer all funds`);
    await render("sign_message", { chainId: "dusk:2", messageHash: `0x${"ab".repeat(32)}`, messageLen: bytes.length, messagePreview: describeSignMessagePreview(bytes) });
    const box = app.querySelector(".ap-message");
    const goesOn = () => {
      const line = app.querySelector(".ap-goes-on");
      return isShown(line) ? line.textContent : "";
    };
    // As the window lays it out: 1,326 px of text in a box of 180.
    Object.assign(box, { scrollHeight: 1326, clientHeight: 180, scrollTop: 0 });
    dom.window.dispatchEvent(fakeEvent("resize"));
    expect(goesOn()).not.toBe("");
    // Read to the end, it has nothing more to say.
    box.scrollTop = 1146;
    box.dispatchEvent(fakeEvent("scroll"));
    expect(goesOn()).toBe("");

    // A message that fits says nothing.
    const short = new TextEncoder().encode("Sign in to the shop");
    await render("sign_message", { chainId: "dusk:2", messageHash: `0x${"ab".repeat(32)}`, messageLen: short.length, messagePreview: describeSignMessagePreview(short) });
    Object.assign(app.querySelector(".ap-message"), { scrollHeight: 45, clientHeight: 45, scrollTop: 0 });
    dom.window.dispatchEvent(fakeEvent("resize"));
    expect(goesOn()).toBe("");
  });

  it("leaves a plain memo as it is, and neutralizes what a site writes about itself", async () => {
    await render("send_tx", transfer(BOB, { memo: "Order 1042" }));
    expect(row("Memo").textContent).toBe("Order 1042");
    expect(row("Memo").querySelector(".safe-text__flag")).toBeNull();

    await render("send_tx", {
      kind: "contract_call",
      privacy: "public",
      contractId: `0x${"ab".repeat(32)}`,
      fnName: "call",
      fnArgs: "0x00",
      display: { title: `Pay ${RLO}0001` },
      chainId: "dusk:2",
      nodeUrl: TESTNET,
      networkName: "Testnet",
    });
    expect(app.querySelector(".ap-site-details pre").textContent).toContain("Pay \\u202e0001");
    expect(visibleText(app)).not.toContain(RLO);
  });
});

describe("a site's request with more than one wallet", () => {
  const two = { walletName: "Wallet 2" };

  it("names the wallet it's bound to beside the paying or signing profile", async () => {
    await render("send_tx", transfer(BOB), two);
    expect(visibleText(row("From"))).toContain("Wallet 2");
    expect(visibleText(row("From"))).toContain("alice.dusk");
    await render("send_tx", transfer(ADDRESS, { privacy: "shielded" }), two);
    expect(visibleText(row("From"))).toContain("Wallet 2");
    const deposit = fixtures.calls.find((c) => c.name === "deposit-shoot");
    await render("send_tx", { kind: "contract_call", contractId: duskEvmContracts(2).bridge, fnName: deposit.fnName, fnArgs: deposit.args, deposit: deposit.expected.amountLux, chainId: "dusk:2", nodeUrl: TESTNET }, two);
    expect(visibleText(row("From"))).toContain("Wallet 2");
    expect(visibleText(row("From"))).toContain("alice.dusk");

    await render("sign_message", { chainId: "dusk:2", messageLen: 2, messagePreview: { kind: "text", text: "hi", truncated: false } }, two);
    expect(visibleText(row("Account"))).toContain("Wallet 2");
    expect(visibleText(row("Account"))).toContain(shortAddress(MAIN));
    await render("sign_auth", { chainId: "dusk:2", nonce: "n-1" }, { ...two, duskNames: {} });
    expect(visibleText(row("Account"))).toContain("Wallet 2");
    expect(visibleText(row("Account"))).toContain(MAIN);

    await render("connect", { requestedProfiles: true }, two);
    const group = app.querySelector("[role=radiogroup]");
    expect(app.querySelector(`#${group.getAttribute("aria-labelledby")}`).textContent).toContain("Wallet 2");
    await render("connect", { requestedProfiles: true }, { ...two, accounts: [MAIN], accountCount: 1 });
    expect(app.querySelector(".ap-profiles .ap-section").textContent).toContain("Wallet 2");
  });

  it("names no wallet with one", async () => {
    await render("send_tx", transfer(BOB), { walletName: "" });
    expect(visibleText(row("From"))).toContain("alice.dusk");
    expect(visibleText(row("From"))).not.toMatch(/wallet/i);
    await render("sign_message", { chainId: "dusk:2", messageLen: 2, messagePreview: { kind: "text", text: "hi", truncated: false } });
    expectNamedAccount(row("Account"), "alice.dusk", MAIN);
  });
});

describe("a site's request to pay", () => {
  it("says why it won't pay a recipient the network's file blocks, as the web wallet does, and offers only Reject", async () => {
    const { account } = networks.testnet.display.blocklist.find((entry) => entry.reason === "scam");
    await render("send_tx", transfer(account));
    // Why, as the network's file gives it.
    expect(visibleText(app.querySelector(".callout.warn"))).toContain(blockedRecipient(account));
    expect(approve().disabled).toBe(true);
    approve().click();
    await settle();
    expect(decision("approve")).toBeUndefined();

    // Anyone else's request has none, and can be approved.
    await render("send_tx", transfer(BOB));
    expect(app.querySelector(".callout.warn")).toBeNull();
    expect(approve().disabled).toBe(false);
  });

  it("shows the amount it pays; the chain and node sit under Details", async () => {
    await render("send_tx", transfer(BOB, { amount: "1500000000", memo: "Order 1042" }));

    expect(visibleText(head().querySelector(".ap-amount"))).toBe("1.5 DUSK");
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
  // the profile's verified name. A shielded one: nothing.
  it.each([
    ["with a memo, under its verified name", transfer(BOB, { memo: "Order 1042" }), {}, { memo: true, name: true }],
    ["without a memo, under its verified name", transfer(BOB), {}, { memo: false, name: true }],
    ["with a memo, for a profile without a name", transfer(BOB, { memo: "Order 1042" }), { duskNames: {} }, { memo: true, name: false }],
    ["without a memo, for a profile without a name", transfer(BOB), { duskNames: {} }, { memo: false, name: false }],
    ["for a shielded transfer", transfer(ADDRESS, { privacy: "shielded", memo: "Order 1042" }), {}, null],
  ])("says what becomes visible to everyone %s", async (_label, params, over, shows) => {
    await render("send_tx", params, over);
    const line = app.querySelector(".ap-visible")?.textContent ?? null;
    if (!shows) {
      expect(line).toBeNull();
      return;
    }
    expect(line).not.toBeNull();
    expect(/memo/i.test(line)).toBe(shows.memo);
    expect(line.includes("alice.dusk")).toBe(shows.name);
  });

  it("says what becomes visible on a payment, as Send does, and on no other call", async () => {
    const deposit = fixtures.calls.find((c) => c.name === "deposit-shoot");
    for (const params of [
      transfer(BOB, { memo: "Order 1042" }),
      transfer(routes(networks.testnet).find((route) => route.kind === "service").account, { memo: deposit.expected.to }),
    ]) {
      await render("send_tx", params);
      expect(app.querySelector(".ap-visible"), params.to).not.toBeNull();
    }
    for (const params of [
      { kind: "contract_call", contractId: duskEvmContracts(2).bridge, fnName: deposit.fnName, fnArgs: deposit.args, deposit: deposit.expected.amountLux, chainId: "dusk:2", nodeUrl: TESTNET },
      { kind: "contract_call", privacy: "public", contractId: `0x${"11".repeat(32)}`, fnName: "x", fnArgs: "0x00", deposit: "5", nodeUrl: TESTNET },
    ]) {
      await render("send_tx", params);
      expect(app.querySelector(".ap-visible"), params.fnName).toBeNull();
    }
  });

  it("names the paying profile and the rail in plain words", async () => {
    await render("send_tx", transfer(BOB));
    const pays = visibleText(row("From"));
    expect(pays).toContain("alice.dusk");
    expect(pays).toMatch(/public/i);
    await render("send_tx", transfer(ADDRESS, { privacy: "shielded" }));
    expect(visibleText(row("From"))).toMatch(/shielded/i);
    expect(visibleText(row("From"))).not.toContain("alice.dusk");
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
    pastClickGuard();
    approve().click();
    await settle();
    const error = bar().querySelector(".field-error");
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe(editorError.message);
    expect(decision("approve")).toBeUndefined();
    expect(globalThis.alert).not.toHaveBeenCalled();
  });
});

describe("a site's request to pay the bridge's account", () => {
  const [mainnet, testnet] = [networks.mainnet, networks.testnet].map((net) => routes(net).find((route) => route.kind === "service"));
  // A DuskEVM address with its checksum, as the bridge's own fixtures have it.
  const EVM = fixtures.calls.find((c) => c.name === "deposit-shoot").expected.to;
  const tag = () => head().querySelector(".ap-tag")?.textContent ?? null;
  const warns = () => app.querySelectorAll(".callout.warn .callout-title").map((t) => t.textContent);
  const values = () => app.querySelectorAll(".kv-value").map(visibleText);
  const sub = () => visibleText(head().querySelector(".ap-sub"));
  // The part of that line that says what arrives, by its own word.
  const arrives = () => sub().split(" · ").find((part) => /arriv/i.test(part)) ?? "";
  // Every part that says what arrives: one, and never a second promising an amount.
  const arrivals = () => sub().split(" · ").filter((part) => /arriv/i.test(part));
  const feePart = () => sub().split(" · ").find((part) => /fee/i.test(part)) ?? "";
  // Every part but the fee and what's sent: none may name an amount where nothing arrives.
  const payouts = () => sub().split(" · ").filter((part) => !/fee|sent/i.test(part));
  // What the bridge's rules (bridgeCalls.js) make of a payment: its line, and its warnings by kind,
  // "off" while the bridge doesn't pay out there, "fee" where its fee takes it all.
  const service = (params) => bridgeServiceTransfer(params);
  const rules = (params) => bridgeServiceWarnings(service(params));
  const kinds = (params) => rules(params).map((w) => w.kind);
  const titles = (params) => rules(params).map((w) => w.title);
  const onMainnet = { chainId: "dusk:1", nodeUrl: "https://nodes.dusk.network", networkName: "Mainnet" };

  it("shows it as a bridge to the chain the memo's address is on, tagged as known", async () => {
    const params = transfer(testnet.account, { amount: "2000000000", memo: EVM });
    await render("send_tx", params);
    expect(head().querySelector("h1").textContent).toContain("Sepolia");
    expect(visibleText(head().querySelector(".ap-amount"))).toBe("2 DUSK");
    expect(tag()).not.toBeNull();
    // Whom it pays out to, and the bridge's own account, both in full.
    expect(values()).toContain(EVM);
    expect(visibleText(row("To"))).toContain(testnet.account);
    expect(row("Memo")).toBeUndefined();
    expect(app.querySelector(".ap-visible").textContent).toContain("alice.dusk");
    // Testnet's route doesn't pay out now: that warning alone.
    expect(kinds(params)).toEqual(["off"]);
    expect(warns()).toEqual(titles(params));
    // No name to look up for the bridge's account.
    expect(nameAsks()).toEqual([]);

    // Mainnet's pays out on BNB Smart Chain.
    const onMain = transfer(mainnet.account, { amount: "2000000000", memo: EVM, ...onMainnet });
    await render("send_tx", onMain);
    expect(head().querySelector("h1").textContent).toContain("BNB Smart Chain");
    expect(values()).toContain(EVM);
    expect(warns()).toEqual([]);
  });

  it("says what arrives on BNB Smart Chain once the bridge takes its 1 DUSK fee, and warns when it takes it all", async () => {
    const two = transfer(mainnet.account, { amount: "2000000000", memo: EVM, ...onMainnet });
    await render("send_tx", two);
    expect([service(two).feeLux, service(two).arrivesLux]).toEqual([1_000_000_000n, 1_000_000_000n]);
    expect(sub()).toBe(bridgeServiceLine(service(two)));
    expect(feePart()).toMatch(exactly("1 DUSK"));
    expect(arrivals()).toHaveLength(1);
    expect(arrives()).toMatch(exactly("1 DUSK"));

    const big = transfer(mainnet.account, { amount: "200001000000000", memo: EVM, ...onMainnet });
    await render("send_tx", big);
    expect(sub()).toBe(bridgeServiceLine(service(big)));
    expect(arrives()).toMatch(exactly("200,000 DUSK"));
    expect(feePart()).toMatch(exactly("1 DUSK"));

    // A memo that's no address there: nothing arrives, as its warning says.
    const noAddress = transfer(mainnet.account, { amount: "2000000000", memo: "Order 1042", ...onMainnet });
    await render("send_tx", noAddress);
    expect(service(noAddress).recipientOk).toBe(false);
    expect(sub()).toBe(bridgeServiceLine(service(noAddress)));
    expect(arrivals()).toHaveLength(1);
    expect(arrives()).not.toMatch(/\d/);
    expect(kinds(noAddress)).toEqual([]);
    expect(warns()).toHaveLength(1);

    const all = transfer(mainnet.account, { amount: "1000000000", memo: EVM, ...onMainnet });
    await render("send_tx", all);
    expect(service(all).arrivesLux).toBe(0n);
    expect(sub()).toBe(bridgeServiceLine(service(all)));
    expect(arrivals()).toHaveLength(1);
    expect(arrives()).not.toMatch(/\d/);
    expect(kinds(all)).toEqual(["fee"]);
    expect(warns()).toEqual(titles(all));
    expect(app.querySelector(".callout.warn .muted").textContent).toBe(rules(all)[0].text);
    // The 1 DUSK fee that takes it all.
    expect(app.querySelector(".callout.warn .muted").textContent).toMatch(exactly("1 DUSK"));
    // Reject stays the user's choice.
    expect(approve().disabled).toBe(false);
  });

  it("says the testnet bridge to Sepolia isn't running right now", async () => {
    const params = transfer(testnet.account, { amount: "5000000000", memo: EVM });
    await render("send_tx", params);
    expect(service(params).running).toBe(false);
    expect(kinds(params)).toEqual(["off"]);
    expect(warns()).toEqual(titles(params));
    expect(app.querySelector(".callout.warn .muted").textContent).toBe(rules(params)[0].text);
    // Nothing arrives there while it isn't running: one part says what arrives, with no amount, and nothing else
    // promises one.
    expect(sub()).toBe(bridgeServiceLine(service(params)));
    expect(arrivals()).toHaveLength(1);
    expect(arrives()).toMatch(/nothing/i);
    expect(arrives()).not.toMatch(/\d/);
    expect(payouts().join(" · ")).not.toMatch(/\d/);
    expect(feePart()).toMatch(exactly("1 DUSK"));
  });

  it.each([
    ["isn't an address", "Order 1042"],
    ["is missing", undefined],
    ["has a wrong checksum", EVM.replace(/[a-f]/, (c) => c.toUpperCase())],
  ])("warns when the memo %s", async (_label, memo) => {
    const params = transfer(testnet.account, { amount: "2000000000", memo });
    await render("send_tx", params);
    expect(head().querySelector("h1").textContent).toContain("Sepolia");
    expect(head().querySelector(".ap-recipient")).toBeNull();
    // The bridge's own warnings, and one that the memo is no address there.
    expect(warns()).toHaveLength(titles(params).length + 1);
    expect(warns()).toEqual(expect.arrayContaining(titles(params)));
    // All lower case has no checksum to get wrong.
    const lower = transfer(testnet.account, { amount: "2000000000", memo: EVM.toLowerCase() });
    await render("send_tx", lower);
    expect(warns()).toEqual(titles(lower));
  });

  it("is a plain payment on another network's account, or through a custom node", async () => {
    for (const params of [transfer(mainnet.account, { memo: EVM }), transfer(testnet.account, { memo: EVM, nodeUrl: "https://node.example" })]) {
      await render("send_tx", params);
      expect(tag()).toBeNull();
      expect(head().querySelector("h1").textContent).not.toMatch(/Sepolia|BNB Smart Chain/);
      expect(warns()).toEqual([]);
    }
  });

  it("says what it is before the wallet is unlocked, with what arrives", async () => {
    const params = transfer(testnet.account, { memo: EVM });
    await render("send_tx", params, { isUnlocked: false, accounts: [], duskNames: {} });
    expect(head().querySelector("h1").textContent).toContain("Sepolia");
    expect(visibleText(head().querySelector(".ap-recipient"))).toContain(`${EVM.slice(0, 6)}…${EVM.slice(-4)}`);
    expect(sub()).toBe(bridgeServiceLine(service(params)));
  });
});

describe("a site's request the balance can't pay", () => {
  const gas = { limit: "2500000", price: "1" };
  // In the bar, in view with the buttons.
  const guard = () => bar().querySelector(".pay-guard");
  const CONTRACT = `0x${"ab".repeat(32)}`;
  const call = (over = {}) => ({ kind: "contract_call", privacy: "public", contractId: CONTRACT, fnName: "do_it", fnArgs: "0x00", gas, chainId: "dusk:2", nodeUrl: TESTNET, networkName: "Testnet", ...over });

  it("says how much is missing, with the fee, and keeps Approve off", async () => {
    await render("send_tx", transfer(BOB, { amount: "10000000000", gas }), { payBalance: "13000000" });
    expect(guard().textContent).toMatch(exactly("9.9895 DUSK"));
    expect(approve().disabled).toBe(true);
    // Reject still answers.
    bar().querySelector(".btn-outline").click();
    await settle();
    expect(decision("reject")).toBeTruthy();
  });

  it("follows the fee as it's edited, down within the balance and back past it", async () => {
    await render("send_tx", transfer(BOB, { amount: "1000000000", gas }), { payBalance: "1001000000" });
    expect(guard().textContent).toMatch(exactly("0.0015 DUSK"));
    expect(approve().disabled).toBe(true);
    const editor = app.querySelector("dusk-gas-editor");
    editor.dispatchEvent(fakeEvent("dusk-gas-fee", { detail: { feeLux: 900000n } }));
    expect(guard().hidden).toBe(true);
    expect(approve().disabled).toBe(false);
    editor.dispatchEvent(fakeEvent("dusk-gas-fee", { detail: { feeLux: 3000000n } }));
    expect(approve().disabled).toBe(true);
  });

  it("says a fee alone isn't covered, for a call that moves no DUSK", async () => {
    await render("send_tx", call(), { payBalance: "1000" });
    expect(guard().textContent).toMatch(exactly("0.0025 DUSK"));
    expect(approve().disabled).toBe(true);
  });

  it("counts a call's amount and deposit", async () => {
    await render("send_tx", call({ amount: "2000000000", deposit: "3000000000" }), { payBalance: "4000000000" });
    expect(guard().textContent).toMatch(exactly("1.0025 DUSK"));
  });

  it("checks a shielded payment against the shielded balance", async () => {
    await render("send_tx", transfer(ADDRESS, { privacy: "shielded", gas }), { payBalance: "1000" });
    expect(guard().textContent).toMatch(/shielded/i);
    expect(guard().textContent).toMatch(exactly("1.0025 DUSK"));
  });

  it("hides the figure with Hide balances, which would give the balance away", async () => {
    await render("send_tx", transfer(BOB, { gas }), { payBalance: "1000", hideBalances: true });
    expect(guard().textContent).toContain("•••• DUSK");
    expect(guard().textContent).not.toMatch(/\d/);
  });

  it("stops nothing when it can pay, or when the balance couldn't be read", async () => {
    await render("send_tx", transfer(BOB, { gas }), { payBalance: "5000000000" });
    expect([guard().hidden, approve().disabled]).toEqual([true, false]);
    await render("send_tx", transfer(BOB, { gas }), { payBalance: null });
    expect([guard().hidden, approve().disabled]).toEqual([true, false]);
  });

  it("keeps an allowance's MAX and the balance's check together", async () => {
    await render("send_tx", call({ fnName: "approve", fnArgs: "0x00" }), { payBalance: "1000" });
    expect(approve().disabled).toBe(true);
    typeInto(app.querySelector(".callout.warn input"), "MAX");
    // MAX typed, and still not enough for the fee.
    expect(approve().disabled).toBe(true);
    expect(guard().textContent).toMatch(exactly("0.0025 DUSK"));
  });
});

describe("a fee the site chose", () => {
  const networkPrice = (median) => {
    mocks.answers.DUSK_UI_GET_CACHED_GAS_PRICE = () => ({ result: { median } });
  };
  const fee = () => visibleText(app.querySelector(".ap-site-fee"));
  const warned = () => app.querySelector(".ap-site-fee .callout.warn") !== null;

  it("says so with a warning, compared with the network's price, and offers the network's price", async () => {
    networkPrice("1");
    await render("send_tx", transfer(BOB, { amount: "10000000", gas: { limit: "10000000", price: "50" }, feeFromSite: { limit: true, price: true } }));
    await settle();
    // 50 times the network's price.
    expect(warned()).toBe(true);
    expect(fee()).toMatch(exactly("50"));
    const editor = app.querySelector("dusk-gas-editor");
    app.querySelector(".ap-site-fee button").click();
    expect(editor.setGas).toHaveBeenLastCalledWith({ limit: "10000000", price: "1" });
    expect(app.querySelector(".ap-site-fee").hidden).toBe(true);
  });

  it("writes how many times over in the browser's number format", async () => {
    networkPrice("2");
    vi.stubGlobal("navigator", { ...globalThis.navigator, language: "de-DE" });
    await render("send_tx", transfer(BOB, { gas: { limit: "2500000", price: "5" }, feeFromSite: { limit: true, price: true } }));
    await settle();
    expect(warned()).toBe(true);
    expect(fee()).toMatch(exactly("2,5"));
  });

  it("says it of the site's own fee only: a fee changed here puts it away, and the site's brings it back", async () => {
    networkPrice("1");
    await render("send_tx", transfer(BOB, { gas: { limit: "10000000", price: "50" }, feeFromSite: { limit: true, price: true } }));
    await settle();
    const editor = app.querySelector("dusk-gas-editor");
    const box = app.querySelector(".ap-site-fee");
    editor.dispatchEvent(fakeEvent("dusk-gas-fee", { detail: { feeLux: 500000000n } }));
    expect(box.hidden).toBe(false);
    editor.dispatchEvent(fakeEvent("dusk-gas-fee", { detail: { feeLux: 20000000n } }));
    expect(box.hidden).toBe(true);
    editor.dispatchEvent(fakeEvent("dusk-gas-fee", { detail: { feeLux: 500000000n } }));
    expect(box.hidden).toBe(false);
  });

  it("says so calmly at or under the network's price", async () => {
    networkPrice("2");
    // A note, no warning: at, below and above the network's price each said apart.
    const said = [];
    for (const [network, price] of [["2", "2"], ["2", "1"], ["4", "5"]]) {
      networkPrice(network);
      await render("send_tx", transfer(BOB, { gas: { limit: "2500000", price }, feeFromSite: { limit: true, price: true } }));
      await settle();
      expect(warned()).toBe(false);
      expect(fee()).not.toBe("");
      said.push(fee());
    }
    expect(new Set(said).size).toBe(3);
  });

  it("says when the site chose only the limit, and nothing when it chose none of it", async () => {
    networkPrice("1");
    await render("send_tx", transfer(BOB, { gas: { limit: "100000000", price: "1" }, feeFromSite: { limit: true, price: false } }));
    await settle();
    expect(warned()).toBe(false);
    expect(fee()).toMatch(exactly("0.1 DUSK"));
    await render("send_tx", transfer(BOB, { gas: { limit: "2500000", price: "1" }, feeFromSite: { limit: false, price: false } }));
    await settle();
    expect(app.querySelector(".ap-site-fee").hidden).toBe(true);
  });

  it("says the site chose it before the network's price is read", async () => {
    mocks.answers.DUSK_UI_GET_CACHED_GAS_PRICE = () => new Promise(() => {});
    await render("send_tx", transfer(BOB, { gas: { limit: "2500000", price: "50" }, feeFromSite: { limit: true, price: true } }));
    expect(app.querySelector(".ap-site-fee").hidden).toBe(false);
    expect(fee()).not.toBe("");
    expect(warned()).toBe(false);
  });
});

describe("the recipient of a site's request to send", () => {
  const answerName = (result) => {
    mocks.answers.DUSK_UI_RECIPIENT_NAME = async () => ({ ok: true, result });
  };

  it("leads with the .dusk name the recipient set, once checked, and shows the full address under To", async () => {
    answerName("carol.dusk");
    await render("send_tx", transfer(CAROL));

    await vi.waitFor(() => expect(recipient().lead).toBe("carol.dusk"));
    expect(mocks.sent).toContainEqual({ type: "DUSK_UI_RECIPIENT_NAME", rid: "r1", recipient: CAROL });
    // The full address over the name, and under To.
    expect(head().querySelector(".ap-recipient__lead").title).toContain(CAROL);
    expect(row("To").textContent).toBe(CAROL);
  });

  it("says whose word a name is when a node the wallet doesn't know gave it, once it comes", async () => {
    const custom = "https://my-node.example:8443";
    const note = () => head().querySelector(".ap-recipient__note");
    let answer;
    mocks.answers.DUSK_UI_RECIPIENT_NAME = () => new Promise((resolve) => (answer = resolve));
    await render("send_tx", transfer(CAROL, { nodeUrl: custom }), { nodeUrl: custom, chainId: 2 });
    await vi.waitFor(() => expect(answer).toBeTypeOf("function"));
    // No name yet, so nothing to say of it.
    expect(isShown(note())).toBe(false);
    answer({ ok: true, result: "carol.dusk" });
    await vi.waitFor(() => expect(recipient().lead).toBe("carol.dusk"));
    expect(isShown(note())).toBe(true);
    expect(visibleText(note())).toContain("my-node.example:8443");

    // None, and it stays out of sight.
    answerName(null);
    await render("send_tx", transfer(CAROL, { nodeUrl: custom }), { nodeUrl: custom, chainId: 2 });
    await settle();
    expect(isShown(note())).toBe(false);

    // On the network's own node, there's none to show.
    answerName("carol.dusk");
    await render("send_tx", transfer(CAROL));
    await vi.waitFor(() => expect(recipient().lead).toBe("carol.dusk"));
    expect(note()).toBeNull();
  });

  it("shows the short address until the name comes, in the same line, and Approve doesn't wait", async () => {
    let answer;
    mocks.answers.DUSK_UI_RECIPIENT_NAME = () => new Promise((resolve) => (answer = resolve));
    await render("send_tx", transfer(CAROL));
    expect(recipient().lead).toBe(shortAddress(CAROL));

    pastClickGuard();
    approve().click();
    await vi.waitFor(() => expect(decision("approve")).toBeTruthy());

    answer({ ok: true, result: "carol.dusk" });
    await settle();
    expect(recipient().lead).toBe("carol.dusk");
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
    expect(recipient().lead).toBe(shortAddress(CAROL));
  });

  // The copy audit's: Send's Review says a recipient isn't one of your contacts; a site's request to pay said nothing.
  it("says a recipient that's none of your profiles or contacts isn't a contact, an account or a shielded address", async () => {
    const stranger = /Not a contact/i;
    answerName(null);
    for (const params of [transfer(CAROL), transfer(STRANGER_ADDRESS, { privacy: "shielded" })]) {
      await render("send_tx", params);
      expect(recipient().tag).toMatch(stranger);
    }
    // A contact, or one of your profiles: whose it is, never that it's no contact.
    for (const [to, whose] of [
      [BOB, "Bob"],
      [SAVINGS, "Profile 2"],
    ]) {
      await render("send_tx", transfer(to));
      expect(recipient().tag).toContain(whose);
      expect(recipient().tag).not.toMatch(stranger);
    }
  });

  it("calls no recipient a stranger where the contacts weren't read: locked, or their store didn't open", async () => {
    const stranger = /Not a contact/i;
    answerName(null);
    await render("send_tx", transfer(CAROL), { contacts: null });
    expect(recipient().tag ?? "").not.toMatch(stranger);
    // Locked: what's asked shows over the unlock, the contacts not read yet.
    await render("send_tx", transfer(CAROL), { isUnlocked: false, accounts: [], duskNames: {}, contacts: [] });
    expect(app.querySelector("input[type=password]")).not.toBeNull();
    expect(recipient().tag ?? "").not.toMatch(stranger);
  });

  it("shows a saved contact's label beside the name the recipient set, never instead of it", async () => {
    answerName("bob-shop.dusk");
    await render("send_tx", transfer(BOB));
    await vi.waitFor(() => expect(recipient().lead).toBe("bob-shop.dusk"));
    expect(recipient().tag).toContain("Bob");
    expect(nameAsks()).toEqual([BOB]);

    // Without a name, the label still shows beside the short address.
    answerName(null);
    await render("send_tx", transfer(BOB));
    await settle();
    expect(recipient().lead).toBe(shortAddress(BOB));
    expect(recipient().tag).toContain("Bob");
  });

  it("names one of your profiles by its checked name and label, and looks it up nowhere", async () => {
    answerName("carol.dusk");
    const contacts = [
      { name: "Bob", address: ` ${BOB} ` },
      { name: "Old savings", address: SAVINGS },
    ];
    // Your own profile by its label, never a contact's label for the same address.
    for (const [params, lead, label] of [
      [transfer(SAVINGS), "bob.dusk", "Profile 2"],
      [transfer(MAIN), "alice.dusk", "Main"],
      [transfer(ADDRESS, { privacy: "shielded" }), shortAddress(ADDRESS), "Profile 2"],
    ]) {
      await render("send_tx", params, { contacts, duskNames: { [MAIN]: "alice.dusk", [SAVINGS]: "bob.dusk" } });
      expect(recipient().lead).toBe(lead);
      expect(recipient().tag).toContain(label);
      expect(recipient().tag).not.toContain("Old savings");
    }
    await settle();
    expect(nameAsks()).toEqual([]);

    // A site picks the address: one that differs from a contact's in case only is not that contact.
    await render("send_tx", transfer(CAROL), { contacts: [{ name: "Carol", address: CAROL.toLowerCase() }] });
    await vi.waitFor(() => expect(recipient().lead).toBe("carol.dusk"));
    expect(recipient().tag ?? "").not.toContain("Carol");
  });

  it("asks for no name for a shielded address or off Mainnet and Testnet", async () => {
    answerName("carol.dusk");
    for (const params of [
      transfer(STRANGER_ADDRESS, { privacy: "shielded" }),
      transfer(CAROL, { nodeUrl: "http://127.0.0.1:8080" }),
    ]) {
      await render("send_tx", params);
    }
    await settle();
    expect(nameAsks()).toEqual([]);
  });

  // A token or NFT contract call, read as the engine reads it (drc20Calls.js).
  const call = (fnName, decoded) => ({
    params: { kind: "contract_call", contractId: `0x${"11".repeat(32)}`, fnName, fnArgs: "0x00", chainId: "dusk:2", nodeUrl: TESTNET },
    answers: decoded.drc20
      ? {
          DUSK_UI_DRC20_DECODE_INPUT: async () => ({ ok: true, result: { driver: "drc20", fn: fnName, ...decoded.drc20 } }),
          DUSK_UI_DRC20_GET_METADATA: async () => ({ ok: true, result: { name: "Token", symbol: "TKN", decimals: 0 } }),
        }
      : {
          DUSK_UI_DRC20_DECODE_INPUT: async () => ({ ok: true, result: null }),
          DUSK_UI_DRC721_DECODE_INPUT: async () => ({ ok: true, result: decoded.drc721 }),
          DUSK_UI_DRC721_GET_METADATA: async () => ({ ok: true, result: { name: "Art", symbol: "ART" } }),
        },
  });
  const account = (value) => ({ kind: "account", value });

  it.each([
    ["a DRC20 transfer", call("transfer", { drc20: { to: account(CAROL), amount: "5" } })],
    ["a DRC721 transfer", call("transfer_from", { drc721: { from: { External: MAIN }, to: { External: CAROL }, token_id: "7" } })],
  ])("names the recipient of %s the same way", async (_label, { params, answers }) => {
    Object.assign(mocks.answers, answers);
    answerName("carol.dusk");
    await render("send_tx", params);
    await vi.waitFor(() => expect(recipient().lead).toBe("carol.dusk"));
    expect(row("To").textContent).toBe(CAROL);
  });

  it("asks for no name for a token spender, which receives nothing", async () => {
    const { params, answers } = call("approve", { drc20: { spender: account(CAROL), amount: "5" } });
    Object.assign(mocks.answers, answers);
    answerName("carol.dusk");
    await render("send_tx", params);
    await settle();
    expect(row("Spender").textContent).toBe(CAROL);
    expect(nameAsks()).toEqual([]);
  });
});

describe("a site's token call, read with the wallet's token drivers", () => {
  // The drivers the wallet ships, which read the call as the engine does
  // (drc20Calls.js); the site writes it with its token's own driver.
  const drivers = {};
  beforeAll(async () => {
    for (const key of ["drc20_standard", "drc20", "sozu_staked_dusk"]) {
      drivers[key] = await dataDrivers.load(new Uint8Array(await readFile(path.resolve(process.cwd(), "public", "drivers", `${key}_data_driver.wasm`))));
      drivers[key].init?.();
    }
  });
  // An account and a Phoenix key as the DRC20 standard's tests make them, and a contract.
  const SHOP = "sqrtP6LvrNqtDWn4cic3hCXZatjoW3U3V2NoCPKt7QMkS2J3Lt7LZ7LZ9YZ7Go7N63RJcSP89GBxDS1Sgg9Fqq17LsvX9FAnCbZcV1LyqSTGRg4fdi8aoq75jdomJEgsC4y";
  const PHOENIX = "J3W3PD1aVTtUwf4N7mthhuKb4KVutxQuZgy5SAt8RmkL";
  const ROUTER = "18".repeat(32);

  // A site's call to a token of 9 decimals, as `key`'s driver writes it.
  const tokenCall = (key, fnName, json) => {
    Object.assign(mocks.answers, {
      DUSK_UI_DRC20_DECODE_INPUT: async (m) => ({ ok: true, result: readDrc20Call(drivers, m.fnName, toBytes(m.fnArgs)) }),
      DUSK_UI_DRC20_GET_METADATA: async () => ({ ok: true, result: { name: "Token", symbol: "TKN", decimals: 9 } }),
    });
    const fnArgs = `0x${bytesToHex(drivers[key].encodeInputFn(fnName, json))}`;
    return { kind: "contract_call", privacy: "public", contractId: `0x${"11".repeat(32)}`, fnName, fnArgs, chainId: "dusk:2", nodeUrl: TESTNET };
  };
  const amount = () => visibleText(head().querySelector(".ap-amount"));
  // The box that holds Approve back until MAX is typed into it.
  const maxBox = () => app.querySelector(".callout.warn input");
  // The spender's ID, alone.
  const spenderId = () => {
    const code = row("Spender").querySelector("code");
    return isShown(code) ? visibleText(code) : "";
  };
  // A warning in view that the allowance is unlimited.
  const unlimited = () => app.querySelectorAll(".callout.warn").some((w) => isShown(w) && /unlimited/i.test(visibleText(w)));

  it("shows a standard transfer's amount exactly, above 2^53 too, and names its recipient", async () => {
    mocks.answers.DUSK_UI_RECIPIENT_NAME = async () => ({ ok: true, result: "shop.dusk" });
    await render("send_tx", tokenCall("drc20_standard", "transfer", `{"to":{"Moonlight":"${SHOP}"},"amount":9007199254740993}`), {
      contacts: [{ name: "Shop", address: SHOP }],
    });
    expect(amount()).toBe("9,007,199.254740993 TKN");
    await vi.waitFor(() => expect(recipient().lead).toBe("shop.dusk"));
    expect(recipient().tag).toContain("Shop");
    expect([row("To").textContent, row("Units").textContent]).toEqual([SHOP, "9007199254740993"]);
    expect(row("Spender")).toBeUndefined();
  });

  it("shows a standard approval of the most there is exactly, with Approve waiting for MAX", async () => {
    await render("send_tx", tokenCall("drc20_standard", "transfer", `{"to":{"Moonlight":"${SHOP}"},"amount":5}`));
    const transferTitle = title();
    await render("send_tx", tokenCall("drc20_standard", "approve", `{"spender":{"Contract":"${ROUTER}"},"amount":18446744073709551615}`));
    // Said as an allowance, not as a transfer: of the most there is, Unlimited, its exact figure under Details, in the token's units.
    expect(title()).not.toBe(transferTitle);
    expect(title()).toMatch(/allow|spend/i);
    expect(transferTitle).not.toMatch(/allow|spend/i);
    expect(amount()).toBe("Unlimited TKN");
    expect(row("Amount").textContent).toBe("18,446,744,073.709551615 TKN");
    expect(spenderId()).toBe(ROUTER);
    expect(visibleText(row("Spender"))).toMatch(/contract/i);
    expect(row("Units").textContent).toBe("18446744073709551615");
    // Unlimited, said where it shows, with Approve waiting for MAX.
    expect(unlimited()).toBe(true);
    expect(maxBox()).not.toBeNull();
    expect(approve().disabled).toBe(true);
  });

  it("names a shielded address and a contract as they are, and whose tokens a transfer_from moves", async () => {
    await render("send_tx", tokenCall("drc20_standard", "transfer_from", `{"owner":{"Moonlight":"${SAVINGS}"},"to":{"Phoenix":"${PHOENIX}"},"amount":7}`));
    expect(amount()).toBe("0.000000007 TKN");
    expect(visibleText(head().querySelector(".ap-recipient"))).toContain(shortAddress(PHOENIX));
    expect(visibleText(head().querySelector(".ap-recipient"))).toMatch(/shielded/i);
    expect(visibleText(row("To"))).toContain(PHOENIX);
    expect(row("Owner").textContent).toBe(SAVINGS);

    await render("send_tx", tokenCall("drc20_standard", "transfer", `{"to":{"Contract":"${ROUTER}"},"amount":7}`));
    expect(visibleText(head().querySelector(".ap-recipient"))).toContain(shortAddress(ROUTER));
    expect(visibleText(head().querySelector(".ap-recipient"))).toMatch(/contract/i);
  });

  it("reads the standard's allowance changes", async () => {
    // An increase, said as one, by exactly what it adds.
    await render("send_tx", tokenCall("drc20_standard", "increase_allowance", `{"spender":{"Moonlight":"${SHOP}"},"added_amount":1000000000000000001}`));
    expect(title()).toMatch(/more|increase/i);
    expect(title()).not.toMatch(/less|decrease/i);
    expect([amount(), row("Spender").textContent]).toEqual(["1,000,000,000.000000001 TKN", SHOP]);
    // A decrease, said as one, by exactly what it takes off.
    await render("send_tx", tokenCall("drc20_standard", "decrease_allowance", `{"spender":{"Moonlight":"${SHOP}"},"subtracted_amount":5}`));
    expect(title()).toMatch(/less|decrease/i);
    expect(title()).not.toMatch(/more|increase/i);
    expect([amount(), row("Spender").textContent]).toEqual(["0.000000005 TKN", SHOP]);
  });

  it("shows a Sozu approval of the most there is for a contract, waiting for MAX", async () => {
    // A contract ID with a 0, which Sozu's driver writes in hex.
    const pool = "10".repeat(32);
    await render("send_tx", tokenCall("sozu_staked_dusk", "approve", `["${pool}","18446744073709551615"]`));
    expect(amount()).toBe("Unlimited TKN");
    expect(row("Amount").textContent).toBe("18,446,744,073.709551615 TKN");
    expect(row("Units").textContent).toBe("18446744073709551615");
    expect(spenderId()).toBe(pool);
    expect(unlimited()).toBe(true);
    expect(approve().disabled).toBe(true);
    typeInto(maxBox(), "MAX");
    expect(approve().disabled).toBe(false);

    await render("send_tx", tokenCall("sozu_staked_dusk", "transfer", `["${pool}","5"]`));
    expect(visibleText(head().querySelector(".ap-recipient"))).toContain(shortAddress(pool));
    expect(visibleText(row("To"))).toContain(pool);
  });

  it.each([
    // An older token's approval of the most there is, with a byte its driver
    // reads past set: what the wallet showed before, waiting for MAX.
    [
      "a driver reads but not exactly",
      async () => {
        const params = tokenCall("drc20", "approve", `{"spender":{"External":"${SHOP}"},"value":"18446744073709551615"}`);
        const bytes = toBytes(params.fnArgs);
        bytes[3] = 1;
        return { ...params, fnArgs: `0x${bytesToHex(bytes)}` };
      },
    ],
    [
      "the engine couldn't read",
      async () => {
        const params = tokenCall("drc20", "approve", `{"spender":{"External":"${SHOP}"},"value":"18446744073709551615"}`);
        mocks.answers.DUSK_UI_DRC20_DECODE_INPUT = async () => ({ ok: false, error: "Engine call timed out" });
        return params;
      },
    ],
  ])("keeps an allowance waiting for MAX when %s", async (_label, request) => {
    await render("send_tx", await request());
    // That it can't read the request, and that it may be an unlimited allowance: Approve waits for MAX.
    expect(app.querySelectorAll(".callout.warn").length).toBeGreaterThan(0);
    expect(maxBox()).not.toBeNull();
    expect(approve().disabled).toBe(true);
    typeInto(maxBox(), "max");
    expect(approve().disabled).toBe(false);
  });

  it("shows an older token's transfer as before, every decimal the token has", async () => {
    await render("send_tx", tokenCall("drc20", "transfer", `{"to":{"External":"${SHOP}"},"value":"1234567891234"}`));
    expect([amount(), row("To").textContent]).toEqual(["1,234.567891234 TKN", SHOP]);
  });

  it("says it can't read a token call in a form it doesn't know, rather than show a blank", async () => {
    const params = tokenCall("drc20_standard", "transfer", `{"to":{"Moonlight":"${SHOP}"},"amount":5}`);
    // A recipient that isn't a valid key, which the standard writes as InvalidMoonlight.
    const bytes = toBytes(params.fnArgs);
    bytes[20] ^= 0xff;
    await render("send_tx", { ...params, fnArgs: `0x${bytesToHex(bytes)}` });
    // A warning that it can't, and no amount or recipient made up.
    expect(app.querySelectorAll(".callout.warn")).toHaveLength(1);
    expect(head().querySelector(".ap-amount")).toBeNull();
    expect([row("To"), row("Units"), app.querySelector(".ap-opaque")]).toEqual([undefined, undefined, null]);
    expect(approve().disabled).toBe(false);
  });

  // The copy audit's: a 10 stDUSK allowance's first window read "10,000,000,000 TOKEN", the call's
  // units as an unnamed token's, until the token's details came.
  describe("a token whose details come late, or never", () => {
    // Sozu's approval of 10 stDUSK (9 decimals), and of the most there is, for a contract.
    const tenStDusk = () => tokenCall("sozu_staked_dusk", "approve", `["${"10".repeat(32)}","10000000000"]`);
    const allOfIt = () => tokenCall("sozu_staked_dusk", "approve", `["${"10".repeat(32)}","18446744073709551615"]`);
    // The token's details as the test gives them, once it does: held back after the call is made, which answers them at once.
    const detailsLater = () => {
      let give;
      mocks.answers.DUSK_UI_DRC20_GET_METADATA = () => new Promise((resolve) => (give = resolve));
      return (answer) => give(answer);
    };
    const STAKED = { ok: true, result: { name: "Staked Dusk", symbol: "stDUSK", decimals: 9 } };
    // Said while the token's details are read, and once they couldn't be.
    const reading = () => /Reading the token…/.test(visibleText(head()));
    const unreadLines = () => visibleText(app).match(/Couldn't read this token/gi) ?? [];

    it("says it's reading the token, with Approve off, then shows the amount in the token's units", async () => {
      const params = tenStDusk();
      const give = detailsLater();
      const shown = render("send_tx", params);
      await vi.waitFor(() => expect(reading()).toBe(true));
      // No amount until the token's decimals come: never the units scaled for a token it guessed.
      expect(head().querySelector(".ap-amount")).toBeNull();
      expect(visibleText(app)).not.toMatch(/TOKEN|10,000,000,000/);
      expect(row("Units").textContent).toBe("10000000000");
      expect(approve().disabled).toBe(true);
      pastClickGuard();
      approve().click();
      await settle();
      expect(decision("approve")).toBeUndefined();

      give(STAKED);
      await shown;
      expect(reading()).toBe(false);
      expect(amount()).toBe("10 stDUSK");
      expect(visibleText(row("Token"))).toMatch(/\(stDUSK\)/);
      expect(unreadLines()).toEqual([]);
      expect(approve().disabled).toBe(false);
    });

    it.each([
      ["the wallet couldn't read them", { ok: false, error: "Engine call timed out" }],
      ["they name no symbol", { ok: true, result: { name: "", symbol: "", decimals: 0 } }],
      ["their decimals aren't a whole number", { ok: true, result: { name: "Staked Dusk", symbol: "stDUSK", decimals: 9.5 } }],
    ])("shows the call's raw units beside its contract when %s, never a figure scaled for an unnamed token", async (_label, answer) => {
      const params = tenStDusk();
      const give = detailsLater();
      const shown = render("send_tx", params);
      await vi.waitFor(() => expect(reading()).toBe(true));
      give(answer);
      await shown;
      expect(reading()).toBe(false);
      // The units as the call has them, said once why, and the contract they're of on the main view.
      expect(amount()).toBe("10000000000 units");
      expect(unreadLines()).toHaveLength(1);
      expect(visibleText(row("Token"))).toBe("111111…111111");
      expect(row("Token").closest("details")).toBeNull();
      expect(visibleText(app)).not.toMatch(/TOKEN|10,000,000,000|stDUSK/);
      expect(approve().disabled).toBe(false);
    });

    it("keeps an unlimited allowance waiting for MAX, while it reads the token and when it can't", async () => {
      const params = allOfIt();
      const give = detailsLater();
      const shown = render("send_tx", params);
      await vi.waitFor(() => expect(reading()).toBe(true));
      expect(approve().disabled).toBe(true);
      give({ ok: false, error: "Engine call timed out" });
      await shown;
      expect(amount()).toBe("18446744073709551615 units");
      expect(unlimited()).toBe(true);
      expect(approve().disabled).toBe(true);
      typeInto(maxBox(), "MAX");
      expect(approve().disabled).toBe(false);
    });

    it("doesn't draw the token over the unlock the window asked for meanwhile", async () => {
      const params = tenStDusk();
      const give = detailsLater();
      const shown = render("send_tx", params);
      await vi.waitFor(() => expect(reading()).toBe(true));
      mocks.pending = { ...mocks.pending, isUnlocked: false, accounts: [], duskNames: {} };
      for (const hear of mocks.heard) hear({ type: "DUSK_UI_LOCK_STATE", isUnlocked: false, reason: "engine_closed" });
      await vi.waitFor(() => expect(app.querySelector("input[type=password]")).not.toBeNull());
      give(STAKED);
      await shown;
      await settle();
      // Still the unlock, with no amount drawn over it.
      expect(app.querySelector("input[type=password]")).not.toBeNull();
      expect(visibleText(app)).not.toMatch(/stDUSK/);
    });
  });
});

describe("contract calls", () => {
  const { bridge, portal } = duskEvmContracts(2);
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
  // The window's Details, at the bottom, and whether `el` is folded in it.
  const detailsBlock = () => app.children.find((el) => el.localName === "details" && el.querySelector("summary").textContent === "Details");
  const folded = (el) => el.closest("#app > *") === detailsBlock();

  it("says the wallet can't read an unknown call's arguments, with the function and their size and hash under Details", async () => {
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
    expect(visibleText(head().querySelector(".ap-amount"))).toBe("10 DUSK");
    expect(visibleText(row("From"))).toContain("alice.dusk");
    // As every Dusk app writes a contract ID, though the site sent it with 0x, on the main view.
    expect(row("Contract").querySelector(".mono").title).toBe("11".repeat(32));
    expect(visibleText(row("Contract ID"))).toBe("11".repeat(32));
    expect(folded(row("Contract"))).toBe(false);
    // It says it can't read the arguments; not a known call.
    expect(app.querySelector(".ap-opaque")).not.toBeNull();
    expect(head().querySelector(".ap-tag")).toBeNull();
    expect(row("Method").textContent).toBe("stake");
    expect(row("Call data").textContent).toBe("1 bytes · sha256=6e340b9cffb3…17afa01d");
  });

  it("reads a DuskEVM deposit: its recipient and amount on top, the call data's hash and the site's words under Details", async () => {
    const shoot = fixture("deposit-shoot");
    await render(
      "send_tx",
      contractCall(bridge, "deposit-shoot", { deposit: "100000000", display: { label: "Bridge 0.1 DUSK to DuskEVM", recipient: "0x96BA8D18dBa0a9B933c2e733EA07F47767dc893e" } })
    );

    expect(head().querySelector("h1").textContent).toContain("DuskEVM");
    expect(visibleText(head().querySelector(".ap-amount"))).toBe("0.1 DUSK");
    // Known: tagged so, and its recipient on the main view.
    expect(head().querySelector(".ap-tag")).not.toBeNull();
    expect(row("DuskEVM recipient").textContent).toBe(shoot.expected.to);
    expect(folded(row("DuskEVM recipient"))).toBe(false);
    expect(row("Amount").textContent).toBe("0.1 DUSK");
    // The hash the bridge's review page shows, to match against.
    expect(row("Call data").textContent).toBe("40 bytes · sha256=2f64b19f5ac0…731c7c2a");
    expect(shoot.sha256).toMatch(/^2f64b19f5ac0.*731c7c2a$/);
    // The bytes and the site's own words, as they came.
    const raw = app.querySelectorAll("details").find((d) => d.querySelector("code")?.textContent === shoot.args);
    expect(raw).toBeTruthy();
    expect(app.querySelector(".ap-site-details pre").textContent).toContain('"label": "Bridge 0.1 DUSK to DuskEVM"');
    // Its contract by the network's name for it, its ID 6…6; nothing on what's public, which is for a payment.
    const bridgeId = duskEvmContracts(2).bridge;
    expect(visibleText(row("Contract"))).toContain(`${bridgeId.slice(0, 6)}…${bridgeId.slice(-6)}`);
    expect(app.querySelector(".ap-visible")).toBeNull();
  });

  // The call shown as the opaque one it is, with the bridge's warning, never as known.
  const unchecked = () => {
    expect(head().querySelector(".ap-tag")).toBeNull();
    expect(app.querySelectorAll(".callout.warn")).toHaveLength(1);
    expect(row("DuskEVM recipient")).toBeUndefined();
  };
  // An account that isn't the wallet's.
  const STRANGER = "oUgxBUWEPyFAekXW9T2UdJBcMF7xAuBfstrCX8ATXFk7MusqddFGoq2LN9euCbwVuXpSM5rGLKNUb6NVPFUVM5g4pA6CnXjNfNVBiy91NcH9eBVcdcG1eYUaKWQSYQ9t2um";

  it("doesn't read a deposit that sends other DUSK than it bridges", async () => {
    await render("send_tx", contractCall(bridge, "deposit", { deposit: "200000000" }));
    unchecked();
  });

  it("doesn't read a deposit whose transfer also pays someone, and says whom", async () => {
    await render("send_tx", contractCall(bridge, "deposit", { deposit: "100000000", amount: "5000000000", to: STRANGER }));
    unchecked();
    expect(visibleText(head().querySelector(".ap-amount"))).toBe("5.1 DUSK");
    expect(row("Amount").textContent).toBe("5 DUSK");
    expect(row("Amount to").textContent).toBe(STRANGER);
  });

  it.each([
    ["an amount", { amount: "1000000000" }],
    ["a deposit", { deposit: "1000000000" }],
    ["an amount to someone", { amount: "1000000000", to: STRANGER }],
  ])("doesn't read a withdrawal's proof sent with %s", async (_what, over) => {
    await render("send_tx", contractCall(portal, "prove-account", over));
    unchecked();
  });

  it("reads a deposit whose transfer names the wallet's own account", async () => {
    await render("send_tx", contractCall(bridge, "deposit", { deposit: "100000000", to: MAIN }));
    expect(head().querySelector(".ap-tag")).not.toBeNull();
  });

  // The gas a proof or claim comes with: 0.051 DUSK at most.
  const GAS = { gas: { limit: "51000000", price: "1" } };

  it.each(["prove-account", "claim-external-account"])("reads %s: what it costs first, then the withdrawal and whom it pays on Dusk", async (name) => {
    // It pays the wallet's second profile.
    await render("send_tx", contractCall(portal, name, GAS), { duskNames: { [MAIN]: "alice.dusk", [SAVINGS]: "bob.dusk" } });
    // The cost leads, as on the bridge's review, then the withdrawal it's for.
    const cost = () => visibleText(head().querySelector(".ap-amount"));
    expect(cost()).toMatch(exactly("0.051 DUSK"));
    expect(visibleText(head().querySelector(".ap-recipient__line"))).toMatch(exactly("1,008 DUSK"));
    expect(recipient().lead).toBe("bob.dusk");
    expect(recipient().tag).toContain("Profile 2");
    expect(row("Pays to").textContent).toBe(SAVINGS);
    expect(row("Amount").textContent).toBe("1,008 DUSK");
    expect(row("Sent from DuskEVM").textContent).toBe(fixture(name).expected.from);
    expect(head().querySelector(".ap-tag")).not.toBeNull();

    // It follows the fee as Custom fee changes it, and shows none while the gas won't do.
    const editor = app.querySelector("dusk-gas-editor");
    editor.dispatchEvent(fakeEvent("dusk-gas-fee", { detail: { feeLux: 102_000_000n } }));
    expect(cost()).toMatch(exactly("0.102 DUSK"));
    editor.dispatchEvent(fakeEvent("dusk-gas-fee", { detail: { feeLux: null } }));
    expect(cost()).not.toMatch(/\d/);
  });

  it("shows a withdrawal off the bridge's route as the call it is, with a warning, never as known", async () => {
    // Its target is another contract than Dusk's messenger.
    const fnArgs = fixture("prove-account").args.replace(fixtures.route.l1Messenger.slice(2).toLowerCase(), "11".repeat(20));
    expect(fnArgs).not.toBe(fixture("prove-account").args);
    await render("send_tx", contractCall(portal, "prove-account", { fnArgs }));
    unchecked();
    expect(app.querySelector(".ap-opaque")).toBeNull();
  });

  it("names a withdrawal that pays a contract", async () => {
    await render("send_tx", contractCall(portal, "claim-contract", GAS));
    const contract = fixture("claim-contract").expected.recipient;
    expect(row("Pays to contract").textContent).toBe(contract);
    expect(visibleText(head().querySelector(".ap-amount"))).toMatch(exactly("0.051 DUSK"));
    expect(visibleText(head().querySelector(".ap-recipient__line"))).toMatch(exactly("1 DUSK"));
    expect(visibleText(head().querySelector(".ap-recipient__line"))).toContain(`${contract.slice(0, 6)}…${contract.slice(-6)}`);
    expect(visibleText(head().querySelector(".ap-recipient__line"))).toMatch(/contract/i);
  });

  it("leaves the same call undecoded on Mainnet, where no bridge is configured", async () => {
    await render("send_tx", contractCall(bridge, "deposit", { deposit: "100000000", chainId: "dusk:1", nodeUrl: "https://nodes.dusk.network", networkName: "Mainnet" }));
    expect(head().querySelector(".ap-tag")).toBeNull();
    expect(app.querySelector(".ap-opaque")).not.toBeNull();
  });
});

// The suites below ask a one-profile wallet for shop.example, whose account
// (SAVINGS above) is someone else's there.
const SHOP = SAVINGS;
const renderShop = (kind, params = {}, over = {}) =>
  render(kind, params, {
    origin: "https://shop.example",
    accounts: [MAIN],
    addresses: ["addr0"],
    accountCount: 1,
    accountNames: {},
    contacts: [],
    ...over,
  });
const title = () => app.querySelector(".ap-head h1")?.textContent;

describe("a site's request while the wallet is locked", () => {
  const locked = { isUnlocked: false, accounts: [], duskNames: {} };
  const pay = { kind: "transfer", privacy: "public", to: SHOP, amount: "1000000000", chainId: "dusk:2", nodeUrl: TESTNET };

  // What each asks, and what of it shows: the message signed, how many bytes, the network.
  it.each([
    ["connect", { requestedProfiles: true }, null],
    ["connect", { requestedProfiles: true, shieldedReceiveAddress: true, currentAccountIndex: 0 }, null],
    ["sign_message", { messageLen: 25, messagePreview: { kind: "text", text: "I agree to the shop terms" } }, "I agree to the shop terms"],
    ["sign_message", { messageLen: 3, messagePreview: { kind: "opaque" } }, "3"],
    ["switch_network", { to: { networkName: "Mainnet" } }, "Mainnet"],
    ["watch_asset", { type: "DRC721" }, null],
  ])("shows what %s asks before the password", async (kind, params, shows) => {
    await renderShop(kind, params, locked);
    expect(title()).toBeTruthy();
    if (shows) expect(visibleText(app.querySelector(".ap-head"))).toMatch(exactly(shows));
    // The password to unlock, Reject beside Unlock.
    expect(app.querySelector("input[type=password]")).not.toBeNull();
    expect(bar().querySelectorAll("button")).toHaveLength(2);
    expect(bar().querySelector(".btn-outline")).not.toBeNull();
  });

  it("says what connecting and sharing the shielded address each ask before the password", async () => {
    // A connection: the public account, not the shielded address.
    await renderShop("connect", { requestedProfiles: true }, locked);
    expect(visibleText(app.querySelector(".ap-head"))).toMatch(/public/i);
    expect(visibleText(app.querySelector(".ap-head"))).not.toMatch(/shielded/i);
    // The shielded address.
    await renderShop("connect", { requestedProfiles: true, shieldedReceiveAddress: true, currentAccountIndex: 0 }, locked);
    expect(visibleText(app.querySelector(".ap-head"))).toMatch(/shielded/i);
  });

  it("shows a payment's amount and recipient, named once checked", async () => {
    mocks.answers.DUSK_UI_RECIPIENT_NAME = async () => ({ ok: true, result: "wallet-both.dusk" });
    await renderShop("send_tx", pay, locked);
    expect(visibleText(app.querySelector(".ap-amount"))).toBe("1 DUSK");
    await vi.waitFor(() => expect(app.querySelector(".ap-recipient__lead").textContent).toBe("wallet-both.dusk"));
  });

  it("shows a known bridge deposit's amount and DuskEVM recipient", async () => {
    const deposit = fixtures.calls.find((c) => c.name === "deposit-shoot");
    await renderShop(
      "send_tx",
      { kind: "contract_call", contractId: duskEvmContracts(2).bridge, fnName: deposit.fnName, fnArgs: deposit.args, deposit: "100000000", chainId: "dusk:2", nodeUrl: TESTNET },
      locked
    );
    expect(title()).toContain("DuskEVM");
    expect(visibleText(app.querySelector(".ap-amount"))).toBe("0.1 DUSK");
    expect(visibleText(app.querySelector(".ap-recipient"))).toContain("0x96BA…893e");
  });

  it("shows what a withdrawal's proof costs first, then the withdrawal and whom it pays", async () => {
    const prove = fixtures.calls.find((c) => c.name === "prove-account");
    await renderShop(
      "send_tx",
      { kind: "contract_call", contractId: duskEvmContracts(2).portal, fnName: prove.fnName, fnArgs: prove.args, chainId: "dusk:2", nodeUrl: TESTNET, gas: { limit: "51000000", price: "1" } },
      locked
    );
    expect(visibleText(app.querySelector(".ap-amount"))).toMatch(exactly("0.051 DUSK"));
    expect(visibleText(app.querySelector(".ap-recipient__line"))).toMatch(exactly("1,008 DUSK"));
    expect(visibleText(app.querySelector(".ap-recipient__line"))).toContain(`${SHOP.slice(0, 6)}…${SHOP.slice(-6)}`);
  });

  it("rejects without unlocking", async () => {
    await renderShop("send_tx", pay, locked);
    bar().querySelector(".btn-outline").click();
    await vi.waitFor(() => expect(mocks.sent).toContainEqual({ type: "DUSK_PENDING_DECISION", rid: "r1", decision: "reject" }));
    expect(mocks.sent.some((m) => m.type === "DUSK_UI_UNLOCK")).toBe(false);
    await vi.waitFor(() => expect(dom.window.close).toHaveBeenCalled());
  });

  it("keeps the form retryable after a wrong password, the error under the field", async () => {
    await renderShop("send_tx", pay, locked);
    const pwd = app.querySelector("input[type=password]");
    const unlock = bar().querySelector(".btn-primary");
    mocks.answers.DUSK_UI_UNLOCK = async () => ({ error: { message: "Incorrect password" } });

    typeInto(pwd, "wrong password");
    unlock.click();
    await vi.waitFor(() => expect(app.querySelector("#approval-unlock-error").hidden).toBe(false));
    // The wallet's own answer, under the field; the password cleared, and both ready again.
    expect(app.querySelector("#approval-unlock-error").textContent).toBe("Incorrect password");
    expect([pwd.value, pwd.disabled, unlock.disabled]).toEqual(["", false, false]);

    // Typing again clears the error; the right password shows the approval.
    typeInto(pwd, "right password");
    expect(app.querySelector("#approval-unlock-error").hidden).toBe(true);
    mocks.answers.DUSK_UI_UNLOCK = async () => {
      mocks.pending = { ...mocks.pending, isUnlocked: true, accounts: [MAIN], duskNames: { [MAIN]: "alice.dusk" } };
      return { ok: true };
    };
    unlock.click();
    await vi.waitFor(() => expect(app.querySelector("input[type=password]")).toBeNull());
    expect(approve()).not.toBeNull();
    expect(mocks.sent.filter((m) => m.type === "DUSK_UI_UNLOCK").map((m) => m.password)).toEqual(["wrong password", "right password"]);
    expect(visibleText(app.querySelector(".kv-value"))).toContain("alice.dusk");
  });

  it("asks to set up a wallet that has none, with Reject beside it", async () => {
    await renderShop("connect", {}, { hasVault: false });
    // Nothing to unlock: no password, the setup beside Reject.
    expect(app.querySelector("input[type=password]")).toBeNull();
    expect(bar().querySelectorAll("button")).toHaveLength(2);
    expect(bar().querySelector(".btn-outline")).not.toBeNull();
  });
});

describe("the request's network", () => {
  it("shows the network in the header: a transaction's own, a signature's chain, or the wallet's", async () => {
    const chip = dom.document.createElement("div");
    chip.id = "approval-network";
    chip.hidden = true;
    dom.document.body.appendChild(chip);

    await renderShop("send_tx", { kind: "transfer", privacy: "public", to: SHOP, amount: "1", networkName: "Testnet", nodeUrl: TESTNET });
    expect([chip.textContent, chip.hidden]).toEqual(["Testnet", false]);
    await renderShop("sign_message", { chainId: "dusk:1", messageLen: 1 }, { networkName: "Testnet" });
    expect(chip.textContent).toBe("Mainnet");
    await renderShop("connect", { requestedProfiles: true }, { networkName: "Devnet" });
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

    await renderShop("send_tx", { kind: "transfer", privacy: "public", to: SHOP, amount: "1", networkName: "Testnet", nodeUrl: TESTNET });
    expect(strips()).toHaveLength(1);
    expect(strips()[0].textContent).not.toBe("");
    // A locked wallet's window says it too.
    await renderShop("connect", { requestedProfiles: true }, { isUnlocked: false, accounts: [], duskNames: {} });
    expect(strips()).toHaveLength(1);

    await renderShop("sign_message", { chainId: "dusk:1", messageLen: 1 }, { nodeUrl: "https://nodes.dusk.network", networkName: "Mainnet" });
    expect(strips()).toHaveLength(0);
  });
});

describe("a node that isn't a network's own", () => {
  const HOSTILE = "https://nodes.dusk.network.evil.example";
  const panelled = () => {
    const panel = dom.document.createElement("div");
    panel.className = "panel";
    panel.appendChild(app);
    dom.document.body.appendChild(panel);
    return panel;
  };

  it("is Custom with its host at the top of an approval, whichever chain it says, with no test-network words", async () => {
    const panel = panelled();
    const chip = dom.document.createElement("div");
    chip.id = "approval-network";
    dom.document.body.appendChild(chip);
    const strip = () => visibleText(panel.querySelector(".testnet-strip"));
    // What Testnet's own node says of its DUSK, in the wallet's words.
    await render("send_tx", transfer(BOB));
    const noValue = strip().replace("Testnet", "").replace(/^[\s·]+/, "");
    expect(noValue).not.toBe("");
    for (const [chainId, counts] of [[2, "Testnet"], [3, "Devnet"]]) {
      await render(
        "send_tx",
        transfer(BOB, { chainId: "dusk:3070325578", nodeUrl: HOSTILE, networkName: "Custom" }),
        { nodeUrl: HOSTILE, networkName: "Custom", chainId }
      );
      expect(chip.textContent).toBe("Custom");
      // Its host, and where what's signed counts; never that its DUSK has no value.
      expect(strip()).toContain(new URL(HOSTILE).host);
      expect(strip()).toContain(counts);
      expect(strip()).not.toContain(noValue);
    }
    await render("send_tx", transfer(BOB, { chainId: "dusk:3070325578", nodeUrl: HOSTILE, networkName: "Custom" }), { nodeUrl: HOSTILE, networkName: "Custom", chainId: 1 });
    expect(strip()).toContain("Mainnet");
    expect(row("Network").textContent).toContain(new URL(HOSTILE).host);
    // Details name the chain the signature carries, and the ID sites see apart from it.
    expect(row("Signs for").textContent).toContain("Mainnet");
    expect(app.querySelectorAll(".kv-value").map((v) => v.textContent)).toContain("dusk:3070325578");
  });

  it("says why it can't be signed, in plain words, and offers only Reject, for what's signed of every kind", async () => {
    const chainRefusal = "hostile.example now says it's on Mainnet (chain 1), not Testnet (chain 2). Nothing was signed, because a signature here could count on the other network.";
    for (const [kind, params] of [
      ["send_tx", transfer(BOB)],
      ["sign_message", { chainId: "dusk:3070325578", messageLen: 2, messagePreview: { kind: "text", text: "hi" } }],
      ["sign_auth", { chainId: "dusk:3070325578", nonce: "n" }],
      ["sign_typed_data", { chainId: "dusk:3070325578" }],
    ]) {
      await render(kind, params, { chainRefusal });
      // Why, as the wallet found it.
      expect(visibleText(app.querySelector(".callout.warn"))).toContain(chainRefusal);
      expect(approve().disabled, kind).toBe(true);
    }
    // Rejecting still answers.
    bar().querySelector(".btn-outline").click();
    await settle();
    expect(decision("reject")).toBeTruthy();
  });

  describe("a site's request to switch to it", () => {
    const from = { chainId: "dusk:1", nodeUrl: "https://nodes.dusk.network", host: "nodes.dusk.network", networkName: "Mainnet" };
    const to = { chainId: "dusk:3070325578", nodeUrl: HOSTILE, host: new URL(HOSTILE).host, networkName: "Custom" };

    it("shows the host large on the main view, what that choice means, and never a network's name", async () => {
      await render("switch_network", { from, to });
      const head = app.querySelector(".ap-head");
      expect(head.querySelector(".ap-node").textContent).toBe("nodes.dusk.network.evil.example");
      // That such a node sees your activity and can show false balances.
      expect(visibleText(app)).toContain(SWITCH_NODE_FACT);
      // Never named as Mainnet, though its address starts as Mainnet's.
      expect(head.querySelector("h1").textContent).not.toContain("Mainnet");
      // Not behind Details.
      expect(head.closest?.("details") ?? null).toBeNull();
    });

    it("says so before the wallet is unlocked too", async () => {
      await render("switch_network", { from, to }, { isUnlocked: false, accounts: [], duskNames: {} });
      expect(app.querySelector(".ap-head h1").textContent).not.toContain("Mainnet");
      expect(app.querySelector(".ap-node").textContent).toBe("nodes.dusk.network.evil.example");
      expect(visibleText(app)).toContain(SWITCH_NODE_FACT);
    });

    it("says Switch to Mainnet for Mainnet's own address alone, its host still large", async () => {
      await render("switch_network", { from: to, to: { ...from, chainId: "dusk:1" } });
      expect(app.querySelector(".ap-head h1").textContent).toContain("Mainnet");
      expect(app.querySelector(".ap-node").textContent).toBe("nodes.dusk.network");
      expect(visibleText(app)).not.toContain(SWITCH_NODE_FACT);
    });
  });
});

describe("contract-call decoding", () => {
  it("asks the background to decode token calls with serializable 0x-hex arguments", async () => {
    mocks.answers.DUSK_UI_DRC20_DECODE_INPUT = async () => ({ ok: true, result: null });
    mocks.answers.DUSK_UI_DRC721_DECODE_INPUT = async () => ({ ok: false, error: "Not a DRC721 call" });
    await renderShop("send_tx", {
      kind: "contract_call",
      contractId: `0x${"11".repeat(32)}`,
      fnName: "transfer_from",
      fnArgs: [1, 2, 255],
      chainId: "dusk:2",
      nodeUrl: TESTNET,
    });
    const asks = mocks.sent.filter((m) => /DECODE_INPUT$/.test(m.type));
    // One read with every token driver, then the NFT driver's.
    expect(asks.map((m) => [m.type, m.fnArgs, m.driver ?? ""])).toEqual([
      ["DUSK_UI_DRC20_DECODE_INPUT", "0x0102ff", ""],
      ["DUSK_UI_DRC721_DECODE_INPUT", "0x0102ff", ""],
    ]);
    expect(app.querySelector(".ap-opaque")).not.toBeNull();
  });

  it("makes no driver call for a known bridge call, which the wallet reads itself", async () => {
    const claim = fixtures.calls.find((c) => c.name === "claim-account");
    await renderShop("send_tx", { kind: "contract_call", contractId: duskEvmContracts(2).portal, fnName: claim.fnName, fnArgs: claim.args, chainId: "dusk:2", nodeUrl: TESTNET });
    // Read and known, without the drivers.
    expect(head().querySelector(".ap-tag")).not.toBeNull();
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

  it("shows the origin, the domain, the primary type and each field in its own row, and the digest-checked full request", async () => {
    await renderShop("sign_typed_data", params());
    // Each value in its own row: a value under another's label fails.
    expect(value("Request from")).toBe("https://shop.example");
    expect(value("Domain name")).toBe("Shop");
    expect(value("Domain version")).toBe("1");
    expect(value("Chain ID")).toBe("dusk:2");
    expect(value("Verifying contract")).toMatch(exactly("32 zero bytes"));
    expect(value("Primary type")).toBe("Order");
    expect([value("item · string"), value("quantity · uint64")]).toEqual(["Dusk hoodie", "2"]);
    // The whole request, as signed, and its digest.
    expect(JSON.parse(app.querySelector("textarea").textContent)).toEqual(input);
    expect(app.querySelector(".ap-digest").textContent).toBe(hashTypedDataHex(input));
    expect(approve().disabled).toBe(false);
    expect(app.querySelector(".callout.warn")).toBeNull();
  });

  it("disables Sign but keeps Reject when the request doesn't match its digest", async () => {
    await renderShop("sign_typed_data", params({ message: { item: "Changed after hashing", quantity: "2" } }));
    expect(app.querySelector("[role=alert]")).not.toBeNull();
    expect(approve().disabled).toBe(true);
    expect(app.querySelector("textarea")).toBeNull();
    bar().querySelector(".btn-outline").click();
    await settle();
    expect(mocks.sent).toContainEqual({ type: "DUSK_PENDING_DECISION", rid: "r1", decision: "reject" });
  });

  it("flags text that needs review", async () => {
    const tricky = { ...input, message: { item: "Dusk‮hoodie", quantity: "2" } };
    await renderShop("sign_typed_data", { ...params(), message: tricky.message, digestHex: hashTypedDataHex(tricky) });
    expect(app.querySelector(".callout.warn")).not.toBeNull();
  });
});

describe("decisions", () => {
  it("says so when an answer doesn't reach the wallet, and stays open to try again", async () => {
    // Firefox's runtime rejects when the background is gone.
    mocks.answers.DUSK_PENDING_DECISION = async () => {
      throw new Error("Receiving end does not exist.");
    };
    // What went wrong, as the browser said it.
    const failed = "Receiving end does not exist.";
    await renderShop("connect", { requestedProfiles: true });
    const error = () => bar().querySelector(".ap-actions__error");
    pastClickGuard();
    approve().click();
    await vi.waitFor(() => expect(error().hidden).toBe(false));
    expect(error().textContent).toContain(failed);
    bar().querySelector(".btn-outline").click();
    await settle();
    expect(error().textContent).toContain(failed);
    expect(dom.window.close).not.toHaveBeenCalled();

    // Locked, Reject says it under the password.
    await renderShop("connect", { requestedProfiles: true }, { isUnlocked: false, accounts: [], duskNames: {} });
    bar().querySelector(".btn-outline").click();
    await vi.waitFor(() => expect(app.querySelector("#approval-unlock-error").hidden).toBe(false));
    expect(app.querySelector("#approval-unlock-error").textContent).toContain(failed);
  });

  it("sends the approval with what the window collected, then closes", async () => {
    await renderShop("connect", { requestedProfiles: true });
    pastClickGuard();
    approve().click();
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
    expect(app.querySelector(".err").textContent).not.toBe("");
    expect(bar().hidden).toBe(true);
  });
});

describe("an approval's button, the moment the window shows", () => {
  const typed = {
    origin: "https://dapp.example",
    domain: { name: "Shop", version: "1", chainId: "dusk:2" },
    types: {
      DuskTypedDataDomain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "string" },
        { name: "verifyingContract", type: "bytes32" },
      ],
      Order: [{ name: "item", type: "string" }],
    },
    primaryType: "Order",
    message: { item: "Dusk hoodie" },
  };
  const { origin: _origin, ...typedParams } = typed;

  it.each([
    ["connect", { requestedProfiles: true }],
    ["sign_message", { chainId: "dusk:2", messageLen: 2, messagePreview: { kind: "text", text: "hi", truncated: false } }],
    ["sign_auth", { chainId: "dusk:2", nonce: "n-1" }],
    ["sign_typed_data", { ...typedParams, digestHex: hashTypedDataHex(typed) }],
    ["send_tx", transfer(BOB)],
    ["switch_network", { to: { networkName: "Mainnet" } }],
    ["watch_asset", { type: "DRC20", options: { contractId: `0x${"11".repeat(32)}` } }],
  ])("ignores a click as it lands from the site that opened it, and takes one a moment later (%s)", async (kind, params) => {
    await render(kind, params);
    // It looks ready as ever meanwhile.
    expect(approve().disabled).toBe(false);
    approve().click();
    await settle();
    expect(decision("approve")).toBeUndefined();

    pastClickGuard();
    approve().click();
    await vi.waitFor(() => expect(decision("approve")).toBeTruthy());
  });

  it("ignores a click as the request shows after an unlock, where Unlock was", async () => {
    await render("send_tx", transfer(BOB), { isUnlocked: false, accounts: [], duskNames: {} });
    mocks.answers.DUSK_UI_UNLOCK = async () => {
      mocks.pending = { ...mocks.pending, isUnlocked: true, accounts: [MAIN, SAVINGS] };
      return { ok: true };
    };
    typeInto(app.querySelector("input[type=password]"), "password");
    bar().querySelector(".btn-primary").click();
    await vi.waitFor(() => expect(app.querySelector("input[type=password]")).toBeNull());
    approve().click();
    await settle();
    expect(decision("approve")).toBeUndefined();

    pastClickGuard();
    approve().click();
    await vi.waitFor(() => expect(decision("approve")).toBeTruthy());
  });
});

// Marek's: the "Keep open" tab closed with an approval open; the wallet locked, and Approve did nothing.
describe("the wallet locking while an approval is open", () => {
  const lockedNow = () => {
    mocks.pending = { ...mocks.pending, isUnlocked: false, accounts: [], duskNames: {} };
  };

  it("asks for the unlock to answer it, rather than leaving an Approve that does nothing", async () => {
    await render("send_tx", transfer(BOB));
    expect(app.querySelector("#approval-password")).toBeNull();
    lockedNow();
    for (const hear of mocks.heard) hear({ type: "DUSK_UI_LOCK_STATE", isUnlocked: false, reason: "engine_closed" });
    // The password to unlock, Reject beside Unlock.
    await vi.waitFor(() => expect(app.querySelector("#approval-password")).not.toBeNull());
    expect(bar().querySelectorAll("button")).toHaveLength(2);
    expect(decision("approve")).toBeUndefined();
  });

  it("asks for the unlock when Approve finds the wallet locked first, and answers nothing", async () => {
    await render("send_tx", transfer(BOB));
    mocks.answers.DUSK_PENDING_DECISION = async () => {
      lockedNow();
      return { ok: false, error: { code: "locked", message: "Unlock to answer." } };
    };
    pastClickGuard();
    approve().click();
    await vi.waitFor(() => expect(app.querySelector("#approval-password")).not.toBeNull());
    expect(dom.window.close).not.toHaveBeenCalled();
    expect(bar().querySelectorAll("button")).toHaveLength(2);
  });
});

// Marek's: Approve as the signal dropped; the approval closed at once, and only the site said "NetworkError".
describe("an approved send on a phone", () => {
  const onPhone = () => vi.stubGlobal("navigator", { ...globalThis.navigator, userAgent: "Mozilla/5.0 (Android 15; Mobile; rv:159.0) Gecko/159.0 Firefox/159.0" });

  it("stays while the wallet hands it to the network, and says in the wallet why nothing went", async () => {
    onPhone();
    await render("send_tx", transfer(BOB));
    pastClickGuard();
    approve().click();
    await vi.waitFor(() => expect(decision("approve")).toBeTruthy());
    await settle();
    expect(dom.window.close).not.toHaveBeenCalled();
    // Sending: nothing left to press meanwhile.
    expect(bar().querySelector("[role=status]")).not.toBeNull();
    expect(bar().querySelectorAll("button")).toHaveLength(0);

    for (const hear of mocks.heard) hear({ type: "DUSK_APPROVAL_SEND_FAILED", rid: "r1", error: { message: "NetworkError when attempting to fetch resource." } });
    await settle();
    // Not sent, said so, and one way back to the site.
    expect(visibleText(app)).toMatch(/\bNot sent\b/);
    expect(bar().querySelectorAll("button")).toHaveLength(1);
    bar().querySelector("button").click();
    await settle();
    expect(mocks.sent.at(-1)).toEqual({ type: "DUSK_APPROVAL_CLOSE", rid: "r1" });
  });

  it("closes as before on a computer, whose window goes with the answer", async () => {
    await render("send_tx", transfer(BOB));
    pastClickGuard();
    approve().click();
    await vi.waitFor(() => expect(dom.window.close).toHaveBeenCalled());
  });
});
