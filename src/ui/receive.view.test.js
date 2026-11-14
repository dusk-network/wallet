import { readFile } from "node:fs/promises";
import path from "node:path";
import { createLensReader } from "@duskdomains/sdk/lens-reader";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { lookupPrimaryName, lookupShieldedName } from "../shared/duskNames.js";
import { iconSvg } from "./components/ActionIcon.js";
import { qrSvgString } from "./components/QrCode.js";
import { accessibleName, installFakeDom, isShown, screenReaderText, settle, typeInto, visibleText } from "./testing/fakeDom.js";
import { receiveView } from "./popup/views/receive.js";
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

const PUBLIC_NOTE = "People who send to alice.dusk reach this public account.";
const SHIELDED_NOTE =
  "People who pay alice.dusk choose public or shielded. Anyone can see this address belongs to alice.dusk.";

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
  const $ = (selector) => dom.document.body.querySelector(selector);
  const [nameField, addressField] = dom.document.body.querySelectorAll(".receive-fields > .receive-field");
  const note = $(".receive-name-note");
  const button = (text) => dom.document.body.querySelectorAll("button").find((b) => visibleText(b) === text);
  // Clicks the copy button labelled `label`: what it copied, what the button
  // is called then, and the toast, if any.
  const copy = async (label) => {
    dom.clipboard.writeText.mockClear();
    const pressed = $(`button[aria-label="${label}"]`);
    pressed.click();
    await settle();
    return [dom.clipboard.writeText.mock.calls.at(-1)?.[0], accessibleName(pressed), actions.showToast.mock.calls.at(-1)?.[0]];
  };
  return {
    state,
    nameField,
    addressField,
    name: () => (isShown(nameField) ? visibleText(nameField.querySelector(".receive-field__name")) : ""),
    address: addressField.querySelector(".receive-field__address"),
    note,
    shownNote: () => (isShown(note) ? note.textContent : ""),
    button,
    copy,
  };
}

