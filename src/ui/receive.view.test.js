import { createLensReader } from "@duskdomains/sdk/lens-reader";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { lookupPrimaryName, lookupShieldedName } from "../shared/duskNames.js";
import { HIDDEN_BALANCE } from "./components/Balance.js";
import { qrSvgString } from "./components/QrCode.js";
import { HIDDEN_CHARACTERS_TEXT, numbersText } from "./components/SafeText.js";
import { installFakeDom, isShown, settle, typeInto, visibleText } from "./testing/fakeDom.js";
import { receiveView } from "./popup/views/receive.js";
import { paidAlreadyText } from "./popup/views/requests.js";
import { txDetailsView } from "./popup/views/txDetails.js";
import { activityKey } from "./popup/activity.js";
import { whenAtText } from "./popup/views/txRow.js";
import { entryOf } from "../shared/fixtures/rows.js";

vi.mock("../shared/duskNames.js", async (importOriginal) => ({
  ...(await importOriginal()),
  lookupPrimaryName: vi.fn(),
  lookupShieldedName: vi.fn(),
}));
// chrome.storage, as a map: where the requests made here are kept.
const items = vi.hoisted(() => ({}));
vi.mock("../shared/storage.js", async (importOriginal) => ({
  ...(await importOriginal()),
  storage: {
    get: async (key) => ({ [key]: structuredClone(items[key]) }),
    set: async (patch) => Object.assign(items, structuredClone(patch)),
    remove: async (keys) => [keys].flat().forEach((key) => delete items[key]),
  },
}));
vi.mock("@duskdomains/sdk/lens-reader", async (importOriginal) => ({
  ...(await importOriginal()),
  createLensReader: vi.fn(),
}));

const ACCOUNT =
  "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927";
const ADDRESS =
  "2Ana1pUpv2ZbMVkwF5FXapYeBEjdxDatLn7nvJkhgTSXbs59SyZSx866bXirPgj8QQVB57uxHJBG1YFvkRbFj4T";

const overview = {
  nodeUrl: "https://testnet.nodes.dusk.network",
  accounts: [ACCOUNT],
  addresses: [ADDRESS],
  selectedAccountIndex: 0,
};

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
  lookupShieldedName.mockReset();
  lookupPrimaryName.mockResolvedValue(null);
  lookupShieldedName.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// Renders Receive as the popup does, and finds the parts the tests read.
async function receive(tab, { state = { receive: { tab } }, ov = overview } = {}) {
  const actions = { render: vi.fn(async () => {}), showToast: vi.fn() };
  dom.document.body.replaceChildren(...receiveView(ov, { state, actions }));
  await settle();
  const [nameField, addressField] = dom.document.body.querySelectorAll(".receive-fields > .receive-field");
  const note = dom.document.body.querySelector(".receive-name-note");
  return {
    name: () => (isShown(nameField) ? visibleText(nameField.querySelector(".receive-field__name")) : ""),
    address: addressField.querySelector(".receive-field__address"),
    shownNote: () => (isShown(note) ? note.textContent : ""),
    // The name's copy, in its field, and the address's.
    nameCopy: nameField.querySelector("button"),
    addressCopy: dom.document.body.querySelector(".receive-copy-address"),
  };
}

// Presses a copy button: what it put on the clipboard, if anything.
async function copiedBy(button) {
  dom.clipboard.writeText.mockClear();
  button.click();
  await settle();
  return dom.clipboard.writeText.mock.calls.at(-1)?.[0];
}

// The buttons by what they do, not their words: Request payment's copy, the one copy in its form; by the
// address, Share in the app (its first button that isn't a copy), and the QR's download, last.
const requestCopy = () => dom.document.body.querySelector(".receive-request button[data-label]");
const addressShare = () => dom.document.body.querySelectorAll(".receive-address-actions button").find((b) => !b.hasAttribute("data-label"));
const qrDownload = () => dom.document.body.querySelectorAll(".receive-address-actions button").at(-1);

// A request as it's copied or shared, whatever its words: what it says, then the link Send reads, last.
function readRequest(text) {
  const [, says, link] = /^([\s\S]*?)(\S+)$/.exec(String(text)) ?? [];
  return { says, link };
}

