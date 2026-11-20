import { sozuRate } from "@dusk-network/app-core/sozu";
import { feePercent } from "@dusk-network/networks/sozu";

import {
  formatDusk,
  formatDuskExact,
  formatFee,
  amountLocale,
  formatLuxForInput,
  formatLuxToDusk,
  groupThousands,
  maxAmountLux,
  parseDuskToLux,
  safeBigInt,
} from "../../../shared/amount.js";
import { TX_KIND } from "../../../shared/constants.js";
import { chainIdForNode, networkKeyOf } from "../../../shared/nodeNetwork.js";
import { getDefaultGas, getMinimumGas } from "../../../shared/txDefaults.js";
import { openUrl } from "../../../platform/index.js";
import { h } from "../../lib/dom.js";
import { waiting } from "../../components/Waiting.js";
import { guarded } from "../../lib/clickGuard.js";
import { ratePercent, shortAddress } from "../../lib/strings.js";
import { subnav } from "../../components/Subnav.js";
import "../../components/GasEditor.js";
import { iconSvg } from "../../components/ActionIcon.js";
import { amountField } from "../../components/AmountField.js";
import { bracketTitle } from "../../components/BracketTitle.js";
import { balance, balancesHidden } from "../../components/Balance.js";
import { fieldLabel, reviewActions, submitOnGasEnter } from "../../components/FormControls.js";
import { gasFeeLux, payGuard, reviewGas, startingGas } from "../../components/NetworkGas.js";
import { shortfallText } from "../../lib/shortfall.js";
import { profileNameEl, withReviewWallet } from "../../components/ProfileName.js";
import { readSozuFactsAgain, sozuHolding, sozuLiquidStakingView, stakeStaleNote, stakingHistory } from "./sozu.js";
import { lastReadText } from "./txRow.js";
import { keepBalances, keptBalancesOf } from "../../../shared/keptBalances.js";
import { NODE_ANSWER_MS } from "../../../shared/networkStatus.js";
import { keptRatesOf, nativeRewardsOf, rewardYearsOf, sozuGrowthOf } from "../activity.js";
import { currencyName } from "../activityExport.js";
import { duskPrices } from "../duskPrice.js";
import { defaultCurrency } from "@dusk-network/app-core/amounts";
import { REWARDS_COUNTED, REWARD_WORDS, rewardWorth } from "@dusk-network/app-core/export";
import { sendFromReview } from "./sent.js";

const FUNDING_PUBLIC = "account";
const FUNDING_SHIELDED = "address";
const ACTION_TOPUP = "topup";
const ACTION_UNSTAKE = "unstake";
const ACTION_CLAIM = "claim";

// The staking screens, all on the "stake" route: the overview, the amount for
// native staking, and liquid staking through Sozu.
export const SCREEN_OVERVIEW = "overview";
export const SCREEN_NATIVE = "native";
export const SCREEN_LIQUID = "liquid";

// Running a node, as native staking needs: Dusk's docs.
const DOCS_NODE_URL = "https://docs.dusk.network/operator/provisioner/";

function stakeKindLabel(kind, { hasStake = true } = {}) {
  const k = String(kind ?? "").toLowerCase();
  if (k === TX_KIND.STAKE) return hasStake ? "Stake more" : "Stake";
  if (k === TX_KIND.UNSTAKE) return "Unstake";
  if (k === TX_KIND.WITHDRAW_REWARD) return "Claim rewards";
  return "Staking";
}

function actionToKind(action) {
  if (action === ACTION_UNSTAKE) return TX_KIND.UNSTAKE;
  if (action === ACTION_CLAIM) return TX_KIND.WITHDRAW_REWARD;
  return TX_KIND.STAKE;
}

function fmtLux(luxStr) {
  return formatDusk(luxStr);
}

function profileLabel(index) {
  return `Profile ${Number(index ?? 0) + 1}`;
}

// A profile by its name as the header shows it: its .dusk name once looked
// up, else its label.
function profileName(ov, index) {
  return profileNameEl(ov, { index: Number(index ?? 0) || 0 });
}


function positionKey(pos) {
  return `stake:${Number(pos?.stakeProfileIndex ?? pos?.profileIndex ?? 0)}`;
}

// The fee Review starts from (startingGas): the draft's gas or custom gas
// from Settings (`feeGas`) included, so Max and the balance checks match it.
function reviewFeeLux(kind, payment = FUNDING_PUBLIC, { customGas = null, gas = null } = {}) {
  const privacy = payment === FUNDING_SHIELDED ? "shielded" : "public";
  return gasFeeLux(
    startingGas({ defaultGas: getDefaultGas(kind, { privacy }), minLimit: getMinimumGas(kind, { privacy })?.limit, customGas, gas })
  );
}

// "1,000 DUSK", hidden with Hide balances.
function amountParts(hidden, lux) {
  return [balance(hidden, fmtLux(lux)), h("span", { class: "balance-unit", text: " DUSK" })];
}

// Who owns a stake, in a word: a profile, a contract, or a key not here.
function ownerLabel(pos, ownerProfileIndex) {
  if (pos?.ownerKind === "contract") return "Contract";
  if (pos?.ownerKind === "missing") return "Not in this wallet";
  return profileLabel(ownerProfileIndex ?? pos?.ownerProfileIndex);
}

function ownerCopy(pos) {
  if (!pos?.hasStake) {
    return `${profileLabel(pos?.ownerProfileIndex ?? pos?.stakeProfileIndex)} will own this stake.`;
  }
  if (pos.ownerKind === "self") {
    return `${profileLabel(pos.stakeProfileIndex)} owns this stake.`;
  }
  if (pos.ownerKind === "local") {
    return `${profileLabel(pos.ownerProfileIndex)} owns this ${profileLabel(pos.stakeProfileIndex)} stake.`;
  }
  if (pos.ownerKind === "missing") {
    return "Owner key not found in this wallet.";
  }
  if (pos.ownerKind === "contract") {
    return "Contract-owned stake. View only.";
  }
  return pos?.reason || "Stake owner unavailable.";
}

function normalizePosition(raw, ownerStatus, selectedIndex) {
  const stakeProfileIndex = Number(raw?.profileIndex ?? selectedIndex ?? 0) || 0;
  return {
    stakeProfileIndex,
    stakeAccount: raw?.account ?? "",
    publicBalance: raw?.publicBalance ?? null,
    hasStake: Boolean(raw?.hasStake),
    info: raw?.info ?? { amount: null, reward: "0", faults: 0, hardFaults: 0 },
    keys: raw?.keys ?? null,
    ownerKind: raw?.ownerKind ?? "none",
    ownerAccount: raw?.ownerAccount ?? null,
    ownerContract: raw?.ownerContract ?? null,
    ownerProfileIndex:
      raw?.ownerProfileIndex !== undefined && raw?.ownerProfileIndex !== null
        ? Number(raw.ownerProfileIndex)
        : stakeProfileIndex,
    manageable: raw?.manageable !== false,
    reason: raw?.reason ?? "",
    profiles: ownerStatus?.profiles ?? [],
  };
}

