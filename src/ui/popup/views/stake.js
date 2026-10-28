import {
  UI_DISPLAY_DECIMALS,
  formatDusk,
  formatFee,
  formatLuxToDusk,
  groupThousands,
  parseDuskToLux,
  safeBigInt,
} from "../../../shared/amount.js";
import { TX_KIND } from "../../../shared/constants.js";
import { getDefaultGas } from "../../../shared/txDefaults.js";
import { openUrl } from "../../../platform/index.js";
import { h } from "../../lib/dom.js";
import { shortAddress } from "../../lib/strings.js";
import { subnav } from "../../components/Subnav.js";
import "../../components/GasEditor.js";
import { iconSvg } from "../../components/ActionIcon.js";
import { amountField } from "../../components/AmountField.js";
import { bracketTitle } from "../../components/BracketTitle.js";
import { HIDDEN_BALANCE, balance, balancesHidden } from "../../components/Balance.js";
import { fieldLabel, submitOnGasEnter } from "../../components/FormControls.js";
import { createGasQuickControls } from "../../components/GasQuickControls.js";
import { sozuLiquidStakingView } from "./sozu.js";
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

// How native staking works: what a node is, and how the stake ties to it.
const DOCS_STAKING_URL = "https://docs.dusk.network/learn/guides/staking-basics/";

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

function fundingLabel(payment) {
  return String(payment ?? FUNDING_PUBLIC) === FUNDING_SHIELDED
    ? "Shielded balance"
    : "Public balance";
}

function fmtLux(luxStr) {
  return formatDusk(luxStr, UI_DISPLAY_DECIMALS);
}

function profileLabel(index) {
  return `Profile ${Number(index ?? 0) + 1}`;
}

function positionKey(pos) {
  return `stake:${Number(pos?.stakeProfileIndex ?? pos?.profileIndex ?? 0)}`;
}

