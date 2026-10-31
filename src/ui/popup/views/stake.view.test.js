import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The fake DOM goes before the views: it defines HTMLElement for the gas editor.
import { accessibleName, installFakeDom, isShown, screenReaderText, settle, typeInto, visibleText } from "../../testing/fakeDom.js";
import { lookupPrimaryName } from "../../../shared/duskNames.js";
import { maxAmountLux } from "../../../shared/amount.js";
import { stakeConfirmView, stakeFormView } from "./stake.js";
import { sozuConfirmView } from "./sozu.js";
import { reviewOf, sentView } from "./sent.js";
import { switchContext } from "../context.js";

// The profile's verified name, as the header shows it: none unless a test gives one.
vi.mock("../../../shared/duskNames.js", async (importOriginal) => ({
  ...(await importOriginal()),
  lookupPrimaryName: vi.fn(async () => null),
}));

const ACCOUNT =
  "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927";
const OTHER =
  "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";
const dusk = (n) => (BigInt(n) * 1_000_000_000n).toString();
const POOL = `${"72".repeat(32)}`;
const ST_DUSK = `${"5d".repeat(32)}`;

// Profile 1 (selected) has no stake and 1,482.9383 DUSK public. `related`
// adds Profile 2's stake, which Profile 1 owns.
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
const related = (over = {}) => ({
  profileIndex: 1,
  account: OTHER,
  publicBalance: { value: dusk(500) },
  hasStake: true,
  info: {
    amount: { value: dusk(2000), locked: dusk(10), eligibility: "4687000", total: dusk(2000) },
    reward: dusk(42),
    faults: 1,
    hardFaults: 0,
  },
  ownerKind: "local",
  ownerProfileIndex: 0,
  manageable: true,
  ...over,
});
const staking = (ownerStatus = owner(), over = {}) => ({
  loaded: true,
  loading: false,
  profileIndex: 0,
  minimumStakeLux: dusk(1000),
  actionKind: "topup",
  stakeAmountDusk: "",
  ownerProfileIndex: 0,
  ownerStatus,
  ...over,
});
// Sozu's pool: 3,071.932 DUSK staked for 1,000 stDUSK, so each stDUSK is worth
// about 3.07 DUSK. Testnet's fees: 0.25% of a deposit and 10% of rewards.
const sozu = (over = {}) => ({
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
    contracts: { pool: POOL, "staked-dusk": ST_DUSK },
    publicBalance: { value: "1482938300000" },
    fees: { deposit: { numerator: "25", denominator: "10000" }, reward: { numerator: "10", denominator: "100" } },
    features: { maintenance: false, synchronization: false },
  },
  pool: { totalStakeLux: "3071932000000", tokenTotalSupply: dusk(1000) },
  position: { poolBalanceLux: "0", stDuskBalanceLux: "0" },
  ...over,
});

const ov = (over = {}) => ({ isUnlocked: true, accounts: [ACCOUNT], selectedAccountIndex: 0, nodeUrl: "https://testnet.nodes.dusk.network", networkName: "Testnet", ...over });
// What Liquid staking says after leaving a stake's Review the popup moved away from.
const SWITCHED = "The network or profile changed, so nothing was sent. Check the stake again.";
const LOCKED = "The wallet locked, so nothing was sent. Check the stake again.";

let dom;
let body;