describe("receive", () => {
  it("shows the name and the whole account, and copies each", async () => {
    lookupPrimaryName.mockResolvedValue("alice.dusk");
    const view = await receive("public");
    expect(view.name()).toBe("alice.dusk");
    // All of it, to read and compare.
    expect(visibleText(view.address)).toBe(ACCOUNT);
    expect(await copiedBy(view.nameCopy)).toBe("alice.dusk");
    expect(await copiedBy(view.addressCopy)).toBe(ACCOUNT);
  });

  it("names the shielded address only when the name's record is that address", async () => {
    // The account has a name, but its phoenix_payment_endpoint is not this address.
    lookupPrimaryName.mockResolvedValue("alice.dusk");
    let view = await receive("shielded", { state: { receive: { tab: "shielded" } } });
    expect(lookupShieldedName).toHaveBeenCalledWith(ACCOUNT, ADDRESS, { nodeUrl: overview.nodeUrl });
    expect([view.name(), view.shownNote()]).toEqual(["", ""]);
    expect(visibleText(view.address)).toBe(ADDRESS);
    expect(await copiedBy(view.addressCopy)).toBe(ADDRESS);

    lookupShieldedName.mockResolvedValue("alice.dusk");
    view = await receive("shielded");
    expect(view.name()).toBe("alice.dusk");
    // Said under it: anyone can see the name pays this address.
    expect(view.shownNote()).toMatch(/alice\.dusk/);
    expect(await copiedBy(view.addressCopy)).toBe(ADDRESS);
  });

  it("shows and copies no name once a lookup a minute on finds it cleared", async () => {
    // The real lookups, with the lens reader standing in for the node.
    const real = await vi.importActual("../shared/duskNames.js");
    lookupPrimaryName.mockImplementation(real.lookupPrimaryName);
    const verifyPrimary = vi.fn(async () => ({ primary: { spelling: "alice.dusk" } }));
    createLensReader.mockResolvedValue({ verifyPrimary });
    vi.useFakeTimers({ toFake: ["Date"] });

    let view = await receive("public");
    await vi.waitFor(() => expect(view.name()).toBe("alice.dusk"));

    // A minute on, the account has no primary name any more.
    vi.advanceTimersByTime(61_000);
    verifyPrimary.mockResolvedValue(null);
    view = await receive("public");
    await vi.waitFor(() => expect(verifyPrimary).toHaveBeenCalledTimes(2));
    await settle();
    expect([view.name(), view.shownNote()]).toEqual(["", ""]);
    expect(await copiedBy(view.nameCopy)).toBeUndefined();
  });

  it("copies the request link from Request payment once the QR holds a request", async () => {
    const state = { receive: { tab: "public", requestOpen: true, amountDusk: "", memo: "" } };
    await receive("public", { state });
    expect(requestCopy().disabled).toBe(true);

    state.receive.amountDusk = "1.5";
    await receive("public", { state });
    expect(requestCopy().disabled).toBe(false);
    requestCopy().click();
    await settle();
    const asked = readRequest(dom.clipboard.writeText.mock.calls.at(-1)[0]);
    // A line a person reads, then the web wallet's Send on the network it's for, which survives email and chat.
    expect(asked.says).toMatch(/\b1\.5 DUSK/);
    expect(asked.link).toBe(`https://apps.testnet.dusk.network/wallet/dashboard/send?to=${ACCOUNT}&amount=1.5&network=testnet`);
    // The QR holds the same request, for a wallet to read.
    expect(dom.document.body.querySelector(".qr-inner").innerHTML).toBe(qrSvgString(`dusk:public-${ACCOUNT}@dusk:2?amount=1.5`));
  });

  it("copies a shielded request with its memo, and the dusk: link where the network has no web wallet", async () => {
    const state = { receive: { tab: "shielded", requestOpen: true, amountDusk: "", memo: "Factura 33" } };
    await receive("shielded", { state });
    requestCopy().click();
    await settle();
    let asked = readRequest(dom.clipboard.writeText.mock.calls.at(-1)[0]);
    // Its memo, and no amount: any will do.
    expect(asked.says).toMatch(/Factura 33/);
    expect(asked.says).not.toMatch(/\d DUSK/);
    expect(asked.link).toBe(`https://apps.testnet.dusk.network/wallet/dashboard/send?to=${ADDRESS}&memo=Factura+33&network=testnet`);

    // A chain there's no file for: nothing to open, so the link a wallet reads.
    state.receive.tab = "public";
    await receive("public", { state, ov: { ...overview, nodeUrl: "https://node.example", chainId: 42 } });
    requestCopy().click();
    await settle();
    asked = readRequest(dom.clipboard.writeText.mock.calls.at(-1)[0]);
    expect(asked.says).toMatch(/Factura 33/);
    expect(asked.link).toBe(`dusk:public-${ACCOUNT}@dusk:42?memo=Factura+33`);
  });

  // Chen's: the request says who asks by the name given the profile here, where it has no .dusk name.
  it("copies a request with the name given the profile here, where it has no .dusk name", async () => {
    const state = { receive: { tab: "public", requestOpen: true, amountDusk: "0.02", memo: "chicken rice" } };
    await receive("public", { state, ov: { ...overview, networkName: "Testnet", accountNames: { 0: "Chen" } } });
    requestCopy().click();
    await settle();
    const asked = readRequest(dom.clipboard.writeText.mock.calls.at(-1)[0]);
    // Who asks, for what, on which test network, and its memo.
    for (const value of [/Chen/, /\b0\.02 DUSK/, /Testnet/, /chicken rice/]) expect(asked.says).toMatch(value);
    expect(asked.link).toBe(`https://apps.testnet.dusk.network/wallet/dashboard/send?to=${ACCOUNT}&amount=0.02&memo=chicken+rice&network=testnet`);
  });

  it("asks for a network by the chain a custom node signs for", async () => {
    const state = { receive: { tab: "public", requestOpen: true, amountDusk: "1", memo: "" } };
    await receive("public", { state, ov: { ...overview, nodeUrl: "https://node.example", chainId: 1 } });
    requestCopy().click();
    await settle();
    const asked = readRequest(dom.clipboard.writeText.mock.calls.at(-1)[0]);
    expect(asked.says).toMatch(/\b1 DUSK/);
    expect(asked.link).toBe(`https://apps.dusk.network/wallet/dashboard/send?to=${ACCOUNT}&amount=1&network=mainnet`);
  });

  // Sofía's first wish for three rounds: her clients to see what they pay in their own money, euros.
  it("says what a request asks comes to in your currency on mainnet, with the price's time, the link still in DUSK, and nothing on testnet", async () => {
    vi.stubGlobal("navigator", { ...globalThis.navigator, language: "es-ES" });
    const shown = (selector) => {
      const el = dom.document.body.querySelector(selector);
      return el && isShown(el) ? el.textContent : "";
    };
    const state = { receive: { tab: "public", requestOpen: true, amountDusk: "30", memo: "Factura 2026-133" } };
    await receive("public", { state, ov: { ...overview, nodeUrl: "https://nodes.dusk.network" } });
    // 30 DUSK in euros, and when its price was read.
    await vi.waitFor(() => expect(shown(".receive-in-currency")).toMatch(/1,82\s€/));
    expect(shown(".receive-in-currency")).toMatch(/\d{2}:\d{2}/);
    requestCopy().click();
    await settle();
    // What's asked stays in DUSK.
    const asked = readRequest(dom.clipboard.writeText.mock.calls.at(-1)[0]);
    expect(asked.says).toMatch(/\b30 DUSK/);
    expect(asked.says).not.toMatch(/€/);
    expect(asked.link).toBe(`https://apps.dusk.network/wallet/dashboard/send?to=${ACCOUNT}&amount=30&memo=Factura+2026-133&network=mainnet`);
    // The request kept in the list says it too.
    await vi.waitFor(() => expect(shown(".request-row__in-currency")).toMatch(/1,82\s€/));

    // Test DUSK has no value: nothing said, nothing asked.
    coingecko.mockClear();
    await receive("public", { state });
    expect([shown(".receive-in-currency"), coingecko.mock.calls]).toEqual(["", []]);
  });

  it("asks for the amount a decimal comma writes", async () => {
    const state = { receive: { tab: "public", requestOpen: true, amountDusk: "1,5", memo: "" } };
    await receive("public", { state });
    requestCopy().click();
    await settle();
    const [link] = dom.clipboard.writeText.mock.calls.at(-1);
    expect(link).toContain("amount=1.5");
  });

  describe("Request payment's checks, the ones Send has", () => {
    const open = (over) => ({ receive: { tab: "public", requestOpen: true, amountDusk: "", memo: "", ...over } });
    const shown = (selector) => {
      const el = dom.document.body.querySelector(selector);
      return el && isShown(el) ? el.textContent : "";
    };
    const amountError = () => shown(".receive-amount-error");
    const meta = () => dom.document.body.querySelector(".receive-request__meta").textContent;
    const inLanguage = (language) => vi.stubGlobal("navigator", { ...globalThis.navigator, language });

    // Why, by what the words hold: an amount of nothing, one that can't be read, more decimals than DUSK's 9.
    it.each([
      ["0", /\b0\b/],
      ["0.000", /\b0\b/],
      ["abc", /\S/],
      ["0.1234567891", /\b9\b/],
    ])("won't make a link for %s, and says why, with nothing claimed above it", async (amountDusk, why) => {
      inLanguage("en-US");
      await receive("public", { state: open({ amountDusk, memo: "Lunch" }) });
      expect(amountError()).toMatch(why);
      expect(requestCopy().disabled).toBe(true);
      expect(meta()).toBe("");
    });

    // Nandini's and Chen's: the question had no buttons, and asked to retype.
    it("says an amount that could be two amounts is that, in the language's own way, with a button for each", async () => {
      // The readings it offers, a button each.
      const readings = () => dom.document.body.querySelectorAll(".receive-amount-error button");
      inLanguage("nl-NL");
      await receive("public", { state: open({ amountDusk: "1.234" }) });
      expect(readings().map(visibleText)).toEqual(["1,2340 DUSK", "1234 DUSK"]);
      expect(requestCopy().disabled).toBe(true);
      inLanguage("en-US");
      await receive("public", { state: open({ amountDusk: "1,234" }) });
      expect(readings().map(visibleText)).toEqual(["1.2340 DUSK", "1234 DUSK"]);
      expect(requestCopy().disabled).toBe(true);
      // A reading tapped: in the field, which asks nothing, and the request can go.
      readings()[0].click();
      await settle();
      expect([dom.document.body.querySelector(".receive-request input").value, amountError(), requestCopy().disabled]).toEqual(["1.2340", "", false]);
    });

    it("takes an amount still being typed, and reads it as the plain amount the link asks for", async () => {
      inLanguage("en-US");
      await receive("public", { state: open({ amountDusk: "1." }) });
      expect(amountError()).toBe("");
      requestCopy().click();
      await settle();
      expect(dom.clipboard.writeText.mock.calls.at(-1)[0]).toContain("amount=1");
    });

    it("won't make a link with a memo over 512 bytes, counted in bytes as Send counts them", async () => {
      inLanguage("en-US");
      await receive("public", { state: open({ memo: "é".repeat(257) }) });
      expect(shown(".memo-error")).toMatch(/\b512\b/);
      expect(requestCopy().disabled).toBe(true);
      expect(meta()).toBe("");
      await receive("public", { state: open({ memo: "é".repeat(256) }) });
      expect(shown(".memo-error")).toBe("");
      expect(requestCopy().disabled).toBe(false);
    });

    // Marek's: a memo with a direction override read "r22 x req" in the field, and nothing said it until it was in the list.
    it("shows a memo's hidden characters as codes under the field, and what to check, before the link is copied", async () => {
      inLanguage("en-US");
      const memoShown = () => shown(".receive-memo-shown");
      await receive("public", { state: open({ memo: "r22 x \u202eqer" }) });
      // As the payer will see it: the override as its code, never itself, and said so.
      expect(memoShown()).toContain("r22 x \\u202eqer");
      expect(memoShown()).toContain(HIDDEN_CHARACTERS_TEXT);
      expect(memoShown()).not.toContain("\u202e");
      expect(requestCopy().disabled).toBe(false);
      // A look-alike digit says what to check; a plain memo says nothing.
      await receive("public", { state: open({ memo: "Invoice \u09ea" }) });
      expect(memoShown()).toContain(numbersText({ lookalikeDigits: true }));
      await receive("public", { state: open({ memo: "Lunch" }) });
      expect(memoShown()).toBe("");
    });

    it("says nothing with the panel closed, and claims nothing for what wouldn't do", async () => {
      inLanguage("en-US");
      await receive("public", { state: { receive: { tab: "public", requestOpen: false, amountDusk: "abc", memo: "Lunch" } } });
      expect(amountError()).toBe("");
      expect(meta()).toBe("");
      // One that would do: said to be there.
      await receive("public", { state: { receive: { tab: "public", requestOpen: false, amountDusk: "1", memo: "Lunch" } } });
      expect(meta()).not.toBe("");
    });
  });

  // Lena's: the app offered no dusk: link, which opens the app's own Send.
  it("copies the app's dusk: link in the app, of the account or of the request", async () => {
    dom.document.body.dataset.runtime = "tauri";
    dom.window.matchMedia = () => ({ matches: true });
    dom.window.__TAURI_INTERNALS__ = { invoke: vi.fn(async () => null) };
    vi.stubGlobal("navigator", { ...globalThis.navigator, userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 6; wv) Chrome/156.0 Mobile Safari/537.36" });
    // The copy by the address that isn't the address's own.
    const appLink = () => dom.document.body.querySelectorAll(".receive-address-actions button[data-label]").find((b) => !b.classList.contains("receive-copy-address"));
    await receive("public");
    expect(await copiedBy(appLink())).toBe(`dusk:public-${ACCOUNT}@dusk:2`);
    await receive("public", { state: { receive: { tab: "public", requestOpen: true, amountDusk: "0.03", memo: "Invoice 114" } } });
    expect(await copiedBy(appLink())).toBe(`dusk:public-${ACCOUNT}@dusk:2?amount=0.03&memo=Invoice+114`);
  });

  // Sofía's: Share sent one bare long web link; and then the client got only a ~270-character link, no sentence.
  it("shares a request in the app as a line of who asks for what, and its link", async () => {
    dom.document.body.dataset.runtime = "tauri";
    dom.window.matchMedia = () => ({ matches: true });
    const invoke = vi.fn(async () => null);
    dom.window.__TAURI_INTERNALS__ = { invoke };
    vi.stubGlobal("navigator", { ...globalThis.navigator, userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 6; wv) Chrome/156.0 Mobile Safari/537.36" });
    const state = { receive: { tab: "public", requestOpen: true, amountDusk: "0.03", memo: "Invoice 2026-115" } };
    const actions = { render: vi.fn(async () => {}), showToast: vi.fn() };
    lookupPrimaryName.mockResolvedValue("sofiadesign.dusk");
    dom.document.body.replaceChildren(...receiveView({ ...overview, networkName: "Testnet" }, { state, actions }));
    await settle();
    // The request's own Share, beside its Copy.
    dom.document.body.querySelectorAll(".receive-request__actions button").find((b) => !b.hasAttribute("data-label")).click();
    await vi.waitFor(() => expect(invoke.mock.calls.some(([cmd]) => cmd === "share_text")).toBe(true));
    const [, args] = invoke.mock.calls.find(([cmd]) => cmd === "share_text");
    const shared = readRequest(args.text);
    // Who asks, for what, on which test network, and its memo; then the link Send reads.
    for (const value of [/sofiadesign\.dusk/, /\b0\.03 DUSK/, /Testnet/, /Invoice 2026-115/]) expect(shared.says).toMatch(value);
    expect(shared.link).toBe(`https://apps.testnet.dusk.network/wallet/dashboard/send?to=${ACCOUNT}&amount=0.03&memo=Invoice+2026-115&network=testnet`);

    // The Share by the address shares the address, the request open or not.
    invoke.mockClear();
    addressShare().click();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("share_text", expect.objectContaining({ text: ACCOUNT }), undefined));
  });

  it("starts a request over when the profile switches, rather than asking for it on the other one", async () => {
    const { switchContext } = await import("./popup/context.js");
    const state = {};
    switchContext(state);
    await receive("public", { state });
    const fields = () => dom.document.body.querySelectorAll(".receive-request .advanced-body input");
    typeInto(fields()[0], "0.03");
    typeInto(fields()[1], "Invoice 2026-081");
    Object.assign(state.receive, { requestOpen: true, amountDusk: "0.03", memo: "Invoice 2026-081" });
    await receive("public", { state, ov: { ...overview, accounts: [ACCOUNT, ADDRESS], selectedAccountIndex: 0 } });
    expect(fields().map((f) => f.value)).toEqual(["0.03", "Invoice 2026-081"]);

    // Profile 2 picked from the header: a switch, as the popup marks it.
    switchContext(state);
    await receive("public", { state, ov: { ...overview, accounts: [ACCOUNT, ADDRESS], selectedAccountIndex: 1 } });
    expect(fields().map((f) => f.value)).toEqual(["", ""]);
    expect(state.receive.requestOpen).toBe(false);
  });
});

describe("the requests made here", () => {
  const KEY = "dusk_payment_requests_v1";
  const unlocked = { ...overview, isUnlocked: true };
  const T0 = Date.UTC(2026, 10, 5, 9, 0);
  const HOUR = 3_600_000;
  // What came in, as the archive's history gives it.
  const paidIn = (hash, value, memo, at, blockHeight = 4_687_000) =>
    entryOf({ blockHeight, counterparty: "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz", direction: "in", hash, memo, timestamp: at, value });
  const kept = (fields) => ({ at: T0, id: fields.id, lux: null, memo: "", network: "testnet", to: ACCOUNT, ...fields });
  const rows = () => dom.document.body.querySelectorAll(".request-row");
  // Each request listed: what it asks, and its state, in the words the web wallet uses (none is exported to compare with).
  const shown = () =>
    rows().map((row) => ({
      amount: visibleText(row.querySelector(".request-row__amount")),
      state: visibleText(row.querySelector(".request-state")),
    }));
  // What a card says came in for it.
  const matchOf = (row) => visibleText(row.querySelector(".request-row__match"));
  // A card's buttons by what they are: its copy, Share in the app (the one before Remove), and Remove, last.
  const copyOf = (row) => row.querySelector(".request-row__actions button[data-label]");
  const actionsOf = (row) => row.querySelectorAll(".request-row__actions button");
  // The question before a request paid already goes out again, and its first button: Copy, Share or Download anyway.
  const anywayIn = (where) => where.querySelector(".request-paid-ask button");
  // A payment's Send back: its button that isn't See payment.
  const sendBack = (payment) => payment.querySelectorAll("button").find((b) => !b.classList.contains("chain-link"));
  const draw = async (state) => {
    const actions = { render: vi.fn(async () => dom.document.body.replaceChildren(...receiveView(unlocked, { state, actions }))), showToast: vi.fn() };
    await actions.render();
    await vi.waitFor(() => expect(state.requests?.loaded).toBe(true));
    await actions.render();
    return actions;
  };

  beforeEach(() => {
    for (const key of Object.keys(items)) delete items[key];
  });

  // Amélie's: Lucas's new request said "Check it's this one" of a payment she'd made two minutes before he asked.
  // Sofía's: an unpaid invoice said "Check" for an hour as another invoice of the same amount was paid.
  it("counts no payment made before a request was asked, nor one whose memo is another request's, for it", async () => {
    items[KEY] = {
      [ACCOUNT]: [
        kept({ id: "tulips", lux: "10000000", memo: "Les tulipes de dimanche", at: T0 + 2 * 60_000 }),
        kept({ id: "f101", lux: "30000000", memo: "Factura F-2026-101", at: T0 + HOUR }),
        kept({ id: "f102", lux: "30000000", memo: "Factura F-2026-102", at: T0 + HOUR + 60_000 }),
      ],
    };
    const entries = [
      // Two minutes before Lucas asked: same amount, another memo.
      paidIn("b1".repeat(32), "10000000", "Wi-Fi coupé r35", T0, 4_687_000),
      // F-2026-102 paid, the same amount as F-2026-101.
      paidIn("b2".repeat(32), "30000000", "Factura F-2026-102", T0 + 2 * HOUR, 4_687_700),
    ];
    const state = { receive: { tab: "public" }, activity: { key: activityKey(unlocked), entries, names: new Map() } };
    await draw(state);
    await vi.waitFor(() => expect(shown().map((row) => row.state)).toContain("Paid"));
    // Each request by its own memo.
    const stateOf = (memo) => visibleText(rows().find((row) => visibleText(row.querySelector(".request-row__memo")).includes(memo)).querySelector(".request-state"));
    expect(["Les tulipes de dimanche", "Factura F-2026-101", "Factura F-2026-102"].map(stateOf)).toEqual(["Waiting", "Waiting", "Paid"]);
  });

  it("keeps a request as its link is copied, once, and lists it as waiting", async () => {
    const state = { receive: { tab: "public", requestOpen: true, amountDusk: "1.25", memo: "Factura 33" } };
    await draw(state);
    expect(shown()).toEqual([]);

    requestCopy().click();
    await vi.waitFor(() => expect(shown()).toHaveLength(1));
    expect(shown()).toEqual([{ amount: "1.25 DUSK", state: "Waiting" }]);
    expect(items[KEY][ACCOUNT]).toEqual([expect.objectContaining({ lux: "1250000000", memo: "Factura 33", network: "testnet", to: ACCOUNT })]);

    // The same one copied again is the same request.
    requestCopy().click();
    await settle();
    expect(items[KEY][ACCOUNT]).toHaveLength(1);

    // Sofía's and Chen's: the list's Copy link gave the bare link. Its Copy request gives what the form's gave.
    const fromForm = dom.clipboard.writeText.mock.lastCall?.[0];
    const asked = readRequest(fromForm);
    expect(asked.says).toMatch(/\b1\.25 DUSK/);
    expect(asked.says).toMatch(/Factura 33/);
    expect(asked.link).toBe(`https://apps.testnet.dusk.network/wallet/dashboard/send?to=${ACCOUNT}&amount=1.25&memo=Factura+33&network=testnet`);
    dom.clipboard.writeText.mockClear();
    copyOf(rows()[0]).click();
    await settle();
    expect(dom.clipboard.writeText.mock.calls).toEqual([[fromForm]]);
  });

  // Sofía's, in the app: Copy request on an invoice paid already, the form still filled in, made a second
  // request with the same invoice number, Waiting, which a client could pay again. Then Sofía's, Nandini's, Marek's
  // and Chen's: copying or sharing it said only "Copied", and the one toast that said more hid under Android's
  // clipboard preview.
  it("asks on the form before a request paid already is copied or downloaded again, copies it only on Copy anyway, and keeps no second one", async () => {
    items[KEY] = { [ACCOUNT]: [kept({ id: "a", lux: "10000000", memo: "Factura 2026-151" })] };
    const entries = [paidIn("a1".repeat(32), "10000000", "Factura 2026-151", T0 + HOUR)];
    const state = { receive: { tab: "public", requestOpen: true, amountDusk: "0.01", memo: "Factura 2026-151" }, activity: { key: activityKey(unlocked), entries, names: new Map() } };
    const actions = await draw(state);
    await vi.waitFor(() => expect(shown().map((row) => row.state)).toEqual(["Paid"]));
    const formAsk = () => dom.document.body.querySelector(".receive-request .request-paid-ask");
    const asked = () => (isShown(formAsk()) ? visibleText(formAsk()) : "");
    // Its answers: anyway, then Cancel.
    const answer = (i) => formAsk().querySelectorAll("button")[i].click();
    const SAID = paidAlreadyText(T0 + HOUR);

    // Nothing copied yet: asked first, on the form itself.
    dom.clipboard.writeText.mockClear();
    requestCopy().click();
    await settle();
    expect(asked()).toContain(SAID);
    expect(dom.clipboard.writeText).not.toHaveBeenCalled();
    // Kept through a redraw; Cancel, and nothing is copied.
    await actions.render();
    expect(asked()).toContain(SAID);
    answer(1);
    expect(asked()).toBe("");
    expect(dom.clipboard.writeText).not.toHaveBeenCalled();
    // Copy anyway: the request it was asked with, as before, and no second request.
    requestCopy().click();
    await settle();
    answer(0);
    await settle();
    expect(String(dom.clipboard.writeText.mock.lastCall?.[0] ?? "")).toContain("memo=Factura+2026-151");
    expect(asked()).toBe("");
    expect(items[KEY][ACCOUNT].map((r) => r.id)).toEqual(["a"]);
    expect(shown().map((row) => row.state)).toEqual(["Paid"]);
    // Its QR too: asked first.
    qrDownload().click();
    await settle();
    expect(dom.document.body.querySelectorAll(".request-paid-ask").filter(isShown).map(visibleText)).toEqual([expect.stringContaining(SAID)]);
  });

  // Sofía's, Nandini's, Marek's and Chen's: a request in the list paid already said only "Copied" as its Copy link
  // gave it out again, and its Share sent a fresh "asks you to pay".
  it("says on a paid request's card that it was paid, and when, beside its Copy and Share, which ask first there", async () => {
    dom.document.body.dataset.runtime = "tauri";
    dom.window.matchMedia = () => ({ matches: true });
    const invoke = vi.fn(async () => null);
    dom.window.__TAURI_INTERNALS__ = { invoke };
    vi.stubGlobal("navigator", { ...globalThis.navigator, userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 6; wv) Chrome/156.0 Mobile Safari/537.36" });
    items[KEY] = { [ACCOUNT]: [kept({ id: "a", lux: "16000000", memo: "Factura 117" }), kept({ id: "b", lux: "20000000", memo: "Factura 118", at: T0 + 30_000 })] };
    const entries = [paidIn("a2".repeat(32), "16000000", "Factura 117", T0 + 2 * HOUR, 4_687_100), paidIn("a1".repeat(32), "16000000", "Factura 117", T0 + HOUR, 4_687_000)];
    const state = { route: "receive", receive: { tab: "public" }, activity: { key: activityKey(unlocked), entries, names: new Map() } };
    const actions = await draw(state);
    const [paid, waiting] = rows();
    // When it was first paid, on its card; nothing of the kind on the one waiting.
    expect(visibleText(paid.querySelector(".request-row__paid"))).toContain(whenAtText(T0 + HOUR));
    expect(waiting.querySelector(".request-row__paid")).toBeNull();
    const ask = () => {
      const el = dom.document.body.querySelector(".request-row .request-paid-ask");
      return el && isShown(el) ? visibleText(el) : "";
    };

    actionsOf(paid).at(-2).click();
    await settle();
    expect(ask()).toContain(paidAlreadyText(T0 + HOUR));
    expect(invoke.mock.calls.some(([cmd]) => cmd === "share_text")).toBe(false);
    anywayIn(rows()[0]).click();
    await vi.waitFor(() => expect(invoke.mock.calls.some(([cmd]) => cmd === "share_text")).toBe(true));
    const [, shared] = invoke.mock.calls.find(([cmd]) => cmd === "share_text");

    dom.clipboard.writeText.mockClear();
    copyOf(rows()[0]).click();
    await settle();
    expect(dom.clipboard.writeText).not.toHaveBeenCalled();
    await actions.render();
    expect(ask()).toContain(paidAlreadyText(T0 + HOUR));
    anywayIn(rows()[0]).click();
    await settle();
    // Sofía's and Chen's: Copy link gave the bare link, Share the whole message. Copy request gives what Share gives.
    expect(dom.clipboard.writeText).toHaveBeenLastCalledWith(shared.text);
    const again = readRequest(shared.text);
    expect(again.says).toMatch(/\b0\.016 DUSK/);
    expect(again.says).toMatch(/Factura 117/);
    expect(again.link).toBe(`https://apps.testnet.dusk.network/wallet/dashboard/send?to=${ACCOUNT}&amount=0.016&memo=Factura+117&network=testnet`);
    // One not paid gives its request at once.
    copyOf(rows()[1]).click();
    await settle();
    const other = readRequest(dom.clipboard.writeText.mock.lastCall?.[0]);
    expect(other.says).toMatch(/\b0\.02 DUSK/);
    expect(other.says).toMatch(/Factura 118/);
    expect(other.link).toBe(`https://apps.testnet.dusk.network/wallet/dashboard/send?to=${ACCOUNT}&amount=0.02&memo=Factura+118&network=testnet`);
  });

  it("says what came in for each: paid, to check, or paid twice, each payment to open, and keeps what paid", async () => {
    items[KEY] = {
      [ACCOUNT]: [
        kept({ id: "a", lux: "1250000000", memo: "Factura 33" }),
        kept({ id: "b", lux: "2000000000", memo: "Factura 34" }),
        // W23's: a deposit of any amount, paid with its memo, and again.
        kept({ id: "c", memo: "anticipo" }),
        // Another network's, and another profile's: not here.
        kept({ id: "d", lux: "5", memo: "x", network: "mainnet" }),
        kept({ id: "e", lux: "5", memo: "y", to: "z".repeat(60) }),
      ],
    };
    const entries = [
      paidIn("a1".repeat(32), "1250000000", "Factura 33", T0 + HOUR),
      paidIn("b1".repeat(32), "2000000000", "Other", T0 + 2 * HOUR),
      paidIn("c1".repeat(32), "700000000", "anticipo", T0 + 3 * HOUR),
      paidIn("c2".repeat(32), "300000000", "anticipo", T0 + 4 * HOUR),
    ];
    const state = { receive: { tab: "public" }, activity: { key: activityKey(unlocked), entries, names: new Map() } };
    const actions = await draw(state);

    expect(shown()).toEqual([{ amount: "1.25 DUSK", state: "Paid" }, { amount: "2 DUSK", state: "Check" }, expect.objectContaining({ state: "Paid twice" })]);
    // What came in and when; for the one to check, the memo it came with; and how many paid twice.
    const [paid, check, twice] = rows().map(matchOf);
    expect(paid).toMatch(/\b1\.25 DUSK/);
    expect(paid).toContain(whenAtText(T0 + HOUR));
    expect(check).toContain(whenAtText(T0 + 2 * HOUR));
    expect(check).toContain("Other");
    expect(twice).toMatch(/\b2\b/);
    // What paid stays paid, kept with its request and what it paid.
    await vi.waitFor(() => expect(items[KEY][ACCOUNT].find((r) => r.id === "a").paid).toEqual({ at: T0 + HOUR, hash: "a1".repeat(32), lux: "1250000000" }));

    // Paid twice: each payment, what it brought and when, to see; the second to send back.
    const payments = () => rows()[2].querySelectorAll(".request-row__payments li");
    // To the second: two in the same minute read apart (Sofía's).
    const seconds = { seconds: true };
    expect(payments().map((li) => visibleText(li.querySelector(".request-payment__what")))).toEqual([
      `0.7 DUSK ${whenAtText(T0 + 3 * HOUR, Date.now(), seconds)}`,
      `0.3 DUSK ${whenAtText(T0 + 4 * HOUR, Date.now(), seconds)}`,
    ]);
    expect(payments().map((li) => Boolean(sendBack(li)))).toEqual([false, true]);
    // A payment opens in its details, and comes back here.
    payments()[1].querySelector(".chain-link").click();
    expect([state.route, state.txDetailHash, state.txDetailFrom]).toEqual(["tx", "c2".repeat(32), "receive"]);

    // Remove takes one off, here and where it's kept.
    state.route = "receive";
    await actions.render();
    actionsOf(rows()[1]).at(-1).click();
    await vi.waitFor(() => expect(shown().map((row) => row.state)).toEqual(["Paid", "Paid twice"]));
    expect(items[KEY][ACCOUNT].map((r) => r.id)).toEqual(["a", "c", "d", "e"]);
  });

  it("says what came in on every Paid request, one of any amount too, also once its payment is too far back to read", async () => {
    // Marek's: a request of any amount paid with its memo and one lux said Paid, and nothing of how much.
    items[KEY] = {
      [ACCOUNT]: [
        kept({ id: "a", memo: "r18 open" }),
        // Sofia's: kept paid by an earlier visit, its payment off the page now.
        kept({ id: "b", memo: "Anticipo Proyecto Sol", paid: { at: T0 + 2 * HOUR, hash: "b1".repeat(32), lux: "20000000" } }),
        // Kept paid by an earlier version, which kept no amount.
        kept({ id: "c", memo: "Older", paid: { at: T0 + 3 * HOUR, hash: "c1".repeat(32) } }),
        kept({ id: "d", lux: "10000000", memo: "Fixed", at: T0 + 4 * HOUR }),
      ],
    };
    const entries = [paidIn("a1".repeat(32), "1", "r18 open", T0 + HOUR), paidIn("d1".repeat(32), "10000000", "Fixed", T0 + 5 * HOUR)];
    const state = { receive: { tab: "public" }, activity: { key: activityKey(unlocked), entries, names: new Map() } };
    await draw(state);
    const badges = () => rows().map((row) => visibleText(row.querySelector(".request-state")));
    // A request of any amount says what came in: one lux reads as that, not as Paid. One of an amount asked says Paid.
    expect(badges()).toEqual(["0.000000001 DUSK", "0.02 DUSK", "Paid", "Paid"]);
    const [first, second] = rows().map(matchOf);
    expect(first).toMatch(/\b0\.000000001 DUSK/);
    expect(first).toContain(whenAtText(T0 + HOUR));
    expect(second).toMatch(/\b0\.02 DUSK/);
    expect(second).toContain(whenAtText(T0 + 2 * HOUR));
    await vi.waitFor(() => expect(items[KEY][ACCOUNT].find((r) => r.id === "a").paid).toEqual({ at: T0 + HOUR, hash: "a1".repeat(32), lux: "1" }));

    // With balances hidden, what came in is too.
    const hiddenState = { receive: { tab: "public" }, activity: state.activity };
    const actions = { render: vi.fn(async () => dom.document.body.replaceChildren(...receiveView({ ...unlocked, hideBalances: true }, { state: hiddenState, actions }))), showToast: vi.fn() };
    await actions.render();
    await vi.waitFor(() => expect(hiddenState.requests?.loaded).toBe(true));
    await actions.render();
    expect(badges().slice(0, 2)).toEqual([`${HIDDEN_BALANCE} DUSK`, `${HIDDEN_BALANCE} DUSK`]);
    for (const line of rows().slice(0, 2).map(matchOf)) {
      expect(line).toContain(HIDDEN_BALANCE);
      expect(line).not.toMatch(/0\.000000001|0\.02/);
    }
  });

  // Sofía's: after Send back, the request still offered it, and said nothing of it.
  it("says when a payment was sent back, and offers no Send back for it again; and copies the request", async () => {
    items[KEY] = { [ACCOUNT]: [kept({ id: "a", lux: "16000000", memo: "Factura 117" })] };
    const SENDER = "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";
    const entries = [
      // The refund, after the second payment, in a later block.
      entryOf({ blockHeight: 4_687_200, counterparty: SENDER, direction: "out", hash: "b1".repeat(32), memo: "Refund: Factura 117", timestamp: T0 + 3 * HOUR, value: "16000000" }),
      paidIn("a2".repeat(32), "16000000", "Factura 117", T0 + 2 * HOUR, 4_687_100),
      paidIn("a1".repeat(32), "16000000", "Factura 117", T0 + HOUR, 4_687_000),
    ];
    const state = { route: "receive", receive: { tab: "public" }, activity: { key: activityKey(unlocked), entries, names: new Map() } };
    await draw(state);
    const second = dom.document.body.querySelectorAll(".request-row__payments li")[1];
    expect(sendBack(second)).toBeUndefined();
    expect(visibleText(second.querySelector(".request-payment__sent"))).toContain(whenAtText(T0 + 3 * HOUR, Date.now(), { seconds: true }));

    // The request, its words and link, to copy again (the web wallet's list has it), once it's said it was paid already.
    copyOf(rows()[0]).click();
    await settle();
    anywayIn(rows()[0]).click();
    await settle();
    const asked = readRequest(dom.clipboard.writeText.mock.lastCall?.[0]);
    expect(asked.says).toMatch(/\b0\.016 DUSK/);
    expect(asked.says).toMatch(/Factura 117/);
    expect(asked.link).toBe(`https://apps.testnet.dusk.network/wallet/dashboard/send?to=${ACCOUNT}&amount=0.016&memo=Factura+117&network=testnet`);
  });

  it("sends back a payment that paid a request again: to whoever sent it, what it brought, with the request's memo", async () => {
    // Sofia's: paid twice, and no way to refund but filling Send in by hand.
    items[KEY] = { [ACCOUNT]: [kept({ id: "a", lux: "16000000", memo: "Factura 2026-074 Ilustración" })] };
    const SENDER = "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";
    const entries = [paidIn("a1".repeat(32), "16000000", "Factura 2026-074 Ilustración", T0 + HOUR), paidIn("a2".repeat(32), "16000000", "Factura 2026-074 Ilustración", T0 + 2 * HOUR)];
    const state = { route: "receive", receive: { tab: "public" }, activity: { key: activityKey(unlocked), entries, names: new Map() } };
    await draw(state);
    expect(shown()[0]).toMatchObject({ state: "Paid twice" });
    const back = () => dom.document.body.querySelectorAll(".request-row__payments li").map(sendBack).find(Boolean);
    back().click();
    expect(state.route).toBe("send");
    expect(state.draft).toMatchObject({ to: SENDER, amountDusk: "0.016", amountMasked: false, memo: "Refund: Factura 2026-074 Ilustración" });

    // With balances hidden, the amount it fills in stays hidden on Send and Review.
    const hiddenState = { route: "receive", receive: { tab: "public" }, activity: state.activity };
    const actions = { render: vi.fn(async () => dom.document.body.replaceChildren(...receiveView({ ...unlocked, hideBalances: true }, { state: hiddenState, actions }))), showToast: vi.fn() };
    await actions.render();
    await vi.waitFor(() => expect(hiddenState.requests?.loaded).toBe(true));
    await actions.render();
    back().click();
    expect(hiddenState.draft).toMatchObject({ to: SENDER, amountDusk: "0.016", amountMasked: true });
  });

  it("finds a payment past the page Activity shows: one paid while closed, with more than a page after it", async () => {
    // Codex's: 60 newer payments left it off the page, and the request said Waiting.
    items[KEY] = { [ACCOUNT]: [kept({ id: "a", lux: "1250000000", memo: "Factura 33" })] };
    const paid = paidIn("a1".repeat(32), "1250000000", "Factura 33", T0 + HOUR, 4_700_000);
    const after = Array.from({ length: 60 }, (_, i) => paidIn(`${i}`.padStart(64, "f"), "1000000", `n${i}`, T0 + 2 * HOUR + i * 60_000, 4_700_100 + i));
    // Newest first, as the store gives them.
    const all = [paid, ...after].sort((x, y) => y.blockHeight - x.blockHeight);
    const history = { read: vi.fn(async ({ limit }) => ({ entries: all.slice(0, limit), state: null, complete: true })), needsDetails: () => false, fillDetails: vi.fn(async () => {}) };
    const state = { receive: { tab: "public" }, activity: { key: activityKey(unlocked), entries: all.slice(0, 50), loaded: true, limit: 50, history, names: new Map(), shielded: [] } };
    const actions = await draw(state);
    await vi.waitFor(() => expect(shown().map((row) => row.state)).toEqual(["Paid"]));
    expect(history.read).toHaveBeenCalledWith({ limit: 100 });

    // Its details, from the row found past the page: Codex's "isn't in your activity".
    // Kept paid by now: the page alone is matched, and the payment is read back to its time.
    await vi.waitFor(() => expect(items[KEY][ACCOUNT][0].paid?.hash).toBe("a1".repeat(32)));
    await actions.render();
    rows()[0].querySelector(".chain-link").click();
    await vi.waitFor(() => expect([state.route, state.txDetailHash, state.txDetailRow?.reading]).toEqual(["tx", "a1".repeat(32), false]));
    const details = (ov) => {
      dom.document.body.replaceChildren(...txDetailsView(ov, { state, actions: { render: vi.fn(async () => {}), showToast: vi.fn() } }));
      return dom.document.body;
    };
    // Found, with what it brought.
    expect(details(unlocked).querySelector(".tx-missing")).toBeNull();
    expect(visibleText(dom.document.body.querySelector(".tx-hero"))).toContain("1.25");

    // Another profile open by now: its row isn't this one's (Codex's: a Testnet payment shown under Mainnet).
    const other = details({ ...unlocked, accounts: [ACCOUNT, "z".repeat(60)], selectedAccountIndex: 1 });
    expect(other.querySelector(".tx-hero")).toBeNull();
    expect(other.querySelector(".tx-missing")).not.toBeNull();
    expect(state.txDetailRow).toBeNull();
  });

  it("shows a request an earlier version kept for an unnamed custom or local node on any such node, unchecked, and takes it off", async () => {
    // Codex's: kept as "custom" or "local", they vanished once chains were told apart.
    items[KEY] = {
      [ACCOUNT]: [kept({ id: "old", lux: "5000000000", memo: "old", network: "custom" }), kept({ id: "here", lux: "1250000000", memo: "Factura 33", network: "local" })],
    };
    const entries = [paidIn("b1".repeat(32), "5000000000", "old", T0 + HOUR), paidIn("a1".repeat(32), "1250000000", "Factura 33", T0 + HOUR)];
    const on = (nodeUrl, chainId) => ({ ...unlocked, nodeUrl, chainId });
    const drawOn = async (ov) => {
      const state = { receive: { tab: "public" }, activity: { key: activityKey(ov), entries: entries.map((entry) => ({ ...entry })), names: new Map() } };
      const actions = { render: vi.fn(async () => dom.document.body.replaceChildren(...receiveView(ov, { state, actions }))), showToast: vi.fn() };
      await actions.render();
      await vi.waitFor(() => expect(state.requests?.loaded).toBe(true));
      await actions.render();
      return state;
    };

    const unchecked = (amount) => ({ amount, state: "Not checked" });
    // On a custom node: the earlier custom one, never matched to the payment that looks like its own.
    await drawOn(on("https://node-42.example", 42));
    expect(shown()).toEqual([unchecked("5 DUSK")]);
    // On this machine's nodes, whatever chain each signs for: the earlier local one, the same way (Codex's: one of chain 43 paid it).
    for (const chainId of [0, 43]) {
      await drawOn(on("http://127.0.0.1:8080", chainId));
      expect(shown()).toEqual([unchecked("1.25 DUSK")]);
    }
    expect(items[KEY][ACCOUNT].some((r) => r.paid)).toBe(false);

    await drawOn(on("https://node-43.example", 43));
    actionsOf(rows()[0]).at(-1).click();
    await vi.waitFor(() => expect(items[KEY][ACCOUNT].map((r) => r.id)).toEqual(["here"]));
  });

  it("keeps the requests of a node outside the listed networks by the chain it signs for, apart from another's", async () => {
    // Codex's: two such chains both kept "custom", and one's requests showed, and could be paid, on the other.
    const on = (chainId) => ({ ...unlocked, nodeUrl: `https://node-${chainId}.example`, chainId });
    const state = { receive: { tab: "public", requestOpen: true, amountDusk: "0.5", memo: "r17" } };
    const drawOn = async (chainId) => {
      const actions = { render: vi.fn(async () => dom.document.body.replaceChildren(...receiveView(on(chainId), { state, actions }))), showToast: vi.fn() };
      await actions.render();
      await vi.waitFor(() => expect(state.requests?.loaded).toBe(true));
      await actions.render();
    };
    await drawOn(42);
    requestCopy().click();
    await vi.waitFor(() => expect(items[KEY]?.[ACCOUNT]).toHaveLength(1));
    expect(items[KEY][ACCOUNT][0].network).toBe("custom:dusk:42");
    await drawOn(43);
    expect(shown()).toEqual([]);
    await drawOn(42);
    expect(shown().map((row) => row.amount)).toEqual(["0.5 DUSK"]);
  });

  // Sofía's: a request paid, then paid again while Receive stayed open: "Paid", with no
  // Send back, for 65 and 110 seconds, till the popup was opened again.
  it("looks again every 30 seconds while a paid request shows, and says Paid twice once a second payment comes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    items[KEY] = { [ACCOUNT]: [kept({ id: "p", lux: "5000000", memo: "Factura F-2026-053" })] };
    const first = paidIn("f1".repeat(32), "5000000", "Factura F-2026-053", T0 + HOUR, 4_700_000);
    const second = paidIn("f2".repeat(32), "5000000", "Factura F-2026-053", T0 + 2 * HOUR, 4_700_100);
    let entries = [first];
    const history = { read: vi.fn(async () => ({ entries, state: null, complete: true })), sync: vi.fn(async () => {}), needsDetails: () => false, fillDetails: vi.fn(async () => {}) };
    const ov = { ...unlocked };
    const state = {
      route: "receive",
      overview: ov,
      receive: { tab: "public" },
      activity: { key: activityKey(ov), walletId: ACCOUNT, nodeUrl: ov.nodeUrl, profileIndex: 0, account: ACCOUNT, entries: [first], loaded: true, limit: 50, history, names: new Map(), checked: new Set(), shielded: [], shieldedAsked: true, shieldedReadAt: Date.now(), send: vi.fn(async () => ({})), epoch: Promise.resolve(1), txEpoch: Promise.resolve(1) },
    };
    const actions = { render: vi.fn(async () => dom.document.body.replaceChildren(...receiveView(ov, { state, actions }))), showToast: vi.fn() };
    await actions.render();
    await vi.waitFor(() => expect(shown().map((row) => row.state)).toEqual(["Paid"]));

    entries = [second, first];
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(shown().map((row) => row.state)).toEqual(["Paid twice"]));
    expect(dom.document.body.querySelectorAll(".request-payment").map(sendBack).filter(Boolean)).toHaveLength(1);
  });

  it("reads the shielded history again as it looks, once the notes synced since, for a request to the shielded address", async () => {
    // Codex's: kept open, Receive read only the public history again.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    items[KEY] = { [ACCOUNT]: [kept({ id: "s", lux: "1250000000", to: ADDRESS })] };
    const payment = { hash: "5e".repeat(32), kind: "transfer", direction: "in", value: "1250000000", success: true, timestamp: T0 + HOUR, blockHeight: 4_700_000 };
    const send = vi.fn(async ({ type }) => (type === "DUSK_UI_GET_SHIELDED_HISTORY" ? { result: { walletId: ACCOUNT, nodeUrl: overview.nodeUrl, profileIndex: 0, entries: [payment] } } : {}));
    const history = { read: vi.fn(async () => ({ entries: [], state: null, complete: true })), sync: vi.fn(async () => {}), needsDetails: () => false, fillDetails: vi.fn(async () => {}) };
    const ov = { ...unlocked, shieldedSync: { state: "done", updatedAt: 1 } };
    const state = {
      route: "receive",
      overview: ov,
      receive: { tab: "shielded" },
      activity: { key: activityKey(ov), walletId: ACCOUNT, nodeUrl: ov.nodeUrl, profileIndex: 0, account: ACCOUNT, entries: [], loaded: true, limit: 50, history, names: new Map(), checked: new Set(), shielded: [], shieldedAsked: true, shieldedReadAt: Date.now(), send, epoch: Promise.resolve(1), txEpoch: Promise.resolve(1) },
    };
    const actions = { render: vi.fn(async () => dom.document.body.replaceChildren(...receiveView(ov, { state, actions }))), showToast: vi.fn() };
    await actions.render();
    await vi.waitFor(() => expect(shown().map((row) => row.state)).toEqual(["Waiting"]));

    // The notes synced after the shielded history was read: the overview the look asks for says so.
    ov.shieldedSync = { state: "done", updatedAt: Date.now() + 1 };
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(shown().map((row) => row.state)).toEqual(["Check"]));
    expect(actions.render).toHaveBeenCalledWith({ forceRefresh: true });
    expect(send).toHaveBeenCalledWith({ type: "DUSK_UI_GET_SHIELDED_HISTORY" });
  });
});