function buildPositions(ownerStatus, selectedIndex) {
  if (!ownerStatus) return [];

  const rawPositions = Array.isArray(ownerStatus.relatedStakes)
    ? ownerStatus.relatedStakes
    : [];
  const selected = normalizePosition(
    {
      profileIndex: ownerStatus.profileIndex ?? selectedIndex,
      account: ownerStatus.account,
      publicBalance:
        ownerStatus.publicBalance ??
        ownerStatus.profiles?.find?.((p) => Number(p.profileIndex) === Number(selectedIndex))
          ?.publicBalance ??
        null,
      hasStake: ownerStatus.hasStake,
      info: ownerStatus.info,
      keys: ownerStatus.keys,
      ownerKind: ownerStatus.ownerKind,
      ownerAccount: ownerStatus.ownerAccount,
      ownerContract: ownerStatus.ownerContract,
      ownerProfileIndex: ownerStatus.ownerProfileIndex,
      manageable: ownerStatus.manageable,
      reason: ownerStatus.reason,
    },
    ownerStatus,
    selectedIndex
  );

  const seen = new Map();
  for (const pos of [selected, ...rawPositions.map((p) => normalizePosition(p, ownerStatus, selectedIndex))]) {
    seen.set(positionKey(pos), pos);
  }

  return [...seen.values()];
}

function ensureStakeLoaded(ov, { state, actions } = {}) {
  const st = (state.staking ??= {
    loaded: false,
    loading: false,
    error: null,
    updatedAt: 0,
    profileIndex: null,
    minimumStakeLux: null,
    ownerStatus: null,
    actionKind: ACTION_TOPUP,
    activePositionKey: null,
    stakeAmountDusk: "",
    unstakeAmountDusk: "",
    withdrawAmountDusk: "",
    ownerProfileIndex: null,
    fundingMode: FUNDING_PUBLIC,
    screen: SCREEN_OVERVIEW,
  });

  const idx = Number(ov?.selectedAccountIndex ?? 0) || 0;
  const place = { nodeUrl: String(ov?.nodeUrl ?? ""), account: String(ov?.accounts?.[idx] ?? "") };
  // Whose figures they are: the profile's account, any wallet's, on its node
  // (round 40's review: a profile's index alone took one wallet's Profile 1
  // for another's, and a switch while its read went on drew the other's
  // stake, Unstake and Claim with it). Figures with no account of theirs
  // are the profile's their index says.
  const owner = `${place.nodeUrl}\n${place.account}`;
  const sameOwner = st.owner ? st.owner === owner : st.profileIndex === idx;
  const stale = !st.loaded || !sameOwner;
  if (!stale || (st.loading && (st.reading ?? owner) === owner)) return st;
  // A read for this profile that failed stays failed, said on the screen,
  // till the overview's read again (app.js clears it): not read anew as the
  // screen's drawn again (round 40's second review: a node refusing the
  // stake was asked again and again, and "can't be read" never stayed).
  if (st.error && sameOwner && st.reading === owner) return st;

  st.loading = true;
  st.reading = owner;
  st.error = null;
  st.slow = false;
  // This read, which what it brings is for: another profile's, or a later
  // read's, isn't drawn over it.
  const read = (st.read = {});
  // Another's figures don't stay on the screen while this one's are read.
  if (!sameOwner) Object.assign(st, { ownerStatus: null, minimumStakeLux: null, kept: false, updatedAt: 0, loaded: false });
  st.owner = owner;
  // What was read last on this device shows, said to be maybe out of date
  // with when it was read: at once, till the node answers; and once the node
  // has had its time, the screen says what it can rather than waiting on
  // (Lena's: offline, "Loading staking…" for more than a minute, no figures,
  // no time).
  const fromKept = (kept) => {
    const figures = kept?.staking;
    if (!figures?.ownerStatus) return false;
    Object.assign(st, { ownerStatus: figures.ownerStatus, minimumStakeLux: String(figures.minimumStakeLux ?? ""), profileIndex: idx, updatedAt: Number(kept.stakingAt) || 0, kept: true });
    st.ownerProfileIndex = st.ownerStatus?.ownerProfileIndex ?? st.ownerProfileIndex ?? idx;
    return true;
  };
  keptBalancesOf(place)
    .then((kept) => {
      if (st.read === read && st.loading && fromKept(kept)) actions?.render?.().catch(() => {});
    })
    .catch(() => {});
  setTimeout(() => {
    if (st.read !== read || !st.loading) return;
    st.slow = true;
    actions?.render?.().catch(() => {});
  }, NODE_ANSWER_MS);

  Promise.all([
    actions?.send?.({ type: "DUSK_UI_GET_MINIMUM_STAKE", profileIndex: idx }),
    actions?.send?.({ type: "DUSK_UI_GET_STAKE_OWNER_STATUS", profileIndex: idx }),
  ])
    .then(([minResp, ownerResp]) => {
      if (st.read !== read) return;
      if (minResp?.error) throw new Error(minResp.error.message ?? "Failed to load minimum stake");
      if (ownerResp?.error) throw new Error(ownerResp.error.message ?? "Failed to load stake owner");

      const status = ownerResp?.result ?? ownerResp ?? null;
      // Read for another account than this profile's, as when another window
      // switched wallets as it was asked: neither shown nor kept (round 40's
      // second review).
      if (status?.account && status.account !== place.account) throw new Error("Staking can't be read now.");
      // The stake itself not read now (its request failed or timed out, which
      // the wallet says: `infoRead` false): what was read of it before stays,
      // said to be maybe out of date with when, never a fresh "no stake"
      // (round 40's review); with none on the screen, what's kept here.
      if (status?.infoRead === false) {
        const shown = st.ownerStatus ? Promise.resolve(true) : keptBalancesOf(place).then((kept) => st.read === read && fromKept(kept));
        return shown.then((had) => {
          if (st.read !== read) return;
          if (!had) throw new Error("Staking can't be read now: the network isn't answering. It's read again once it does.");
          Object.assign(st, { minimumStakeLux: String(minResp?.result ?? minResp ?? ""), profileIndex: idx, loaded: true, loading: false, kept: true });
          actions?.render?.().catch(() => {});
        });
      }
      st.minimumStakeLux = String(minResp?.result ?? minResp ?? "");
      st.ownerStatus = status;
      st.ownerProfileIndex = st.ownerStatus?.ownerProfileIndex ?? st.ownerProfileIndex ?? idx;
      st.profileIndex = idx;
      st.loaded = true;
      st.loading = false;
      st.kept = false;
      st.updatedAt = Date.now();
      keepBalances(place, { staking: { ownerStatus: st.ownerStatus, minimumStakeLux: st.minimumStakeLux } }).catch(() => {});
      actions?.render?.().catch(() => {});
    })
    .catch((e) => {
      if (st.read !== read) return;
      st.loading = false;
      st.loaded = false;
      st.error = e?.message ?? String(e);
      actions?.render?.().catch(() => {});
    });

  return st;
}

function fundingOptionsForPosition(pos) {
  const publicLux = safeBigInt(pos?.publicBalance?.value ?? 0, 0n);
  return {
    publicLux,
    shieldedAvailable: false,
  };
}

