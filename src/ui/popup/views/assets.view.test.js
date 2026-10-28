import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("assets view", () => {
  it("passes token data-driver hints through balance, encode, and tx metadata paths", async () => {
    const source = await readFile(
      path.resolve(process.cwd(), "src", "ui", "popup", "views", "assets.js"),
      "utf8"
    );

    expect(source).toContain("driver: t?.driver");
    expect(source).toContain("driver: token?.driver");
    expect(source).toContain("token: { contractId: cid, symbol: sym, name, decimals: dec, driver: token?.driver }");
    expect(source).toContain("driver: token?.driver");
  });
});

describe("tokens and NFTs on Home", () => {
  it("shows them in one section with its two actions, the token's balance with its symbol", async () => {
    const { installFakeDom, visibleText } = await import("../../testing/fakeDom.js");
    const { vi } = await import("vitest");
    const { document } = installFakeDom();
    const { assetsSectionsView } = await import("./assets.js");
    const TOKEN = `0x${"cd".repeat(32)}`;
    const assets = (tokens, nfts = []) => ({
      loaded: true,
      loading: false,
      networkKey: "https://testnet.nodes.dusk.network",
      profileIndex: 0,
      updatedAt: Date.now(),
      tokens,
      nfts,
      balances: { [TOKEN]: "12345" },
      balancesAt: { [TOKEN]: Date.now() },
    });
    const ov = { isUnlocked: true, nodeUrl: "https://testnet.nodes.dusk.network", accounts: ["acct"], selectedAccountIndex: 0 };
    const actions = { send: vi.fn(async () => ({})), render: vi.fn(async () => {}), showToast: vi.fn() };
    const draw = (state) => document.body.replaceChildren(...assetsSectionsView(ov, { state, actions }));

    const state = { route: "home", assets: assets([]) };
    draw(state);
    const section = () => document.body.querySelector(".home-assets");
    expect(section().querySelector(".bracket-title").textContent).toBe("Tokens and NFTs");
    expect(section().querySelectorAll(".section-actions button").map((b) => b.textContent)).toEqual(["Add token", "Import NFT"]);
    expect(visibleText(section().querySelector(".tx-empty"))).toBe("No tokens or NFTs yet.");

    state.assets = assets(
      [{ contractId: TOKEN, symbol: "TKN", name: "Token", decimals: 2 }],
      [{ contractId: TOKEN, tokenId: "7", symbol: "ART", name: "Art" }]
    );
    draw(state);
    expect(section().querySelectorAll(".asset-row").map(visibleText)).toEqual(["TTKNToken123.45 TKN", "ART #7Art"]);
    section().querySelectorAll(".section-actions button")[1].click();
    expect(state.route).toBe("asset_add_nft");
  });
});
