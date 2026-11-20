import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TX_KIND } from "../shared/constants.js";
// The fake DOM goes before the views: it defines HTMLElement for the gas editor.
import { installFakeDom, screenReaderText, settle, typeInto, visibleText } from "./testing/fakeDom.js";
import { shortfallText } from "./lib/shortfall.js";
import { convertConfirmView, convertFormView } from "./popup/views/convert.js";
import { sendConfirmView, sendFormView } from "./popup/views/send.js";
import { sozuConfirmView } from "./popup/views/sozu.js";
import { stakeConfirmView, stakeFormView } from "./popup/views/stake.js";

vi.mock("../shared/addressBook.js", () => ({ listAddressBook: vi.fn(async () => []) }));

const ACCOUNT =
  "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927";
const OTHER_ACCOUNT =
  "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";
const ADDRESS = "2Ana1pUpv2ZbMVkwF5FXapYeBEjdxDatLn7nvJkhgTSXbs59SyZSx866bXirPgj8QQVB57uxHJBG1YFvkRbFj4T";
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
// What a form says under its amount where the public balance can't pay it, its figure hidden whatever it is.
const TOO_MUCH = shortfallText({ missingLux: 1n, hidden: true });

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
// A balance with balances hidden: dots, and no figure, to the eyes or to screen readers.
const hides = (el) => {
  expect(visibleText(el)).toContain("••••");
  expect([visibleText(el), screenReaderText(el)].join(" ")).not.toMatch(/\d/);
};

describe("hidden balances", () => {
  it("hide what Send has available after fees, while Max fills in the real amount", async () => {
    const state = { route: "send", draft: null, addressBook: { loaded: true, items: [] } };
    await show(sendFormView(overview(HIDDEN), { state, actions: actions() }));
    const to = body.querySelector(".to-input-wrap textarea");
    const amount = body.querySelector("input.amount-field__input");
    const max = () => body.querySelector(".amount-avail button");

    typeInto(to, OTHER_ACCOUNT);
    await settle();
    hides(body.querySelector(".amount-avail__text"));
    // The fee isn't a balance.
    expect(body.querySelector(".amount-fee-note").textContent).toMatch(/0\.0025 DUSK/);
    max().click();
    expect(amount.value).toBe("1482.9358");

    // Shielded: what's spendable now, the rest held for a pending transaction.
    typeInto(to, ADDRESS);
    await settle();
    hides(body.querySelector(".amount-avail__text"));
    expect(body.querySelector(".amount-fee-note").textContent).toMatch(/0\.05 DUSK/);
    max().click();
    expect(amount.value).toBe("19.95");

    // What the user types shows as typed.
    typeInto(amount, "12.5");
    expect(amount.value).toBe("12.5");
  });

  it("hide Shield's and Unshield's balance lines, while Max and the balance check use the real ones", async () => {
    const state = { route: "convert", draft: { kind: TX_KIND.SHIELD } };
    await show(convertFormView(overview(HIDDEN), { state, actions: actions() }));
    hides(body.querySelector(".amount-avail__text"));
    expect(visibleText(body.querySelector(".amount-fee-note"))).toMatch(/0\.05 DUSK/);
    body.querySelector(".amount-avail button").click();
    expect(body.querySelector("input.amount-field__input").value).toBe("1482.8883");

    // The balance check uses the real balance, says so under the field, and Review doesn't go on.
    typeInto(body.querySelector("input.amount-field__input"), "5000");
    body.querySelector("button.btn-primary").click();
    await settle();
    expect(body.querySelector(".amount-field__error").textContent).toBe(TOO_MUCH);
    expect(state.route).toBe("convert");

    state.draft = { kind: TX_KIND.UNSHIELD };
    await show(convertFormView(overview(HIDDEN), { state, actions: actions() }));
    hides(body.querySelector(".amount-avail__text"));
    expect(visibleText(body.querySelector(".amount-fee-note"))).toMatch(/0\.05 DUSK/);
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
    const act = actions();
    const draw = (state) => show(stakeFormView(overview(HIDDEN), { state, actions: act }));

    // A new stake: the balance that pays it, hidden; Max fills in the real amount.
    const state = { route: "stake", staking: staking(owner(), "native") };
    await draw(state);
    hides(body.querySelector(".amount-avail span"));
    button("Max").click();
    expect(state.staking.stakeAmountDusk).toBe("1482.8383");

    // Too much: the check holds, under the field, and doesn't give the balance away.
    typeInto(body.querySelector("input.amount-field__input"), "5000");
    expect(body.querySelector(".amount-field__error").textContent).toBe(TOO_MUCH);
    expect(act.showToast).not.toHaveBeenCalled();

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
    await draw({ route: "stake", staking: staking(owner({ relatedStakes: [stake] }), "overview") });
    const big = body.querySelectorAll(".stake-sum .stake-big");
    expect(big).toHaveLength(2);
    big.forEach(hides);
    hides(body.querySelector(".stake-sum .stake-cap"));
    hides(body.querySelector(".stake-avail"));
  });
});

describe("still shown with balances hidden", () => {
  it("the amount, fee and total of the transaction under review", async () => {
    const amountOf = () => body.querySelector(".balance-amount").textContent;
    // The fee, then the total.
    const fee = () => body.querySelectorAll("dusk-gas-editor .gas-fee .kv-value").map((value) => value.textContent).join("\n");

    let state = { route: "confirm", draft: { to: OTHER_ACCOUNT, privacy: "public", amountDusk: "1.5", amountLux: "1500000000", memo: "" } };
    await show(sendConfirmView(overview(HIDDEN), { state, actions: actions() }));
    expect(amountOf()).toBe("1.5 DUSK");
    expect(fee()).toMatch(/0\.0025 DUSK[\s\S]*1\.5025 DUSK/);

    state = { route: "convert_confirm", draft: { kind: TX_KIND.SHIELD, amountLux: dusk(2), amountDusk: "2" } };
    await show(convertConfirmView(overview(HIDDEN), { state, actions: actions() }));
    expect(amountOf()).toBe("2 DUSK");
    expect(fee()).toMatch(/0\.05 DUSK[\s\S]*2\.05 DUSK/);

    state = {
      route: "stake_confirm",
      stakeDraft: { kind: TX_KIND.STAKE, stakeProfileIndex: 0, profileIndex: 0, ownerProfileIndex: 0, amountLux: dusk(1000), payment: "account" },
    };
    await show(stakeConfirmView(overview(HIDDEN), { state, actions: actions() }));
    expect(amountOf()).toBe("1,000 DUSK");
    expect(fee()).toMatch(/0\.05 DUSK[\s\S]*1,000\.05 DUSK/);

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
    expect(amountOf()).toBe("10 DUSK");
    expect(fee()).toMatch(/0\.005 DUSK[\s\S]*10\.005 DUSK/);
  });
});