// Whether an action can go ahead on this position, and if not, why, in the
// words the screens show.
function actionState(pos, actionKind, amountLux, minLux, { hidden = false, feeGas } = {}) {
  const kind = actionToKind(actionKind);
  const { publicLux } = fundingOptionsForPosition(pos);
  const feeLux = reviewFeeLux(kind, FUNDING_PUBLIC, feeGas);
  const needsAmount = actionKind === ACTION_TOPUP;
  const spendLux = needsAmount ? safeBigInt(amountLux ?? 0, 0n) : 0n;
  const requiredLux = spendLux + feeLux;
  const rewardLux = safeBigInt(pos?.info?.reward ?? 0, 0n);
  const hasGas = publicLux >= feeLux;

  if (pos?.ownerKind === "contract") {
    return {
      ok: false,
      reason: "Contract-owned stake. View only.",
    };
  }
  if (pos?.ownerKind === "missing") {
    return {
      ok: false,
      reason: "Owner key not found in this wallet.",
    };
  }
  if (pos?.manageable === false) {
    return { ok: false, reason: pos?.reason || "This wallet cannot manage this stake." };
  }
  if (actionKind !== ACTION_TOPUP && !pos?.hasStake) {
    return {
      ok: false,
      reason:
        rewardLux > 0n ? "There is no stake to manage." : "Nothing staked yet, so there's nothing to unstake or claim.",
    };
  }
  if (actionKind === ACTION_CLAIM && rewardLux <= 0n) {
    return { ok: false, reason: "No rewards to claim yet." };
  }
  if (!hasGas) {
    // The fee comes from the stake's profile, also when another one owns it.
    const elsewhere =
      pos?.ownerProfileIndex !== undefined && Number(pos.ownerProfileIndex) !== Number(pos.stakeProfileIndex);
    return { ok: false, reason: shortfallText({ missingLux: feeLux - publicLux, moves: false, hidden, of: elsewhere ? profileLabel(pos.stakeProfileIndex) : "" }) };
  }
  if (actionKind === ACTION_TOPUP && amountLux !== null && amountLux !== undefined) {
    if (safeBigInt(amountLux, 0n) <= 0n) {
      return { ok: false, reason: "Enter an amount greater than 0." };
    }
    if (!pos.hasStake && minLux > 0n && safeBigInt(amountLux, 0n) < minLux) {
      return { ok: false, reason: `The minimum stake is ${fmtLux(minLux)} DUSK.` };
    }
    if (publicLux < requiredLux) {
      return { ok: false, reason: shortfallText({ missingLux: requiredLux - publicLux, hidden }) };
    }
  }
  return { ok: true, reason: "" };
}

// The position the screens show: the one picked under Advanced, else the
// first with a stake, else the selected profile's own.
function stakingContext(ov, { state, actions } = {}) {
  const st = ensureStakeLoaded(ov, { state, actions });
  const selectedIndex = Number(ov?.selectedAccountIndex ?? 0) || 0;
  const minLux = st?.minimumStakeLux != null ? safeBigInt(st.minimumStakeLux, 0n) : 0n;
  const positions = buildPositions(st?.ownerStatus ?? null, selectedIndex);
  if (!st.activePositionKey || !positions.some((pos) => positionKey(pos) === st.activePositionKey)) {
    st.activePositionKey = positionKey(
      positions.find((pos) => pos.hasStake) ?? positions[0] ?? { stakeProfileIndex: selectedIndex }
    );
  }
  const pos = positions.find((p) => positionKey(p) === st.activePositionKey) ?? positions[0] ?? null;
  // The gas Review starts from, for the fee the screens set aside.
  const feeGas = { customGas: ov?.customGas ?? null, gas: state?.stakeDraft?.gas ?? null };
  return { st, selectedIndex, minLux, positions, pos, hidden: balancesHidden(ov), feeGas };
}

// Where Review's draft comes from: the action, its amount and the profiles.
function makeDraft(pos, st, { state, actions, actionKind, amountLux = null, amountMode = "all", amountMasked = false }) {
  const kind = actionToKind(actionKind);
  const stakeProfileIndex = Number(pos.stakeProfileIndex) || 0;
  const ownerProfileIndex =
    pos.hasStake && pos.ownerProfileIndex !== undefined && pos.ownerProfileIndex !== null
      ? Number(pos.ownerProfileIndex)
      : Number(st.ownerProfileIndex ?? stakeProfileIndex) || 0;
  state.stakeDraft = {
    kind,
    stakeProfileIndex,
    profileIndex: stakeProfileIndex,
    ownerProfileIndex,
    amountLux,
    amountMode,
    amountMasked,
    hasStake: Boolean(pos.hasStake),
    // What Unstake and Claim move, for Review and the Sent screen.
    displayLux:
      actionKind === ACTION_UNSTAKE
        ? String(pos?.info?.amount?.total ?? "")
        : actionKind === ACTION_CLAIM
          ? String(pos?.info?.reward ?? "")
          : null,
    payment: FUNDING_PUBLIC,
    fundingMode: FUNDING_PUBLIC,
    stakeProfileLabel: profileLabel(stakeProfileIndex),
    ownerProfileLabel: profileLabel(ownerProfileIndex),
    fundingLabel: `${profileLabel(stakeProfileIndex)} public balance`,
    gas: state.stakeDraft?.gas ?? null,
    position: {
      stakeProfileIndex,
      ownerProfileIndex,
      stakeAccount: pos.stakeAccount,
    },
  };
  state.route = "stake_confirm";
  actions?.render?.().catch(() => {});
}

function setScreen(st, screen, actions) {
  st.screen = screen;
  actions?.render?.().catch(() => {});
}

// Liquid staking as a way to stake: on its Stake tab, whatever an unstake left it on.
function stakeWithSozu(state, st, actions) {
  if (state?.sozu) state.sozu.action = "deposit";
  setScreen(st, SCREEN_LIQUID, actions);
}

function listRow({ icon, title, subs = [], onClick, chevron = true, extra = null }) {
  const children = [
    h("span", { class: "row-icon", html: iconSvg(icon) }),
    h("span", { class: "row-main" }, [
      h("span", { class: "row-title" }, [].concat(title)),
      ...subs.filter(Boolean).map((sub) => h("span", { class: "row-sub" }, [].concat(sub))),
      extra,
    ].filter(Boolean)),
    chevron ? h("span", { class: "row-chev", html: iconSvg("chev-r") }) : null,
  ].filter(Boolean);
  return onClick
    ? h("button", { class: "list-row", type: "button", onclick: onClick }, children)
    : h("div", { class: "list-row" }, children);
}

function infoRow(icon, title, sub) {
  return h("div", { class: "list-row" }, [
    h("span", { class: "row-icon", html: iconSvg(icon) }),
    h("span", { class: "row-main" }, [
      h("span", { class: "row-title" }, [].concat(title)),
      sub ? h("span", { class: "row-sub" }, [].concat(sub)) : null,
    ].filter(Boolean)),
  ]);
}

// Native staking's node: the fact, and Run a node, which opens Dusk's docs on it.
function nodeRow(actions) {
  return infoRow("server", "Needs your own Dusk node", [
    h("button", {
      class: "text-btn text-btn--inline chain-link",
      type: "button",
      text: "Run a node",
      onclick: async () => {
        const ok = await openUrl(DOCS_NODE_URL);
        if (!ok) actions?.showToast?.("Couldn't open the docs");
      },
    }),
  ]);
}

// What a year's rewards of one kind were worth, in both wallets' words
// (app-core's rewardWorth): in the currency, "under" its smallest coin, a loss
// with its minus sign, as taken out by unstaking can be with its deposit fees
// counted, or "a loss under" it, never 0; and how many of them have no price.
function worthText({ worth, unpriced }, currency) {
  if (worth === null || worth === undefined) return "";
  const one = currencyName(currency, 1);
  if (unpriced && !Number(worth)) return `no ${one} value`;
  const said = rewardWorth(String(worth), { currency, language: globalThis.navigator?.language });
  return said ? `${said}${unpriced ? `, ${unpriced} with no ${one} value` : ""}` : "";
}

// A year's rewards of one kind that say anything: more than none, or a loss.
const anyOf = (sum) => typeof sum?.lux === "bigint" && sum.lux !== 0n;

