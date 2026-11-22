import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

// A figure exactly as written: not inside a longer number, not signed or bounded unless written so, and not followed by
// more digits, letters or a decimal part (1.0025 ≠ 11.0025, 0.005 ≠ −0.005, 2,000,000 ≠ 2,000,000.5, BNB ≠ BNBX).
const exactly = (text) => new RegExp(`(?<![\\d.,+\\-−<>≤≥~])(?<![+\\-−<>≤≥~]\\s)${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\dA-Za-z]|[.,]\\d)`);

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
      return document.body.querySelectorAll(".asset-row");
    };

    // Wallet A's token, read and shown; then wallet B's screen shows none of it.
    let state = { route: "home" };
    rows(state, "wallet-a");
    reads.shift().resolve({ result: walletA });
    await settle();
    // Its balance, read as the row shows: in the row's amount, with the token's symbol.
    rows(state, "wallet-a");
    await settle();
    expect(rows(state, "wallet-a").map((row) => visibleText(row.querySelector(".asset-amt")))).toEqual(["123.45 TKN"]);
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

describe("a read of the watched tokens that fails", () => {
  const TOKEN = `0x${"cd".repeat(32)}`;
  const NODE = "https://testnet.nodes.dusk.network";
  const ov = ({ wallet = "wallet-a", nodeUrl = NODE, profile = 0 } = {}) => ({ isUnlocked: true, nodeUrl, accounts: [wallet, "other"], selectedAccountIndex: profile });

  const NFT = `${"ef".repeat(32)}`;
  const TOKENS = { tokens: [{ contractId: TOKEN, symbol: "TKN", name: "Token", decimals: 2 }], nfts: [] };
  const LISTED = { ...TOKENS, nfts: [{ contractId: NFT, tokenId: "7", symbol: "ART", name: "Artwork" }] };

  // The popup's asset screens as it draws them: Home's Tokens and NFTs, a token's page, an NFT's, Add token. Drawn
  // again whenever it asks, by the route; its answers coming a moment later, as the background's do. `answer.list`
  // is the watched list a read gives, `answer.balance` a token balance's answer (a promise holds it).
  async function homeTokens() {
    const { installFakeDom, settle, visibleText } = await import("../../testing/fakeDom.js");
    const { vi } = await import("vitest");
    const { document } = installFakeDom();
    const views = await import("./assets.js");
    const answer = { fail: true, list: TOKENS, balance: { result: "12345" } };
    const state = { route: "home" };
    let shown = ov();
    const screens = { home: views.assetsSectionsView, asset_token: views.assetTokenView, asset_nft: views.assetNftView, asset_add_token: views.assetAddTokenView };
    const draw = (next = shown) => {
      shown = next;
      document.body.replaceChildren(...screens[state.route](shown, { state, actions }));
    };
    const later = (value) => new Promise((resolve) => setTimeout(() => resolve(value)));
    const actions = {
      send: vi.fn((message) => {
        if (message.type === "DUSK_UI_ASSETS_GET") return later(answer.fail ? { error: { message: "Watched tokens can't be read now." } } : { result: answer.list });
        if (message.type === "DUSK_UI_DRC20_GET_BALANCE") return answer.balance instanceof Promise ? answer.balance : later(answer.balance);
        return later({ ok: true });
      }),
      render: vi.fn(async () => draw()),
      showToast: vi.fn(),
    };
    const asked = (type) => actions.send.mock.calls.filter(([m]) => m.type === type).length;
    const reads = () => asked("DUSK_UI_ASSETS_GET");
    const settleAll = async () => {
      for (let i = 0; i < 6; i++) await settle();
    };
    const press = async (text) => {
      document.body.querySelectorAll("button").find((b) => b.textContent === text).click();
      await settleAll();
    };
    return { answer, state, draw, reads, asked, settleAll, press, text: () => visibleText(document.body), rows: () => document.body.querySelectorAll(".asset-row"), vi };
  }

  it("is said on the screen and asked for once, not again each time the screen is drawn, and read again later", async () => {
    const page = await homeTokens();
    try {
      page.draw();
      await page.settleAll();
      expect(page.reads()).toBe(1);
      expect(page.text()).toContain("Watched tokens can't be read now.");
      // Drawn again and again, as the popup does: still the one read, the error still shown.
      for (let i = 0; i < 5; i++) page.draw();
      await page.settleAll();
      expect(page.reads()).toBe(1);
      expect(page.text()).toContain("Watched tokens can't be read now.");

      // Later, as a list read in full would be read again: asked once more, and it's there.
      page.vi.setSystemTime(Date.now() + 30_001);
      page.answer.fail = false;
      page.draw();
      await page.settleAll();
      expect(page.reads()).toBe(2);
      expect(page.rows().length).toBe(1);
      expect(page.text()).not.toContain("Watched tokens can't be read now.");
    } finally {
      page.vi.useRealTimers();
    }
  });

  it.each([
    ["wallet", { wallet: "wallet-b" }],
    ["network", { nodeUrl: "https://nodes.dusk.network" }],
    ["profile", { profile: 1 }],
  ])("is asked for again at once on a switch of %s", async (_, to) => {
    const page = await homeTokens();
    page.draw();
    await page.settleAll();
    expect(page.reads()).toBe(1);
    page.answer.fail = false;
    page.draw(ov(to));
    await page.settleAll();
    expect(page.reads()).toBe(2);
    expect(page.rows().length).toBe(1);
  });

  it("is read again at once when the list changes, as a token added changes it, and the new token shows", async () => {
    const page = await homeTokens();
    page.answer.list = { tokens: [], nfts: [] };
    page.draw();
    await page.settleAll();
    expect(page.reads()).toBe(1);
    expect(page.text()).toContain("Watched tokens can't be read now.");

    // Add token, its details looked up: added, and Home again at once.
    page.answer.fail = false;
    page.answer.list = TOKENS;
    page.state.route = "asset_add_token";
    page.state.assetAddToken = { contractId: TOKEN, loading: false, error: null, meta: { name: "Token", symbol: "TKN", decimals: 2 } };
    page.draw();
    await page.press("Add token");
    expect(page.asked("DUSK_UI_ASSETS_WATCH_TOKEN")).toBe(1);
    expect(page.state.route).toBe("home");
    expect(page.reads()).toBe(2);
    expect(page.rows().length).toBe(1);
    expect(page.text()).not.toContain("Watched tokens can't be read now.");
  });

  it("says only its error on Home with nothing read before, never that there are none", async () => {
    const page = await homeTokens();
    page.draw();
    await page.settleAll();
    expect(page.text()).toContain("Watched tokens can't be read now.");
    expect(page.text()).not.toMatch(/No tokens/);
  });

  it.each([
    ["a token's page", "asset_token", (state) => (state.assetTokenContractId = TOKEN), /Loading/],
    ["an NFT's page", "asset_nft", (state) => (state.assetNft = { contractId: NFT, tokenId: "7" }), /not found/],
  ])("says its error on %s after a switch of profile, and reads again after the pause", async (_, route, open, untrue) => {
    const page = await homeTokens();
    try {
      page.answer.fail = false;
      page.answer.list = LISTED;
      page.draw();
      await page.settleAll();
      expect(page.reads()).toBe(1);

      // The page open, and another profile whose read fails.
      page.state.route = route;
      open(page.state);
      page.answer.fail = true;
      page.draw(ov({ profile: 1 }));
      await page.settleAll();
      expect(page.reads()).toBe(2);
      expect(page.text()).toContain("Watched tokens can't be read now.");
      expect(page.text()).not.toMatch(untrue);

      // After the pause, drawn again: asked again, and the page shows what it's for.
      page.vi.setSystemTime(Date.now() + 30_001);
      page.answer.fail = false;
      page.draw();
      await page.settleAll();
      expect(page.reads()).toBe(3);
      expect(page.text()).not.toContain("Watched tokens can't be read now.");
      expect(page.text()).toContain(route === "asset_token" ? "TKN" : "ART #7");
    } finally {
      page.vi.useRealTimers();
    }
  });

  it("asks for a token's balance once while it's being read, however often the screen is drawn", async () => {
    const page = await homeTokens();
    page.answer.fail = false;
    const balance = Promise.withResolvers();
    page.answer.balance = balance.promise;
    page.draw();
    await page.settleAll();
    for (let i = 0; i < 6; i++) page.draw();
    await page.settleAll();
    expect(page.asked("DUSK_UI_DRC20_GET_BALANCE")).toBe(1);

    // Its answer comes: shown, and not asked for again.
    balance.resolve({ result: "12345" });
    await page.settleAll();
    page.draw();
    await page.settleAll();
    expect(page.asked("DUSK_UI_DRC20_GET_BALANCE")).toBe(1);
    expect(page.text()).toMatch(exactly("123.45"));
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
    // How much the public balance is short of the fee.
    expect(document.body.querySelector(".pay-guard").textContent).toMatch(exactly("0.5 DUSK"));
    expect(document.body.querySelector(".pay-guard").textContent).toMatch(/public/);
    // Its Confirm, whatever it says: the one button at the Review's end.
    expect(document.body.querySelector(".review-actions button").disabled).toBe(true);
  });

  it("writes the token's balance and how much is missing in the browser's number format", async () => {
    const { press } = await open({ to: TO, amount: "2000", spender: "", approveAmount: "" }, "123456", "de-DE");
    const { document } = globalThis;
    expect(document.body.querySelector(".asset-token-balance-value").textContent).toBe("1.234,56 TKN");
    await press("Review transfer");
    expect(document.body.querySelector(".asset-action-section .field-error").textContent).toMatch(exactly("765,44 TKN"));
    const { vi } = await import("vitest");
    vi.unstubAllGlobals();
  });

  it("says how much a transfer is over what the profile holds, and asks nothing", async () => {
    const { press, send, state } = await open({ to: TO, amount: "200", spender: "", approveAmount: "" });
    await press("Review transfer");
    expect(state.route).toBe("asset_token");
    expect(send.mock.calls.map(([m]) => m.type)).not.toContain("DUSK_UI_DRC20_ENCODE_INPUT");
    const { document } = globalThis;
    expect(document.body.querySelector(".asset-action-section .field-error").textContent).toMatch(exactly("76.55 TKN"));
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

  it("reviews a token's amount to its last decimal, as it will go", async () => {
    const { installFakeDom, settle } = await import("../../testing/fakeDom.js");
    const { document } = installFakeDom();
    const { vi } = await import("vitest");
    const { assetTokenConfirmView } = await import("./assets.js");
    const state = {
      route: "asset_token_confirm",
      assetTxDraft: {
        op: "transfer",
        token: { contractId: TOKEN, symbol: "TKN", decimals: 9 },
        asset: { valueUnits: "1234567891", to: TO },
        params: { kind: "contract_call", privacy: "public", contractId: TOKEN, fnName: "transfer", fnArgs: "0x00", amount: "0", deposit: "0" },
      },
    };
    const ov = { isUnlocked: true, nodeUrl: "http://127.0.0.1:8080", accounts: ["acct"], selectedAccountIndex: 0, balance: { value: "100000000" } };
    const actions = { send: vi.fn(async () => ({})), render: vi.fn(async () => {}), showToast: vi.fn() };
    document.body.replaceChildren(...assetTokenConfirmView(ov, { state, actions }));
    await settle();
    expect(document.body.querySelector(".review-head .balance-amount").textContent).toBe("1.234567891 TKN");
    vi.unstubAllGlobals();
  });

  it("reads a token's amount as French writes it", async () => {
    const { press, send } = await open({ to: TO, amount: "1\u202f000,5", spender: "", approveAmount: "" }, "12345678", "fr-FR");
    await press("Review transfer");
    expect(send.mock.calls.find(([m]) => m.type === "DUSK_UI_DRC20_ENCODE_INPUT")[0].args.value).toBe("100050");
    const { vi } = await import("vitest");
    vi.unstubAllGlobals();
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
    // What the Review's From row says, or null where it has none.
    const from = (o) => {
      const state = { route: "asset_token_confirm", assetTxDraft: draft() };
      const actions = { send: vi.fn(async () => ({})), render: vi.fn(async () => {}), showToast: vi.fn(), review: reviewOf(o, state) };
      document.body.replaceChildren(...assetTokenConfirmView(o, { state, actions }));
      const row = document.body.querySelectorAll(".asset-review .kv").find((kv) => visibleText(kv.querySelector(".kv-label")) === "From");
      return row ? visibleText(row.querySelector(".kv-value")) : null;
    };
    expect(from(ov([{ key: "w1", n: 1, active: true }, { key: "w2", n: 2 }]))).toBe("Wallet 1 · Profile 1");
    expect(from(ov([{ key: "w1", n: 1, active: true }]))).toBeNull();
  });

  // Lena's, three rounds: the default followed the mempool's median, which one transaction waiting alone at 2 made
  // everyone's price. What waits fits in a block: a token's transfer starts from the minimum too.
  it("starts a token's transfer from the minimum with one transaction waiting at 2, and the capped median with a full mempool", async () => {
    const { installFakeDom, pastClickGuard, settle, visibleText } = await import("../../testing/fakeDom.js");
    const { vi } = await import("vitest");
    const { document } = installFakeDom();
    const { assetTokenConfirmView } = await import("./assets.js");
    const { reviewOf } = await import("./sent.js");
    const TOKEN = `0x${"cd".repeat(32)}`;
    const TO = "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927";
    const ov = { isUnlocked: true, nodeUrl: "http://127.0.0.1:8080", accounts: ["acct"], selectedAccountIndex: 0 };
    const priceSent = async (stats) => {
      const state = {
        route: "asset_token_confirm",
        assetTxDraft: {
          op: "transfer",
          token: { contractId: TOKEN, symbol: "TKN", name: "Token", decimals: 2 },
          params: { kind: "contract_call", privacy: "public", contractId: TOKEN, fnName: "transfer", fnArgs: "0x00", amount: "0", deposit: "0" },
          asset: { type: "DRC20", op: "transfer", symbol: "TKN", name: "Token", decimals: 2, valueUnits: "150", to: TO },
        },
      };
      const sent = [];
      const send = vi.fn(async (message) => {
        if (message.type === "DUSK_UI_SEND_TX") sent.push(message);
        return message.type === "DUSK_UI_GET_CACHED_GAS_PRICE" ? stats : { ok: true, result: { hash: "ab".repeat(32) } };
      });
      document.body.replaceChildren(...assetTokenConfirmView(ov, { state, actions: { send, render: vi.fn(async () => {}), showToast: vi.fn(), announce: vi.fn(), review: reviewOf(ov, state) } }));
      await settle();
      // Whether it says the network is busy.
      const busy = visibleText(document.body.querySelector("dusk-gas-editor .gas-busy") ?? { textContent: "" }) !== "";
      pastClickGuard();
      // Its Confirm, whatever it says: the one button at the Review's end.
      document.body.querySelector(".review-actions button").click();
      await settle();
      return [sent[0]?.params.gas?.price, busy];
    };
    try {
      expect(await priceSent({ mempool: [{ gasPrice: "2", gasLimit: "6000000" }] })).toEqual(["1", false]);
      const full = { mempool: Array.from({ length: 1000 }, () => ({ gasPrice: "900", gasLimit: "2500000" })) };
      expect(await priceSent(full)).toEqual(["5", true]);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
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
      // Its Confirm, whatever it says: the one button at the Review's end.
      const confirm = document.body.querySelector(".review-actions button");
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
