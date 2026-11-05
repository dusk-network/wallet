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

describe("sending a token from its page", () => {
  const TOKEN = `0x${"cd".repeat(32)}`;
  const TO = "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nF";

  async function open(form, held = "12345", language = "en-US") {
    const { installFakeDom, settle } = await import("../../testing/fakeDom.js");
    const { vi } = await import("vitest");
    const { document } = installFakeDom();
    vi.stubGlobal("navigator", { ...globalThis.navigator, language });
    const { assetTokenView, assetsOwner } = await import("./assets.js");
    const ov = { isUnlocked: true, nodeUrl: "http://127.0.0.1:8080", accounts: ["acct"], selectedAccountIndex: 0 };
    const send = vi.fn(async (message) => (message.type === "DUSK_UI_DRC20_ENCODE_INPUT" ? { result: [1, 2, 3] } : {}));
    const state = {
      route: "asset_token",
      assetTokenForm: form,
      assetTokenContractId: TOKEN,
      assets: { loaded: true, loading: false, owner: assetsOwner(ov), updatedAt: Date.now(), tokens: [{ contractId: TOKEN, symbol: "TKN", name: "Token", decimals: 2 }], nfts: [], balances: { [TOKEN]: held }, balancesAt: { [TOKEN]: Date.now() } },
    };
    const actions = { send, render: vi.fn(async () => {}), showToast: vi.fn() };
    document.body.replaceChildren(...assetTokenView(ov, { state, actions }));
    const press = async (text) => {
      document.body.querySelectorAll("button").find((b) => b.textContent === text).click();
      await settle();
    };
    return { press, send, state };
  }

  it("says on Review when the public balance can't pay its fee, and keeps Confirm off", async () => {
    const { installFakeDom, settle } = await import("../../testing/fakeDom.js");
    const { vi } = await import("vitest");
    const { document } = installFakeDom();
    const { assetTokenConfirmView } = await import("./assets.js");
    const ov = { isUnlocked: true, nodeUrl: "http://127.0.0.1:8080", accounts: ["acct"], selectedAccountIndex: 0, balance: { value: "1000" } };
    const state = {
      route: "asset_token_confirm",
      assetTxDraft: {
        op: "transfer",
        token: { contractId: TOKEN, symbol: "TKN", decimals: 2 },
        params: { kind: "contract_call", privacy: "public", contractId: TOKEN, fnName: "transfer", fnArgs: [1], amount: "0", deposit: "0" },
        asset: { type: "DRC20", op: "transfer", valueUnits: "100", to: TO },
      },
    };
    const actions = { send: vi.fn(async () => ({})), render: vi.fn(async () => {}), showToast: vi.fn(), review: {} };
    document.body.replaceChildren(...assetTokenConfirmView(ov, { state, actions }));
    await settle();
    expect(document.body.querySelector(".pay-guard").textContent).toContain("The public balance doesn't cover the network fee:");
    expect(document.body.querySelectorAll("button").find((b) => b.textContent === "Confirm").disabled).toBe(true);
  });

  it("writes the token's balance and how much is missing in the browser's number format", async () => {
    const { press } = await open({ to: TO, amount: "2000", spender: "", approveAmount: "" }, "123456", "de-DE");
    const { document } = globalThis;
    expect(document.body.querySelector(".asset-token-balance-value").textContent).toBe("1.234,56 TKN");
    await press("Review transfer");
    expect(document.body.querySelector(".asset-action-section .field-error").textContent).toBe("That's 765,44 TKN more than you have.");
    const { vi } = await import("vitest");
    vi.unstubAllGlobals();
  });

  it("says how much a transfer is over what the profile holds, and asks nothing", async () => {
    const { press, send, state } = await open({ to: TO, amount: "200", spender: "", approveAmount: "" });
    await press("Review transfer");
    expect(state.route).toBe("asset_token");
    expect(send.mock.calls.map(([m]) => m.type)).not.toContain("DUSK_UI_DRC20_ENCODE_INPUT");
    const { document } = globalThis;
    expect(document.body.querySelector(".asset-action-section .field-error").textContent).toBe("That's 76.55 TKN more than you have.");
  });

  it("asks the engine for the token's own call, and reviews what it asked", async () => {
    const { press, send, state } = await open({ to: TO, amount: "90071992547409.93", spender: "", approveAmount: "" }, "9007199254740993");
    await press("Review transfer");
    expect(send.mock.calls.map(([m]) => m).find((m) => m.type === "DUSK_UI_DRC20_ENCODE_INPUT")).toMatchObject({
      contractId: TOKEN,
      fnName: "transfer",
      args: { to: { External: TO }, value: "9007199254740993" },
    });
    expect(state.route).toBe("asset_token_confirm");
    expect(state.assetTxDraft.params).toMatchObject({ contractId: TOKEN, fnName: "transfer", fnArgs: [1, 2, 3], amount: "0" });
    expect(state.assetTxDraft.asset).toMatchObject({ valueUnits: "9007199254740993", to: TO });
  });

  it.each([`0x${"AB".repeat(32)}`, "ab".repeat(32)])("takes %s as a contract, as the token drivers write one", async (typed) => {
    const contract = "ab".repeat(32);
    const { press, send, state } = await open({ to: typed, amount: "1", spender: typed, approveAmount: "2" });
    await press("Review transfer");
    expect(send.mock.calls.at(-1)[0].args).toEqual({ to: { Contract: contract }, value: "100" });
    expect(state.assetTxDraft.asset.to).toBe(contract);
    state.route = "asset_token";
    await press("Review approval");
    expect(send.mock.calls.at(-1)[0]).toMatchObject({ contractId: TOKEN, fnName: "approve", args: { spender: { Contract: contract }, value: "200" } });
    expect(state.assetTxDraft.asset.spender).toBe(contract);
  });

  it("reads a decimal comma, and refuses what isn't an amount instead of cutting it short", async () => {
    const first = await open({ to: TO, amount: "1,5", spender: "", approveAmount: "" });
    await first.press("Review transfer");
    expect(first.send.mock.calls.at(-1)[0].args.value).toBe("150");

    for (const amount of ["1.2.3", "1,2,3", "1.foo", "-1", "1e1", ",", "."]) {
      const { press, send, state } = await open({ to: TO, amount, spender: TO, approveAmount: amount });
      await press("Review transfer");
      await press("Review approval");
      expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "DUSK_UI_DRC20_ENCODE_INPUT" }));
      expect(state.route).toBe("asset_token");
    }
  });

  it("doesn't go to Review when the engine won't write the call", async () => {
    const { press, send, state } = await open({ to: TO, amount: "1", spender: "", approveAmount: "" });
    send.mockImplementation(async () => ({ error: { message: "The call wasn't written as asked, so it wasn't sent." } }));
    await press("Review transfer");
    expect(state.route).toBe("asset_token");
    expect(state.assetTxDraft).toBeUndefined();
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

  it("ignores a click on Confirm the moment it's up, and sends one a moment later", async () => {
    const { installFakeDom, pastClickGuard, settle } = await import("../../testing/fakeDom.js");
    const { vi } = await import("vitest");
    const { document } = installFakeDom();
    const { assetTokenConfirmView } = await import("./assets.js");
    const { reviewOf } = await import("./sent.js");
    const { screenShown } = await import("../../lib/clickGuard.js");
    const TOKEN = `0x${"cd".repeat(32)}`;
    const TO = "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927";
    const ov = { isUnlocked: true, nodeUrl: "http://127.0.0.1:8080", accounts: ["acct"], selectedAccountIndex: 0 };
    const state = {
      route: "asset_token_confirm",
      assetTxDraft: {
        op: "transfer",
        token: { contractId: TOKEN, symbol: "TKN", name: "Token", decimals: 2 },
        params: { kind: "contract_call", privacy: "public", contractId: TOKEN, fnName: "transfer", fnArgs: "0x00", amount: "0", deposit: "0" },
        asset: { type: "DRC20", op: "transfer", symbol: "TKN", name: "Token", decimals: 2, valueUnits: "150", to: TO },
      },
    };
    const send = vi.fn(async (message) => (message.type === "DUSK_UI_SEND_TX" ? { ok: true, result: { hash: "ab".repeat(32) } } : {}));
    const actions = { send, render: vi.fn(async () => {}), showToast: vi.fn(), announce: vi.fn(), review: reviewOf(ov, state) };
    try {
      document.body.replaceChildren(...assetTokenConfirmView(ov, { state, actions }));
      // Up, as app.js marks a new screen.
      screenShown();
      const confirm = document.body.querySelectorAll("button").find((b) => b.textContent === "Confirm");
      const sends = () => send.mock.calls.filter(([m]) => m.type === "DUSK_UI_SEND_TX");

      confirm.click();
      await settle();
      expect([sends(), state.route, confirm.disabled]).toEqual([[], "asset_token_confirm", false]);

      pastClickGuard();
      confirm.click();
      await settle();
      expect(sends()).toHaveLength(1);
      expect(state.route).toBe("sent");
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
