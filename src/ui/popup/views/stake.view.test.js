import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The fake DOM goes before the views: it defines HTMLElement for the gas editor.
import { accessibleName, installFakeDom, isShown, screenReaderText, settle, typeInto, visibleText } from "../../testing/fakeDom.js";
import { stakeConfirmView, stakeFormView } from "./stake.js";
import { sozuConfirmView, stDuskEstimate } from "./sozu.js";
import { sentView } from "./sent.js";

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
// about 3.07 DUSK.
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
  },
  pool: { totalStakeLux: "3071932000000", tokenTotalSupply: dusk(1000) },
  position: { poolBalanceLux: "0", stDuskBalanceLux: "0" },
  ...over,
});

const ov = (over = {}) => ({ selectedAccountIndex: 0, nodeUrl: "https://testnet.nodes.dusk.network", networkName: "Testnet", ...over });

let dom;
let body;

beforeEach(() => {
  dom = installFakeDom();
  body = dom.document.body;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Draws Staking, its Review and Sent as app.js routes them, and redraws on render.
function popup(state, overview = ov()) {
  const actions = {
    send: vi.fn(async (message) => {
      if (message.type === "DUSK_UI_GET_CACHED_GAS_PRICE") return { min: "1", median: "1", max: "1" };
      if (message.type === "DUSK_UI_SEND_TX") return { ok: true, result: { hash: "ab".repeat(32) } };
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
    body.replaceChildren(...view(overview, { state, actions }));
  };
  draw();
  return { actions, draw };
}

const button = (text) => body.querySelectorAll("button").find((b) => isShown(b) && visibleText(b) === text);
const buttonStarting = (text) => body.querySelectorAll("button").find((b) => isShown(b) && visibleText(b).startsWith(text));
const field = (name) => body.querySelectorAll("input").find((i) => accessibleName(i) === name);

describe("staking overview", () => {
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
      "Locked: 10 DUSK. It stays yours; unstaking returns it.",
      "Add gas funds to Profile 2 before managing this stake. Profile 1 owns this stake. Gas still comes from Profile 2.",
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
    // Blocked: the field says why and Review stays off.
    expect(body.querySelector(".amount-field__error").textContent).toBe("Contract-owned stake. View only.");
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

    // Max leaves the network fee.
    button("Max").click();
    expect(field("Stake amount").value).toBe("1482.8883");

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

  it("states the node, timing, penalty and fee facts from Dusk's staking docs", () => {
    popup({ route: "stake", staking: staking(owner(), { screen: "native" }) });
    expect(body.querySelectorAll(".group.info .list-row").map(visibleText)).toEqual([
      "Needs your own Dusk nodeA computer that runs Dusk's node software and stays online. What's a node?",
      "Rewards start in about 6 to 12 hoursUnstake any time, with no waiting period.",
      "If your node misses its turnPart of the stake is moved to locked. It stays yours, and unstaking returns it. Misbehaving can burn part of it.",
      "Network fee up to 0.0500 DUSK",
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
    expect(visibleText(body.querySelector(".liquid-intro"))).toBe(
      "Sozuthird partySozu, not Dusk, holds the DUSK you stake here and returns it under Sozu's own rules: sozu.fi."
    );
  });

  it("goes to the Sent screen after Confirm, and Done goes back to Staking", async () => {
    const state = { route: "stake", staking: staking(owner(), { screen: "native" }) };
    popup(state);
    typeInto(field("Stake amount"), "1000");
    button("Review stake").click();
    await settle();
    expect(visibleText(body.querySelector(".review-head"))).toBe("Stake1,000 DUSKNative staking");
    expect(body.querySelectorAll(".kv").map(visibleText)).toEqual([
      "Stake accountProfile 1",
      "OwnerProfile 1",
      "Fee paid fromProfile 1 public balance",
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

describe("liquid staking", () => {
  it("says what a stake gets in stDUSK, worth the pool's rate each", () => {
    // The rate is DUSK per stDUSK: the pool's total stake over the stDUSK supply.
    const pool = { totalStakeLux: "3071932000000", tokenTotalSupply: dusk(1000) };
    expect(stDuskEstimate(dusk(100), pool)).toBe("32.55");
    expect(stDuskEstimate(dusk(100), { totalStakeLux: "0", tokenTotalSupply: "0" })).toBe("");

    const state = { route: "stake", staking: staking(owner(), { screen: "liquid" }), sozu: sozu() };
    popup(state);
    expect(visibleText(body.querySelector(".stake-estimate"))).toBe("");
    typeInto(field("Stake amount"), "100");
    expect(visibleText(body.querySelector(".stake-estimate"))).toBe(
      "You get about 32.55 stDUSK. Each stDUSK is worth 3.07 DUSK and grows as rewards come in."
    );
    // With nothing staked yet, stDUSK can still be added to Assets.
    expect(body.querySelectorAll(".group.info .list-row").map(visibleText)).toEqual([
      "Any amount, no node neededYou get stDUSK, a token for your share of Sozu's pool.Add to Assets",
      "Network fee up to 0.5000 DUSK",
      `Sozu's contract${"72".repeat(4)}…${"72".repeat(4)}Copy`,
    ]);
    expect(body.querySelectorAll("button").find((b) => b.getAttribute("aria-label") === "Add stDUSK to Assets")).toBeTruthy();
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
    expect(field("Stake amount").value).toBe("1482.4383");
    typeInto(field("Stake amount"), "5");
    button("Review stake").click();
    expect(state.sozuDraft).toMatchObject({ kind: "contract_call", fnName: "sozu_stake", amount: "0", deposit: dusk(5) });
    expect(app.actions.showToast).not.toHaveBeenCalled();

    state.route = "stake";
    state.sozu.action = "withdraw";
    app.draw();
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
      "You get about32.55 stDUSK",
      "Fee paid fromProfile 1 public balance",
    ]);
    button("Confirm").click();
    await settle();
    const sentTx = app.actions.send.mock.calls.map(([m]) => m).find((m) => m.type === "DUSK_UI_SEND_TX");
    expect(sentTx).toMatchObject({
      params: { kind: "contract_call", fnName: "sozu_stake", profileIndex: 0, deposit: dusk(100) },
      asset: { kind: "sozu", action: "sozu_stake" },
    });
    expect(sentTx.params).not.toHaveProperty("stDuskEstimate");
    expect(state.route).toBe("sent");
    expect(visibleText(body.querySelector(".sent-head"))).toBe("Liquid staking100 DUSKWith Sozu, a third party");
  });

  it("hides what Sozu holds with Hide balances, but not the rate or the fee", () => {
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
    expect(visibleText(body.querySelector(".stake-estimate"))).toContain("Each stDUSK is worth 3.07 DUSK");
    expect(visibleText(body.querySelector(".group.info"))).toContain("Network fee up to 0.5000 DUSK");
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
