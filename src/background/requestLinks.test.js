import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runtimeGetURL, tabsCreate, tabsQuery, tabsRemove, tabsUpdate, windowsGet, windowsUpdate } from "../platform/extensionApi.js";
import { loadVault } from "../shared/vault.js";
import { handOverRequestLink, offersRequestLink, openRequestLink } from "./requestLinks.js";

vi.mock("../platform/extensionApi.js", () => ({
  runtimeGetURL: vi.fn((path) => `chrome-extension://wallet/${path}`),
  tabsCreate: vi.fn(async () => ({})),
  // No wallet tab open, unless a test opens one.
  tabsQuery: vi.fn(async () => []),
  tabsUpdate: vi.fn(async () => ({})),
  tabsRemove: vi.fn(async () => {}),
  windowsGet: vi.fn(async () => ({ state: "normal" })),
  windowsUpdate: vi.fn(async () => ({})),
}));
vi.mock("../shared/vault.js", () => ({ loadVault: vi.fn(async () => ({ version: 2 })) }));
// The wallet's node, as Settings has it: a test on this machine says so.
const node = vi.hoisted(() => ({ url: "https://testnet.nodes.dusk.network" }));
vi.mock("../shared/settings.js", () => ({ getSettings: vi.fn(async () => ({ nodeUrl: node.url })) }));

const ACCOUNT = "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927";
const LINK = `https://apps.testnet.dusk.network/wallet/dashboard/send?to=${ACCOUNT}&amount=1&network=testnet`;
const onWalletPage = { url: LINK };

beforeEach(() => {
  vi.clearAllMocks();
  node.url = "https://testnet.nodes.dusk.network";
});
afterEach(() => {
  loadVault.mockImplementation(async () => ({ version: 2 }));
  vi.unstubAllGlobals();
});

