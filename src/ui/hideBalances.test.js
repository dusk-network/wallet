import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TX_KIND } from "../shared/constants.js";
// The fake DOM goes before the views: it defines HTMLElement for the gas editor.
import { fakeEvent, installFakeDom, screenReaderText, settle, typeInto, visibleText } from "./testing/fakeDom.js";
import { assetTokenView, assetsOwner, assetsSectionsView } from "./popup/views/assets.js";
import { convertConfirmView, convertFormView } from "./popup/views/convert.js";
import { homeView } from "./popup/views/home.js";
import { sendConfirmView, sendFormView } from "./popup/views/send.js";
import { sozuConfirmView } from "./popup/views/sozu.js";
import { stakeConfirmView, stakeFormView } from "./popup/views/stake.js";

vi.mock("../shared/addressBook.js", () => ({ listAddressBook: vi.fn(async () => []) }));

const ACCOUNT =
  "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927";
const OTHER_ACCOUNT =
  "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";
const ADDRESS = "2Ana1pUpv2ZbMVkwF5FXapYeBEjdxDatLn7nvJkhgTSXbs59SyZSx866bXirPgj8QQVB57uxHJBG1YFvkRbFj4T";
const TOKEN = `0x${"cd".repeat(32)}`;
const NODE = "https://testnet.nodes.dusk.network";
const dusk = (n) => (BigInt(n) * 1_000_000_000n).toString();

// 1482.9383 DUSK public and 25 DUSK shielded, 5 of it held for a pending
// transaction, and a sent 1 DUSK in Activity.
const overview = (over = {}) => ({
  hasVault: true,
  isUnlocked: true,
  nodeUrl: NODE,
  networkName: "Testnet",
  accounts: [ACCOUNT],
  addresses: [],
  selectedAccountIndex: 0,
  balance: { value: "1482938300000" },
  shieldedBalance: { value: dusk(25), spendable: dusk(20) },
  txs: [{ hash: "ab".repeat(32), kind: TX_KIND.TRANSFER, to: OTHER_ACCOUNT, amount: dusk(1), status: "executed" }],
  ...over,
});
const HIDDEN = { hideBalances: true };

// The watched token, 123.45 TKN, with its balance just read.
const assets = () => ({
  owner: assetsOwner(overview()),
  loaded: true,
  loading: false,
  updatedAt: Date.now(),
  tokens: [{ contractId: TOKEN, symbol: "TKN", name: "Token", decimals: 2 }],
  nfts: [],
  balances: { [TOKEN]: "12345" },
  balancesAt: { [TOKEN]: Date.now() },
});

let dom;
let body;

