import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runtimeGetURL, tabsCreate, tabsQuery, tabsUpdate } from "../platform/extensionApi.js";
import { loadVault } from "../shared/vault.js";
import { handOverRequestLink, offersRequestLink, openRequestLink } from "./requestLinks.js";

vi.mock("../platform/extensionApi.js", () => ({
  runtimeGetURL: vi.fn((path) => `chrome-extension://wallet/${path}`),
  tabsCreate: vi.fn(async () => ({})),
  // No wallet tab open, unless a test opens one.
  tabsQuery: vi.fn(async () => []),
  tabsUpdate: vi.fn(async () => ({})),
}));
vi.mock("../shared/vault.js", () => ({ loadVault: vi.fn(async () => ({ version: 2 })) }));
// The wallet's node, as Settings has it: a test on this machine says so.
const node = vi.hoisted(() => ({ url: "https://testnet.nodes.dusk.network" }));
vi.mock("../shared/settings.js", () => ({ getSettings: vi.fn(async () => ({ nodeUrl: node.url })) }));

const LINK = "https://apps.testnet.dusk.network/wallet/dashboard/send?to=abc&amount=1&network=testnet";
const onWalletPage = { url: LINK };

beforeEach(() => {
  vi.clearAllMocks();
  node.url = "https://testnet.nodes.dusk.network";
});
afterEach(() => loadVault.mockImplementation(async () => ({ version: 2 })));

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
  const ACCOUNT = "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927";
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