function defaultFeeLux(kind, payment = FUNDING_PUBLIC) {
  const gas = getDefaultGas(kind, {
    privacy: payment === FUNDING_SHIELDED ? "shielded" : "public",
  });
  return safeBigInt(gas?.limit, 0n) * safeBigInt(gas?.price, 1n);
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
  const stale = !st.loaded || st.profileIndex !== idx;
  if (!stale || st.loading) return st;

  st.loading = true;
  st.error = null;

  Promise.all([
    actions?.send?.({ type: "DUSK_UI_GET_MINIMUM_STAKE", profileIndex: idx }),
    actions?.send?.({ type: "DUSK_UI_GET_STAKE_OWNER_STATUS", profileIndex: idx }),
  ])
    .then(([minResp, ownerResp]) => {
      if (minResp?.error) throw new Error(minResp.error.message ?? "Failed to load minimum stake");
      if (ownerResp?.error) throw new Error(ownerResp.error.message ?? "Failed to load stake owner");

      st.minimumStakeLux = String(minResp?.result ?? minResp ?? "");
      st.ownerStatus = ownerResp?.result ?? ownerResp ?? null;
      st.ownerProfileIndex = st.ownerStatus?.ownerProfileIndex ?? st.ownerProfileIndex ?? idx;
      st.profileIndex = idx;
      st.loaded = true;
      st.loading = false;
      st.updatedAt = Date.now();
      actions?.render?.().catch(() => {});
    })
    .catch((e) => {
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
function actionState(pos, actionKind, amountLux, minLux, { hidden = false } = {}) {
  const kind = actionToKind(actionKind);
  const { publicLux } = fundingOptionsForPosition(pos);
  const feeLux = defaultFeeLux(kind, FUNDING_PUBLIC);
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
    const ownerText =
      pos?.ownerProfileIndex !== undefined &&
      Number(pos.ownerProfileIndex) !== Number(pos.stakeProfileIndex)
        ? ` ${profileLabel(pos.ownerProfileIndex)} owns this stake. Gas still comes from ${profileLabel(pos.stakeProfileIndex)}.`
        : "";
    return {
      ok: false,
      reason: `Add gas funds to ${profileLabel(pos.stakeProfileIndex)} before managing this stake.${ownerText}`,
    };
  }
  if (actionKind === ACTION_TOPUP && amountLux !== null && amountLux !== undefined) {
    if (safeBigInt(amountLux, 0n) <= 0n) {
      return { ok: false, reason: "Enter an amount greater than 0." };
    }
    if (!pos.hasStake && minLux > 0n && safeBigInt(amountLux, 0n) < minLux) {
      return { ok: false, reason: `The minimum stake is ${fmtLux(minLux)} DUSK.` };
    }
    if (publicLux < requiredLux) {
      return {
        ok: false,
        reason: `That's ${hidden ? HIDDEN_BALANCE : fmtLux(requiredLux - publicLux)} DUSK more than the public balance, with the network fee.`,
      };
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
  return { st, selectedIndex, minLux, positions, pos, hidden: balancesHidden(ov) };
}

// Where Review's draft comes from: the action, its amount and the profiles.
function makeDraft(pos, st, { state, actions, actionKind, amountLux = null, amountMode = "all" }) {
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

function statusLine(st) {
  if (st?.loading && !st?.loaded) return h("div", { class: "muted", text: "Loading staking…" });
  if (st?.error) return h("div", { class: "err", text: String(st.error) });
  return null;
}

/**
 * Staking: the overview, the native amount screen or liquid staking,
 * whichever `state.staking.screen` holds.
 */
export function stakeFormView(ov, { state, actions } = {}) {
  const ctx = stakingContext(ov, { state, actions });
  const screen = ctx.st.screen ?? SCREEN_OVERVIEW;
  if (screen === SCREEN_NATIVE && ctx.pos) return nativeStakeView(ov, ctx, { state, actions });
  if (screen === SCREEN_LIQUID) {
    return sozuLiquidStakingView(ov, { state, actions, onBack: () => setScreen(ctx.st, SCREEN_OVERVIEW, actions) });
  }
  return stakingOverview(ov, ctx, { state, actions });
}

function stakingOverview(ov, ctx, { state, actions }) {
  const { st, minLux, positions, pos, hidden } = ctx;
  const onBack = () => {
    state.route = "home";
    actions?.render?.().catch(() => {});
  };
  if (!pos) {
    return [subnav({ title: "Staking", onBack }), statusLine(st) ?? h("div", { class: "muted", text: "Loading staking…" })];
  }

  const stakedLux = safeBigInt(pos.info?.amount?.total ?? 0, 0n);
  const lockedLux = safeBigInt(pos.info?.amount?.locked ?? 0, 0n);
  const rewardLux = safeBigInt(pos.info?.reward ?? 0, 0n);
  const unstakeState = actionState(pos, ACTION_UNSTAKE, null, minLux);
  const claimState = actionState(pos, ACTION_CLAIM, null, minLux);
  const { publicLux } = fundingOptionsForPosition(pos);
  const several = positions.length > 1;

  // The reasons Unstake and Claim can't be pressed, said once each.
  const reasons = [...new Set([unstakeState, claimState].filter((s) => !s.ok).map((s) => s.reason))];

  const summary = h("div", { class: "group stake-sum" }, [
    several
      ? h("div", { class: "stake-account" }, [
          `${profileLabel(pos.stakeProfileIndex)} · `,
          h("span", { class: "mono", title: pos.stakeAccount, text: shortAddress(pos.stakeAccount) }),
        ])
      : null,
    h("div", { class: "stake-sum__two" }, [
      h("div", {}, [h("div", { class: "stake-lbl", text: "Staked" }), h("div", { class: "stake-big" }, amountParts(hidden, stakedLux))]),
      h("div", {}, [h("div", { class: "stake-lbl", text: "Rewards" }), h("div", { class: "stake-big" }, amountParts(hidden, rewardLux))]),
    ]),
    lockedLux > 0n
      ? h("div", { class: "stake-cap" }, [
          "Locked: ",
          ...amountParts(hidden, lockedLux),
          ". It's still yours, and unstaking returns it.",
        ])
      : null,
    h("div", { class: "stake-pair" }, [
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
    ]),
    ...reasons.map((reason) => h("div", { class: "stake-cap", text: reason })),
  ].filter(Boolean));

  // Two equal choices; neither is picked for you.
  const choices = h("div", { class: "group stake-choices" }, [
    listRow({
      icon: "server",
      title: "Native staking",
      subs: pos.hasStake
        ? ["Add to your stake", "Needs your own Dusk node"]
        : [`Minimum ${fmtLux(minLux)} DUSK`, "Needs your own Dusk node"],
      onClick: () => setScreen(st, SCREEN_NATIVE, actions),
    }),
    listRow({
      icon: "drop",
      title: ["Liquid staking", h("span", { class: "tag", text: "Sozu · third party" })],
      subs: ["Any amount · No node needed", "You get stDUSK for your share"],
      onClick: () => setScreen(st, SCREEN_LIQUID, actions),
    }),
  ]);

  const available = h("div", { class: "stake-avail" }, [
    balance(hidden, fmtLux(publicLux)),
    " DUSK available to stake, from your public balance",
  ]);

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
        kvRow("Owner", ownerLabel(pos)),
        kvRow("Stake account", [
          `${profileLabel(pos.stakeProfileIndex)} · `,
          h("span", { class: "mono", title: pos.stakeAccount, text: shortAddress(pos.stakeAccount) }),
        ]),
        pos.hasStake
          ? kvRow(
              "Active from",
              safeBigInt(pos.info?.amount?.eligibility ?? 0, 0n) > 0n
                ? `Block ${groupThousands(safeBigInt(pos.info.amount.eligibility, 0n).toString())}`
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
    h("div", { class: "section-head" }, [bracketTitle({ text: "Choose how to stake" })]),
    choices,
    available,
    advanced,
  ].filter(Boolean);
}

function nativeStakeView(ov, ctx, { state, actions }) {
  const { st, minLux, pos, hidden } = ctx;
  const back = () => setScreen(st, SCREEN_OVERVIEW, actions);
  const kind = TX_KIND.STAKE;
  const feeLux = defaultFeeLux(kind, FUNDING_PUBLIC);
  const { publicLux } = fundingOptionsForPosition(pos);
  const maxTopupLux = publicLux > feeLux ? publicLux - feeLux : 0n;
  const isNew = !pos.hasStake;
  const stakeProfileIndex = Number(pos.stakeProfileIndex) || 0;
  const ownerProfileIndex = pos.hasStake
    ? Number(pos.ownerProfileIndex ?? stakeProfileIndex) || 0
    : Number(st.ownerProfileIndex ?? stakeProfileIndex) || 0;

  // What stops any amount: no gas, a stake this wallet can't manage.
  const blocked = actionState(pos, ACTION_TOPUP, null, minLux);

  const field = amountField({
    label: isNew ? "Stake amount" : "Amount to add",
    value: st.stakeAmountDusk ?? "",
    disabled: !blocked.ok,
    onInput: () => {
      st.amountMode = "custom";
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

  // The amount as typed, checked as it is typed: the minimum and the balance
  // say so under the field, and Review can't be pressed until it is right.
  function check() {
    const raw = String(field.input.value ?? "").trim();
    st.stakeAmountDusk = raw;
    if (!blocked.ok) {
      field.setError(blocked.reason);
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
      field.setError("Enter an amount such as 1000 or 1000.5.");
      reviewBtn.disabled = true;
      return null;
    }
    const result = actionState(pos, ACTION_TOPUP, lux, minLux, { hidden });
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
    });
    st.amountMode = "custom";
  }

  const fill = (lux, mode) => {
    field.setValue(formatLuxToDusk(lux));
    st.amountMode = mode;
    check();
    field.input.focus();
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
    title: "All of it, less the network fee",
    disabled: !blocked.ok || maxTopupLux <= 0n,
    onclick: () => fill(maxTopupLux, "max"),
  });

  const available = h("div", { class: "amount-avail" }, [
    h("span", {}, ["Available ", balance(hidden, fmtLux(publicLux)), " DUSK from your public balance"]),
    useMin,
    maxBtn,
  ].filter(Boolean));

  const nodeLink = h("button", {
    class: "text-btn text-btn--inline",
    type: "button",
    text: "How native staking works",
    onclick: async () => {
      const ok = await openUrl(DOCS_STAKING_URL);
      if (!ok) actions?.showToast?.("Couldn't open the docs");
    },
  });

  // The facts from Dusk's staking docs, in a few lines.
  const facts = h("div", { class: "group info" }, [
    // The stake is the stake account's: the node signs with its consensus key.
    infoRow("server", "Needs your own Dusk node", [
      `A computer that runs Dusk's node software and stays online, with ${profileLabel(stakeProfileIndex)}'s consensus key from this recovery phrase. `,
      nodeLink,
    ]),
    infoRow("clock", "Rewards start in about 6 to 12 hours", "Unstake any time, with no waiting period."),
    isNew
      ? null
      : infoRow(
          "lock",
          "10% of what you add is locked",
          "When your stake is already active. It's still yours, and unstaking returns it."
        ),
    infoRow(
      "alert",
      "If your node misses its turn",
      "Part of your stake gets locked. It's still yours, and unstaking returns it. If the node breaks the rules, part of the stake can be burned (lost)."
    ),
    infoRow("fee", `Network fee up to ${formatFee(feeLux)} DUSK`, null),
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
        : h("div", { class: "group group--inset" }, [kvRow("Owner", ownerLabel(pos, ownerProfileIndex))]),
      h("div", { class: "group group--inset" }, [
        kvRow("Stake account", [
          `${profileLabel(stakeProfileIndex)} · `,
          h("span", { class: "mono", title: pos.stakeAccount, text: shortAddress(pos.stakeAccount) }),
        ]),
      ]),
    ]);

  // Under the minimum, the way that takes any amount, named as a third party.
  const liquidLink = isNew
    ? h("button", {
        class: "text-btn stake-liquid-link",
        type: "button",
        text: `Less than ${fmtLux(minLux)} DUSK? Use liquid staking (Sozu, third party)`,
        onclick: () => setScreen(st, SCREEN_LIQUID, actions),
      })
    : null;

  // An amount brought back from Review, or a blocked stake, says so at once.
  if (st.stakeAmountDusk || !blocked.ok) check();

  return [
    subnav({ title: isNew ? "Native staking" : "Stake more", onBack: back }),
    statusLine(st),
    h("div", { class: "amount-entry" }, [field.el, field.error, available]),
    facts,
    advanced,
    h("div", { class: "stake-bottom" }, [reviewBtn, liquidLink].filter(Boolean)),
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

  const confirmBtn = h("button", { class: "btn-primary", text: "Confirm" });

  const defaultGas = getDefaultGas(kind, {
    privacy: d.payment === FUNDING_SHIELDED ? "shielded" : "public",
  });
  const defaultLimit =
    defaultGas?.limit !== undefined && defaultGas?.limit !== null ? String(defaultGas.limit) : "";
  const fallbackPrice =
    defaultGas?.price !== undefined && defaultGas?.price !== null ? String(defaultGas.price) : "";

  const gasEditor = document.createElement("dusk-gas-editor");
  gasEditor.maxDecimals = UI_DISPLAY_DECIMALS;
  gasEditor.amountLux = kind === TX_KIND.STAKE ? String(d.amountLux ?? "0") : "0";
  gasEditor.setGas(d?.gas ?? null);

  // The gas price line and the presets open with the fee's Edit.
  createGasQuickControls({
    actions,
    defaultLimit,
    fallbackPrice,
    gas: d?.gas,
    gasEditor,
  });

  // What moves: the amount staked, or all of the stake or the rewards. The
  // stake and the rewards are balances, hidden with Hide balances; an amount
  // typed in for a stake shows, as on every Review.
  const shownLux = kind === TX_KIND.STAKE ? d.amountLux : d.amountLux || d.displayLux;
  const allText = kind === TX_KIND.UNSTAKE ? "All stake" : kind === TX_KIND.WITHDRAW_REWARD ? "All rewards" : "—";
  const hideAmount = kind !== TX_KIND.STAKE && balancesHidden(ov);
  const amountLine = () =>
    shownLux && safeBigInt(shownLux, 0n) > 0n ? [balance(hideAmount, fmtLux(shownLux)), " DUSK"] : [allText];

  const line =
    kind === TX_KIND.STAKE ? "Native staking" : kind === TX_KIND.UNSTAKE ? "Back to your public balance" : "To your public balance";

  // Gas that won't do says so above Confirm; nothing is sent.
  const confirmError = h("div", { class: "field-error", role: "alert", hidden: true });

  confirmBtn.addEventListener("click", async () => {
    let gas;
    try {
      gas = gasEditor.readFinalGas();
    } catch (e) {
      confirmError.textContent = e?.message ?? String(e);
      confirmError.hidden = false;
      return;
    }
    confirmError.hidden = true;
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
    confirmBtn.disabled = false;
  });
  submitOnGasEnter(gasEditor, confirmBtn);

  const severalProfiles = Number(d.ownerProfileIndex) !== Number(d.stakeProfileIndex ?? d.profileIndex);

  return [
    subnav({ title: "Review", onBack: goBack }),
    h("div", { class: "row" }, [
      h("div", { class: "review-head" }, [
        h("div", { class: "review-kind", text: kindLabel }),
        h("div", { class: "balance-amount" }, amountLine()),
        h("div", { class: "review-line", text: line }),
      ]),
      h("div", { class: "group" }, [
        kvRow("Stake account", d.stakeProfileLabel ?? profileLabel(d.stakeProfileIndex ?? d.profileIndex)),
        kvRow("Owner", d.ownerProfileLabel ?? profileLabel(d.ownerProfileIndex)),
        kvRow("Fee paid from", d.fundingLabel ?? fundingLabel(d.payment)),
        kind === TX_KIND.STAKE && !severalProfiles && !d.hasStake ? kvRow("Rewards start", "In about 6 to 12 hours") : null,
      ].filter(Boolean)),
      gasEditor,
      confirmError,
      h("div", { class: "btnrow" }, [confirmBtn]),
    ]),
  ];
}