// Rewards by calendar year, in this device's time zone, as a tax return asks
// for them: native rewards claimed, and with Sozu what grew while held and
// what unstaking took out that year (rewardYearsOf), from the profile's whole
// public history and Sozu's `status`, in the web wallet's words. What each
// was worth in the region's currency, at its time, only when asked, as
// Activity's export asks: CoinGecko's prices.
function rewardYears(ov, { state, actions, hidden, status }) {
  const history = stakingHistory(ov, { state, actions });
  if (history.reading || !history.rows.length) return null;
  const currency = defaultCurrency();
  const valued = Boolean(state.rewardYearsValued);
  // Read again for a new status, what was said kept meanwhile: what's held
  // and what it's worth now, which grows as Sozu's rewards come; with their
  // value once it's asked for; and after each read of Sozu's facts again.
  const base = `${history.key}|${history.rows.length}|${history.facts?.size ?? 0}|${history.factsRead ?? 0}`;
  const held = status?.position ?? {};
  const key = `${base}|${status ? `${held.stDusk ?? held.stDuskBalanceLux ?? ""}/${held.balance ?? held.poolBalanceLux ?? ""}` : "-"}|${valued ? currency : ""}`;
  if (state.rewardYears?.key !== key) {
    // What was said stays while it's read again, for the same profile: a new
    // stake's or unstake's facts come from the archive a little after its block.
    const kept = (state.rewardYears = { base, key, of: history.key, years: state.rewardYears?.of === history.key ? state.rewardYears.years : [] });
    rewardYearsOf(ov, { rows: history.rows, facts: history.facts, complete: Boolean(history.whole), status, price: valued ? duskPrices({ currency }) : undefined })
      .then((years) => {
        if (state.rewardYears !== kept) return;
        kept.years = years;
        // Some of it still read: its facts asked again a moment on.
        if (years.some((year) => year.reading > 0)) readSozuFactsAgain(ov, { state, actions });
        actions?.render?.()?.catch?.(() => {});
      })
      .catch(() => {});
  }
  // Sozu's part as it is, or null where it couldn't be read, which is said.
  // While a stake's or an unstake's facts are read (app-core's `reading`),
  // "Reading…" in place of what it moves, never a figure from before it beside
  // one after it (Lena's: the "taken out" from before her unstake, beside a
  // "grown" that had moved, for 20 to 25 s, with no word that it was read).
  const years = state.rewardYears.years.filter((year) => year.reading > 0 || anyOf(year.claimed) || anyOf(year.sozu) || anyOf(year.sozuGrown) || year.sozu === null || year.sozuGrown === null);
  if (!years.length) return null;
  const line = (label, sum, reading = false) => {
    if (sum === null) return [`${label}: couldn't be read`];
    if (reading) return [`${label}: `, h("span", { class: "muted", text: "Reading…" })];
    if (!anyOf(sum)) return null;
    const worth = valued ? worthText(sum, currency) : "";
    return [`${label}: `, ...amountParts(hidden, sum.lux), worth ? h("span", { class: "kv-muted" }, [" · ", balance(hidden, worth)]) : null].filter(Boolean);
  };
  const value = h("label", { class: "checkline stake-years-value", for: "stake-years-value" }, [
    h("input", {
      type: "checkbox",
      id: "stake-years-value",
      checked: valued,
      onchange: (e) => {
        state.rewardYearsValued = Boolean(e?.target?.checked);
        actions?.render?.()?.catch?.(() => {});
      },
    }),
    h("span", { text: `Add ${currency} value (CoinGecko)` }),
  ]);
  // Sozu's two lines, how they're counted, in both wallets' words (app-core).
  const sozuShown = years.some(({ sozu, sozuGrown, reading }) => reading > 0 || sozu === null || sozuGrown === null || anyOf(sozu) || anyOf(sozuGrown));
  return [
    h("div", { class: "section-head" }, [bracketTitle({ text: "Rewards by year" })]),
    h("div", { class: "group stake-years" }, [...years].reverse().map(({ year, claimed, sozu, sozuGrown, reading }) =>
      kvRow(
        String(year),
        // What grew moves with each stake and unstake; what was taken out, where some was, with an unstake.
        [line(REWARD_WORDS.claimed, claimed), line(REWARD_WORDS.sozuGrown, sozuGrown, reading > 0), line(REWARD_WORDS.sozu, sozu, reading > 0 && anyOf(sozu))]
          .filter(Boolean)
          .map((parts) => h("span", { class: "stake-year-part" }, parts))
      )
    )),
    sozuShown ? h("p", { class: "settings-note stake-years-counted", text: REWARDS_COUNTED }) : null,
    value,
  ].filter(Boolean);
}

function kvRow(label, value) {
  return h("div", { class: "kv" }, [h("span", { class: "kv-label", text: label }), h("span", { class: "kv-value" }, [].concat(value))]);
}

// An Advanced disclosure that stays as the user left it when the screen redraws.
function advancedPanel(st, key, children) {
  const open = Boolean(st.advancedOpen?.[key]);
  const details = h("details", { class: "advanced", open }, [h("summary", { text: "Advanced" }), h("div", { class: "advanced-body" }, children)]);
  details.addEventListener("toggle", () => {
    st.advancedOpen = { ...(st.advancedOpen ?? {}), [key]: details.open };
  });
  return details;
}

// What Staking says while it has no figures: that it reads them, for as long
// as the node is given to answer; then that they can't be read now, never a
// spinner that goes on. Its figures read last show instead where there are
// any (ensureStakeLoaded).
function statusLine(st) {
  const offline = globalThis.navigator?.onLine === false;
  if (st?.loading && !st?.loaded && !st?.kept) {
    if (offline) return h("div", { class: "muted stake-unread", role: "status", text: "Staking can't be read until you're back online." });
    if (st.slow) return h("div", { class: "muted stake-unread", role: "status", text: "Staking can't be read now: the network isn't answering. It's read again once it does." });
    return waiting("Loading staking…");
  }
  if (st?.error && !st?.kept) return h("div", { class: "err", text: String(st.error) });
  return null;
}

/**
 * Staking: the overview, the native amount screen or liquid staking,
 * whichever `state.staking.screen` holds.
 */
export function stakeFormView(ov, { state, actions } = {}) {
  const ctx = stakingContext(ov, { state, actions });
  const screen = ctx.st.screen ?? SCREEN_OVERVIEW;
  if (screen === SCREEN_LIQUID) {
    return sozuLiquidStakingView(ov, { state, actions, onBack: () => setScreen(ctx.st, SCREEN_OVERVIEW, actions) });
  }
  // Away from liquid staking, what it said about a Review it left is done with.
  if (state.sozu?.notice) state.sozu.notice = "";
  if (screen === SCREEN_NATIVE && ctx.pos) return nativeStakeView(ov, ctx, { state, actions });
  return stakingOverview(ov, ctx, { state, actions });
}

