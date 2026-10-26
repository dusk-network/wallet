import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TX_KIND } from "../shared/constants.js";
// The fake DOM goes before the views: it defines HTMLElement for the gas editor.
import { installFakeDom, screenReaderText, settle, typeInto, visibleText } from "./testing/fakeDom.js";
import { iconSvg } from "./components/ActionIcon.js";
import { assetTokenView, assetsSectionsView } from "./popup/views/assets.js";
import { convertConfirmView, convertFormView } from "./popup/views/convert.js";
import { homeView } from "./popup/views/home.js";
import { sendConfirmView, sendFormView } from "./popup/views/send.js";
import { sozuConfirmView, sozuLiquidStakingView } from "./popup/views/sozu.js";
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
  loaded: true,
  loading: false,
  networkKey: NODE,
  profileIndex: 0,
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
// What the eyes see and what screen readers say.
const seen = (el) => [visibleText(el), screenReaderText(el)];

describe("Hide balances", () => {
  it("hides the dashboard's balances behind the eye beside Refresh, and shows them again", async () => {
    const state = { route: "home", overview: overview(), addressBook: { loaded: true, items: [] }, assets: assets() };
    const act = actions();
    const draw = () => show(homeView(state.overview, { state, actions: act }));
    act.render.mockImplementation(draw);
    const eye = () => body.querySelector(".balance-label button.balance-eye");
    const eyeState = () => [eye().getAttribute("aria-label"), eye().title, eye().getAttribute("aria-pressed"), eye().innerHTML];
    const values = () => body.querySelectorAll(".balance-amount, .balance-split-value, .asset-amt").map(seen);
    const titles = () =>
      body.querySelectorAll(".balance-amount, .balance-split-value, .balance-split-label").map((el) => el.getAttribute("title"));

    await draw();
    expect(eyeState()).toEqual(["Hide balances", "Hide balances", "false", iconSvg("eye")]);
    // The total, its Public and Shielded split, and the token.
    expect(values()).toEqual([
      ["1,507.9383 DUSK", "1,507.9383 DUSK"],
      ["1,482.9383", "1,482.9383"],
      ["25", "25"],
      ["123.45", "123.45"],
    ]);
    expect(titles()).toEqual(["1,507.9383", null, "1,482.9383", "Reserved 5 DUSK", "25"]);

    eye().click();
    await settle();
    expect(act.send).toHaveBeenCalledWith({ type: "DUSK_UI_SET_HIDE_BALANCES", hideBalances: true });
    expect([state.hideBalances, state.overview.hideBalances]).toEqual([true, true]);

    // Redrawn at once, the focus still on the eye.
    expect(act.render).toHaveBeenCalledTimes(1);
    expect(dom.document.activeElement).toBe(eye());
    expect(eyeState()).toEqual(["Hide balances", "Hide balances", "true", iconSvg("eye-off")]);
    expect(values()).toEqual([["•••• DUSK", "hidden DUSK"], ...Array(3).fill(["••••", "hidden"])]);
    // No tooltip gives them away either, the shielded amount held back included.
    expect(titles()).toEqual([null, null, null, null, null]);
    // Their labels stay.
    expect(body.querySelectorAll(".balance-split-label, .asset-sub").map(visibleText)).toEqual([
      "Public",
      "Shielded · Pending",
      "Balance",
    ]);
    // Past transactions still show what they moved.
    expect(body.querySelector(".activity-amount").textContent).toBe("-1 DUSK");

    eye().click();
    await settle();
    expect(act.send).toHaveBeenLastCalledWith({ type: "DUSK_UI_SET_HIDE_BALANCES", hideBalances: false });
    expect(eyeState()).toEqual(["Hide balances", "Hide balances", "false", iconSvg("eye")]);
    expect(values()[0]).toEqual(["1,507.9383 DUSK", "1,507.9383 DUSK"]);
  });

  it("says so when the choice can't be saved, and keeps it in the popup", async () => {
    const state = { route: "home", overview: overview(), addressBook: { loaded: true, items: [] }, assets: assets() };
    const act = actions(async () => ({ error: { message: "Storage is full" } }));
    await show(homeView(state.overview, { state, actions: act }));
    body.querySelector("button.balance-eye").click();
    await settle();
    expect(act.showToast).toHaveBeenCalledWith("Storage is full", 2500);
    expect(state.hideBalances).toBe(true);
  });

  it("keeps the popup's choice over an overview read before it was saved", async () => {
    vi.resetModules();
    const { state } = await import("./popup/state.js");
    const { refreshOverview } = await import("./popup/overview.js");

    // A new popup takes the saved choice.
    await refreshOverview(async () => overview(HIDDEN), { force: true });
    expect(state.overview.hideBalances).toBe(true);

    state.hideBalances = false;
    await refreshOverview(async () => overview(HIDDEN), { force: true });
    expect(state.overview.hideBalances).toBe(false);
  });

  it("comes with the overview, in the extension and in the desktop app", async () => {
    for (const parts of [["background", "index.js"], ["wallet", "localBus.js"]]) {
      const source = await readFile(path.resolve(process.cwd(), "src", ...parts), "utf8");
      const reply = source.slice(source.indexOf('message?.type === "DUSK_UI_OVERVIEW"'));
      expect(reply, parts.join("/")).toContain("hideBalances: settings.hideBalances === true,");
    }
  });
});