beforeEach(() => {
  dom = installFakeDom();
  body = dom.document.body;
  lookupPrimaryName.mockReset();
  lookupPrimaryName.mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Draws Staking, its Review and Sent as app.js routes them, and redraws on
// render. Sozu's status, read again before a stake is sent, is the one Staking
// holds, unless `sozuStatus` gives what the node says by then.
function popup(state, overview = ov(), { sozuStatus, rewardRate = null } = {}) {
  const actions = {
    send: vi.fn(async (message) => {
      if (message.type === "DUSK_UI_GET_CACHED_GAS_PRICE") return { min: "1", median: "1", max: "1" };
      if (message.type === "DUSK_UI_GET_REWARD_RATE") return { ok: true, result: rewardRate };
      if (message.type === "DUSK_UI_SEND_TX") return { ok: true, result: { hash: "ab".repeat(32) } };
      if (message.type === "DUSK_UI_GET_SOZU_STATUS") {
        const st = state.sozu;
        return { ok: true, result: sozuStatus ? await sozuStatus() : { ...st?.status, pool: st?.pool, position: st?.position } };
      }
      return {};
    }),
    render: vi.fn(async () => draw()),
    showToast: vi.fn(),
    announce: vi.fn(),
  };
  const draw = () => {
    const view =
      state.route === "stake_confirm"
        ? stakeConfirmView
        : state.route === "sozu_confirm"
          ? sozuConfirmView
          : state.route === "sent"
            ? sentView
            : state.route === "stake"
              ? stakeFormView
              : () => [];
    // What the screen is drawn for, as render() gives it (reviewOf).
    body.replaceChildren(...view(overview, { state, actions: { ...actions, review: reviewOf(overview, state) } }));
  };
  draw();
  return { actions, draw };
}

const button = (text) => body.querySelectorAll("button").find((b) => isShown(b) && visibleText(b) === text);
const buttonStarting = (text) => body.querySelectorAll("button").find((b) => isShown(b) && visibleText(b).startsWith(text));
const field = (name) => body.querySelectorAll("input").find((i) => accessibleName(i) === name);

describe("staking overview", () => {
  it("says about what each choice pays a year, once read: native across the network lately, Sozu after its fee", async () => {
    const fifteen = sozu();
    fifteen.status = { ...fifteen.status, fees: { ...fifteen.status.fees, reward: { numerator: "15", denominator: "100" } } };
    const state = { route: "stake", staking: staking(), sozu: fifteen };
    // Mainnet's estimate lately (rewardRate.test.js).
    const { actions } = popup(state, ov(), { rewardRate: 0.23498725582204427 });
    const subs = () => body.querySelectorAll(".stake-choices > button").map((b) => [...b.querySelectorAll(".row-sub")].map(visibleText).slice(2));
    expect(subs()).toEqual([[], []]);
    await vi.waitFor(() =>
      expect(subs()).toEqual([["About 23% a year lately, across the network. Not promised."], ["About 20% a year after Sozu's 15%. Not promised."]])
    );
    // Asked once for this network, whatever is drawn again.
    actions.render();
    await settle();
    expect(actions.send.mock.calls.filter(([m]) => m.type === "DUSK_UI_GET_REWARD_RATE")).toHaveLength(1);
    // Sozu's fee as Liquid staking read it, without reading Sozu again.
    expect(actions.send.mock.calls.filter(([m]) => m.type === "DUSK_UI_GET_SOZU_STATUS")).toHaveLength(0);
    expect(body.textContent).not.toMatch(/\bEarn\b/);
  });

  it("works Sozu's rate out from native staking's as shown, so both wallets give the same figure", async () => {
    // 86.15% shows as 86%: Sozu's 10% off that is 77.4%, never 77.5% from the figure before rounding.
    const state = { route: "stake", staking: staking(), sozu: sozu() };
    popup(state, ov(), { rewardRate: 0.8615 });
    const subs = () => body.querySelectorAll(".stake-choices > button").map((b) => [...b.querySelectorAll(".row-sub")].map(visibleText).slice(2));
    await vi.waitFor(() =>
      expect(subs()).toEqual([["About 86% a year lately, across the network. Not promised."], ["About 77% a year after Sozu's 10%. Not promised."]])
    );
  });

  it("estimates with the Sozu of the node's own network: asked again once a custom node's chain ID is read, never another network's fee", async () => {
    const rates = () => body.querySelectorAll(".stake-choices > button").map((b) => [...b.querySelectorAll(".row-sub")].map(visibleText).slice(2));
    const statusReads = (actions) => actions.send.mock.calls.filter(([m]) => m.type === "DUSK_UI_GET_SOZU_STATUS").length;
    const testnet = sozu().status;
    const unread = { configured: false, networkKey: "custom" };
    // A custom node chosen while it couldn't say its network: no Sozu there
    // yet, even from an engine already told it's Testnet's.
    const state = { route: "stake", staking: staking(), sozu: sozu({ status: unread }) };
    const custom = ov({ nodeUrl: "https://my-node.example", networkName: "Custom", chainId: null });
    popup(state, custom, { rewardRate: 0.2, sozuStatus: async () => testnet });
    await vi.waitFor(() => expect(rates()[0]).toHaveLength(1));
    expect(rates()[1]).toEqual([]);

    // Read since: Testnet, whose Sozu is asked for, past the status held of before.
    const later = popup(state, { ...custom, chainId: 2 }, { rewardRate: 0.2, sozuStatus: async () => testnet });
    await vi.waitFor(() => expect(rates()[1]).toEqual(["About 18% a year after Sozu's 10%. Not promised."]));
    expect(statusReads(later.actions)).toBe(1);

    // Mainnet's Sozu, held from before a switch, isn't Testnet's.
    const mainnet = { ...testnet, networkKey: "mainnet", fees: { ...testnet.fees, reward: { numerator: "15", denominator: "100" } } };
    const switched = { route: "stake", staking: staking(), sozu: sozu({ status: mainnet }) };
    const next = popup(switched, ov(), { rewardRate: 0.2, sozuStatus: async () => testnet });
    await vi.waitFor(() => expect(rates()[1]).toEqual(["About 18% a year after Sozu's 10%. Not promised."]));
    expect(statusReads(next.actions)).toBe(1);
  });

  it("offers native and liquid staking as two equal choices, neither picked", () => {
    const state = { route: "stake", staking: staking() };
    popup(state);

    const choices = body.querySelectorAll(".stake-choices > button");
    expect(choices.map((b) => visibleText(b.querySelector(".row-title")))).toEqual([
      "Native staking",
      "Liquid stakingSozu · third party",
    ]);
    expect(choices.map((b) => [...b.querySelectorAll(".row-sub")].map(visibleText))).toEqual([
      ["Minimum 1,000 DUSK", "Needs your own Dusk node"],
      ["Any amount · No node needed", "You get stDUSK for your share"],
    ]);
    // Nothing is chosen for you: no pressed or selected choice, no amount to fill in yet.
    for (const choice of choices) {
      for (const attr of ["aria-pressed", "aria-selected", "aria-checked", "aria-current"]) {
        expect(choice.getAttribute(attr)).toBeNull();
      }
      expect(choice.className).toBe("list-row");
    }
    expect(body.querySelectorAll(".tab.is-active")).toEqual([]);
    expect(body.querySelectorAll("input").filter(isShown)).toEqual([]);
    expect(visibleText(body.querySelector(".stake-avail"))).toBe("1,482.9383 DUSK available to stake, from your public balance");
  });

  it("heads the two choices Stake, short in the ledger's capitals, as the web wallet does", () => {
    popup({ route: "stake", staking: staking() });
    expect(body.querySelectorAll(".section-head .bracket-title").map(screenReaderText)).toEqual(["Stake"]);
  });

  it("says why Unstake and Claim rewards can't be pressed", () => {
    popup({ route: "stake", staking: staking() });
    const sum = body.querySelector(".stake-sum");
    expect(sum.querySelectorAll(".stake-big").map(visibleText)).toEqual(["0 DUSK", "0 DUSK"]);
    expect([button("Unstake").disabled, button("Claim rewards").disabled]).toEqual([true, true]);
    // One reason for both, said once.
    expect(sum.querySelectorAll(".stake-cap").map(visibleText)).toEqual([
      "Nothing staked yet, so there's nothing to unstake or claim.",
    ]);

    // A stake whose profile can't pay the fee says that instead.
    popup({ route: "stake", staking: staking(owner({ relatedStakes: [related({ publicBalance: { value: "0" } })] })) });
    expect([button("Unstake").disabled, button("Claim rewards").disabled]).toEqual([true, true]);
    expect(body.querySelectorAll(".stake-sum .stake-cap").map(visibleText)).toEqual([
      "Locked: 10 DUSK. It's still yours, and unstaking returns it.",
      "You need some public DUSK in Profile 2 to pay the network fee.",
    ]);

    for (const [ownerKind, reason] of [
      ["contract", "Contract-owned stake. View only."],
      ["missing", "Owner key not found in this wallet."],
    ]) {
      popup({ route: "stake", staking: staking(owner({ relatedStakes: [related({ ownerKind, manageable: false })] })) });
      expect(button("Unstake").disabled).toBe(true);
      expect(visibleText(body.querySelector(".stake-sum"))).toContain(reason);
    }
  });

  it("drafts a full unstake and a claim of all rewards with the stake's and the owner's profiles", () => {
    for (const [label, kind, displayLux] of [
      ["Unstake", "unstake", dusk(2000)],
      ["Claim rewards", "withdraw_reward", dusk(42)],
    ]) {
      const state = { route: "stake", staking: staking(owner({ relatedStakes: [related()] })) };
      popup(state);
      // The stake with a stake shows, named, with what it holds.
      expect(visibleText(body.querySelector(".stake-account"))).toBe("Profile 2 · 21n5nc…fMMLNz");
      expect(body.querySelectorAll(".stake-sum .stake-big").map(visibleText)).toEqual(["2,000 DUSK", "42 DUSK"]);
      button(label).click();
      expect(state.route).toBe("stake_confirm");
      expect(state.stakeDraft).toMatchObject({
        kind,
        profileIndex: 1,
        stakeProfileIndex: 1,
        ownerProfileIndex: 0,
        amountLux: null,
        amountMode: "all",
        displayLux,
      });
    }
  });

  it("hides what an unstake or a claim moves on Review with Hide balances", () => {
    const state = { route: "stake", staking: staking(owner({ relatedStakes: [related()] })) };
    popup(state, ov({ hideBalances: true }));
    button("Unstake").click();
    const amount = body.querySelector(".review-head .balance-amount");
    expect([visibleText(amount), screenReaderText(amount)]).toEqual(["•••• DUSK", "hidden DUSK"]);

    popup(state, ov());
    expect(visibleText(body.querySelector(".review-head .balance-amount"))).toBe("2,000 DUSK");
  });

  it("names a contract or a missing key as the owner, under Advanced on both screens", () => {
    const state = {
      route: "stake",
      staking: staking(owner({ relatedStakes: [related({ ownerKind: "contract", ownerProfileIndex: null, manageable: false })] })),
    };
    popup(state);
    expect(body.querySelectorAll("details.advanced .kv").map(visibleText)[0]).toBe("OwnerContract");
    state.staking.screen = "native";
    popup(state);
    expect(body.querySelectorAll("details.advanced .kv").map(visibleText)[0]).toBe("OwnerContract");
    // Blocked: a note says why, not an error, and Review stays off.
    expect(body.querySelector(".amount-note").textContent).toBe("Contract-owned stake. View only.");
    expect(body.querySelector(".amount-field__error").hidden).toBe(true);
    expect(button("Review stake").disabled).toBe(true);
  });

  it("keeps the stake account and owner behind Advanced, and switches the stake shown there", () => {
    const state = { route: "stake", staking: staking(owner({ relatedStakes: [related()] })) };
    popup(state);
    const advanced = body.querySelector("details.advanced");
    expect([visibleText(advanced.querySelector("summary")), advanced.open]).toEqual(["Advanced", false]);
    const radios = advanced.querySelectorAll("[role=radio]");
    expect(radios.map((r) => [visibleText(r), r.getAttribute("aria-checked")])).toEqual([
      ["Profile 1 · 26FCH7…Tck927No stake", "false"],
      ["Profile 2 · 21n5nc…fMMLNz2,000 DUSK staked", "true"],
    ]);
    expect(advanced.querySelectorAll(".kv").map(visibleText)).toEqual([
      "OwnerProfile 1",
      "Stake accountProfile 2 · 21n5nc…fMMLNz",
      "Active fromBlock 4,687,000",
      "Penalties1 soft · 0 hard",
    ]);

    // Picking another stake shows it, and Advanced stays open.
    advanced.open = true;
    advanced.dispatchEvent({ type: "toggle", bubbles: false, preventDefault() {}, stopPropagation() {} });
    radios[0].click();
    expect(body.querySelectorAll(".stake-sum .stake-big").map(visibleText)).toEqual(["0 DUSK", "0 DUSK"]);
    expect(body.querySelector("details.advanced").open).toBe(true);
  });

  it("hides what is staked, earned and available with Hide balances", () => {
    popup({ route: "stake", staking: staking(owner({ relatedStakes: [related()] })) }, ov({ hideBalances: true }));
    const big = body.querySelectorAll(".stake-sum .stake-big");
    expect(big.map(visibleText)).toEqual(["•••• DUSK", "•••• DUSK"]);
    expect(big.map(screenReaderText)).toEqual(["hidden DUSK", "hidden DUSK"]);
    expect(visibleText(body.querySelector(".stake-avail"))).toBe("•••• DUSK available to stake, from your public balance");
    expect(visibleText(body.querySelector(".stake-sum"))).toContain("Locked: •••• DUSK.");
  });
});

describe("native staking", () => {
  it("says the minimum under the amount as it is typed, and Review stays off", async () => {
    const state = { route: "stake", staking: staking(owner(), { screen: "native" }) };
    const app = popup(state);
    const amount = field("Stake amount");
    expect(amount).toBeTruthy();

    typeInto(amount, "100");
    // Inline, tied to the field, where it was typed: not a toast that can scroll away.
    const errorId = amount.getAttribute("aria-describedby");
    const error = errorId ? dom.document.getElementById(errorId) : null;
    expect(error && isShown(error) ? error.textContent : null).toBe("The minimum stake is 1,000 DUSK.");
    expect(amount.getAttribute("aria-invalid")).toBe("true");

    // Review doesn't go on, and says nothing elsewhere.
    const review = body.querySelectorAll("button").find((b) => b.textContent === "Review stake");
    review.click();
    await settle();
    expect(state.route).toBe("stake");
    expect(app.actions.showToast).not.toHaveBeenCalled();
    expect(review.disabled).toBe(true);
  });

  it("fixes the amount with Use 1,000 or Max, and drafts the stake from the public balance", async () => {
    const state = { route: "stake", staking: staking(owner(), { screen: "native" }) };
    popup(state);
    typeInto(field("Stake amount"), "100");

    button("Use 1,000").click();
    expect(field("Stake amount").value).toBe("1000");
    expect(body.querySelector(".amount-field__error").hidden).toBe(true);
    expect(button("Review stake").disabled).toBe(false);
    expect(visibleText(body.querySelector(".amount-avail span"))).toBe("Available 1,482.9383 DUSK from your public balance");

    // Max leaves this stake's fee and the fee to unstake later, and says both.
    button("Max").click();
    expect(field("Stake amount").value).toBe("1482.8383");
    expect(visibleText(body.querySelector(".amount-note"))).toBe("Max keeps 0.1 DUSK: up to 0.05 for this fee and 0.05 to unstake later.");

    // Too much says by how much, fee included.
    typeInto(field("Stake amount"), "5000");
    expect(body.querySelector(".amount-field__error").textContent).toBe(
      "That's 3,517.1117 DUSK more than the public balance, with the network fee."
    );

    typeInto(field("Stake amount"), "1000");
    button("Review stake").click();
    expect(state.route).toBe("stake_confirm");
    expect(state.stakeDraft).toMatchObject({
      kind: "stake",
      profileIndex: 0,
      ownerProfileIndex: 0,
      amountLux: dusk(1000),
      amountMode: "custom",
      fundingLabel: "Profile 1 public balance",
    });
  });

  it("sets aside the fee Review starts from, with custom gas from Settings", async () => {
    // Price 3 and staking's own 50M limit, as the custom 2.5M is under its minimum.
    const state = { route: "stake", staking: staking(owner(), { screen: "native" }) };
    popup(state, ov({ customGas: { limit: "2500000", price: "3" } }));
    expect(body.querySelectorAll(".group.info .list-row").map(visibleText)).toContain("Network fee up to 0.15 DUSK");
    typeInto(field("Stake amount"), "1482.8");
    expect(body.querySelector(".amount-field__error").textContent).toBe(
      "That's 0.0117 DUSK more than the public balance, with the network fee."
    );
    button("Max").click();
    expect(field("Stake amount").value).toBe("1482.6383");
    expect(visibleText(body.querySelector(".amount-note"))).toBe("Max keeps 0.3 DUSK: up to 0.15 for this fee and 0.15 to unstake later.");
    button("Review stake").click();
    await settle();
    expect(visibleText(body.querySelector(".gas-fee"))).toBe("Network feeup to 0.15 DUSKTotalup to 1,482.7883 DUSK");
  });

  it("sets aside Sozu's fees with custom gas from Settings: its price, and its limit where it clears the call's minimum", async () => {
    // The stake takes the custom 2.5M, its minimum; the unstake Max keeps a fee for, its own 10M.
    const state = { route: "stake", staking: staking(owner(), { screen: "liquid" }), sozu: sozu() };
    popup(state, ov({ customGas: { limit: "2500000", price: "3" } }));
    button("Max").click();
    expect(field("Stake amount").value).toBe("1482.9008");
    button("Review stake").click();
    await settle();
    expect(visibleText(body.querySelector(".gas-fee"))).toBe("Network feeup to 0.0075 DUSKTotalup to 1,482.9083 DUSK");
    expect(button("Confirm").disabled).toBe(false);
  });

  it("states the node, timing, penalty and fee facts from Dusk's staking docs", () => {
    popup({ route: "stake", staking: staking(owner(), { screen: "native" }) });
    expect(body.querySelectorAll(".group.info .list-row").map(visibleText)).toEqual([
      "Needs your own Dusk nodeRun a node",
      "Rewards start in about 6 to 12 hoursUnstake any time, with no waiting period.",
      "If your node misses its turnPart of your stake gets locked. It's still yours, and unstaking returns it. If the node breaks the rules, part of the stake can be burned (lost).",
      "Network fee up to 0.05 DUSK",
    ]);

    // Adding to a stake says what a top-up locks, and has no minimum.
    const state = {
      route: "stake",
      staking: staking(owner({ hasStake: true, ownerKind: "self", info: related().info }), { screen: "native" }),
    };
    popup(state);
    expect(visibleText(body.querySelector(".subnav-title"))).toBe("Stake more");
    expect(body.querySelectorAll(".group.info .row-title").map(visibleText)).toContain("10% of what you add is locked");
    typeInto(field("Amount to add"), "5");
    expect(body.querySelector(".amount-field__error").hidden).toBe(true);
    expect(button("Use 1,000")).toBeUndefined();
    button("Max").click();
    button("Review stake").click();
    expect(state.stakeDraft).toMatchObject({ kind: "stake", amountMode: "max", hasStake: true });
  });

  it("says only that native staking needs your own node, and Run a node opens Dusk's docs on running one", async () => {
    dom.window.open = vi.fn(() => ({}));
    popup({ route: "stake", staking: staking(owner(), { screen: "native" }) });
    expect(visibleText(body)).not.toMatch(/consensus|always-on|recovery phrase/i);
    button("Run a node").click();
    await settle();
    expect(dom.window.open).toHaveBeenCalledWith("https://docs.dusk.network/operator/provisioner/", "_blank", "noopener,noreferrer");
  });

  it("keeps the owner choice behind Advanced", () => {
    const state = { route: "stake", staking: staking(owner(), { screen: "native" }) };
    popup(state);
    const advanced = body.querySelector("details.advanced");
    expect(advanced.open).toBe(false);
    const select = advanced.querySelector("#stake-owner-profile");
    expect(accessibleName(select)).toBe("Owner");
    expect(select.querySelectorAll("option").map((o) => o.textContent)).toEqual(["Profile 1 (this profile)", "Profile 2"]);

    select.value = "1";
    select.dispatchEvent({ type: "change", bubbles: true, target: select, preventDefault() {}, stopPropagation() {} });
    typeInto(field("Stake amount"), "1000");
    button("Review stake").click();
    expect(state.stakeDraft).toMatchObject({ kind: "stake", profileIndex: 0, ownerProfileIndex: 1 });
  });

  it("points under the minimum to liquid staking, named as a third party", () => {
    const state = { route: "stake", staking: staking(owner(), { screen: "native" }), sozu: sozu() };
    popup(state);
    const link = buttonStarting("Less than");
    expect(link.textContent).toBe("Less than 1,000 DUSK? Use liquid staking (Sozu, third party)");
    link.click();
    expect(state.staking.screen).toBe("liquid");
    // Sozu, named a third party, with its site; no more about who holds what.
    expect(visibleText(body.querySelector(".liquid-intro"))).toBe("Sozuthird partysozu.fi");
    expect(body.querySelector(".liquid-who button.chain-link").textContent).toBe("sozu.fi");
  });

  it("goes to the Sent screen after Confirm, and Done goes back to Staking", async () => {
    const state = { route: "stake", staking: staking(owner(), { screen: "native" }) };
    popup(state);
    typeInto(field("Stake amount"), "1000");
    button("Review stake").click();
    await settle();
    // What's public is said on Send only.
    expect(visibleText(body.querySelector(".review-head"))).toBe("Stake1,000 DUSKNative staking");
    // The review's rows; the fee's own come after them.
    expect(body.querySelectorAll(".row > .group > .kv").map(visibleText)).toEqual([
      "FromProfile 1 · Public",
      "Rewards startIn about 6 to 12 hours",
    ]);

    button("Confirm").click();
    await settle();
    expect(state.route).toBe("sent");
    expect(visibleText(body.querySelector(".sent-head"))).toBe("Stake1,000 DUSKNative staking");
    expect(state.stakeDraft).toBeNull();
    expect(state.staking.screen).toBe("overview");
    button("Done").click();
    expect(state.route).toBe("stake");
  });
});

describe("staking with little or nothing", () => {
  it("opens without an error when the profile has no DUSK, saying plainly what it needs", () => {
    const empty = owner({ publicBalance: { value: "0" } });
    popup({ route: "stake", staking: staking(empty, { screen: "native" }) });
    const amount = field("Stake amount");
    // Nothing was tried: no error, nothing marked invalid, a note instead.
    expect(body.querySelector(".amount-field__error").hidden).toBe(true);
    expect(amount.getAttribute("aria-invalid")).toBeNull();
    expect(body.querySelector(".amount-field").classList.contains("is-invalid")).toBe(false);
    expect(visibleText(body.querySelector(".amount-note"))).toBe("You need some public DUSK to pay the network fee.");
    expect(button("Review stake").disabled).toBe(true);
    expect(body.textContent).not.toMatch(/gas funds/i);
  });

  it("keeps Max to the 4 decimals amounts show with, and below what's there", () => {
    expect(maxAmountLux(1_480_550_766_286n, 100_000_000n)).toBe(1_480_450_700_000n);
    expect(maxAmountLux(50_000_000n, 100_000_000n)).toBe(0n);
    // 1,480.550766286 DUSK, less 0.05 for this fee and 0.05 to unstake later.
    popup({ route: "stake", staking: staking(owner({ publicBalance: { value: "1480550766286" } }), { screen: "native" }) });
    button("Max").click();
    expect(field("Stake amount").value).toBe("1480.4507");
    expect(button("Review stake").disabled).toBe(false);
  });
});

describe("staking reviews", () => {
  const named = () => ov({ accounts: [ACCOUNT, OTHER] });

  it("name the profile as the header does, and repeat that it needs your own node", async () => {
    lookupPrimaryName.mockImplementation(async (account) => (account === ACCOUNT ? "alice.dusk" : null));
    const state = { route: "stake", staking: staking(owner(), { screen: "native" }) };
    popup(state, named());
    typeInto(field("Stake amount"), "1000");
    button("Review stake").click();
    await settle();
    expect(body.querySelector(".review-visible")).toBeNull();
    expect(body.querySelectorAll(".row > .group > .kv").map(visibleText)).toEqual([
      "Fromalice.dusk · Public",
      "Rewards startIn about 6 to 12 hours",
    ]);
    expect(visibleText(body.querySelector(".row > .group.info"))).toBe("Needs your own Dusk nodeRun a node");
    expect(visibleText(body)).not.toContain("Profile 1");
  });

  it("name another owner", async () => {
    const state = { route: "stake", staking: staking(owner({ relatedStakes: [related()] })) };
    popup(state, named());
    button("Unstake").click();
    await settle();
    expect(body.querySelector(".review-visible")).toBeNull();
    expect(body.querySelectorAll(".row > .group > .kv").map(visibleText)).toEqual(["ToProfile 2 · Public", "OwnerProfile 1"]);
    // No node warning to unstake.
    expect(body.querySelector(".row > .group.info")).toBeNull();
  });

  it("say on Sozu's what it's worth now and how the DUSK comes back, its contract under Custom fee", async () => {
    lookupPrimaryName.mockResolvedValue("alice.dusk");
    const state = { route: "stake", staking: staking(owner(), { screen: "liquid" }), sozu: sozu({ position: { poolBalanceLux: dusk(12), stDuskBalanceLux: dusk(4) } }) };
    const app = popup(state, named());
    typeInto(field("Stake amount"), "50");
    button("Review stake").click();
    await settle();
    expect(body.querySelector(".review-visible")).toBeNull();
    expect(body.querySelectorAll(".row > .group .kv").map(visibleText)[0]).toBe("You get about16.2357 stDUSK, worth about 49.875 DUSK now");
    // The contract it calls, to check before Confirm: under Custom fee, as the network names it, with Copy.
    const pool = "72".repeat(32);
    const contract = body.querySelector("dusk-gas-editor details.gas-custom .sozu-contract");
    expect(visibleText(contract)).toBe(`ContractSozu pool · ${pool.slice(0, 6)}…${pool.slice(-6)}`);
    contract.querySelector("button.copy-ico").click();
    await settle();
    expect(dom.clipboard.writeText).toHaveBeenLastCalledWith(pool);

    state.route = "stake";
    state.sozu.action = "withdraw";
    app.draw();
    typeInto(field("Unstake amount"), "5");
    button("Review unstake").click();
    await settle();
    expect(body.querySelectorAll(".row > .group .kv").map(visibleText)).toEqual(["Toalice.dusk · Public"]);
    expect(body.querySelectorAll(".row > .stake-cap").map(visibleText)[0]).toBe("The DUSK comes back in the same transaction. No fee, no waiting.");
  });
});

describe("liquid staking", () => {
  it("says Sozu's deposit fee before and as an amount is typed, and takes it off what the stake gets and is worth", () => {
    const state = { route: "stake", staking: staking(owner(), { screen: "liquid" }), sozu: sozu() };
    popup(state);
    expect(visibleText(body.querySelector(".stake-estimate"))).toBe("");
    expect(visibleText(body.querySelector(".sozu-terms"))).toBe("Deposit fee 0.25%");
    typeInto(field("Stake amount"), "100");
    expect(visibleText(body.querySelector(".sozu-terms"))).toBe("Deposit fee 0.25% · 0.25 DUSK");
    expect(body.querySelector(".stake-estimate").children.map(visibleText)).toEqual([
      "You get about 32.4714 stDUSK, worth about 99.75 DUSK now.",
      "stDUSK is Sozu's token for your share. Its DUSK value follows Sozu's pool, its rewards and its fees.",
    ]);
    // Sozu's fees as read and the network fee; its contract is on Review.
    expect(body.querySelectorAll(".group.info .list-row").map(visibleText)).toEqual([
      "Any amount, no node neededYou get stDUSK, a token for your share of Sozu's pool.Add to Assets",
      "Sozu keeps 10% of rewards0.25% on deposits · No fee to unstake",
      "Network fee up to 0.005 DUSK",
    ]);
    expect(visibleText(body)).not.toMatch(/whole (gas )?limit|Sozu's contract/);
    expect(body.querySelectorAll("button").find((b) => b.getAttribute("aria-label") === "Add stDUSK to Assets")).toBeTruthy();

    // Mainnet's fees, as its substrate gives them.
    state.sozu.status.fees = { deposit: { numerator: "1", denominator: "400" }, reward: { numerator: "15", denominator: "100" } };
    popup(state);
    expect(visibleText(body.querySelectorAll(".group.info .list-row")[1])).toBe("Sozu keeps 15% of rewards0.25% on deposits · No fee to unstake");
  });

  it("refuses a stake under the least that gets stDUSK at the rate now, after the fee", () => {
    const state = { route: "stake", staking: staking(owner(), { screen: "liquid" }), sozu: sozu() };
    popup(state);
    // 1 lux: the fee takes all of it, and Sozu's pool would refuse it.
    for (const tooLittle of ["0.000000001", "0.000000004"]) {
      typeInto(field("Stake amount"), tooLittle);
      expect(body.querySelector(".amount-field__error").textContent).toBe("The minimum stake is 0.000000005 DUSK.");
      expect(button("Review stake").disabled).toBe(true);
    }
    typeInto(field("Stake amount"), "0.000000005");
    expect(body.querySelector(".amount-field__error").hidden).toBe(true);
    expect(visibleText(body.querySelector(".stake-estimate__main"))).toBe("You get about 0.000000001 stDUSK, worth about 0.000000004 DUSK now.");
    expect(button("Review stake").disabled).toBe(false);
  });

  it("keeps a stake off until Sozu's fees are read, and says so", () => {
    const status = { ...sozu().status, fees: null };
    const state = { route: "stake", staking: staking(owner(), { screen: "liquid" }), sozu: sozu({ status }) };
    popup(state);
    expect(visibleText(body.querySelector(".sozu-terms"))).toBe("Deposit fee not read yet");
    expect(visibleText(body.querySelectorAll(".group.info .list-row")[1])).toBe("Sozu's feesThey couldn't be read just now.");
    typeInto(field("Stake amount"), "5");
    expect(body.querySelector(".amount-field__error").textContent).toBe("Sozu's rate and fees couldn't be read. Try again later.");
    expect(button("Review stake").disabled).toBe(true);
  });

  it("turns staking off while Sozu has paused deposits, keeps unstaking, and warns while its pool is synchronizing", async () => {
    const status = { ...sozu().status, features: { maintenance: true, synchronization: false } };
    const state = {
      route: "stake",
      staking: staking(owner(), { screen: "liquid" }),
      sozu: sozu({ status, position: { poolBalanceLux: dusk(12), stDuskBalanceLux: dusk(4) } }),
    };
    const app = popup(state);
    expect(visibleText(body.querySelector(".sozu-paused"))).toBe("Sozu has paused depositsUnstaking still works.");
    expect(field("Stake amount").disabled).toBe(true);
    expect(button("Max").disabled).toBe(true);
    expect(button("Review stake").disabled).toBe(true);
    expect(body.querySelector(".sozu-sync")).toBeNull();

    state.sozu.action = "withdraw";
    app.draw();
    expect(body.querySelector(".sozu-paused")).toBeNull();
    typeInto(field("Unstake amount"), "5");
    expect(button("Review unstake").disabled).toBe(false);

    // Synchronizing: a call can fail.
    status.features = { maintenance: false, synchronization: true };
    app.draw();
    const sync = "Sozu is synchronizing its poolA stake or unstake can fail until it's done.";
    expect(visibleText(body.querySelector(".sozu-sync"))).toBe(sync);
    button("Review unstake").click();
    await settle();
    expect(visibleText(body.querySelector(".sozu-sync"))).toBe(sync);
    expect(button("Confirm").disabled).toBe(false);

    // Paused after a stake was drafted: its Review says so, and Confirm stays off.
    state.route = "stake";
    state.sozu.action = "deposit";
    app.draw();
    typeInto(field("Stake amount"), "5");
    button("Review stake").click();
    await settle();
    status.features = { maintenance: true, synchronization: false };
    app.draw();
    expect(body.querySelector(".row > .field-error").textContent).toBe("Sozu has paused deposits.");
    expect(button("Confirm").disabled).toBe(true);
  });

  it("sends a stake with 5M gas and an unstake with 10M at the node's price, never under 2.5M and 4M, nor at the contract call default", async () => {
    const liquid = (action) => ({
      route: "stake",
      staking: staking(owner(), { screen: "liquid" }),
      sozu: sozu({ action, position: { poolBalanceLux: dusk(12), stDuskBalanceLux: dusk(4) } }),
    });
    const sentGas = (app) => app.actions.send.mock.calls.map(([m]) => m).find((m) => m.type === "DUSK_UI_SEND_TX")?.params.gas;

    let app = popup(liquid("deposit"));
    typeInto(field("Stake amount"), "5");
    button("Review stake").click();
    await settle();
    let editor = body.querySelector("dusk-gas-editor");
    expect(String(editor.minLimit)).toBe("2500000");
    expect(visibleText(body.querySelector(".gas-fee"))).toBe("Network feeup to 0.005 DUSKTotalup to 5.005 DUSK");
    // Fields left empty send the stake's own gas.
    editor.setGas(null);
    button("Confirm").click();
    await settle();
    expect(sentGas(app)).toEqual({ limit: "5000000", price: "1" });

    app = popup(liquid("withdraw"));
    typeInto(field("Unstake amount"), "5");
    button("Review unstake").click();
    await settle();
    editor = body.querySelector("dusk-gas-editor");
    expect(String(editor.minLimit)).toBe("4000000");
    expect(visibleText(body.querySelector(".gas-fee"))).toBe("Network feeup to 0.01 DUSKTotalup to 0.01 DUSK");
    button("Confirm").click();
    await settle();
    expect(sentGas(app)).toEqual({ limit: "10000000", price: "1" });
  });

  it("reads Sozu's terms again before sending a stake, and shows them for another Confirm when they changed", async () => {
    const state = { route: "stake", staking: staking(owner(), { screen: "liquid" }), sozu: sozu() };
    // What the node says when Confirm is pressed.
    let now = { ...sozu().status, pool: sozu().pool, position: sozu().position };
    const app = popup(state, ov(), { sozuStatus: () => now });
    const sent = () => app.actions.send.mock.calls.map(([m]) => m).filter((m) => m.type === "DUSK_UI_SEND_TX");
    const rows = () => body.querySelectorAll(".row > .group .kv").map(visibleText).slice(0, 2);
    typeInto(field("Stake amount"), "100");
    button("Review stake").click();
    await settle();
    expect(rows()).toEqual(["You get about32.4714 stDUSK, worth about 99.75 DUSK now", "Deposit fee0.25% · 0.25 DUSK"]);

    // Sozu's manager raises the deposit fee to 5% meanwhile: nothing is sent, and the new figures show.
    now = { ...now, fees: { ...now.fees, deposit: { numerator: "5", denominator: "100" } } };
    button("Confirm").click();
    await settle();
    expect(sent()).toEqual([]);
    expect(visibleText(body.querySelector(".sozu-changed"))).toBe("Sozu's terms changedThese are the figures now. Check them, then confirm again.");
    expect(rows()).toEqual(["You get about30.9251 stDUSK, worth about 95 DUSK now", "Deposit fee5% · 5 DUSK"]);

    // Confirmed again on those terms: sent, and only the call goes.
    button("Confirm").click();
    await settle();
    expect(sent()).toHaveLength(1);
    expect(sent()[0].params).toMatchObject({ fnName: "sozu_stake", deposit: dusk(100), contractId: POOL });
    expect(sent()[0].params).not.toHaveProperty("termsChanged");
  });

  it("doesn't send a stake when Sozu's terms can't be read again, or deposits were paused since its Review", async () => {
    const state = { route: "stake", staking: staking(owner(), { screen: "liquid" }), sozu: sozu() };
    let now = null;
    const app = popup(state, ov(), { sozuStatus: () => now });
    const sent = () => app.actions.send.mock.calls.map(([m]) => m).filter((m) => m.type === "DUSK_UI_SEND_TX");
    const errors = () => body.querySelectorAll(".row > .field-error").filter(isShown).map((e) => e.textContent);
    typeInto(field("Stake amount"), "100");
    button("Review stake").click();
    await settle();

    button("Confirm").click();
    await settle();
    expect(sent()).toEqual([]);
    expect(errors()).toEqual(["Couldn't check Sozu's terms just now, so nothing was sent. Try again."]);
    expect(button("Confirm").disabled).toBe(false);

    now = { ...sozu().status, pool: sozu().pool, features: { maintenance: true, synchronization: false } };
    button("Confirm").click();
    await settle();
    expect(sent()).toEqual([]);
    expect(errors()).toEqual(["Sozu has paused deposits."]);
    expect(button("Confirm").disabled).toBe(true);
  });

  describe("a stake whose check of Sozu's terms answers late", () => {
    // Review of a 100 DUSK stake, Confirm pressed, and Sozu's status held back
    // until `answer` gives it: unchanged unless told otherwise.
    async function lateCheck() {
      const overview = ov();
      const state = { route: "stake", staking: staking(owner(), { screen: "liquid" }), sozu: sozu(), overview };
      let release;
      const held = new Promise((resolve) => (release = resolve));
      const app = popup(state, overview, { sozuStatus: () => held });
      typeInto(field("Stake amount"), "100");
      button("Review stake").click();
      await settle();
      const draft = state.sozuDraft;
      button("Confirm").click();
      await settle();
      const messages = (type) => app.actions.send.mock.calls.map(([m]) => m).filter((m) => m.type === type);
      return {
        state,
        app,
        draft,
        reads: () => messages("DUSK_UI_GET_SOZU_STATUS").length,
        sent: () => messages("DUSK_UI_SEND_TX"),
        // Back on the stake's form, with the amount typed for the Review, and why.
        backOnForm: (notice) => {
          expect([state.route, state.staking.screen, state.sozuDraft]).toEqual(["stake", "liquid", null]);
          expect(visibleText(body.querySelector(".sozu-notice"))).toBe(notice);
          expect(field("Stake amount").value).toBe("100");
        },
        answer: async (over = {}) => {
          release({ ...sozu().status, pool: sozu().pool, position: sozu().position, ...over });
          await settle();
        },
      };
    }

    it("sends nothing when Review is left before the answer comes", async () => {
      const t = await lateCheck();
      expect(t.reads()).toBe(1);
      body.querySelector(".subnav-back").click();
      expect(t.state.route).toBe("stake");
      await t.answer();
      expect(t.sent()).toEqual([]);
      expect(t.state.route).toBe("stake");
    });

    it("sends nothing for a stake whose Review another one took the place of meanwhile", async () => {
      const t = await lateCheck();
      body.querySelector(".subnav-back").click();
      typeInto(field("Stake amount"), "50");
      button("Review stake").click();
      await settle();
      expect(t.state.sozuDraft).not.toBe(t.draft);
      await t.answer();
      expect(t.sent()).toEqual([]);
      // The new stake's own Review stays, its Confirm free to press.
      expect(t.state.route).toBe("sozu_confirm");
      expect(visibleText(body.querySelector(".review-head .balance-amount"))).toBe("50 DUSK");
      expect(button("Confirm").disabled).toBe(false);
    });

    it.each([
      ["the network changes", { nodeUrl: "https://nodes.dusk.network", networkName: "Mainnet" }, SWITCHED],
      ["the profile changes", { selectedAccountIndex: 1 }, SWITCHED],
      ["the wallet locks", { isUnlocked: false }, LOCKED],
    ])("sends nothing when %s before the answer comes, and goes back to the stake to say so", async (_, change, notice) => {
      const t = await lateCheck();
      t.state.overview = ov(change);
      await t.answer();
      expect(t.sent()).toEqual([]);
      t.backOnForm(notice);
    });

    it("sends nothing when a switch starts before the answer comes, though the overview still names the Review's network", async () => {
      const t = await lateCheck();
      // The header's switch has begun: the wallet may be on the new network
      // already, while the overview is still being read again.
      switchContext(t.state);
      await t.answer();
      expect(t.sent()).toEqual([]);
    });

    it("sends nothing when a switch starts as the Sent screen is drawn, and says so", async () => {
      const t = await lateCheck();
      const draw = t.app.actions.render.getMockImplementation();
      t.app.actions.render.mockImplementation(async () => {
        if (t.state.route === "sent") switchContext(t.state);
        return draw();
      });
      await t.answer();
      expect(t.sent()).toEqual([]);
      const step = body.querySelector(".step");
      expect([visibleText(step.querySelector(".step-title")), visibleText(step.querySelector(".step-sub"))]).toEqual([
        "Not sent",
        "The network, profile or wallet changed meanwhile. No fee was charged.",
      ]);
    });

    it("leaves a Review drawn again after a switch at once, and its answer then does nothing", async () => {
      const t = await lateCheck();
      // The switch to Profile 2 is done first, and the popup draws again.
      switchContext(t.state);
      Object.assign(t.state.overview, { selectedAccountIndex: 1 });
      t.app.draw();
      t.backOnForm(SWITCHED);
      expect(button("Confirm")).toBeUndefined();
      await t.answer();
      expect(t.sent()).toEqual([]);
      t.backOnForm(SWITCHED);
    });

    it("goes back to the stake to say so when the answer comes from another network, as one another window switched to", async () => {
      const t = await lateCheck();
      await t.answer({ networkKey: "mainnet" });
      expect(t.sent()).toEqual([]);
      // Not a Confirm that does nothing: the stake's form, the overview read
      // again, the amount kept and checked, and why.
      t.backOnForm(SWITCHED);
      expect(t.state.needsRefresh).toBe(true);
      expect(button("Review stake").disabled).toBe(false);
      // It says so until Staking shows another screen, or the stake is reviewed again.
      body.querySelector(".subnav-back").click();
      buttonStarting("Liquid staking").click();
      expect(t.state.staking.screen).toBe("liquid");
      expect(body.querySelector(".sozu-notice")).toBeNull();
      t.state.sozu.notice = SWITCHED;
      t.app.draw();
      button("Review stake").click();
      expect(t.state.sozu.notice).toBe("");
    });

    it("checks once and sends once however often Confirm is pressed, a redrawn Review's included", async () => {
      const t = await lateCheck();
      button("Confirm").click();
      t.app.draw();
      expect(button("Confirm").disabled).toBe(true);
      button("Confirm").click();
      await settle();
      expect(t.reads()).toBe(1);
      await t.answer();
      expect(t.reads()).toBe(1);
      expect(t.sent()).toHaveLength(1);
      expect(t.sent()[0].params).toMatchObject({ fnName: "sozu_stake", deposit: dusk(100) });
    });
  });

  describe("a stake's Review, drawn again after the popup moved away from where it was drafted", () => {
    const THIRD =
      "2Ana1pUpv2ZbMVkwF5FXapYeBEjdxDatLn7nvJkhgTSXbs59SyZSx866bXirPgj8QQVB57uxHJBG1YFvkRbFj4T";

    it.each([
      ["a switch to Profile 2", (state) => (switchContext(state), { selectedAccountIndex: 1 }), SWITCHED],
      ["a switch to Mainnet", (state) => (switchContext(state), { nodeUrl: "https://nodes.dusk.network", networkName: "Mainnet" }), SWITCHED],
      ["a lock and an unlock", (state) => (switchContext(state, "lock"), {}), LOCKED],
      ["another wallet unlocked in another window", () => ({ accounts: [THIRD] }), SWITCHED],
    ])("offers no Confirm after %s, and goes back to the stake to say so", async (_, move, notice) => {
      const overview = ov({ accounts: [ACCOUNT, OTHER] });
      const state = { route: "stake", staking: staking(owner(), { screen: "liquid" }), sozu: sozu(), overview };
      const app = popup(state, overview);
      typeInto(field("Stake amount"), "100");
      button("Review stake").click();
      await settle();
      expect(button("Confirm").disabled).toBe(false);

      // The Review, left idle, is drawn again once the popup moved on: it
      // offers no Confirm, and the stake's form shows instead.
      Object.assign(overview, move(state));
      app.draw();
      expect(button("Confirm")).toBeUndefined();
      expect([state.route, state.staking.screen, state.sozuDraft]).toEqual(["stake", "liquid", null]);
      expect(visibleText(body.querySelector(".sozu-notice"))).toBe(notice);
      expect(field("Stake amount").value).toBe("100");
      await settle();
      expect(app.actions.send.mock.calls.filter(([m]) => m.type === "DUSK_UI_SEND_TX")).toEqual([]);
    });

    it("leaves a stake drafted on a form drawn before a switch began, at once", async () => {
      const state = { route: "stake", staking: staking(owner(), { screen: "liquid" }), sozu: sozu() };
      popup(state);
      typeInto(field("Stake amount"), "100");
      // The switch starts while the form shows, and Review stake is pressed
      // before the form is drawn again: its figures are for the old network.
      switchContext(state);
      button("Review stake").click();
      await settle();
      expect(button("Confirm")).toBeUndefined();
      expect([state.route, state.sozuDraft]).toEqual(["stake", null]);
      expect(visibleText(body.querySelector(".sozu-notice"))).toBe(SWITCHED);
    });
  });

  it("keeps staking off while it can't tell whether Sozu takes deposits, and says so", () => {
    const status = { ...sozu().status, features: { maintenance: null, synchronization: false } };
    const state = {
      route: "stake",
      staking: staking(owner(), { screen: "liquid" }),
      sozu: sozu({ status, position: { poolBalanceLux: dusk(12), stDuskBalanceLux: dusk(4) } }),
    };
    const app = popup(state);
    expect(visibleText(body.querySelector(".sozu-paused"))).toBe(
      "Sozu's deposits couldn't be checkedStaking stays off until they can be. Unstaking still works."
    );
    expect(field("Stake amount").disabled).toBe(true);
    expect(button("Review stake").disabled).toBe(true);
    state.sozu.action = "withdraw";
    app.draw();
    typeInto(field("Unstake amount"), "5");
    expect(button("Review unstake").disabled).toBe(false);
  });

  it("says no stake gets stDUSK when Sozu's deposit fee is 100%", () => {
    const status = { ...sozu().status, fees: { ...sozu().status.fees, deposit: { numerator: "1", denominator: "1" } } };
    const state = { route: "stake", staking: staking(owner(), { screen: "liquid" }), sozu: sozu({ status }) };
    popup(state);
    typeInto(field("Stake amount"), "100");
    expect(body.querySelector(".amount-field__error").textContent).toBe("No stake gets stDUSK at Sozu's deposit fee now.");
    expect(visibleText(body.querySelector(".sozu-terms"))).toBe("Deposit fee 100% · 100 DUSK");
    expect(button("Review stake").disabled).toBe(true);
  });

  it("checks the amount as it is typed, and drafts the stake and the unstake", () => {
    const state = {
      route: "stake",
      staking: staking(owner(), { screen: "liquid" }),
      sozu: sozu({ position: { poolBalanceLux: dusk(12), stDuskBalanceLux: dusk(4) } }),
    };
    const app = popup(state);
    expect(body.querySelectorAll(".kv").map(visibleText).slice(0, 2)).toEqual([
      "Staked with Sozu12 DUSK",
      "stDUSK4 stDUSKAdd to Assets",
    ]);
    typeInto(field("Stake amount"), "5000");
    expect(body.querySelector(".amount-field__error").textContent).toBe(
      "That's more than your public balance, with the network fee."
    );
    expect(button("Review stake").disabled).toBe(true);
    button("Max").click();
    expect(field("Stake amount").value).toBe("1482.9233");
    typeInto(field("Stake amount"), "5");
    button("Review stake").click();
    expect(state.sozuDraft).toMatchObject({ kind: "contract_call", fnName: "sozu_stake", amount: "0", deposit: dusk(5) });
    expect(app.actions.showToast).not.toHaveBeenCalled();

    state.route = "stake";
    state.sozu.action = "withdraw";
    app.draw();
    expect(visibleText(body.querySelector(".sozu-terms"))).toBe("The DUSK comes back in the same transaction. No fee, no waiting.");
    typeInto(field("Unstake amount"), "13");
    expect(body.querySelector(".amount-field__error").textContent).toBe("That's more than you have staked with Sozu.");
    button("Max").click();
    expect(field("Unstake amount").value).toBe("12");
    button("Review unstake").click();
    expect(state.sozuDraft).toMatchObject({ fnName: "sozu_unstake", deposit: "0" });
  });

  it("goes to the Sent screen after Confirm, named as a third party", async () => {
    const state = { route: "stake", staking: staking(owner(), { screen: "liquid" }), sozu: sozu() };
    const app = popup(state);
    typeInto(field("Stake amount"), "100");
    button("Review stake").click();
    await settle();
    expect(visibleText(body.querySelector(".review-head"))).toBe("Liquid staking100 DUSKWith Sozu, a third party");
    expect(body.querySelectorAll(".row > .group .kv").map(visibleText)).toEqual([
      "You get about32.4714 stDUSK, worth about 99.75 DUSK now",
      "Deposit fee0.25% · 0.25 DUSK",
      "FromProfile 1 · Public",
    ]);
    // Nothing on what a failed call costs; Sozu is named a third party above.
    expect(body.querySelectorAll(".row > .stake-cap")).toEqual([]);
    expect(visibleText(body)).not.toMatch(/whole (gas )?limit/);
    button("Confirm").click();
    await settle();
    const sentTx = app.actions.send.mock.calls.map(([m]) => m).find((m) => m.type === "DUSK_UI_SEND_TX");
    expect(sentTx).toMatchObject({
      params: { kind: "contract_call", fnName: "sozu_stake", profileIndex: 0, deposit: dusk(100) },
      asset: { kind: "sozu", action: "sozu_stake" },
    });
    expect(sentTx.params).not.toHaveProperty("quote");
    expect(sentTx.params.gas).toEqual({ limit: "5000000", price: "1" });
    expect(state.route).toBe("sent");
    expect(visibleText(body.querySelector(".sent-head"))).toBe("Liquid staking100 DUSKWith Sozu, a third party");
  });

  it("asks the wallet to send a stake or an unstake only on the wallet, profile and network of its Review", async () => {
    const overview = ov({ selectedAccountIndex: 1, accounts: [ACCOUNT, OTHER] });
    for (const [action, amount, review] of [
      ["deposit", "Stake amount", "Review stake"],
      ["withdraw", "Unstake amount", "Review unstake"],
    ]) {
      const state = {
        route: "stake",
        staking: staking(owner(), { screen: "liquid", profileIndex: 1 }),
        sozu: sozu({ action, profileIndex: 1, position: { poolBalanceLux: dusk(12), stDuskBalanceLux: dusk(4) } }),
      };
      const app = popup(state, overview);
      typeInto(field(amount), "5");
      button(review).click();
      await settle();
      button("Confirm").click();
      await settle();
      const sentTx = app.actions.send.mock.calls.map(([m]) => m).find((m) => m.type === "DUSK_UI_SEND_TX");
      expect(sentTx.params).toMatchObject({
        profileIndex: 1,
        _approvalContext: { walletId: ACCOUNT, profileIndex: 1, account: OTHER, nodeUrl: "https://testnet.nodes.dusk.network" },
      });
    }
  });

  it("hides what Sozu holds with Hide balances, and the deposit fee in DUSK, but not what a typed amount gets or the network fee", () => {
    const state = {
      route: "stake",
      staking: staking(owner(), { screen: "liquid" }),
      sozu: sozu({ position: { poolBalanceLux: dusk(7), stDuskBalanceLux: dusk(10) } }),
    };
    popup(state, ov({ hideBalances: true }));
    expect(body.querySelectorAll(".kv").map(visibleText).slice(0, 2)).toEqual([
      "Staked with Sozu•••• DUSK",
      "stDUSK•••• stDUSKAdd to Assets",
    ]);
    expect(visibleText(body.querySelector(".amount-avail span"))).toBe("Available •••• DUSK from your public balance");
    typeInto(field("Stake amount"), "100");
    expect(visibleText(body.querySelector(".stake-estimate"))).toContain("You get about 32.4714 stDUSK, worth about 99.75 DUSK now.");
    expect(visibleText(body.querySelector(".sozu-terms"))).toBe("Deposit fee 0.25% · •••• DUSK");
    expect(visibleText(body.querySelector(".group.info"))).toContain("Network fee up to 0.005 DUSK");
  });
});

describe("staking words", () => {
  it("never say Earn", async () => {
    for (const file of ["stake.js", "sozu.js", "sent.js"]) {
      const source = await readFile(path.resolve(process.cwd(), "src", "ui", "popup", "views", file), "utf8");
      expect(source, file).not.toMatch(/\bEarn/);
    }
  });
});
