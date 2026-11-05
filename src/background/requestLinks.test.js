import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runtimeGetURL, tabsCreate } from "../platform/extensionApi.js";
import { loadVault } from "../shared/vault.js";
import { offersRequestLink, openRequestLink } from "./requestLinks.js";

vi.mock("../platform/extensionApi.js", () => ({
  runtimeGetURL: vi.fn((path) => `chrome-extension://wallet/${path}`),
  tabsCreate: vi.fn(async () => ({})),
}));
vi.mock("../shared/vault.js", () => ({ loadVault: vi.fn(async () => ({ version: 2 })) }));

const LINK = "https://apps.testnet.dusk.network/wallet/dashboard/send?to=abc&amount=1&network=testnet";
const onWalletPage = { url: LINK };

beforeEach(() => vi.clearAllMocks());
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
    ]) {
      await expect(offersRequestLink({ link }, sender)).resolves.toBe(false);
      await expect(openRequestLink({ link }, sender)).resolves.toBe(false);
    }
    expect(tabsCreate).not.toHaveBeenCalled();
    expect(runtimeGetURL).toHaveBeenCalledTimes(1);
  });
});