describe("a request link from the web wallet's Send", () => {
  it("gets its offer from a wallet here to pay it with", async () => {
    await expect(offersRequestLink({ link: LINK }, onWalletPage)).resolves.toBe(true);
    loadVault.mockImplementation(async () => null);
    await expect(offersRequestLink({ link: LINK }, onWalletPage)).resolves.toBe(false);
  });

  it("opens the extension's Send on a tab of its own, with the link in its address", async () => {
    await expect(openRequestLink({ link: LINK }, onWalletPage)).resolves.toBe(true);
    expect(tabsCreate).toHaveBeenCalledWith({ url: `chrome-extension://wallet/full.html?route=send&link=${encodeURIComponent(LINK)}` });
  });

  // Marek's: 14 tabs in 35 minutes, a wallet tab for each link.
  it("opens it in the wallet's tab open already, brought to the front, rather than another", async () => {
    tabsQuery.mockResolvedValueOnce([{ id: 3, url: LINK }, { id: 6, url: "chrome-extension://wallet/notification.html?rid=r1" }, { id: 7, url: "chrome-extension://wallet/popup.html" }]);
    await expect(openRequestLink({ link: LINK }, onWalletPage)).resolves.toBe(true);
    expect(tabsUpdate).toHaveBeenCalledWith(7, { url: `chrome-extension://wallet/full.html?route=send&link=${encodeURIComponent(LINK)}`, active: true });
    expect(tabsCreate).not.toHaveBeenCalled();
  });

  // Astra's: the wallet's tab in another window, maybe minimised, came forward there alone.
  it("brings the window of the wallet's tab to the front too, where it's another, minimised or not", async () => {
    tabsQuery.mockResolvedValueOnce([{ id: 7, windowId: 2, url: "chrome-extension://wallet/full.html" }]);
    windowsGet.mockResolvedValueOnce({ id: 2, state: "minimized" });
    await expect(openRequestLink({ link: LINK }, onWalletPage)).resolves.toBe(true);
    expect(tabsUpdate).toHaveBeenCalledWith(7, { url: `chrome-extension://wallet/full.html?route=send&link=${encodeURIComponent(LINK)}`, active: true });
    expect(windowsUpdate).toHaveBeenCalledWith(2, { focused: true, state: "normal" });

    // A maximised one stays so.
    tabsQuery.mockResolvedValueOnce([{ id: 7, windowId: 4, url: "chrome-extension://wallet/full.html" }]);
    windowsGet.mockResolvedValueOnce({ id: 4, state: "maximized" });
    await openRequestLink({ link: LINK }, onWalletPage);
    expect(windowsUpdate).toHaveBeenLastCalledWith(4, { focused: true });
  });

  // Chen's, Amélie's and Marek's: each link left a web page's tab also called "Dusk Wallet"; five piled up.
  it("takes the web page's tab's place on a phone, and leaves a computer's tabs as they were", async () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Android 15; Mobile; rv:159.0) Gecko/159.0 Firefox/159.0" });
    const send = `chrome-extension://wallet/full.html?route=send&link=${encodeURIComponent(LINK)}`;
    const page = { ...onWalletPage, tab: { id: 3, url: LINK } };
    // The wallet's tab open already: it shows the link, and the page's goes.
    tabsQuery.mockResolvedValueOnce([{ id: 3, url: LINK }, { id: 7, url: "chrome-extension://wallet/full.html" }]);
    await expect(openRequestLink({ link: LINK }, page)).resolves.toBe(true);
    expect(tabsUpdate).toHaveBeenCalledWith(7, { url: send, active: true });
    expect(tabsRemove).toHaveBeenCalledWith(3);
    // None open: the page's own tab becomes the wallet's.
    vi.clearAllMocks();
    await expect(handOverRequestLink("https://apps.testnet.dusk.network", LINK, { pressed: true, tabId: 3 })).resolves.toBe(true);
    expect(tabsUpdate).toHaveBeenCalledWith(3, { url: send, active: true });
    expect([tabsCreate.mock.calls, tabsRemove.mock.calls]).toEqual([[], []]);

    // A computer's: a tab of its own, the page's left.
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0" });
    vi.clearAllMocks();
    await expect(openRequestLink({ link: LINK }, page)).resolves.toBe(true);
    expect(tabsCreate).toHaveBeenCalledWith({ url: send });
    expect(tabsRemove).not.toHaveBeenCalled();
  });

  it("is taken from the web wallet's own pages alone, also once it moved on", async () => {
    await expect(openRequestLink({ link: LINK }, { url: "https://apps.testnet.dusk.network/wallet/" })).resolves.toBe(true);
    tabsCreate.mockClear();
    for (const [link, sender] of [
      // Another site, whatever it claims.
      [LINK, { url: "https://phish.example/" }],
      [LINK, {}],
      // Another network's wallet than the page's.
      ["https://apps.dusk.network/wallet/dashboard/send?to=abc", onWalletPage],
      // No request.
      ["https://apps.testnet.dusk.network/wallet/dashboard/send", onWalletPage],
      ["https://apps.testnet.dusk.network/wallet/settings?to=abc", onWalletPage],
      ["https://phish.example/wallet/dashboard/send?to=abc", { url: "https://phish.example/" }],
      ["dusk:public-abc", onWalletPage],
      [undefined, onWalletPage],
      // A link that says a field twice, or with a user part before its host, which could be read two ways.
      [`${LINK}&network=mainnet`, onWalletPage],
      ["https://apps.testnet.dusk.network/wallet/dashboard/send?to=abc&to=def", onWalletPage],
      ["https://apps.dusk.network@apps.testnet.dusk.network/wallet/dashboard/send?to=abc", onWalletPage],
    ]) {
      await expect(offersRequestLink({ link }, sender)).resolves.toBe(false);
      await expect(openRequestLink({ link }, sender)).resolves.toBe(false);
    }
    expect(tabsCreate).not.toHaveBeenCalled();
    expect(tabsUpdate).not.toHaveBeenCalled();
    // One look for the wallet's tab: the one link taken.
    expect(tabsQuery).toHaveBeenCalledTimes(1);
  });
});