describe("hidden balances", () => {
  it("hide Send's Available and Spendable lines and the slider's share, while Max fills in the real amount", async () => {
    const state = { route: "send", draft: null, addressBook: { loaded: true, items: [] } };
    await show(sendFormView(overview(HIDDEN), { state, actions: actions() }));
    const to = body.querySelector(".to-input-wrap input");
    const amount = body.querySelector("input.amount-input");
    // With the amount, the share of max would give the balance away.
    const share = () => [
      ...seen(body.querySelector(".amount-range__pct")),
      body.querySelector("input.amount-range").getAttribute("aria-valuetext"),
    ];

    typeInto(to, OTHER_ACCOUNT);
    await settle();
    expect(seen(body.querySelector(".amount-meta__main"))).toEqual([
      "Available (public): •••• DUSK",
      "Available (public): hidden DUSK",
    ]);
    // The fee cap isn't a balance.
    expect(body.querySelector(".amount-meta__sub").textContent).toBe("Fee cap: 0.0025 DUSK");
    body.querySelector(".amount-input-row button").click();
    expect(amount.value).toBe("1482.9358");
    expect(share()).toEqual(["••%", "hidden", "hidden"]);

    typeInto(to, ADDRESS);
    await settle();
    expect(visibleText(body.querySelector(".amount-meta__main"))).toBe("Spendable (shielded): •••• DUSK");
    expect(seen(body.querySelector(".amount-meta__sub"))).toEqual([
      "Total shielded: •••• DUSK · Fee cap: 0.05 DUSK",
      "Total shielded: hidden DUSK · Fee cap: 0.05 DUSK",
    ]);
    body.querySelector(".amount-input-row button").click();
    expect(amount.value).toBe("19.95");

    // What the user types shows as typed.
    typeInto(amount, "12.5");
    expect(amount.value).toBe("12.5");
    expect(share()).toEqual(["••%", "hidden", "hidden"]);

    // Shown, the share says what it is.
    await show(sendFormView(overview(), { state: { ...state, draft: null }, actions: actions() }));
    typeInto(body.querySelector(".to-input-wrap input"), OTHER_ACCOUNT);
    await settle();
    body.querySelector(".amount-input-row button").click();
    expect(share()).toEqual(["100%", "100%", "100%"]);
  });

  it("hide Shield's and Unshield's balance lines, while Max and the balance check use the real ones", async () => {
    const state = { route: "convert", draft: { kind: TX_KIND.SHIELD } };
    await show(convertFormView(overview(HIDDEN), { state, actions: actions() }));
    const lines = () => body.querySelectorAll(".row > .box > .muted").map(visibleText);
    expect(lines()).toEqual(["Available (public): •••• DUSK", "Fee cap: 0.05 DUSK"]);
    expect(screenReaderText(body.querySelector(".row > .box > .muted"))).toBe("Available (public): hidden DUSK");
    body.querySelector(".amount-input-row button").click();
    expect(body.querySelector("input.amount-input").value).toBe("1482.8883");
    expect(seen(body.querySelector(".amount-range__pct"))).toEqual(["••%", "hidden"]);
    expect(body.querySelector("input.amount-range").getAttribute("aria-valuetext")).toBe("hidden");

    typeInto(body.querySelector("input.amount-input"), "5000");
    button("Review").click();
    await settle();
    expect(body.querySelector(".err").textContent).toBe("Insufficient public balance");

    state.draft = { kind: TX_KIND.UNSHIELD };
    await show(convertFormView(overview(HIDDEN), { state, actions: actions() }));
    expect(lines()).toEqual(["Spendable (shielded): •••• DUSK", "Fee cap: 0.05 DUSK"]);
  });

  it("hide token balances on the dashboard and on the token's page", async () => {
    const state = { route: "asset_token", assets: assets(), assetTokenContractId: TOKEN };
    await show(assetsSectionsView(overview(HIDDEN), { state, actions: actions() }));
    expect(seen(body.querySelector(".asset-amt"))).toEqual(["••••", "hidden"]);

    await show(assetTokenView(overview(HIDDEN), { state, actions: actions() }));
    expect(seen(body.querySelector(".asset-token-balance-value"))).toEqual(["••••", "hidden"]);
    const units = body.querySelectorAll(".asset-token-meta-row").find((row) => row.textContent.startsWith("Atomic units"));
    expect([visibleText(units), units.querySelector("code").hasAttribute("title")]).toEqual(["Atomic units••••", false]);

    await show(assetTokenView(overview(), { state, actions: actions() }));
    expect(body.querySelector(".asset-token-balance-value").textContent).toBe("123.45");
  });

  it("hide Stake's balance, staked amounts and rewards, while Max and the balance check use the real ones", async () => {
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
    const staking = (actionKind, ownerStatus) => ({
      loaded: true,
      loading: false,
      profileIndex: 0,
      minimumStakeLux: dusk(1000),
      actionKind,
      stakeAmountDusk: "",
      ownerProfileIndex: 0,
      ownerStatus,
    });
    const act = actions();
    const draw = (state) => show(stakeFormView(overview(HIDDEN), { state, actions: act }));
    const editorLines = () =>
      body.querySelectorAll(".stake-editor .stake-gas-line, .stake-editor > .muted, .stake-editor .hrow").map(visibleText);

    // A new stake: the balance that pays it and what Max leaves after the fee.
    const state = { route: "stake", staking: staking("topup", owner()) };
    await draw(state);
    expect(editorLines()).toEqual(["Most people leave this as it is.", "Paid fromProfile 1 public · •••• DUSK", "Max after the fee: •••• DUSK."]);
    expect(screenReaderText(body.querySelector(".stake-gas-line"))).toBe("Paid fromProfile 1 public · hidden DUSK");
    button("Max").click();
    expect(state.staking.stakeAmountDusk).toBe("1482.8883");

    // Too much: the check holds, and doesn't give the balance away.
    state.staking.stakeAmountDusk = "5000";
    await draw(state);
    button("Review stake").click();
    expect(act.showToast).toHaveBeenCalledWith(
      "Profile 1 public balance is short by •••• DUSK including the estimated fee.",
      3000
    );

    // Profile 2's stake, which Profile 1 owns.
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
    for (const [actionKind, amountLine] of [
      ["unstake", "AmountFull stake · •••• DUSK"],
      ["claim", "AmountAll rewards · •••• DUSK"],
    ]) {
      await draw({ route: "stake", staking: staking(actionKind, owner({ relatedStakes: [stake] })) });
      const metrics = body.querySelectorAll(".stake-card.is-selected .stake-metrics .hrow");
      expect(metrics.map(visibleText)).toEqual([
        "Staked•••• DUSK",
        "Locked•••• DUSK",
        "EligibilityEligible now",
        "Rewards•••• DUSK",
        "Faults0 / 0",
      ]);
      expect(metrics.map((row) => row.querySelector("code").getAttribute("title") || null).filter(Boolean)).toEqual([
        "Stake contract eligibility value: 0",
      ]);
      expect(editorLines()).toEqual(["Paid fromProfile 2 public · •••• DUSK", amountLine]);
    }
  });

  it("hide what Sozu holds for the profile, but not the pool's rate", async () => {
    const pool = `0x${"01".repeat(32)}`;
    const st = {
      action: "deposit",
      depositAmountDusk: "",
      withdrawAmountDusk: "",
      loaded: true,
      loading: false,
      error: null,
      profileIndex: 0,
      status: {
        configured: true,
        networkKey: "testnet",
        contracts: { pool, "staked-dusk": `0x${"02".repeat(32)}` },
        publicBalance: { value: "1482938300000" },
      },
      pool: { totalStakeLux: dusk(1050), tokenTotalSupply: dusk(1000) },
      position: { poolBalanceLux: dusk(7), stDuskBalanceLux: dusk(10) },
    };
    const state = { route: "stake", sozu: st };
    await show(sozuLiquidStakingView(overview(HIDDEN), { state, actions: actions() }));
    expect(body.querySelectorAll(".sozu-stats .hrow").map(visibleText)).toEqual([
      "Pool balance•••• DUSK",
      "Available•••• DUSK",
      "stDUSK•••• stDUSK",
      "Rate1.05",
    ]);
    button("Max").click();
    expect(st.depositAmountDusk).toBe("1482.4383");
  });
});

