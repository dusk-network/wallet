import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fakeEvent, installFakeDom, isShown, settle, visibleText } from "./ui/testing/fakeDom.js";

const SEND = "https://apps.testnet.dusk.network/wallet/dashboard/send";
const LINK = `${SEND}?to=abc&amount=1&network=testnet`;

let dom;
let sent;
let kept;

const at = (href) => {
  const { pathname, search } = new URL(href);
  vi.stubGlobal("location", { href, pathname, search });
};

// A page of the web wallet loading, with the extension's script on it: the
// tab's session storage stays through its pages (`fresh` for a new tab).
async function page(href = LINK, { offer = true, readyState = "complete", fresh = true } = {}) {
  dom = installFakeDom();
  at(href);
  dom.document.readyState = readyState;
  sent = [];
  if (fresh) kept = new Map();
  vi.stubGlobal("sessionStorage", {
    getItem: (key) => kept.get(key) ?? null,
    setItem: (key, value) => kept.set(key, value),
    removeItem: (key) => kept.delete(key),
  });
  vi.stubGlobal("chrome", {
    runtime: {
      sendMessage: vi.fn(async (message) => {
        sent.push(message);
        return message.type === "DUSK_REQUEST_LINK_OFFER" ? { offer } : { ok: true };
      }),
    },
  });
  vi.resetModules();
  await import("./requestLinkOffer.js");
  await settle();
}

const host = () => dom.document.querySelector("dusk-wallet-offer");
const button = (name) => host().shadow.querySelectorAll("button").find((b) => b.textContent === name);

beforeEach(() => vi.stubGlobal("browser", undefined));
afterEach(() => vi.unstubAllGlobals());

describe("the offer on the web wallet", () => {
  it("says nothing on a page no request link opened, and asks nothing", async () => {
    for (const href of ["https://apps.testnet.dusk.network/wallet/", SEND, `${SEND}?amount=1`, "https://apps.testnet.dusk.network/wallet/settings?to=abc"]) {
      await page(href);
      expect(sent).toEqual([]);
      expect(host()).toBeNull();
    }
  });

  it("asks about the link it was opened with, and shows nothing the wallet doesn't offer", async () => {
    await page(LINK, { offer: false });
    expect(sent).toEqual([{ type: "DUSK_REQUEST_LINK_OFFER", link: LINK }]);
    expect(host()).toBeNull();
  });

  it("offers the extension's Send, and leaves the page alone until it's pressed", async () => {
    await page();
    expect(isShown(host())).toBe(true);
    expect(visibleText(host().shadow)).toBe("Pay this with your Dusk Wallet extension?Not nowOpen Send");
    expect(sent).toHaveLength(1);
  });

  it("offers it still on the page the web wallet goes on to with no wallet open, and opens the link", async () => {
    await page();
    // A new page in the same tab: its setup or unlock screen.
    await page("https://apps.testnet.dusk.network/wallet/setup/", { fresh: false });
    expect(sent).toEqual([{ type: "DUSK_REQUEST_LINK_OFFER", link: LINK }]);
    button("Open Send").click();
    await settle();
    expect(sent.at(-1)).toEqual({ type: "DUSK_REQUEST_LINK_OPEN", link: LINK });
    expect(host()).toBeNull();
    // Answered: not again on the next page.
    await page("https://apps.testnet.dusk.network/wallet/", { fresh: false });
    expect(sent).toEqual([]);
    expect(host()).toBeNull();
  });

  it("goes with Not now, sending nothing, for good", async () => {
    await page();
    button("Not now").click();
    await settle();
    expect(host()).toBeNull();
    expect(sent).toHaveLength(1);
    await page("https://apps.testnet.dusk.network/wallet/setup/", { fresh: false });
    expect(sent).toEqual([]);
    expect(host()).toBeNull();
  });

  it("takes only a person's press, nothing the page fires itself", async () => {
    await page();
    button("Open Send").dispatchEvent(fakeEvent("click", { isTrusted: false }));
    await settle();
    expect(sent).toHaveLength(1);
    expect(isShown(host())).toBe(true);
  });

  it("waits for the page while it's still loading", async () => {
    await page(LINK, { readyState: "loading" });
    expect(host()).toBeNull();
    dom.document.body.dispatchEvent(fakeEvent("DOMContentLoaded"));
    expect(isShown(host())).toBe(true);
  });

  it("works without the tab's session storage, on the link's own page", async () => {
    await page();
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    sent = [];
    vi.resetModules();
    await import("./requestLinkOffer.js");
    await settle();
    expect(sent).toEqual([{ type: "DUSK_REQUEST_LINK_OFFER", link: LINK }]);
  });
});