describe("a request the web wallet hands over (dusk_openPaymentLink)", () => {
  const WALLET = "https://apps.testnet.dusk.network";
  const opened = () => tabsCreate.mock.calls.map(([{ url }]) => decodeURIComponent(url.split("&link=")[1]));

  it("opens Send with the link of the web wallet's own page, on a press, with a wallet here", async () => {
    await expect(handOverRequestLink(WALLET, LINK, { pressed: true })).resolves.toBe(true);
    // A browser that can't say whether there was a press: as for the offer card.
    await expect(handOverRequestLink(WALLET, LINK)).resolves.toBe(true);
    expect(opened()).toEqual([LINK, LINK]);
    loadVault.mockImplementation(async () => null);
    await expect(handOverRequestLink(WALLET, LINK, { pressed: true })).resolves.toBe(false);
    expect(opened()).toHaveLength(2);
  });

  // Marek's: a second recipient, a line break or a hidden character inside to= was handed over, OK true, where the web wallet refuses the link.
  it("refuses a link whose recipient Send can't pay, saying why, as the web wallet does, offered or handed over", async () => {
    const OTHER = "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";
    const page = "https://apps.testnet.dusk.network/wallet/dashboard/send";
    for (const to of [`${ACCOUNT},${OTHER}`, `${ACCOUNT}%2C${OTHER}`, `${ACCOUNT.slice(0, 40)}%0A${ACCOUNT.slice(40)}`, `${ACCOUNT}%E2%80%AE`, `${ACCOUNT.slice(0, 40)}%E2%80%8B${ACCOUNT.slice(40)}`, `${ACCOUNT}%EF%B8%8F`]) {
      const link = `${page}?to=${to}&amount=0.001&network=testnet`;
      await expect(handOverRequestLink(WALLET, link, { pressed: true })).rejects.toMatchObject({ code: -32602, message: "This link's address isn't valid. Ask for a new one." });
      await expect(offersRequestLink({ link }, { url: link })).resolves.toBe(false);
      await expect(openRequestLink({ link }, { url: link })).resolves.toBe(false);
    }
    expect(tabsCreate).not.toHaveBeenCalled();
  });

  it("refuses another site's, another page's or another network's link, and one asked without a press", async () => {
    for (const [origin, link] of [
      ["https://phish.example", LINK],
      ["https://phish.example", "https://phish.example/wallet/dashboard/send?to=abc"],
      [WALLET, "https://apps.dusk.network/wallet/dashboard/send?to=abc"],
      [WALLET, "https://apps.testnet.dusk.network/wallet/settings?to=abc"],
      [WALLET, `dusk:public-${ACCOUNT}`],
      [WALLET, undefined],
    ]) {
      await expect(handOverRequestLink(origin, link, { pressed: true })).rejects.toMatchObject({ code: -32602 });
    }
    await expect(handOverRequestLink(WALLET, LINK, { pressed: false })).rejects.toMatchObject({ code: 4100 });
    expect(tabsCreate).not.toHaveBeenCalled();
  });

  it("opens a web wallet's on this machine, with the wallet on a node on this machine, as its network's own link, for Send to read", async () => {
    node.url = "http://127.0.0.1:8080";
    const local = `http://localhost:5173/dashboard/send?to=${ACCOUNT}&amount=1.5&memo=Factura+33&network=testnet`;
    await expect(handOverRequestLink("http://localhost:5173", local, { pressed: true })).resolves.toBe(true);
    expect(opened()).toEqual([`https://apps.testnet.dusk.network/wallet/dashboard/send?to=${ACCOUNT}&amount=1.5&memo=Factura+33&network=testnet`]);
    // Not from another page on this machine.
    await expect(handOverRequestLink("http://localhost:4000", local, { pressed: true })).rejects.toMatchObject({ code: -32602 });
  });

  it("takes nothing from a page on this machine while the wallet is on a network's node, and nothing that doesn't say its network", async () => {
    // Marek's: any page on localhost counted as the web wallet, and its link came out with no network.
    const page = "http://localhost:9999";
    const noNetwork = `${page}/wallet/dashboard/send?to=${ACCOUNT}&amount=0.15`;
    const local = `${page}/wallet/dashboard/send?to=${ACCOUNT}&amount=0.15&network=dusk:0`;
    for (const link of [noNetwork, local]) {
      await expect(handOverRequestLink(page, link, { pressed: true })).rejects.toMatchObject({ code: -32602 });
    }
    node.url = "http://localhost:8080";
    await expect(handOverRequestLink(page, noNetwork, { pressed: true })).rejects.toMatchObject({ code: -32602, message: "params.link must say the network it's for" });
    expect(tabsCreate).not.toHaveBeenCalled();
    // On the wallet's own node on this machine, a link of its network opens, keeping it.
    await expect(handOverRequestLink(page, local, { pressed: true })).resolves.toBe(true);
    expect(opened()).toEqual([`dusk:public-${ACCOUNT}@dusk:0?amount=0.15`]);
  });

  it("refuses a link on this machine that Send would refuse, rather than rebuild it into one Send takes", async () => {
    node.url = "http://127.0.0.1:8080";
    // Codex's: amount=1 and amountLux 5,000 DUSK came out as a link for 5,000 DUSK.
    const twice = `http://localhost:5173/dashboard/send?to=${ACCOUNT}&amount=1&amountLux=5000000000000&network=testnet`;
    await expect(handOverRequestLink("http://localhost:5173", twice, { pressed: true })).rejects.toMatchObject({ code: -32602, message: "This link asks for two different amounts. Ask for a new one." });
    expect(tabsCreate).not.toHaveBeenCalled();
    // The same amount said both ways is one amount.
    await expect(handOverRequestLink("http://localhost:5173", twice.replace("amount=1&", "amount=5000&"), { pressed: true })).resolves.toBe(true);
    expect(opened()).toEqual([`https://apps.testnet.dusk.network/wallet/dashboard/send?to=${ACCOUNT}&amount=5000&network=testnet`]);
  });
});