describe("still shown with balances hidden", () => {
  it("the amount, fee and total of the transaction under review", async () => {
    const amountOf = () => body.querySelector(".balance-amount").textContent;
    const fee = () => body.querySelectorAll("dusk-gas-editor .box code").map((code) => code.textContent);

    let state = { route: "confirm", draft: { to: OTHER_ACCOUNT, privacy: "public", amountDusk: "1.5", amountLux: "1500000000", memo: "" } };
    await show(sendConfirmView(overview(HIDDEN), { state, actions: actions() }));
    expect([amountOf(), ...fee()]).toEqual(["1.5", "0.0025 DUSK", "1.5025 DUSK"]);

    state = { route: "convert_confirm", draft: { kind: TX_KIND.SHIELD, amountLux: dusk(2), amountDusk: "2" } };
    await show(convertConfirmView(overview(HIDDEN), { state, actions: actions() }));
    expect([amountOf(), ...fee()]).toEqual(["2", "0.05 DUSK", "2.05 DUSK"]);

    state = {
      route: "stake_confirm",
      stakeDraft: { kind: TX_KIND.STAKE, stakeProfileIndex: 0, profileIndex: 0, ownerProfileIndex: 0, amountLux: dusk(1000), payment: "account" },
    };
    await show(stakeConfirmView(overview(HIDDEN), { state, actions: actions() }));
    expect([amountOf(), ...fee()]).toEqual(["1000 DUSK", "0.05 DUSK", "1000.05 DUSK"]);

    state = {
      route: "sozu_confirm",
      sozu: { loaded: true, profileIndex: 0, status: { publicBalance: { value: "1482938300000" } } },
      sozuDraft: { fnName: "sozu_stake", deposit: dusk(10), profileIndex: 0, label: "Stake with Sozu" },
    };
    await show(sozuConfirmView(overview(HIDDEN), { state, actions: actions() }));
    expect([amountOf(), ...fee()]).toEqual(["10 DUSK", "0.5 DUSK", "10.5 DUSK"]);
  });
});
