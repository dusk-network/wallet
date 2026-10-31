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
    const { installFakeDom, screenReaderText, visibleText } = await import("../../testing/fakeDom.js");
    const { vi } = await import("vitest");
    const { document } = installFakeDom();
    const { assetsOwner, assetsSectionsView } = await import("./assets.js");
    const TOKEN = `0x${"cd".repeat(32)}`;
    const assets = (tokens, nfts = []) => ({
      loaded: true,
      loading: false,
      owner: assetsOwner(ov),
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
    expect(screenReaderText(section().querySelector(".bracket-title"))).toBe("Tokens and NFTs");
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

describe("tokens and NFTs after a switch to another wallet, on the same network and profile", () => {
  it("shows none of the last wallet's, and what was being read for it lands nowhere", async () => {
    const { installFakeDom, settle, visibleText } = await import("../../testing/fakeDom.js");
    const { vi } = await import("vitest");
    const { document } = installFakeDom();
    const { assetsSectionsView } = await import("./assets.js");
    const TOKEN = `0x${"cd".repeat(32)}`;
    const walletA = { tokens: [{ contractId: TOKEN, symbol: "TKN", name: "Token", decimals: 2 }], nfts: [] };
    // The watched assets each read answers, when the test says.
    const reads = [];
    const actions = {
      send: vi.fn((message) => {
        if (message.type !== "DUSK_UI_ASSETS_GET") return Promise.resolve({ result: "12345" });
        const read = Promise.withResolvers();
        reads.push(read);
        return read.promise;
      }),
      render: vi.fn(async () => {}),
    };
    const ov = (wallet) => ({ isUnlocked: true, nodeUrl: "https://testnet.nodes.dusk.network", accounts: [wallet], selectedAccountIndex: 0 });
    const rows = (state, wallet) => {
      document.body.replaceChildren(...assetsSectionsView(ov(wallet), { state, actions }));
      return document.body.querySelectorAll(".asset-row").map(visibleText);
    };

    // Wallet A's token, read and shown; then wallet B's screen shows none of it.
    let state = { route: "home" };
    rows(state, "wallet-a");
    reads.shift().resolve({ result: walletA });
    await settle();
    // Its balance, read as the row shows.
    rows(state, "wallet-a");
    await settle();
    expect(rows(state, "wallet-a")).toEqual(["TTKNToken123.45 TKN"]);
    expect(rows(state, "wallet-b")).toEqual([]);

    // A read for wallet A still on its way when wallet B opens.
    state = { route: "home" };
    reads.length = 0;
    rows(state, "wallet-a");
    rows(state, "wallet-b");
    reads[0].resolve({ result: walletA });
    await settle();
    expect(rows(state, "wallet-b")).toEqual([]);
  });
});

describe("a token send's Review", () => {
  it("names the wallet and profile it goes from with more than one wallet, and adds nothing with one", async () => {
    const { installFakeDom, visibleText } = await import("../../testing/fakeDom.js");
    const { vi } = await import("vitest");
    const { document } = installFakeDom();
    const { assetTokenConfirmView } = await import("./assets.js");
    const { reviewOf } = await import("./sent.js");
    const TOKEN = `0x${"cd".repeat(32)}`;
    const TO = "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927";
    const draft = () => ({
      op: "transfer",
      token: { contractId: TOKEN, symbol: "TKN", name: "Token", decimals: 2 },
      params: { kind: "contract_call", privacy: "public", contractId: TOKEN, fnName: "transfer", fnArgs: "0x00", amount: "0", deposit: "0" },
      asset: { type: "DRC20", op: "transfer", symbol: "TKN", name: "Token", decimals: 2, valueUnits: "150", to: TO },
    });
    // A local node: no .dusk names, so the profile shows by its label.
    const ov = (wallets) => ({ isUnlocked: true, nodeUrl: "http://127.0.0.1:8080", accounts: ["acct"], selectedAccountIndex: 0, wallets });
    const rows = (o) => {
      const state = { route: "asset_token_confirm", assetTxDraft: draft() };
      const actions = { send: vi.fn(async () => ({})), render: vi.fn(async () => {}), showToast: vi.fn(), review: reviewOf(o, state) };
      document.body.replaceChildren(...assetTokenConfirmView(o, { state, actions }));
      return document.body.querySelectorAll(".asset-review > .group > .kv").map(visibleText);
    };
    expect(rows(ov([{ key: "w1", n: 1, active: true }, { key: "w2", n: 2 }]))[0]).toBe("FromWallet 1 · Profile 1");
    expect(rows(ov([{ key: "w1", n: 1, active: true }])).filter((r) => r.startsWith("From"))).toEqual([]);
  });
});