beforeEach(() => {
  dom = installFakeDom();
  body = dom.document.body;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const actions = (send = async () => ({ ok: true })) => ({
  send: vi.fn(send),
  render: vi.fn(async () => {}),
  refresh: vi.fn(async () => {}),
  showToast: vi.fn(),
});

async function show(nodes) {
  body.replaceChildren(...[nodes].flat());
  await settle();
  return body;
}

const button = (text) => body.querySelectorAll("button").find((b) => b.textContent === text);
// A figure exactly as written: not inside a longer number, not signed or bounded unless written so, and not followed by
// more digits, letters or a decimal part (1.0025 ≠ 11.0025, 0.005 ≠ −0.005, 2,000,000 ≠ 2,000,000.5, BNB ≠ BNBX).
const exactly = (text) => new RegExp(`(?<![\\d.,+\\-−<>≤≥~])(?<![+\\-−<>≤≥~]\\s)${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\dA-Za-z]|[.,]\\d)`);
// What a form says under its amount where the public balance can't pay it: how much short, and of which balance.
const tooMuch = (el, short) => {
  const said = visibleText(el);
  expect(said).toMatch(exactly(short));
  expect(said).toMatch(/public balance/i);
  expect(said).not.toMatch(/shielded/i);
};
// Everything a screen gives away: all its text, shown or not, and each element's title and aria-label.
const everything = (root) => [root.textContent, ...[root, ...root.querySelectorAll("*")].flatMap((el) => [el.getAttribute("title"), el.getAttribute("aria-label")])].filter(Boolean).join("\n");
// None of these figures anywhere on the screen.
const nowhere = (...figures) => {
  for (const figure of figures) expect(everything(body), figure).not.toContain(figure);
};
// A balance with balances hidden: dots, no figure to the eyes or to screen readers, and no tooltip.
const hides = (el) => {
  expect(visibleText(el)).toContain("••••");
  expect([visibleText(el), screenReaderText(el)].join(" ")).not.toMatch(/\d/);
  expect(el.getAttribute("title")).toBeNull();
};
// A figure inside a flow with balances hidden: there, to the eyes and to screen readers, and no dots.
const shows = (el, figure) => {
  expect([visibleText(el), screenReaderText(el)]).toEqual([expect.stringMatching(exactly(figure)), expect.stringMatching(exactly(figure))]);
  expect(visibleText(el)).not.toContain("••••");
};
// A field's row on a page, by its label.
const fieldRow = (label) => body.querySelectorAll(".kv").find((kv) => visibleText(kv.querySelector(".kv-label")) === label);

// The profile's staking, as Staking reads it: no stake yet, its public balance the overview's.
const owner = (over = {}) => ({
  profileIndex: 0,
  account: ACCOUNT,
  publicBalance: { value: "1482938300000" },
  hasStake: false,
  info: { amount: null, reward: "0", faults: 0, hardFaults: 0 },
  ownerKind: "none",
  ownerProfileIndex: 0,
  manageable: true,
  profiles: [{ profileIndex: 0 }, { profileIndex: 1 }],
  relatedStakes: [],
  ...over,
});
const staking = (ownerStatus, screen) => ({
  loaded: true,
  loading: false,
  profileIndex: 0,
  minimumStakeLux: dusk(1000),
  actionKind: "topup",
  stakeAmountDusk: "",
  ownerProfileIndex: 0,
  ownerStatus,
  screen,
});

describe("Hide balances", () => {
  it("hides the dashboard's balances behind the eye beside Refresh, and shows them again", async () => {
    const state = { route: "home", overview: overview(), addressBook: { loaded: true, items: [] }, assets: assets() };
    const act = actions();
    const draw = () => show(homeView(state.overview, { state, actions: act }));
    act.render.mockImplementation(draw);
    const eye = () => body.querySelector(".balance-label button.balance-eye");
    // The total, each part of it by its label, the token and what Activity says was sent.
    const item = (label) => body.querySelectorAll(".balance-split-item").find((el) => label.test(visibleText(el.querySelector(".balance-split-label"))));
    const balances = () => ({
      total: body.querySelector(".home-hero .balance-amount"),
      public: item(/^public/i).querySelector(".balance-split-value"),
      shielded: item(/^shielded/i).querySelector(".balance-split-value"),
      token: body.querySelector(".asset-amt"),
      activity: body.querySelector(".tx-amount"),
    });
    // Each as the eyes see it, as screen readers say it, and its tooltip; and what the shielded balance holds back.
    const read = () => ({
      ...Object.fromEntries(Object.entries(balances()).map(([name, el]) => [name, [visibleText(el), screenReaderText(el), el.getAttribute("title")]])),
      reserved: item(/^shielded/i).querySelector(".balance-split-label").getAttribute("title"),
    });

    await draw();
    expect(read()).toEqual({
      total: ["1,507.9383 DUSK", "1,507.9383 DUSK", "1,507.9383"],
      public: ["1,482.9383 DUSK", "1,482.9383 DUSK", "1,482.9383"],
      shielded: ["25 DUSK", "25 DUSK", "25"],
      token: ["123.45 TKN", "123.45 TKN", null],
      activity: ["−1 DUSK", "−1 DUSK", null],
      reserved: expect.stringMatching(exactly("5 DUSK")),
    });

    eye().click();
    await settle();
    expect(act.send).toHaveBeenCalledWith({ type: "DUSK_UI_SET_HIDE_BALANCES", hideBalances: true });
    expect([state.hideBalances, state.overview.hideBalances]).toEqual([true, true]);
    // Each hidden, with no tooltip to give it away, the shielded amount held back included; nor anywhere else.
    for (const el of Object.values(balances())) hides(el);
    expect(read().reserved).toBeNull();
    nowhere("1,507.9383", "1507.9383", "1,482.9383", "1482.9383", "123.45", "12345", "25 DUSK", "5 DUSK");

    eye().click();
    await settle();
    expect(act.send).toHaveBeenLastCalledWith({ type: "DUSK_UI_SET_HIDE_BALANCES", hideBalances: false });
    expect(read().total).toEqual(["1,507.9383 DUSK", "1,507.9383 DUSK", "1,507.9383"]);
  });
});

describe("hidden balances", () => {
  it("hide token balances on the dashboard and on the token's page", async () => {
    const state = { route: "asset_token", assets: assets(), assetTokenContractId: TOKEN };
    await show(assetsSectionsView(overview(HIDDEN), { state, actions: actions() }));
    hides(body.querySelector(".asset-amt"));
    nowhere("123.45", "12345");

    await show(assetTokenView(overview(HIDDEN), { state, actions: actions() }));
    hides(body.querySelector(".asset-token-balance-value"));
    // Its atomic units too, which say it as well.
    hides(fieldRow("Atomic units").querySelector(".kv-value"));
    nowhere("123.45", "12345", "12,345");

    await show(assetTokenView(overview(), { state, actions: actions() }));
    expect(visibleText(body.querySelector(".asset-token-balance-value"))).toBe("123.45 TKN");
    expect(visibleText(fieldRow("Atomic units").querySelector(".kv-value"))).toBe("12345");
    // Its contract as every Dusk app writes one, without the 0x the wallet keeps it with: short, and copied in full.
    const contract = fieldRow("Contract");
    expect(visibleText(contract.querySelector(".mono"))).toBe("cdcdcd…cdcdcd");
    contract.querySelector("button").click();
    await settle();
    expect(dom.clipboard.writeText).toHaveBeenLastCalledWith("cd".repeat(32));
  });

  it("hide Home's balances again back from Send, which shows them", async () => {
    const state = { route: "home", overview: overview(HIDDEN), addressBook: { loaded: true, items: [] }, assets: assets() };
    const home = async () => {
      await show(homeView(state.overview, { state, actions: actions() }));
      hides(body.querySelector(".home-hero .balance-amount"));
      nowhere("1,507.9383", "1,482.9383", "1,482.9358");
    };
    await home();
    state.route = "send";
    await show(sendFormView(state.overview, { state, actions: actions() }));
    typeInto(body.querySelector(".to-input-wrap textarea"), OTHER_ACCOUNT);
    await settle();
    shows(body.querySelector(".amount-avail__text"), "1,482.9358 DUSK");
    state.route = "home";
    await home();
  });

  it("hide Staking's overview: what's staked, its rewards, its locked part and the balance", async () => {
    // Profile 2's stake, which Profile 1 owns: staked, rewards and locked hidden.
    const stake = {
      profileIndex: 1,
      account: OTHER_ACCOUNT,
      publicBalance: { value: dusk(500) },
      hasStake: true,
      info: {
        amount: { value: dusk(2000), locked: dusk(10), eligibility: "0", total: dusk(2000) },
        reward: dusk(42),
        faults: 0,
        hardFaults: 0,
      },
      ownerKind: "local",
      ownerProfileIndex: 0,
      manageable: true,
    };
    await show(stakeFormView(overview(HIDDEN), { state: { route: "stake", staking: staking(owner({ relatedStakes: [stake] }), "overview") }, actions: actions() }));
    const big = body.querySelectorAll(".stake-sum .stake-big");
    expect(big).toHaveLength(2);
    big.forEach(hides);
    hides(body.querySelector(".stake-sum .stake-cap"));
    hides(body.querySelector(".stake-avail"));
    nowhere("2,000", "2000", "42", "1,482.9383", "1482.9383");
  });
});

describe("still shown with balances hidden", () => {
  it("the amount, fee and total of the transaction under review", async () => {
    // The amount, then the fee and the total, each from its own field.
    const review = () => [
      body.querySelector(".balance-amount").textContent,
      body.querySelector("dusk-gas-editor .gas-fee-value").textContent,
      body.querySelector("dusk-gas-editor .gas-total-value").textContent,
    ];

    let state = { route: "confirm", draft: { to: OTHER_ACCOUNT, privacy: "public", amountDusk: "1.5", amountLux: "1500000000", memo: "" } };
    await show(sendConfirmView(overview(HIDDEN), { state, actions: actions() }));
    expect(review()).toEqual(["1.5 DUSK", "up to 0.0025 DUSK", "up to 1.5025 DUSK"]);

    state = { route: "convert_confirm", draft: { kind: TX_KIND.SHIELD, amountLux: dusk(2), amountDusk: "2" } };
    await show(convertConfirmView(overview(HIDDEN), { state, actions: actions() }));
    expect(review()).toEqual(["2 DUSK", "up to 0.05 DUSK", "up to 2.05 DUSK"]);

    state = {
      route: "stake_confirm",
      stakeDraft: { kind: TX_KIND.STAKE, stakeProfileIndex: 0, profileIndex: 0, ownerProfileIndex: 0, amountLux: dusk(1000), payment: "account" },
    };
    await show(stakeConfirmView(overview(HIDDEN), { state, actions: actions() }));
    expect(review()).toEqual(["1,000 DUSK", "up to 0.05 DUSK", "up to 1,000.05 DUSK"]);

    state = {
      route: "sozu_confirm",
      sozu: { loaded: true, profileIndex: 0, status: { publicBalance: { value: "1482938300000" } } },
      sozuDraft: {
        fnName: "sozu_stake",
        deposit: dusk(10),
        profileIndex: 0,
        label: "Stake with Sozu",
        // Where it was drafted, as the form records it: this overview's.
        reviewed: { context: undefined, nodeUrl: NODE, networkKey: "testnet", walletId: ACCOUNT, profileIndex: 0, account: ACCOUNT },
      },
    };
    await show(sozuConfirmView(overview(HIDDEN), { state, actions: actions() }));
    expect(review()).toEqual(["10 DUSK", "up to 0.005 DUSK", "up to 10.005 DUSK"]);
  });

  it("what Send has available after fees, and what Max fills in, public and shielded", async () => {
    const state = { route: "send", draft: null, addressBook: { loaded: true, items: [] } };
    await show(sendFormView(overview(HIDDEN), { state, actions: actions() }));
    const to = body.querySelector(".to-input-wrap textarea");
    const amount = body.querySelector("input.amount-field__input");
    const max = () => body.querySelector(".amount-avail button");

    typeInto(to, OTHER_ACCOUNT);
    await settle();
    shows(body.querySelector(".amount-avail__text"), "1,482.9358 DUSK");
    expect(body.querySelector(".amount-fee-note").textContent).toMatch(exactly("up to 0.0025 DUSK"));
    max().click();
    expect(amount.value).toBe("1482.9358");

    // Shielded: what's spendable now, the rest held for a pending transaction.
    typeInto(to, ADDRESS);
    await settle();
    shows(body.querySelector(".amount-avail__text"), "19.95 DUSK");
    expect(body.querySelector(".amount-fee-note").textContent).toMatch(exactly("up to 0.05 DUSK"));
    max().click();
    expect(amount.value).toBe("19.95");
    // In the one field, as typed in it.
    expect(body.querySelectorAll(".amount-field input")).toHaveLength(1);
  });

  it("Shield's and Unshield's balance lines, and how much is short", async () => {
    const state = { route: "convert", draft: { kind: TX_KIND.SHIELD } };
    await show(convertFormView(overview(HIDDEN), { state, actions: actions() }));
    shows(body.querySelector(".amount-avail__text"), "1,482.8883 DUSK");
    expect(visibleText(body.querySelector(".amount-fee-note"))).toMatch(exactly("up to 0.05 DUSK"));
    body.querySelector(".amount-avail button").click();
    expect(body.querySelector("input.amount-field__input").value).toBe("1482.8883");

    // Too much: how much is short, under the field, and Review doesn't go on.
    typeInto(body.querySelector("input.amount-field__input"), "5000");
    body.querySelector("button.btn-primary").click();
    await settle();
    tooMuch(body.querySelector(".amount-field__error"), "3,517.1117 DUSK");
    expect(state.route).toBe("convert");

    state.draft = { kind: TX_KIND.UNSHIELD };
    await show(convertFormView(overview(HIDDEN), { state, actions: actions() }));
    shows(body.querySelector(".amount-avail__text"), "19.95 DUSK");
    expect(visibleText(body.querySelector(".amount-fee-note"))).toMatch(exactly("up to 0.05 DUSK"));
  });

  it("what a stake has available, what Max fills in and how much is short", async () => {
    const act = actions();
    const state = { route: "stake", staking: staking(owner(), "native") };
    await show(stakeFormView(overview(HIDDEN), { state, actions: act }));
    shows(body.querySelector(".amount-avail span"), "1,482.9383 DUSK");
    button("Max").click();
    expect([state.staking.stakeAmountDusk, body.querySelector("input.amount-field__input").value]).toEqual(["1482.8383", "1482.8383"]);

    // Too much: how much is short, under the field.
    typeInto(body.querySelector("input.amount-field__input"), "5000");
    tooMuch(body.querySelector(".amount-field__error"), "3,517.1117 DUSK");
    expect(act.showToast).not.toHaveBeenCalled();
  });

  it("what a token's transfer has available, as it's filled in, the page's own figure hidden while it's only looked at", async () => {
    const state = { route: "asset_token", assets: assets(), assetTokenContractId: TOKEN };
    await show(assetTokenView(overview(HIDDEN), { state, actions: actions() }));
    const hero = () => body.querySelector(".asset-token-balance-value");
    const available = () => body.querySelector(".asset-avail");
    const amount = body.querySelector('input[name="assetTokenAmount"]');
    // Looked at: nothing says it.
    hides(hero());
    nowhere("123.45", "12345", "12,345");
    // A transfer begun, the amount tapped: what's available, under it, as Send says it.
    amount.focus();
    amount.dispatchEvent(fakeEvent("focusin", { bubbles: true }));
    shows(available(), "123.45 TKN");
    // Left with nothing typed: gone again.
    amount.blur();
    amount.dispatchEvent(fakeEvent("focusout", { bubbles: true, relatedTarget: null }));
    expect(available().hidden).toBe(true);
    nowhere("123.45");
    // Typed in, it stays, the page's own figure still hidden.
    typeInto(amount, "5");
    shows(available(), "123.45 TKN");
    hides(hero());
  });

  it("what a token's transfer has available only while its own is filled in, to the last decimal it takes", async () => {
    const NINE = `0x${"ab".repeat(32)}`;
    const two = { ...assets(), tokens: [...assets().tokens, { contractId: NINE, symbol: "NIN", name: "Nine", decimals: 9 }], balances: { [TOKEN]: "12345", [NINE]: "1" }, balancesAt: { [TOKEN]: Date.now(), [NINE]: Date.now() } };
    const state = { route: "asset_token", assets: two, assetTokenContractId: TOKEN };
    const amount = () => body.querySelector('input[name="assetTokenAmount"]');
    const available = () => body.querySelector(".asset-avail");
    await show(assetTokenView(overview(HIDDEN), { state, actions: actions() }));
    typeInto(amount(), "5");
    shows(available(), "123.45 TKN");
    // Left typed in, and another token's page opened, its transfer not touched: nothing of its balance.
    state.assetTokenContractId = NINE;
    await show(assetTokenView(overview(HIDDEN), { state, actions: actions() }));
    expect(available().hidden).toBe(true);
    hides(body.querySelector(".asset-token-balance-value"));
    nowhere("0.000000001", "1 NIN");
    // Its own amount tapped: what it holds, one atomic unit, to its ninth decimal rather than 0.
    amount().focus();
    amount().dispatchEvent(fakeEvent("focusin", { bubbles: true }));
    shows(available(), "0.000000001 NIN");
  });

  it("how much more a token transfer asks than there is", async () => {
    const act = actions();
    const state = { route: "asset_token", assets: assets(), assetTokenContractId: TOKEN, assetTokenForm: { to: OTHER_ACCOUNT, amount: "200", spender: "", approveAmount: "" } };
    await show(assetTokenView(overview(HIDDEN), { state, actions: act }));
    button("Review transfer").click();
    await settle();
    const said = body.querySelectorAll(".field-error").filter((el) => !el.hidden).map(visibleText);
    expect(said).toEqual([expect.stringMatching(exactly("76.55 TKN"))]);
    expect(act.send).not.toHaveBeenCalled();
  });
});