// What each way of staking pays a year, beside the choice, with the days it
// was measured over: native staking's as the chain paid it over the last 30
// days (app-core's nativeRewards), else the estimate at today's stake (one read
// of the node a day, rewardRate.js); Sozu's as stDUSK grew, else after its fee
// on rewards from native staking's figure as shown, so both wallets give the
// same one. The rates measured last, kept a day (keptRatesOf), show with their
// days till new ones come, and stay where they can't be read. Asked once a
// popup, node and network (a custom node's once its chain ID is read too), and
// drawn again when the answers come.
function rewardRates(ov, { state, actions }) {
  const nodeUrl = String(ov?.nodeUrl ?? "");
  const networkKey = networkKeyOf(Number.isInteger(ov?.chainId) ? ov.chainId : chainIdForNode(nodeUrl), nodeUrl);
  const ofNetwork = (status) => (status?.networkKey === networkKey ? status : null);
  // Sozu's status as Liquid staking read it last, while it's this network's.
  const heldStatus = ofNetwork(state.sozu?.status);
  const held = heldStatus?.fees?.reward ?? null;
  const key = `${networkKey} ${nodeUrl}`;
  if (state.rewardRates?.key !== key) {
    const rates = (state.rewardRates = { key, native: null, nativeDays: null, sozuFee: null, growth: null, keptFee: null });
    const result = (res) => (res?.error ? null : res?.result ?? null);
    const idx = Number(ov?.selectedAccountIndex ?? 0) || 0;
    // The last measured, unless a new measure came first.
    const kept = keptRatesOf(ov)
      .then(({ native, sozu }) => {
        if (state.rewardRates !== rates || !(native || sozu)) return;
        if (native && !rates.measured) Object.assign(rates, { native: native.rate, nativeDays: native.days, measured: true });
        if (sozu && !rates.growth) Object.assign(rates, { growth: sozu.growth, keptFee: sozu.fee });
        actions?.render?.().catch(() => {});
      })
      .catch(() => {});
    // As the chain paid it, where that can be read: in place of the estimate.
    Promise.resolve(actions?.send?.({ type: "DUSK_UI_GET_STAKING_FIGURES" }))
      .then(result, () => null)
      .then((figures) => nativeRewardsOf(ov, figures))
      .then((measured) => {
        if (state.rewardRates !== rates || !measured) return;
        Object.assign(rates, { native: measured.rate, nativeDays: measured.days, measured: true });
        actions?.render?.().catch(() => {});
      });
    Promise.all([
      Promise.resolve(actions?.send?.({ type: "DUSK_UI_GET_REWARD_RATE" })).then(result, () => null),
      // What the overview reads of Sozu has the fee too, once it answers.
      heldStatus ??
        (state.sozu?.loading
          ? null
          : Promise.resolve(actions?.send?.({ type: "DUSK_UI_GET_SOZU_STATUS", profileIndex: idx })).then(
              (res) => ofNetwork(result(res)),
              () => null
            )),
      kept,
    ]).then(([native, status]) => {
      if (state.rewardRates !== rates) return;
      // The estimate, unless what the chain paid came first, or was kept.
      if (!rates.measured) rates.native = typeof native === "number" ? native : null;
      rates.sozuFee = status?.fees?.reward ?? null;
      if (rates.native !== null) actions?.render?.().catch(() => {});
      measureGrowth(ov, status, { state, actions });
    });
  }
  // Or Liquid staking's status, where it came in while this read none.
  measureGrowth(ov, heldStatus, { state, actions });
  // Sozu's fee as Liquid staking read it last, else as asked here, else as it was with the growth kept.
  const sozuFee = held ?? state.rewardRates.sozuFee ?? state.rewardRates.keptFee;
  const { native, nativeDays, growth } = state.rewardRates;
  const sozu = native !== null && sozuFee ? sozuRate(native, { fees: { reward: sozuFee } }, growth) : null;
  // Sozu's over the days stDUSK grew, else over native staking's.
  const sozuDays = growth?.days ?? nativeDays;
  // When each was measured: said once under both where it's the same, on each where not.
  const nativeWhen = native === null ? null : nativeDays ? `over ${lastDays(nativeDays)}` : "at today's stake";
  const sozuWhen = sozu === null ? null : sozuDays ? `over ${lastDays(sozuDays)}` : "at today's stake";
  const whens = [...new Set([nativeWhen, sozuWhen].filter(Boolean))];
  const once = whens.length === 1 ? whens[0] : "";
  return {
    native: native !== null ? `About ${ratePercent(native)} a year across the network${once ? "" : ` ${nativeWhen}`}` : null,
    sozu: sozu !== null ? `About ${ratePercent(sozu)} a year${once ? "" : ` ${sozuWhen}`}, after Sozu's ${feePercent(sozuFee, amountLocale())}` : null,
    note: whens.length ? (once ? `Rates ${once}, not promised.` : "Not promised.") : null,
  };
}

// "the last 30 days", as app-core's working line says a period.
const lastDays = (days) => (days === 1 ? "the last day" : `the last ${new Intl.NumberFormat(amountLocale()).format(days)} days`);

// How stDUSK grew lately, as Liquid staking measures it, read once a status
// names the pool: the same rate on both screens.
function measureGrowth(ov, status, { state, actions }) {
  const rates = state.rewardRates;
  if (!rates || rates.growthAsked || !status?.contracts?.pool) return;
  rates.growthAsked = true;
  sozuGrowthOf(ov, status).then((growth) => {
    if (state.rewardRates !== rates || !growth) return;
    rates.growth = growth;
    actions?.render?.().catch(() => {});
  });
}

// A Sozu stake or unstake of this profile's that isn't in a block yet.
function sozuTxOnItsWay(ov) {
  const idx = Number(ov?.selectedAccountIndex ?? 0) || 0;
  return (Array.isArray(ov?.txs) ? ov.txs : []).find(
    (tx) => tx?.asset?.kind === "sozu" && tx.profileIndex === idx && (tx.status === "submitted" || tx.status === "mempool")
  );
}