describe("receive", () => {
  it("opens on the public account, first of the two tabs, as the web wallet does", async () => {
    const view = await receive(undefined, { state: {} });
    const tabs = dom.document.body.querySelector(".tabs").children;
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Public", "Shielded"]);
    expect(tabs.map((tab) => tab.classList.contains("is-active"))).toEqual([true, false]);
    // Screen readers hear which is picked.
    expect(dom.document.body.querySelector(".tabs").getAttribute("role")).toBe("tablist");
    expect(tabs.map((tab) => [tab.getAttribute("role"), tab.getAttribute("aria-selected")])).toEqual([
      ["tab", "true"],
      ["tab", "false"],
    ]);
    expect(view.state.receive.tab).toBe("public");
    expect(view.address.title).toBe(ACCOUNT);

    tabs[1].click();
    expect(view.state.receive.tab).toBe("shielded");
    const shielded = await receive(undefined, { state: view.state });
    expect(shielded.address.title).toBe(ADDRESS);
  });

  it("shows the name and the whole account under the QR, and copies the account with a button that says Copied", async () => {
    lookupPrimaryName.mockResolvedValue("alice.dusk");
    const view = await receive("public");
    const row = dom.document.body.querySelector(".row").children;
    const fields = view.addressField.parentNode;
    expect(row.indexOf(fields)).toBe(row.indexOf(dom.document.body.querySelector(".receive-qr-card")) + 1);

    expect(view.name()).toBe("alice.dusk");
    expect(view.nameField.querySelector(".receive-field__name").title).toBe("alice.dusk");
    // All of it, to read and compare, its ends set off: for the eyes and for screen readers alike.
    expect([visibleText(view.address), screenReaderText(view.address), view.address.title]).toEqual([ACCOUNT, ACCOUNT, ACCOUNT]);
    expect(view.address.querySelectorAll("b").map((b) => b.textContent)).toEqual([ACCOUNT.slice(0, 6), ACCOUNT.slice(-6)]);

    // The name's icon and the address's words each say Copied on themselves, with no toast.
    expect(await view.copy("Copy name")).toEqual(["alice.dusk", "Copied", undefined]);
    const copyAddress = view.button("Copy address");
    expect(copyAddress).toBeTruthy();
    expect(await view.copy("Copy address")).toEqual([ACCOUNT, "Copied", undefined]);
    expect(visibleText(copyAddress)).toBe("Copied");

    // Beside Download, below the fields; nothing else is a big button.
    expect(dom.document.body.querySelector(".btn-primary")).toBeNull();
    expect(dom.document.body.querySelector(".btnrow").children.map((b) => b.getAttribute("data-label") ?? b.textContent)).toEqual(["Copy address", "Download QR PNG"]);
  });

  it("draws the name's copy button as an SVG icon, centered in its button", async () => {
    lookupPrimaryName.mockResolvedValue("alice.dusk");
    await receive("public");
    const button = dom.document.body.querySelector(`button[aria-label="Copy name"]`);
    // No glyph text, which shows as an empty box without a font that has it:
    // the copy icon, and the check it turns into.
    expect([button.querySelectorAll(".copy-swap > span").map((face) => face.innerHTML), button.textContent]).toEqual([[iconSvg("copy"), iconSvg("check")], ""]);

    // The button centers the icon, the switcher's copy buttons too.
    const css = await readFile(path.resolve(process.cwd(), "public", "ui.css"), "utf8");
    expect(css).toMatch(/button\.acct-menu-copy,\s*button\.receive-copy \{\s*display: inline-grid;\s*place-items: center;\s*\}/);
  });

  it("says what the name reaches right under it, with no ⓘ to press", async () => {
    lookupPrimaryName.mockResolvedValue("alice.dusk");
    const view = await receive("public");
    expect(view.shownNote()).toBe(PUBLIC_NOTE);
    expect(dom.document.body.querySelector(".receive-info")).toBeNull();
    // It follows the fields it speaks of.
    const row = dom.document.body.querySelector(".row").children;
    expect(row.indexOf(view.note)).toBe(row.indexOf(view.addressField.parentNode) + 1);
  });

  it("names the shielded address only when the name's record is that address", async () => {
    // The account has a name, but its phoenix_payment_endpoint is not this address.
    lookupPrimaryName.mockResolvedValue("alice.dusk");
    let view = await receive("shielded", { state: { receive: { tab: "shielded" } } });
    expect(lookupShieldedName).toHaveBeenCalledWith(ACCOUNT, ADDRESS, { nodeUrl: overview.nodeUrl });
    expect([view.name(), view.shownNote()]).toEqual(["", ""]);
    expect(visibleText(view.address)).toBe(ADDRESS);
    expect(await view.copy("Copy address")).toEqual([ADDRESS, "Copied", undefined]);

    lookupShieldedName.mockResolvedValue("alice.dusk");
    view = await receive("shielded");
    expect(view.name()).toBe("alice.dusk");
    expect(view.shownNote()).toBe(SHIELDED_NOTE);
    expect(await view.copy("Copy address")).toEqual([ADDRESS, "Copied", undefined]);
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
    expect(await view.copy("Copy name")).toEqual([undefined, "Copy name", undefined]);
  });

  it("shows the address alone without a name, and says when a copy fails", async () => {
    const view = await receive("public", { state: { receive: { tab: "public" } } });
    expect([view.name(), view.shownNote()]).toEqual(["", ""]);
    expect(isShown(view.addressField)).toBe(true);

    // A copy that fails says so in a toast, and the button stays as it was.
    dom.clipboard.writeText.mockRejectedValueOnce(new Error("denied"));
    expect((await view.copy("Copy address")).slice(1)).toEqual(["Copy address", "Copy failed"]);

    // Nothing to show or copy without an account.
    const empty = await receive("public", { ov: { ...overview, accounts: [] } });
    expect(visibleText(empty.address)).toBe("—");
    expect(dom.document.body.querySelector('button[aria-label="Copy address"]').disabled).toBe(true);
  });

  it("copies the request link from Request payment once the QR holds a request", async () => {
    const state = { receive: { tab: "public", requestOpen: true, amountDusk: "", memo: "" } };
    let view = await receive("public", { state });
    expect(view.button("Copy request link").disabled).toBe(true);

    state.receive.amountDusk = "1.5";
    view = await receive("public", { state });
    expect(view.button("Copy request link").disabled).toBe(false);
    view.button("Copy request link").click();
    await settle();
    const [copied] = dom.clipboard.writeText.mock.calls.at(-1);
    // A line a person reads, then the web wallet's Send on the network it's for, which survives email and chat.
    expect(copied).toBe(`You're asked to pay 1.5 DUSK\nPay here: https://apps.testnet.dusk.network/wallet/dashboard/send?to=${ACCOUNT}&amount=1.5&network=testnet`);
    // The QR holds the same request, for a wallet to read.
    expect(dom.document.body.querySelector(".qr-inner").innerHTML).toBe(qrSvgString(`dusk:public-${ACCOUNT}@dusk:2?amount=1.5`));
    expect(visibleText(dom.document.body.querySelector(".receive-request"))).toContain("The link opens the web wallet's Send, filled in.");
  });

  it("copies a shielded request with its memo, and the dusk: link where the network has no web wallet", async () => {
    const state = { receive: { tab: "shielded", requestOpen: true, amountDusk: "", memo: "Factura 33" } };
    let view = await receive("shielded", { state });
    view.button("Copy request link").click();
    await settle();
    expect(dom.clipboard.writeText.mock.calls.at(-1)[0]).toBe(
      `You're asked for a payment in DUSK · Factura 33\nPay here: https://apps.testnet.dusk.network/wallet/dashboard/send?to=${ADDRESS}&memo=Factura+33&network=testnet`
    );

    // A chain there's no file for: nothing to open, so the link a wallet reads.
    state.receive.tab = "public";
    view = await receive("public", { state, ov: { ...overview, nodeUrl: "https://node.example", chainId: 42 } });
    view.button("Copy request link").click();
    await settle();
    expect(dom.clipboard.writeText.mock.calls.at(-1)[0]).toBe(`You're asked for a payment in DUSK · Factura 33\nPay here: dusk:public-${ACCOUNT}@dusk:42?memo=Factura+33`);
    expect(visibleText(dom.document.body.querySelector(".receive-request"))).not.toContain("web wallet");
  });

  // Chen's: the request says who asks by the name given the profile here, where it has no .dusk name.
  it("copies a request with the name given the profile here, where it has no .dusk name", async () => {
    const state = { receive: { tab: "public", requestOpen: true, amountDusk: "0.02", memo: "chicken rice" } };
    const view = await receive("public", { state, ov: { ...overview, networkName: "Testnet", accountNames: { 0: "Chen" } } });
    view.button("Copy request link").click();
    await settle();
    expect(dom.clipboard.writeText.mock.calls.at(-1)[0]).toBe(
      `Chen asks you to pay 0.02 DUSK on Testnet · chicken rice\nPay here: https://apps.testnet.dusk.network/wallet/dashboard/send?to=${ACCOUNT}&amount=0.02&memo=chicken+rice&network=testnet`
    );
  });

  it("asks for a network by the chain a custom node signs for", async () => {
    const state = { receive: { tab: "public", requestOpen: true, amountDusk: "1", memo: "" } };
    const view = await receive("public", { state, ov: { ...overview, nodeUrl: "https://node.example", chainId: 1 } });
    view.button("Copy request link").click();
    await settle();
    expect(dom.clipboard.writeText.mock.calls.at(-1)[0]).toBe(`You're asked to pay 1 DUSK\nPay here: https://apps.dusk.network/wallet/dashboard/send?to=${ACCOUNT}&amount=1&network=mainnet`);
  });

  // Sofía's first wish for three rounds: her clients to see what they pay in their own money, euros.
  it("says what a request asks comes to in your currency on mainnet, with the price's time, the link still in DUSK, and nothing on testnet", async () => {
    vi.stubGlobal("navigator", { ...globalThis.navigator, language: "es-ES" });
    const shown = (selector) => {
      const el = dom.document.body.querySelector(selector);
      return el && isShown(el) ? el.textContent : "";
    };
    const state = { receive: { tab: "public", requestOpen: true, amountDusk: "30", memo: "Factura 2026-133" } };
    const view = await receive("public", { state, ov: { ...overview, nodeUrl: "https://nodes.dusk.network" } });
    await vi.waitFor(() => expect(shown(".receive-in-currency")).toMatch(/^≈ 1,82\s€ · price at \d{2}:\d{2}$/));
    view.button("Copy request link").click();
    await settle();
    expect(dom.clipboard.writeText.mock.calls.at(-1)[0]).toBe(
      `You're asked to pay 30 DUSK · Factura 2026-133\nPay here: https://apps.dusk.network/wallet/dashboard/send?to=${ACCOUNT}&amount=30&memo=Factura+2026-133&network=mainnet`
    );
    // The request kept in the list says it too.
    await vi.waitFor(() => expect(shown(".request-row__in-currency")).toMatch(/^≈ 1,82\s€ · price at /));

    // Test DUSK has no value: nothing said, nothing asked.
    coingecko.mockClear();
    await receive("public", { state });
    expect([shown(".receive-in-currency"), coingecko.mock.calls]).toEqual(["", []]);
  });

  it("asks for the amount a decimal comma writes", async () => {
    const state = { receive: { tab: "public", requestOpen: true, amountDusk: "1,5", memo: "" } };
    const view = await receive("public", { state });
    view.button("Copy request link").click();
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

    it.each([
      ["0", "Enter an amount greater than 0."],
      ["0.000", "Enter an amount greater than 0."],
      ["abc", "Enter an amount such as 10 or 10.5."],
      ["0.1234567891", "DUSK has 9 decimals at most."],
    ])("won't make a link for %s, and says why, with nothing claimed above it", async (amountDusk, said) => {
      inLanguage("en-US");
      const view = await receive("public", { state: open({ amountDusk, memo: "Lunch" }) });
      expect(amountError()).toBe(said);
      expect(view.button("Copy request link").disabled).toBe(true);
      expect(meta()).toBe("");
    });

    // Nandini's and Chen's: the question had no buttons, and asked to retype.
    it("says an amount that could be two amounts is that, in the language's own way, with a button for each", async () => {
      inLanguage("nl-NL");
      let view = await receive("public", { state: open({ amountDusk: "1.234" }) });
      expect(amountError()).toBe("Is that 1,2340 or 1234?1,2340 DUSK1234 DUSK");
      expect(view.button("Copy request link").disabled).toBe(true);
      inLanguage("en-US");
      view = await receive("public", { state: open({ amountDusk: "1,234" }) });
      expect(amountError()).toBe("Is that 1.2340 or 1234?1.2340 DUSK1234 DUSK");
      expect(view.button("Copy request link").disabled).toBe(true);
      // A reading tapped: in the field, which asks nothing, and the request can go.
      view.button("1.2340 DUSK").click();
      await settle();
      expect([dom.document.body.querySelector(".receive-request input").value, amountError(), view.button("Copy request link").disabled]).toEqual(["1.2340", "", false]);
    });

    it("gives Dutch separators in its example", async () => {
      inLanguage("nl-NL");
      await receive("public", { state: open({ amountDusk: "abc" }) });
      expect(amountError()).toBe("Enter an amount such as 10 or 10,5.");
    });

    it("takes an amount still being typed, and reads it as the plain amount the link asks for", async () => {
      inLanguage("en-US");
      const view = await receive("public", { state: open({ amountDusk: "1." }) });
      expect(amountError()).toBe("");
      view.button("Copy request link").click();
      await settle();
      expect(dom.clipboard.writeText.mock.calls.at(-1)[0]).toContain("amount=1");
    });

    it("won't make a link with a memo over 512 bytes, counted in bytes as Send counts them", async () => {
      inLanguage("en-US");
      let view = await receive("public", { state: open({ memo: "é".repeat(257) }) });
      expect(shown(".memo-error")).toBe("That memo is too long: 512 bytes at most.");
      expect(view.button("Copy request link").disabled).toBe(true);
      expect(meta()).toBe("");
      view = await receive("public", { state: open({ memo: "é".repeat(256) }) });
      expect(shown(".memo-error")).toBe("");
      expect(view.button("Copy request link").disabled).toBe(false);
    });

    // Marek's: a memo with a direction override read "r22 x req" in the field, and nothing said it until it was in the list.
    it("shows a memo's hidden characters as codes under the field, and what to check, before the link is copied", async () => {
      inLanguage("en-US");
      const memoShown = () => shown(".receive-memo-shown");
      const view = await receive("public", { state: open({ memo: "r22 x \u202eqer" }) });
      expect(memoShown()).toBe("r22 x \\u202eqerHidden characters that can change how this reads show here as � or \\u codes.");
      expect(dom.document.body.querySelector(".receive-memo-shown").getAttribute("role")).toBe("status");
      expect(view.button("Copy request link").disabled).toBe(false);
      // A look-alike digit says what to check; a plain memo says nothing.
      await receive("public", { state: open({ memo: "Invoice \u09ea" }) });
      expect(memoShown()).toContain("A number here uses digits that look like other digits.");
      await receive("public", { state: open({ memo: "Lunch" }) });
      expect(memoShown()).toBe("");
    });

    it("says nothing with the panel closed, and claims nothing for what wouldn't do", async () => {
      inLanguage("en-US");
      await receive("public", { state: { receive: { tab: "public", requestOpen: false, amountDusk: "abc", memo: "Lunch" } } });
      expect(amountError()).toBe("");
      expect(meta()).toBe("");
      await receive("public", { state: { receive: { tab: "public", requestOpen: false, amountDusk: "1", memo: "Lunch" } } });
      expect(meta()).toBe("Configured");
    });

    it("takes back Copied once the request changes", async () => {
      inLanguage("en-US");
      const view = await receive("public", { state: open({ amountDusk: "1" }) });
      const copy = view.button("Copy request link");
      // The form's clock: well before Copied would end by itself.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      copy.click();
      await vi.advanceTimersByTimeAsync(0);
      expect(copy.hasAttribute("data-copied")).toBe(true);
      expect(accessibleName(copy)).toBe("Copied");
      const amount = dom.document.body.querySelectorAll("input").find((i) => accessibleName(i) === "Amount");
      typeInto(amount, "2");
      await vi.advanceTimersByTimeAsync(100);
      expect(copy.hasAttribute("data-copied")).toBe(false);
      expect(accessibleName(copy)).toBe("Copy request link");
      // Copying the new link says it again.
      copy.click();
      await vi.advanceTimersByTimeAsync(0);
      expect(copy.hasAttribute("data-copied")).toBe(true);
      expect(dom.clipboard.writeText.mock.calls.at(-1)[0]).toContain("amount=2");
    });
  });

  it("says no more than the QR, the fields and Request payment show", async () => {
    const state = { receive: { tab: "public", requestOpen: false, amountDusk: "", memo: "" } };
    await receive("public", { state });
    const body = dom.document.body;
    const summary = () => visibleText(body.querySelector("details.receive-request > summary"));

    // No note that Send reads the QR, no "Optional" beside Request payment or its labels:
    // the placeholders say both fields are optional.
    expect(visibleText(body)).not.toMatch(/Send can read|Optional|optional/);
    expect(summary()).toBe("Request payment");
    expect(body.querySelectorAll(".receive-request .advanced-body label").map((l) => l.textContent)).toEqual(["Amount", "Memo"]);
    expect(body.querySelectorAll(".receive-request .advanced-body input").map((i) => i.getAttribute("placeholder"))).toEqual([
      "Optional, e.g. 1.25 DUSK",
      "Optional",
    ]);
    expect(body.querySelector(".tabs").hasAttribute("title")).toBe(false);

    // Once the QR holds a request, Request payment says what it asks for.
    Object.assign(state.receive, { requestOpen: true, amountDusk: "1.5" });
    await receive("public", { state });
    expect(summary()).toBe("Request payment1.5 DUSK");
    Object.assign(state.receive, { amountDusk: "", memo: "Lunch" });
    await receive("public", { state });
    expect(summary()).toBe("Request paymentWith memo");

    // On a Dutch browser, an amount written the Dutch way is the amount it asks for.
    vi.stubGlobal("navigator", { ...globalThis.navigator, language: "nl-NL" });
    try {
      Object.assign(state.receive, { amountDusk: "1,25", memo: "" });
      await receive("public", { state });
      expect(summary()).toBe("Request payment1,25 DUSK");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shares through the phone's share sheet in the app, where it only copied before, and says long-press for the QR's menu", async () => {
    // The app on a phone: its WebView, and Tauri's bridge to the wrapper.
    dom.document.body.dataset.runtime = "tauri";
    dom.window.matchMedia = () => ({ matches: true });
    const invoke = vi.fn(async () => null);
    dom.window.__TAURI_INTERNALS__ = { invoke };
    vi.stubGlobal("navigator", { ...globalThis.navigator, userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 6; wv) Chrome/156.0 Mobile Safari/537.36" });
    const view = await receive("public");
    // A phone has no right-click: the QR's menu is a long press.
    expect(dom.document.body.querySelector(".receive-qr-card").title).toBe("Long-press for QR options");
    view.button("Share").click();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("share_text", { text: ACCOUNT, title: "Dusk address" }, undefined));
    await settle();
    expect(dom.clipboard.writeText).not.toHaveBeenCalled();
  });

  // Lena's: the app offered no dusk: link, which opens the app's own Send.
  it("copies the app's dusk: link beside Share in the app, of the account or of the request", async () => {
    dom.document.body.dataset.runtime = "tauri";
    dom.window.matchMedia = () => ({ matches: true });
    dom.window.__TAURI_INTERNALS__ = { invoke: vi.fn(async () => null) };
    vi.stubGlobal("navigator", { ...globalThis.navigator, userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 6; wv) Chrome/156.0 Mobile Safari/537.36" });
    let view = await receive("public");
    const buttons = dom.document.body.querySelectorAll(".btnrow button").map(visibleText);
    expect(buttons.slice(buttons.indexOf("Share"), buttons.indexOf("Share") + 2)).toEqual(["Share", "Copy app link"]);
    expect((await view.copy("Copy app link"))[0]).toBe(`dusk:public-${ACCOUNT}@dusk:2`);
    view = await receive("public", { state: { receive: { tab: "public", requestOpen: true, amountDusk: "0.03", memo: "Invoice 114" } } });
    expect((await view.copy("Copy app link"))[0]).toBe(`dusk:public-${ACCOUNT}@dusk:2?amount=0.03&memo=Invoice+114`);
  });

  it("offers no app link outside the app", async () => {
    await receive("public");
    expect(dom.document.body.querySelector('button[aria-label="Copy app link"]')).toBeNull();
  });

  // Sofía's, Chen's and Lena's: every QR named alike, without a label, and the message naming an older file.
  it("saves a request's QR in the app named by what it asks and when, says what it asks under the code, and the name Android gave it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 10, 4, 12));
    // A canvas that keeps what's written on it, and a picture that loads.
    const written = [];
    dom = installFakeDom({
      elements: {
        canvas: (el) => {
          el.getContext = () => ({ fillRect() {}, drawImage() {}, fillText: (text) => written.push(text), measureText: (text) => ({ width: text.length * 10 }) });
          el.toBlob = (done) => done(new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }));
        },
      },
    });
    vi.stubGlobal("Image", class {
      set src(url) {
        setTimeout(() => this.onload?.(url));
      }
    });
    vi.stubGlobal("URL", { createObjectURL: () => "blob:qr", revokeObjectURL: () => {} });
    dom.document.body.dataset.runtime = "tauri";
    // A picture of that name is there already: Android adds " (1)".
    const invoke = vi.fn(async (cmd, args) => (cmd === "save_download" ? args.name.replace(/\.png$/, " (1).png") : null));
    dom.window.__TAURI_INTERNALS__ = { invoke };
    lookupPrimaryName.mockResolvedValue("sofiadesign.dusk");
    const state = { receive: { tab: "public", requestOpen: true, amountDusk: "0.03", memo: "Invoice 2026-114" } };
    const actions = { render: vi.fn(async () => {}), showToast: vi.fn() };
    dom.document.body.replaceChildren(...receiveView({ ...overview, networkName: "Testnet" }, { state, actions }));
    await settle();
    dom.document.body.querySelectorAll("button").find((b) => visibleText(b) === "Download QR PNG").click();
    await vi.waitFor(() => expect(actions.showToast).toHaveBeenCalled());
    const [, args] = invoke.mock.calls.find(([cmd]) => cmd === "save_download");
    expect(args.name).toBe("dusk-testnet-request-0.03-DUSK-Invoice-2026-114-2026-11-10-0412.png");
    expect(actions.showToast).toHaveBeenLastCalledWith("QR saved to Downloads as dusk-testnet-request-0.03-DUSK-Invoice-2026-114-2026-11-10-0412 (1).png");
    expect(written).toEqual(["Dusk payment request · Testnet", "0.03 DUSK", "Invoice 2026-114", "To sofiadesign.dusk · 26FCH7…Tck927"]);
  });

  // Sofía's: Share sent one bare long web link; and then the client got only a ~270-character link, no sentence.
  it("shares a request in the app as a line of who asks for what, with its QR code's picture and its link", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 10, 4, 12));
    dom = installFakeDom({
      elements: {
        canvas: (el) => {
          el.getContext = () => ({ fillRect() {}, drawImage() {}, fillText() {}, measureText: (text) => ({ width: text.length * 10 }) });
          el.toBlob = (done) => done(new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }));
        },
      },
    });
    vi.stubGlobal("Image", class {
      set src(url) {
        setTimeout(() => this.onload?.(url));
      }
    });
    // URLs as ever, and a picture's blob that needs none.
    vi.stubGlobal("URL", Object.assign(class extends URL {}, { createObjectURL: () => "blob:qr", revokeObjectURL: () => {} }));
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
    dom.document.body.querySelectorAll("button").find((b) => visibleText(b) === "Share").click();
    await vi.waitFor(() => expect(invoke.mock.calls.some(([cmd]) => cmd === "share_text")).toBe(true));
    const [, args] = invoke.mock.calls.find(([cmd]) => cmd === "share_text");
    expect(args).toEqual({
      text: `sofiadesign.dusk asks you to pay 0.03 DUSK on Testnet · Invoice 2026-115\nPay here: https://apps.testnet.dusk.network/wallet/dashboard/send?to=${ACCOUNT}&amount=0.03&memo=Invoice+2026-115&network=testnet`,
      title: "Dusk payment request",
      image: "iVBORw==",
      name: "dusk-testnet-request-0.03-DUSK-Invoice-2026-115-2026-11-10-0412.png",
    });
    expect(dom.clipboard.writeText).not.toHaveBeenCalled();
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
  const shown = () =>
    dom.document.body.querySelectorAll(".request-row").map((row) => ({
      amount: visibleText(row.querySelector(".request-row__amount")),
      state: visibleText(row.querySelector(".request-state")),
      match: visibleText(row.querySelector(".request-row__match")),
      buttons: row.querySelectorAll(".request-row__actions button").map(visibleText),
    }));
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

  it("keeps a request as its link is copied, once, and lists it as waiting", async () => {
    const state = { receive: { tab: "public", requestOpen: true, amountDusk: "1.25", memo: "Factura 33" } };
    await draw(state);
    expect(shown()).toEqual([]);

    dom.document.body.querySelectorAll("button").find((b) => visibleText(b) === "Copy request link").click();
    await vi.waitFor(() => expect(shown()).toHaveLength(1));
    expect(shown()).toEqual([{ amount: "1.25 DUSK", state: "Waiting", match: "Nothing matching has come in.", buttons: ["Copy link", "Remove"] }]);
    expect(items[KEY][ACCOUNT]).toEqual([expect.objectContaining({ lux: "1250000000", memo: "Factura 33", network: "testnet", to: ACCOUNT })]);

    // The same one copied again is the same request.
    dom.document.body.querySelector('button[data-label="Copy request link"]').click();
    await settle();
    expect(items[KEY][ACCOUNT]).toHaveLength(1);
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

    expect(shown()).toEqual([
      { amount: "1.25 DUSK", state: "Paid", match: `Amount and memo match a payment of 1.25 DUSK ${whenAtText(T0 + HOUR)}.`, buttons: ["See payment", "Copy link", "Remove"] },
      { amount: "2 DUSK", state: "Check", match: `Same amount ${whenAtText(T0 + 2 * HOUR)}, with another memo: "Other". Check it's this one.`, buttons: ["See payment", "Copy link", "Remove"] },
      { amount: "Any amount", state: "Paid twice", match: "Its memo matches 2 payments.", buttons: ["Copy link", "Remove"] },
    ]);
    // What paid stays paid, kept with its request and what it paid.
    await vi.waitFor(() => expect(items[KEY][ACCOUNT].find((r) => r.id === "a").paid).toEqual({ at: T0 + HOUR, hash: "a1".repeat(32), lux: "1250000000" }));

    // Paid twice: each payment, what it brought and when, to see; the second to send back.
    const payments = () => dom.document.body.querySelectorAll(".request-row")[2].querySelectorAll(".request-row__payments li");
    // To the second: two in the same minute read apart (Sofía's).
    const seconds = { seconds: true };
    expect(payments().map((li) => [visibleText(li.querySelector(".request-payment__what")), li.querySelectorAll("button").map(visibleText)])).toEqual([
      [`0.7 DUSK ${whenAtText(T0 + 3 * HOUR, Date.now(), seconds)}`, ["See payment"]],
      [`0.3 DUSK ${whenAtText(T0 + 4 * HOUR, Date.now(), seconds)}`, ["See payment", "Send back"]],
    ]);
    // A payment opens in its details, and comes back here.
    payments()[1].querySelectorAll("button").find((b) => visibleText(b) === "See payment").click();
    expect([state.route, state.txDetailHash, state.txDetailFrom]).toEqual(["tx", "c2".repeat(32), "receive"]);

    // Remove takes one off, here and where it's kept.
    state.route = "receive";
    await actions.render();
    dom.document.body.querySelectorAll(".request-row")[1].querySelectorAll("button").find((b) => visibleText(b) === "Remove").click();
    await vi.waitFor(() => expect(shown().map((row) => row.amount)).toEqual(["1.25 DUSK", "Any amount"]));
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
    const badges = () => dom.document.body.querySelectorAll(".request-row .request-state").map((badge) => [visibleText(badge), badge.className.replace("request-state request-state--", "")]);
    // A request of any amount says what came in, plainly: one lux reads as no green Paid. One of an amount asked says Paid.
    expect(badges()).toEqual([
      ["0.000000001 DUSK", "plain"],
      ["0.02 DUSK", "plain"],
      ["Paid", "plain"],
      ["Paid", "ok"],
    ]);
    expect(shown().slice(0, 2).map(({ match }) => match)).toEqual([
      `Its memo matches a payment of 0.000000001 DUSK ${whenAtText(T0 + HOUR)}.`,
      `Its memo matches a payment of 0.02 DUSK ${whenAtText(T0 + 2 * HOUR)}.`,
    ]);
    await vi.waitFor(() => expect(items[KEY][ACCOUNT].find((r) => r.id === "a").paid).toEqual({ at: T0 + HOUR, hash: "a1".repeat(32), lux: "1" }));

    // With balances hidden, what came in is too.
    const hiddenState = { receive: { tab: "public" }, activity: state.activity };
    const actions = { render: vi.fn(async () => dom.document.body.replaceChildren(...receiveView({ ...unlocked, hideBalances: true }, { state: hiddenState, actions }))), showToast: vi.fn() };
    await actions.render();
    await vi.waitFor(() => expect(hiddenState.requests?.loaded).toBe(true));
    await actions.render();
    expect(shown().slice(0, 2).map(({ match }) => match)).toEqual([`Its memo matches a payment of •••• DUSK ${whenAtText(T0 + HOUR)}.`, `Its memo matches a payment of •••• DUSK ${whenAtText(T0 + 2 * HOUR)}.`]);
    expect(badges().slice(0, 2)).toEqual([
      ["•••• DUSK", "plain"],
      ["•••• DUSK", "plain"],
    ]);
  });

  // Sofía's: after Send back, the request still offered it, and said nothing of it.
  it("says when a payment was sent back, and offers no Send back for it again; and copies a request's link", async () => {
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
    expect(second.querySelectorAll("button").map(visibleText)).toEqual(["See payment"]);
    expect(visibleText(second.querySelector(".request-payment__sent"))).toBe(`Sent back ${whenAtText(T0 + 3 * HOUR, Date.now(), { seconds: true })}`);

    // Its link, to copy again (the web wallet's list has it).
    dom.document.body.querySelectorAll(".request-row__actions button").find((b) => visibleText(b) === "Copy link").click();
    await settle();
    expect(dom.clipboard.writeText).toHaveBeenLastCalledWith(`https://apps.testnet.dusk.network/wallet/dashboard/send?to=${ACCOUNT}&amount=0.016&memo=Factura+117&network=testnet`);
  });

  it("sends back a payment that paid a request again: to whoever sent it, what it brought, with the request's memo", async () => {
    // Sofia's: paid twice, and no way to refund but filling Send in by hand.
    items[KEY] = { [ACCOUNT]: [kept({ id: "a", lux: "16000000", memo: "Factura 2026-074 Ilustración" })] };
    const SENDER = "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";
    const entries = [paidIn("a1".repeat(32), "16000000", "Factura 2026-074 Ilustración", T0 + HOUR), paidIn("a2".repeat(32), "16000000", "Factura 2026-074 Ilustración", T0 + 2 * HOUR)];
    const state = { route: "receive", receive: { tab: "public" }, activity: { key: activityKey(unlocked), entries, names: new Map() } };
    await draw(state);
    expect(shown()[0]).toMatchObject({ state: "Paid twice", match: "Amount and memo match 2 payments." });
    const back = dom.document.body.querySelectorAll(".request-row__payments button").find((b) => visibleText(b) === "Send back");
    expect(accessibleName(back)).toBe(`Send back the payment of 0.016 DUSK ${whenAtText(T0 + 2 * HOUR, Date.now(), { seconds: true })}`);
    back.click();
    expect(state.route).toBe("send");
    expect(state.draft).toMatchObject({ to: SENDER, amountDusk: "0.016", amountMasked: false, memo: "Refund: Factura 2026-074 Ilustración" });

    // With balances hidden, the amount it fills in stays hidden on Send and Review.
    const hiddenState = { route: "receive", receive: { tab: "public" }, activity: state.activity };
    const actions = { render: vi.fn(async () => dom.document.body.replaceChildren(...receiveView({ ...unlocked, hideBalances: true }, { state: hiddenState, actions }))), showToast: vi.fn() };
    await actions.render();
    await vi.waitFor(() => expect(hiddenState.requests?.loaded).toBe(true));
    await actions.render();
    dom.document.body.querySelectorAll(".request-row__payments button").find((b) => visibleText(b) === "Send back").click();
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
    dom.document.body.querySelectorAll(".request-row button").find((b) => visibleText(b) === "See payment").click();
    await vi.waitFor(() => expect([state.route, state.txDetailHash, state.txDetailRow?.reading]).toEqual(["tx", "a1".repeat(32), false]));
    const details = (ov) => {
      dom.document.body.replaceChildren(...txDetailsView(ov, { state, actions: { render: vi.fn(async () => {}), showToast: vi.fn() } }));
      return visibleText(dom.document.body);
    };
    expect(details(unlocked)).not.toContain("isn't in your activity");
    expect(visibleText(dom.document.body.querySelector(".tx-hero"))).toContain("1.25");

    // Another profile open by now: its row isn't this one's (Codex's: a Testnet payment shown under Mainnet).
    expect(details({ ...unlocked, accounts: [ACCOUNT, "z".repeat(60)], selectedAccountIndex: 1 })).toContain("isn't in your activity");
    expect(state.txDetailRow).toBeNull();
  });

  it("opens a payment's details at once, and goes nowhere when the person went elsewhere as it was read", async () => {
    // Codex's: the read's end took them to the payment from wherever they'd gone.
    items[KEY] = { [ACCOUNT]: [kept({ id: "a", lux: "1250000000", memo: "Factura 33", paid: { at: T0 + HOUR, hash: "a1".repeat(32) } })] };
    const paid = paidIn("a1".repeat(32), "1250000000", "Factura 33", T0 + HOUR, 4_700_000);
    const after = Array.from({ length: 60 }, (_, i) => paidIn(`${i}`.padStart(64, "f"), "1000000", `n${i}`, T0 + 2 * HOUR + i * 60_000, 4_700_100 + i));
    const all = [paid, ...after].sort((x, y) => y.blockHeight - x.blockHeight);
    const held = Promise.withResolvers();
    const history = { read: vi.fn(async ({ limit }) => ({ entries: all.slice(0, limit), state: null, complete: true })), needsDetails: () => false, fillDetails: vi.fn(async () => {}) };
    const state = { route: "receive", receive: { tab: "public" }, activity: { key: activityKey(unlocked), entries: all.slice(0, 50), loaded: true, limit: 50, history, names: new Map(), shielded: [] } };
    await draw(state);
    history.read.mockImplementationOnce(() => held.promise);
    dom.document.body.querySelectorAll(".request-row button").find((b) => visibleText(b) === "See payment").click();
    // At once, saying it's looked for.
    expect([state.route, state.txDetailHash]).toEqual(["tx", "a1".repeat(32)]);
    dom.document.body.replaceChildren(...txDetailsView(unlocked, { state, actions: { render: vi.fn(async () => {}), showToast: vi.fn() } }));
    expect(visibleText(dom.document.body)).toContain("Looking for this transaction…");

    // Gone to Send before the read ends: they stay there.
    state.route = "send";
    held.resolve({ entries: all.slice(0, 50), state: null, complete: true });
    await vi.waitFor(() => expect(state.txDetailRow?.reading).toBe(false));
    expect(state.route).toBe("send");
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

    const unchecked = (amount) => ({ amount, state: "Not checked", match: "Made by an earlier version for a node it didn't name, so payments aren't checked against it.", buttons: ["Copy link", "Remove"] });
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
    dom.document.body.querySelectorAll(".request-row button").find((b) => visibleText(b) === "Remove").click();
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
    dom.document.body.querySelector('button[data-label="Copy request link"]').click();
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
    expect(dom.document.body.querySelectorAll(".request-payment button").map(visibleText)).toContain("Send back");
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