function stakingOverview(ov, ctx, { state, actions }) {
  const { st, minLux, positions, pos, hidden, feeGas } = ctx;
  const onBack = () => {
    state.route = "home";
    actions?.render?.().catch(() => {});
  };
  if (!pos) {
    return [subnav({ title: "Staking", onBack }), statusLine(st) ?? (st.loading ? waiting("Loading staking…") : h("div", { class: "muted stake-unread", role: "status", text: "Staking can't be read now." }))];
  }

  const stakedLux = safeBigInt(pos.info?.amount?.total ?? 0, 0n);
  const lockedLux = safeBigInt(pos.info?.amount?.locked ?? 0, 0n);
  const rewardLux = safeBigInt(pos.info?.reward ?? 0, 0n);
  const unstakeState = actionState(pos, ACTION_UNSTAKE, null, minLux, { hidden, feeGas });
  const claimState = actionState(pos, ACTION_CLAIM, null, minLux, { hidden, feeGas });
  const { publicLux } = fundingOptionsForPosition(pos);
  const several = positions.length > 1;

  // What's staked comes first, natively and with Sozu.
  const holding = sozuHolding(ov, { state, actions });
  const hasLiquid = holding.known && (holding.poolLux > 0n || holding.stDuskLux > 0n);
  const hasNative = stakedLux > 0n || rewardLux > 0n;
  const showNativeActions = hasNative || !hasLiquid;
  const sozuOnItsWay = sozuTxOnItsWay(ov);
  // Nothing natively staked says nothing of Sozu, until what's there is read,
  // with what's on its way in it.
  const sozuUnread = (!holding.known || holding.failed || holding.reading || Boolean(sozuOnItsWay)) && !hasNative;

  // The reasons Unstake and Claim can't be pressed, said once each.
  const reasons = showNativeActions && !sozuUnread ? [...new Set([unstakeState, claimState].filter((s) => !s.ok).map((s) => s.reason))] : [];
  // Lena's: with the node silent, Staking said nothing of its own; and "may be
  // out of date" never said when the figures were read. Each figure shown was
  // read on its own: the note says the oldest, and says it for Sozu's too.
  const staleNote = stakeStaleNote(ov, hasLiquid ? [st.updatedAt, holding.readAt] : [st.updatedAt], { kept: Boolean(st.kept || (hasLiquid && state.sozu?.kept)) });
  const sozuNote = sozuOnItsWay
    ? `Your ${sozuOnItsWay.asset.action === "sozu_unstake" ? "unstake from" : "stake with"} Sozu is on its way.`
    : !holding.failed
      ? null
      : !hasLiquid
        ? "What's with Sozu couldn't be read."
        : staleNote
          ? null
          : `What's with Sozu couldn't be read again, so it may be out of date.${lastReadText(holding.readAt)}`;

  const figure = (label, lux, sub = null) =>
    h("div", {}, [
      h("div", { class: "stake-lbl", text: label }),
      h("div", { class: "stake-big" }, amountParts(hidden, lux)),
      sub ? h("div", { class: "stake-cap" }, sub) : null,
    ].filter(Boolean));

  const summary = h("div", { class: "group stake-sum" }, [
    several
      ? h("div", { class: "stake-account" }, [
          profileName(ov, pos.stakeProfileIndex),
          " · ",
          h("span", { class: "mono", title: pos.stakeAccount, text: shortAddress(pos.stakeAccount) }),
        ])
      : null,
    hasLiquid
      ? h("div", { class: "stake-sum__two" }, [
          figure("Staked natively", stakedLux),
          figure(
            pos.stakeProfileIndex === ctx.selectedIndex ? "With Sozu" : `With Sozu · ${profileLabel(ctx.selectedIndex)}`,
            holding.poolLux,
            [balance(hidden, fmtLux(holding.stDuskLux)), " stDUSK, rewards included"]
          ),
          figure("Native rewards", rewardLux),
        ])
      : h("div", { class: "stake-sum__two" }, [figure("Staked", stakedLux), figure("Rewards", rewardLux)]),
    staleNote,
    lockedLux > 0n
      ? h("div", { class: "stake-cap" }, [
          "Locked: ",
          ...amountParts(hidden, lockedLux),
          ". It's still yours, and unstaking returns it.",
        ])
      : null,
    showNativeActions
      ? h("div", { class: "stake-pair" }, [
          h("button", {
            class: "btn-outline",
            type: "button",
            text: "Unstake",
            disabled: !unstakeState.ok,
            onclick: () => makeDraft(pos, st, { state, actions, actionKind: ACTION_UNSTAKE }),
          }),
          h("button", {
            class: "btn-outline",
            type: "button",
            text: "Claim rewards",
            disabled: !claimState.ok,
            onclick: () => makeDraft(pos, st, { state, actions, actionKind: ACTION_CLAIM }),
          }),
        ])
      : null,
    hasLiquid
      ? h("button", {
          class: "btn-outline",
          type: "button",
          text: "Unstake from Sozu",
          onclick: () => {
            state.sozu.action = "withdraw";
            setScreen(st, SCREEN_LIQUID, actions);
          },
        })
      : null,
    ...reasons.map((reason) => h("div", { class: "stake-cap", text: reason })),
    sozuNote ? h("div", { class: "stake-cap", text: sozuNote }) : null,
  ].filter(Boolean));

  // Two equal choices; neither is picked for you. Each says about what it
  // pays a year, once that's read, and the note under both that it's not promised.
  const rates = rewardRates(ov, { state, actions });
  const choices = h("div", { class: "group stake-choices" }, [
    listRow({
      icon: "server",
      title: "Native staking",
      subs: [pos.hasStake ? "Add to your stake · needs your own node" : `From ${fmtLux(minLux)} DUSK · needs your own node`, rates.native],
      onClick: () => setScreen(st, SCREEN_NATIVE, actions),
    }),
    listRow({
      icon: "drop",
      title: ["Liquid staking", h("span", { class: "tag", text: "Sozu, third party" })],
      subs: ["Any amount · no node needed", "You get stDUSK for your share", rates.sozu],
      onClick: () => stakeWithSozu(state, st, actions),
    }),
  ]);
  const ratesNote = rates.note ? h("p", { class: "amount-note stake-rates-note", text: rates.note }) : null;

  const available = h("div", { class: "stake-avail" }, ["Available ", balance(hidden, fmtLux(publicLux)), " DUSK from your public balance"]);

  // Which stake the screen shows, who owns it, and its details, out of the way.
  const advanced = advancedPanel(st, "overview", [
      several
        ? h("div", { class: "row" }, [
            h("div", { class: "advanced-label", id: "stake-account-label", text: "Stake account" }),
            h(
              "div",
              { class: "choice-list", role: "radiogroup", "aria-labelledby": "stake-account-label" },
              positions.map((p) => {
                const picked = positionKey(p) === positionKey(pos);
                return h(
                  "button",
                  {
                    class: picked ? "choice is-picked" : "choice",
                    type: "button",
                    role: "radio",
                    "aria-checked": String(picked),
                    onclick: () => {
                      st.activePositionKey = positionKey(p);
                      actions?.render?.().catch(() => {});
                    },
                  },
                  [
                    h("span", { class: "choice-dot", "aria-hidden": "true" }),
                    h("span", { class: "choice-main" }, [
                      h("span", { class: "choice-title", text: `${profileLabel(p.stakeProfileIndex)} · ${shortAddress(p.stakeAccount)}` }),
                      h("span", { class: "choice-sub" }, p.hasStake ? [...amountParts(hidden, p.info?.amount?.total ?? 0), " staked"] : ["No stake"]),
                    ]),
                  ]
                );
              })
            ),
          ])
        : null,
      h("div", { class: "group group--inset" }, [
        kvRow("Owner", ["self", "local", "none"].includes(pos?.ownerKind) ? profileName(ov, pos.ownerProfileIndex) : ownerLabel(pos)),
        kvRow("Stake account", [
          profileName(ov, pos.stakeProfileIndex),
          " · ",
          h("span", { class: "mono", title: pos.stakeAccount, text: shortAddress(pos.stakeAccount) }),
        ]),
        pos.hasStake
          ? kvRow(
              "Active from",
              safeBigInt(pos.info?.amount?.eligibility ?? 0, 0n) > 0n
                ? ["Block ", h("span", { class: "mono", text: groupThousands(safeBigInt(pos.info.amount.eligibility, 0n).toString()) })]
                : "Active now"
            )
          : null,
        pos.hasStake ? kvRow("Penalties", `${Number(pos.info?.faults ?? 0) || 0} soft · ${Number(pos.info?.hardFaults ?? 0) || 0} hard`) : null,
      ].filter(Boolean)),
      h("div", { class: "stake-cap", text: ownerCopy(pos) }),
    ].filter(Boolean));

  return [
    subnav({ title: "Staking", onBack }),
    statusLine(st),
    summary,
    ...(rewardYears(ov, { state, actions, hidden, status: holding.status }) ?? []),
    h("div", { class: "section-head" }, [bracketTitle({ text: "Stake" })]),
    choices,
    ratesNote,
    available,
    advanced,
  ].filter(Boolean);
}

function nativeStakeView(ov, ctx, { state, actions }) {
  const { st, minLux, pos, hidden, feeGas } = ctx;
  const back = () => setScreen(st, SCREEN_OVERVIEW, actions);
  const kind = TX_KIND.STAKE;
  const feeLux = reviewFeeLux(kind, FUNDING_PUBLIC, feeGas);
  // Max keeps the fee to unstake later too, at the gas Settings may set.
  const unstakeFeeLux = reviewFeeLux(TX_KIND.UNSTAKE, FUNDING_PUBLIC, { customGas: feeGas?.customGas ?? null });
  const { publicLux } = fundingOptionsForPosition(pos);
  const maxTopupLux = maxAmountLux(publicLux, feeLux + unstakeFeeLux);
  const isNew = !pos.hasStake;
  const stakeProfileIndex = Number(pos.stakeProfileIndex) || 0;
  const ownerProfileIndex = pos.hasStake
    ? Number(pos.ownerProfileIndex ?? stakeProfileIndex) || 0
    : Number(st.ownerProfileIndex ?? stakeProfileIndex) || 0;

  // What stops any amount: no gas, a stake this wallet can't manage.
  const blocked = actionState(pos, ACTION_TOPUP, null, minLux, { hidden, feeGas });

  const field = amountField({
    label: isNew ? "Stake amount" : "Amount to add",
    value: st.stakeAmountDusk ?? "",
    disabled: !blocked.ok,
    masked: hidden && Boolean(st.stakeMasked),
    onInput: () => {
      st.amountMode = "custom";
      st.stakeMasked = false;
      check();
    },
    onEnter: () => review(),
  });

  const reviewBtn = h("button", {
    class: "btn-primary",
    type: "button",
    text: "Review stake",
    disabled: true,
    onclick: () => review(),
  });
  // What isn't an error: why nothing can be staked yet, or what Max kept.
  const note = h("p", { class: "amount-note", hidden: true });
  const showNote = (text) => {
    note.textContent = text || "";
    note.hidden = !text;
  };

  // The amount as typed, checked as it is typed: the minimum and the balance
  // say so under the field, and Review can't be pressed until it is right.
  // A stake nothing can be done with says why, as a note: nothing was tried.
  function check() {
    const raw = String(field.input.value ?? "").trim();
    st.stakeAmountDusk = raw;
    // Both fees Max keeps, each at most, as maxTopupLux sets them aside.
    showNote(
      st.amountMode === "max" && blocked.ok
        ? `Max keeps ${formatFee(feeLux + unstakeFeeLux, { max: true })} DUSK: up to ${formatFee(feeLux, { max: true })} for this fee and ${formatFee(unstakeFeeLux, { max: true })} to unstake later.`
        : ""
    );
    if (!blocked.ok) {
      field.setError("");
      showNote(blocked.reason);
      reviewBtn.disabled = true;
      return null;
    }
    if (!raw) {
      field.setError("");
      reviewBtn.disabled = true;
      return null;
    }
    let lux;
    try {
      lux = safeBigInt(parseDuskToLux(raw), 0n);
    } catch {
      field.setProblem(raw, { whole: "1000", decimal: "1000.5" });
      reviewBtn.disabled = true;
      return null;
    }
    const result = actionState(pos, ACTION_TOPUP, lux, minLux, { hidden, feeGas });
    field.setError(result.ok ? "" : result.reason);
    reviewBtn.disabled = !result.ok;
    return result.ok ? lux : null;
  }

  function review() {
    const lux = check();
    if (lux == null) {
      field.input.focus();
      return;
    }
    makeDraft(pos, st, {
      state,
      actions,
      actionKind: ACTION_TOPUP,
      amountLux: lux.toString(),
      amountMode: st.amountMode === "max" ? "max" : "custom",
      amountMasked: field.isMasked(),
    });
    st.amountMode = "custom";
  }

  const fill = (lux, mode) => {
    // What Max fills in shows as dots with balances hidden; the minimum isn't a balance.
    st.stakeMasked = mode === "max";
    field.setValue(formatLuxForInput(lux), { masked: hidden && st.stakeMasked });
    st.amountMode = mode;
    check();
    field.focus();
  };

  const useMin =
    isNew && minLux > 0n && maxTopupLux >= minLux
      ? h("button", {
          class: "mini-btn",
          type: "button",
          text: `Use ${fmtLux(minLux)}`,
          onclick: () => fill(minLux, "custom"),
        })
      : null;
  const maxBtn = h("button", {
    class: "mini-btn",
    type: "button",
    text: "Max",
    title: "All of it, less the network fee and the fee to unstake later",
    disabled: !blocked.ok || maxTopupLux <= 0n,
    onclick: () => fill(maxTopupLux, "max"),
  });

  const available = h("div", { class: "amount-avail" }, [
    h("span", {}, ["Available ", balance(hidden, fmtLux(publicLux)), " DUSK from your public balance"]),
    useMin,
    maxBtn,
  ].filter(Boolean));

  // The facts from Dusk's staking docs, in a few lines.
  const facts = h("div", { class: "group info" }, [
    nodeRow(actions),
    infoRow("clock", "Rewards start in about 6 to 12 hours", "Unstake any time, no waiting period."),
    isNew
      ? null
      : infoRow(
          "lock",
          "10% of what you add is locked",
          "When your stake is already active. It's still yours, and unstaking returns it."
        ),
    infoRow("alert", "If your node misses its turn", "Part of the stake is locked: still yours, and unstaking returns it. If it breaks the rules, part can be burned (lost)."),
    infoRow("fee", `Fee up to ${formatFee(feeLux, { max: true })} DUSK`, null),
  ].filter(Boolean));

  // Who owns a new stake, and which account it is for: most people leave it.
  const ownerSelect = isNew
    ? h(
        "select",
        {
          id: "stake-owner-profile",
          name: "stakeOwnerProfile",
          value: String(ownerProfileIndex),
          onchange: (e) => {
            st.ownerProfileIndex = Number(e?.target?.value ?? stakeProfileIndex) || 0;
          },
        },
        (pos.profiles?.length ? pos.profiles : [{ profileIndex: stakeProfileIndex }]).map((p) => {
          const idx = Number(p.profileIndex ?? 0) || 0;
          return h("option", {
            value: String(idx),
            text: idx === stakeProfileIndex ? `${profileLabel(idx)} (this profile)` : profileLabel(idx),
            selected: idx === ownerProfileIndex,
          });
        })
      )
    : null;
  if (ownerSelect) ownerSelect.value = String(ownerProfileIndex);

  const advanced = advancedPanel(st, "native", [
      ownerSelect
        ? h("div", { class: "row" }, [
            fieldLabel(ownerSelect, "Owner"),
            h("div", { class: "select-wrap" }, [ownerSelect]),
            h("div", { class: "stake-cap", text: "The owner can unstake and claim the rewards. Most people keep this profile." }),
          ])
        : h("div", { class: "group group--inset" }, [
            kvRow("Owner", ["self", "local", "none"].includes(pos?.ownerKind) ? profileName(ov, ownerProfileIndex) : ownerLabel(pos, ownerProfileIndex)),
          ]),
      h("div", { class: "group group--inset" }, [
        kvRow("Stake account", [
          profileName(ov, stakeProfileIndex),
          " · ",
          h("span", { class: "mono", title: pos.stakeAccount, text: shortAddress(pos.stakeAccount) }),
        ]),
      ]),
    ]);

  // Under the minimum, the way that takes any amount, named as a third party.
  const liquidLink = isNew
    ? h("button", {
        class: "text-btn stake-liquid-link chain-link",
        type: "button",
        text: `Under ${fmtLux(minLux)} DUSK? Use liquid staking (Sozu, third party)`,
        onclick: () => stakeWithSozu(state, st, actions),
      })
    : null;

  // An amount brought back from Review, or a blocked stake, says so at once.
  if (st.stakeAmountDusk || !blocked.ok) check();

  return [
    subnav({ title: isNew ? "Native staking" : "Stake more", onBack: back }),
    statusLine(st),
    h("div", { class: "amount-entry" }, [field.el, field.error, note, available]),
    advanced,
    // Review right under the amount, so both fit above a phone's keyboard.
    h("div", { class: "stake-bottom" }, [reviewBtn, liquidLink].filter(Boolean)),
    facts,
  ].filter(Boolean);
}

export function stakeConfirmView(ov, { state, actions } = {}) {
  const d = state.stakeDraft;
  if (!d) {
    state.route = "stake";
    return stakeFormView(ov, { state, actions });
  }

  const kind = String(d.kind ?? "").toLowerCase();
  const kindLabel = stakeKindLabel(kind, { hasStake: Boolean(d.hasStake) });
  // Back returns to Staking, so Review has no Cancel.
  const goBack = () => {
    state.route = "stake";
    actions?.render?.().catch(() => {});
  };

  // What moves: the amount staked, or all of the stake or the rewards. The
  // stake and the rewards are balances, hidden with Hide balances; an amount
  // typed in for a stake shows, as on every Review; what Max filled in doesn't.
  const shownLux = kind === TX_KIND.STAKE ? d.amountLux : d.amountLux || d.displayLux;
  const allText = kind === TX_KIND.UNSTAKE ? "All stake" : kind === TX_KIND.WITHDRAW_REWARD ? "All rewards" : "—";
  const hideAmount = (kind !== TX_KIND.STAKE || Boolean(d.amountMasked)) && balancesHidden(ov);

  // The button names what it does, with the amount as the head shows it: "Stake 1,000 DUSK".
  const verb = kind === TX_KIND.UNSTAKE ? "Unstake" : kind === TX_KIND.WITHDRAW_REWARD ? "Claim" : "Stake";
  const confirmBtn = h(
    "button",
    { class: "btn-primary" },
    shownLux && safeBigInt(shownLux, 0n) > 0n ? [`${verb} `, balance(hideAmount, formatDuskExact(shownLux)), " DUSK"] : [verb]
  );

  const gasPrivacy = d.payment === FUNDING_SHIELDED ? "shielded" : "public";
  // The network's gas price by default; Custom fee for gas of your own. A
  // stake's total is it and its fee; what an unstake or a claim brings back
  // is what you receive, the fee apart (Lena's: "Total up to" the fee alone).
  const { defaultGas, editor: gasEditor, error: confirmError, readGas } = reviewGas({
    kind,
    gasOpts: { privacy: gasPrivacy },
    amountLux: kind === TX_KIND.STAKE ? String(d.amountLux ?? "0") : String(shownLux ?? "0"),
    comesBack: kind !== TX_KIND.STAKE,
    hideTotal: hideAmount,
    ov,
    actions,
    gas: d?.gas,
  });

  const amountLine = () =>
    shownLux && safeBigInt(shownLux, 0n) > 0n ? [balance(hideAmount, formatDuskExact(shownLux)), " DUSK"] : [allText];

  const line =
    kind === TX_KIND.STAKE ? "Native staking" : kind === TX_KIND.UNSTAKE ? "Back to your public balance" : "To your public balance";

  // The stake's profile pays, as Staking read it: a stake from its public
  // balance with its fee, an unstake or a claim its fee alone.
  const payerIndex = Number(d.stakeProfileIndex ?? d.profileIndex ?? 0) || 0;
  const paying =
    state.staking?.ownerStatus?.profiles?.find?.((p) => Number(p.profileIndex) === payerIndex)?.publicBalance?.value ??
    (payerIndex === (Number(ov?.selectedAccountIndex ?? 0) || 0) ? ov?.balance?.value : null);
  const pay = payGuard({
    editor: gasEditor,
    availableLux: paying != null ? safeBigInt(paying, 0n) : null,
    sendsLux: kind === TX_KIND.STAKE ? safeBigInt(d.amountLux ?? 0, 0n) : 0n,
    hidden: balancesHidden(ov),
    button: confirmBtn,
  });

  // It ignores a click for a moment once Review is up (clickGuard.js).
  confirmBtn.addEventListener("click", guarded(async () => {
    if (!pay.covered()) return;
    const gas = readGas();
    if (gas === false) return;
    confirmBtn.disabled = true;
    d.gas = gas;
    const params = {
      kind,
      profileIndex: d.stakeProfileIndex ?? d.profileIndex,
      ...(d.amountLux ? { amount: d.amountLux } : {}),
      ownerProfileIndex: d.ownerProfileIndex,
      payment: d.payment || FUNDING_PUBLIC,
      gas: gas || undefined,
    };

    const capGas = gas ?? defaultGas;
    await sendFromReview({
      state,
      actions,
      message: { type: "DUSK_UI_SEND_TX", params },
      summary: {
        title: kindLabel,
        amountLux: shownLux && safeBigInt(shownLux, 0n) > 0n ? String(shownLux) : null,
        amountText: allText,
        line,
        from: kind === TX_KIND.STAKE ? "from your public balance" : "",
        feeCapLux: (safeBigInt(capGas?.limit, 0n) * safeBigInt(capGas?.price, 0n)).toString(),
      },
      backRoute: "stake_confirm",
      doneRoute: "stake",
      onSent: () => {
        if (state.staking) state.staking.loaded = false;
        // Done with, unless a newer stake draft took its place meanwhile.
        if (state.stakeDraft !== d) return;
        state.stakeDraft = null;
        if (state.staking) {
          state.staking.screen = SCREEN_OVERVIEW;
          state.staking.stakeAmountDusk = "";
        }
      },
    });
    pay.draw();
  }));
  submitOnGasEnter(gasEditor, confirmBtn, { ready: () => pay.covered() });

  const stakeIndex = d.stakeProfileIndex ?? d.profileIndex;
  const severalProfiles = Number(d.ownerProfileIndex) !== Number(stakeIndex);

  // The profile the stake is for, by its name as the header shows it: the
  // stake comes from its public balance, and an unstake or a claim goes back to it.
  const stakeName = profileNameEl(ov, { index: Number(stakeIndex) || 0 });

  return [
    subnav({ title: "Review", onBack: goBack }),
    h("div", { class: "row" }, [
      h("div", { class: "review-head" }, [
        h("div", { class: "review-kind", text: kindLabel }),
        h("div", { class: "balance-amount" }, amountLine()),
        h("div", { class: "review-line", text: line }),
      ]),
      h("div", { class: "group" }, [
        // One line, "alice.dusk · Public", as on Send's Review, after the
        // wallet's name with more than one wallet.
        kvRow(kind === TX_KIND.STAKE ? "From" : "To", [
          h("span", {}, [withReviewWallet(stakeName, actions?.review), h("span", { class: "kv-muted", text: d.payment === FUNDING_SHIELDED ? " · Shielded" : " · Public" })]),
        ]),
        severalProfiles ? kvRow("Owner", profileName(ov, d.ownerProfileIndex)) : null,
        kind === TX_KIND.STAKE && !severalProfiles && !d.hasStake ? kvRow("Rewards start", "In about 6 to 12 hours") : null,
      ].filter(Boolean)),
      // The node from the amount screen, once more before the stake goes.
      kind === TX_KIND.STAKE ? h("div", { class: "group info" }, [nodeRow(actions)]) : null,
      gasEditor,
      reviewActions(confirmBtn, confirmError, pay.el),
    ].filter(Boolean)),
  ];
}
