import {
  UI_DISPLAY_DECIMALS,
  formatLuxShort,
  formatLuxToDusk,
  parseDuskToLux,
  safeBigInt,
} from "../../../shared/amount.js";
import { TX_KIND } from "../../../shared/constants.js";
import { getDefaultGas } from "../../../shared/txDefaults.js";
import { h } from "../../lib/dom.js";
import { subnav } from "../../components/Subnav.js";
import "../../components/GasEditor.js";
import { sozuLiquidStakingView } from "./sozu.js";

const FUNDING_PUBLIC = "account";
const FUNDING_SHIELDED = "address";
const ACTION_TOPUP = "topup";
const ACTION_UNSTAKE = "unstake";
const ACTION_CLAIM = "claim";

function stakeKindLabel(kind, { hasStake = true } = {}) {
  const k = String(kind ?? "").toLowerCase();
  if (k === TX_KIND.STAKE) return hasStake ? "Add stake" : "Stake";
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
  return formatLuxShort(luxStr, UI_DISPLAY_DECIMALS);
}

function fmtLuxFull(luxStr) {
  return formatLuxToDusk(luxStr);
}

function shortAccount(account) {
  const s = String(account ?? "");
  return s.length > 20 ? `${s.slice(0, 10)}…${s.slice(-8)}` : s;
}

function fmtEligibility(value) {
  const n = safeBigInt(value ?? 0, 0n);
  if (n <= 0n) return "Eligible now";
  return `Block ${n.toString()}`;
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

function stakeMetricRows(info, { emptyStake = "—" } = {}) {
  const hasStake = Boolean(info?.amount);
  const stakeTotalLux = safeBigInt(info?.amount?.total ?? 0, 0n);
  const stakeLockedLux = safeBigInt(info?.amount?.locked ?? 0, 0n);
  const stakeElig = safeBigInt(info?.amount?.eligibility ?? 0, 0n);
  const rewardLux = safeBigInt(info?.reward ?? 0, 0n);

  return [
    h("div", { class: "hrow" }, [
      h("div", { class: "muted", text: "Staked" }),
      h("code", {
        text: hasStake ? `${fmtLux(stakeTotalLux)} DUSK` : emptyStake,
        title: hasStake ? `Lux: ${stakeTotalLux.toString()}` : "",
      }),
    ]),
    hasStake
      ? h("div", { class: "hrow" }, [
          h("div", { class: "muted", text: "Locked" }),
          h("code", {
            text: `${fmtLux(stakeLockedLux)} DUSK`,
            title: `Lux: ${stakeLockedLux.toString()}`,
          }),
        ])
      : null,
    hasStake
      ? h("div", { class: "hrow" }, [
          h("div", { class: "muted", text: "Eligibility" }),
          h("code", {
            text: fmtEligibility(stakeElig),
            title: `Stake contract eligibility value: ${stakeElig.toString()}`,
          }),
        ])
      : null,
    h("div", { class: "hrow" }, [
      h("div", { class: "muted", text: "Rewards" }),
      h("code", {
        text: `${fmtLux(rewardLux)} DUSK`,
        title: `Lux: ${rewardLux.toString()}`,
      }),
    ]),
    hasStake
      ? h("div", { class: "hrow" }, [
          h("div", { class: "muted", text: "Faults" }),
          h("code", {
            text: `${Number(info?.faults ?? 0) || 0} / ${
              Number(info?.hardFaults ?? 0) || 0
            }`,
          }),
        ])
      : null,
  ].filter(Boolean);
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

function actionState(pos, actionKind, amountLux, minLux) {
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
    return { ok: false, reason: "There is no stake to manage yet." };
  }
  if (actionKind === ACTION_CLAIM && rewardLux <= 0n) {
    return { ok: false, reason: "No rewards to claim." };
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
      return { ok: false, reason: `Minimum stake is ${fmtLux(minLux)} DUSK.` };
    }
    if (publicLux < requiredLux) {
      return {
        ok: false,
        reason: `${profileLabel(pos.stakeProfileIndex)} public balance is short by ${fmtLux(requiredLux - publicLux)} DUSK including the estimated fee.`,
      };
    }
  }
  return { ok: true, reason: "" };
}

export function stakeFormView(ov, { state, actions } = {}) {
  const st = ensureStakeLoaded(ov, { state, actions });
  const selectedIndex = Number(ov?.selectedAccountIndex ?? 0) || 0;
  const ownerStatus = st?.ownerStatus ?? null;
  const minLux = st?.minimumStakeLux != null ? safeBigInt(st.minimumStakeLux, 0n) : 0n;
  const positions = buildPositions(ownerStatus, selectedIndex);

  if (!st.activePositionKey || !positions.some((pos) => positionKey(pos) === st.activePositionKey)) {
    st.activePositionKey = positionKey(positions.find((pos) => pos.hasStake) ?? positions[0] ?? {
      stakeProfileIndex: selectedIndex,
    });
  }
  const activePosition =
    positions.find((pos) => positionKey(pos) === st.activePositionKey) ?? positions[0] ?? null;

  const onBack = () => {
    state.route = "home";
    actions?.render?.().catch(() => {});
  };

  const selectAction = (pos, actionKind) => {
    st.activePositionKey = positionKey(pos);
    st.actionKind = actionKind;
    actions?.render?.().catch(() => {});
  };

  const positionCard = (pos) => {
    const selected = activePosition && positionKey(pos) === positionKey(activePosition);
    const stakeProfile = Number(pos.stakeProfileIndex) || 0;
    const ownerProfile = pos.ownerProfileIndex;
    const rewardLux = safeBigInt(pos?.info?.reward ?? 0, 0n);
    const topupState = actionState(pos, ACTION_TOPUP, null, minLux);
    const manageState = actionState(pos, ACTION_UNSTAKE, null, minLux);
    const claimState = actionState(pos, ACTION_CLAIM, null, minLux);

    return h("div", { class: selected ? "box is-selected" : "box" }, [
      h("div", { class: "hrow" }, [
        h("div", { class: "muted", text: "Stake account" }),
        h("code", { text: `${profileLabel(stakeProfile)} · ${shortAccount(pos.stakeAccount)}` }),
      ]),
      h("div", { class: "hrow" }, [
        h("div", { class: "muted", text: "Owner" }),
        h("code", {
          text:
            ownerProfile !== undefined && ownerProfile !== null
              ? profileLabel(ownerProfile)
              : pos.ownerKind === "contract"
              ? "Contract"
              : "Unavailable",
        }),
      ]),
      h("div", { class: pos.manageable === false ? "err" : "muted", text: ownerCopy(pos) }),
      ...stakeMetricRows(pos.info),
      h("div", { class: "hrow" }, [
        h("div", { class: "muted", text: "Gas payer" }),
        h("code", {
          text: `${profileLabel(stakeProfile)} public · ${fmtLux(fundingOptionsForPosition(pos).publicLux)} DUSK`,
        }),
      ]),
      h("div", { class: "btnrow" }, [
        h("button", {
          class: "btn-outline",
          text: pos.hasStake ? "Add stake" : "Create stake",
          disabled: pos.manageable === false || !topupState.ok,
          title: topupState.reason,
          onclick: () => selectAction(pos, ACTION_TOPUP),
        }),
        h("button", {
          class: "btn-outline",
          text: "Unstake",
          disabled: !pos.hasStake || pos.manageable === false || !manageState.ok,
          title: manageState.reason,
          onclick: () => selectAction(pos, ACTION_UNSTAKE),
        }),
        h("button", {
          class: "btn-outline",
          text: "Claim",
          disabled: rewardLux <= 0n || pos.manageable === false || !claimState.ok,
          title: claimState.reason,
          onclick: () => selectAction(pos, ACTION_CLAIM),
        }),
      ]),
      !selected && (!topupState.ok || !manageState.ok || !claimState.ok)
        ? h("div", {
            class: "muted",
            text: topupState.reason || manageState.reason || claimState.reason,
          })
        : null,
    ].filter(Boolean));
  };

  const actionPanel = activePosition
    ? actionEditor(activePosition, st, { state, actions, minLux })
    : null;

  const statusLine = st?.loading
    ? h("div", { class: "muted", text: "Loading staking info…" })
    : st?.error
    ? h("div", { class: "err", text: String(st.error) })
    : null;

  return [
    subnav({ title: "Staking", onBack }),
    h("div", { class: "row" }, [
      statusLine,
      h("div", { class: "muted", text: "Stake positions" }),
      positions.length
        ? h("div", { class: "row" }, positions.map(positionCard))
        : h("div", { class: "box muted", text: "No local stake positions found." }),
      actionPanel,
      sozuLiquidStakingView(ov, { state, actions }),
    ].filter(Boolean)),
  ];
}

function actionEditor(pos, st, { state, actions, minLux }) {
  const actionKind = st.actionKind || ACTION_TOPUP;
  const kind = actionToKind(actionKind);
  const stakeProfileIndex = Number(pos.stakeProfileIndex) || 0;
  const ownerProfileIndex =
    pos.hasStake && pos.ownerProfileIndex !== undefined && pos.ownerProfileIndex !== null
      ? Number(pos.ownerProfileIndex)
      : Number(st.ownerProfileIndex ?? stakeProfileIndex) || 0;
  const feeLux = defaultFeeLux(kind, FUNDING_PUBLIC);
  const publicLux = fundingOptionsForPosition(pos).publicLux;
  const rewardLux = safeBigInt(pos?.info?.reward ?? 0, 0n);
  const stakeTotalLux = safeBigInt(pos?.info?.amount?.total ?? 0, 0n);
  const canUseShielded = false;
  const usesAmountInput = actionKind === ACTION_TOPUP;

  const amountValue = usesAmountInput ? st.stakeAmountDusk : "";

  const setAmountValue = (value) => {
    st.stakeAmountDusk = value;
  };

  const currentAmountValue = () => {
    return st.stakeAmountDusk;
  };

  const parseAmount = () => {
    const raw = String(currentAmountValue() ?? "").trim();
    if (!raw) return 0n;
    return safeBigInt(parseDuskToLux(raw), 0n);
  };

  const currentState = actionState(pos, actionKind, null, minLux);

  const maxTopupLux = publicLux > feeLux ? publicLux - feeLux : 0n;
  const setMaxTopup = () => {
    if (maxTopupLux <= 0n) {
      actions?.showToast?.("No spendable public balance after the estimated fee.", 3000);
      return;
    }
    st.amountMode = "max";
    setAmountValue(fmtLuxFull(maxTopupLux));
    actions?.render?.().catch(() => {});
  };

  const makeDraft = (amountLuxOrNull, amountMode) => {
    state.stakeDraft = {
      kind,
      stakeProfileIndex,
      profileIndex: stakeProfileIndex,
      ownerProfileIndex,
      amountLux: amountLuxOrNull,
      amountMode,
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
  };

  const reviewAmount = () => {
    try {
      const lux = parseAmount();
      if (lux <= 0n) throw new Error("Amount must be > 0");
      const check = actionState(pos, actionKind, lux, minLux);
      if (!check.ok) throw new Error(check.reason);
      makeDraft(lux.toString(), st.amountMode === "max" ? "max" : "custom");
      st.amountMode = "custom";
    } catch (e) {
      actions?.showToast?.(e?.message ?? String(e), 3000);
    }
  };

  const amountLabel =
    actionKind === ACTION_UNSTAKE
      ? "Unstake amount"
      : actionKind === ACTION_CLAIM
      ? "Reward amount"
      : pos.hasStake
      ? "Add stake amount"
      : "Stake amount";

  const actionLabel = stakeKindLabel(kind, { hasStake: pos.hasStake });
  const input = h("input", {
    id: "stake-action-amount",
    name: "stakeActionAmount",
    placeholder: `${amountLabel} (DUSK)`,
    value: String(amountValue ?? ""),
    oninput: (e) => {
      st.amountMode = "custom";
      setAmountValue(String(e?.target?.value ?? ""));
    },
  });

  const actionTabs = h("div", { class: "btnrow" }, [
    h("button", {
      class: actionKind === ACTION_TOPUP ? "btn-primary" : "btn-outline",
      text: pos.hasStake ? "Add stake" : "Create",
      onclick: () => {
        st.actionKind = ACTION_TOPUP;
        actions?.render?.().catch(() => {});
      },
    }),
    h("button", {
      class: actionKind === ACTION_UNSTAKE ? "btn-primary" : "btn-outline",
      text: "Unstake",
      disabled: !pos.hasStake,
      onclick: () => {
        st.actionKind = ACTION_UNSTAKE;
        actions?.render?.().catch(() => {});
      },
    }),
    h("button", {
      class: actionKind === ACTION_CLAIM ? "btn-primary" : "btn-outline",
      text: "Claim",
      disabled: !pos.hasStake || rewardLux <= 0n,
      onclick: () => {
        st.actionKind = ACTION_CLAIM;
        actions?.render?.().catch(() => {});
      },
    }),
  ]);

  const maxButton =
    usesAmountInput
      ? h("button", {
          class: "btn-outline",
          text: "Max",
          title: "Max leaves room for the estimated fee.",
          disabled: maxTopupLux <= 0n,
          onclick: setMaxTopup,
        })
      : null;

  const reviewButton = h("button", {
    class: "btn-primary",
    text: `Review ${actionLabel.toLowerCase()}`,
    disabled: !currentState.ok,
    onclick: usesAmountInput ? reviewAmount : () => makeDraft(null, "all"),
  });
  const ownerControl = pos.hasStake
    ? h("code", { text: profileLabel(ownerProfileIndex) })
    : h("select", {
        id: "stake-owner-profile",
        name: "stakeOwnerProfile",
        value: String(ownerProfileIndex),
        onchange: (e) => {
          st.ownerProfileIndex = Number(e?.target?.value ?? stakeProfileIndex) || 0;
          actions?.render?.().catch(() => {});
        },
      }, (pos.profiles?.length ? pos.profiles : [{ profileIndex: stakeProfileIndex }]).map((p) => {
        const idx = Number(p.profileIndex ?? 0) || 0;
        return h("option", {
          value: String(idx),
          text: idx === stakeProfileIndex ? `${profileLabel(idx)} (self-owned)` : profileLabel(idx),
        });
      }));

  return h("div", { class: "box" }, [
    h("div", { class: "muted", text: "Manage position" }),
    h("div", { class: "hrow" }, [
      h("div", { class: "muted", text: "Stake account" }),
      h("code", { text: `${profileLabel(stakeProfileIndex)} · ${shortAccount(pos.stakeAccount)}` }),
    ]),
    h("div", { class: "hrow" }, [
      h("div", { class: "muted", text: "Owner" }),
      ownerControl,
    ]),
    !pos.hasStake
      ? h("div", {
          class: "muted",
          text: "New stakes are self-owned by default. Select another local owner only for owner-separated provisioner setups.",
        })
      : null,
    actionTabs,
    h("div", { class: "hrow" }, [
      h("div", { class: "muted", text: "Funding source" }),
      h("code", { text: `${profileLabel(stakeProfileIndex)} public balance` }),
    ]),
    h("div", {
      class: "muted",
      text: canUseShielded
        ? "Shielded funding is available from the stake profile."
        : "Shielded staking funds are not available here.",
    }),
    h("div", {
      class: currentState.ok ? "muted" : "err",
      text: currentState.reason ||
        `Gas is paid by ${profileLabel(stakeProfileIndex)}. Owner-paid gas is not available here.`,
    }),
    usesAmountInput ? h("label", { for: "stake-action-amount", text: amountLabel }) : null,
    usesAmountInput ? input : null,
    !usesAmountInput
      ? h("div", { class: "hrow" }, [
          h("div", { class: "muted", text: "Amount" }),
          h("code", {
            text:
              actionKind === ACTION_UNSTAKE
                ? `Full stake · ${fmtLux(stakeTotalLux)} DUSK`
                : `All rewards · ${fmtLux(rewardLux)} DUSK`,
          }),
        ])
      : null,
    h("div", { class: "btnrow" }, [maxButton, reviewButton].filter(Boolean)),
    actionKind === ACTION_TOPUP && maxTopupLux > 0n
      ? h("div", {
          class: "muted",
          text: `Max leaves room for the estimated fee: ${fmtLux(maxTopupLux)} DUSK.`,
        })
      : null,
  ].filter(Boolean));
}

export function stakeConfirmView(ov, { state, actions } = {}) {
  const d = state.stakeDraft;
  if (!d) {
    state.route = "stake";
    return stakeFormView(ov, { state, actions });
  }

  const kind = String(d.kind ?? "").toLowerCase();
  const kindLabel = stakeKindLabel(kind);
  const goBack = () => {
    state.route = "stake";
    actions?.render?.().catch(() => {});
  };

  const cancelBtn = h("button", {
    class: "btn-outline",
    text: "Cancel",
    onclick: goBack,
  });
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
  gasEditor.helpText = "Max fee shown is limit × price. Clear both to use wallet defaults.";
  gasEditor.amountLux = kind === TX_KIND.STAKE ? String(d.amountLux ?? "0") : "0";
  gasEditor.setGas(d?.gas ?? null);

  const gasHint = h("div", { class: "muted", text: "Loading gas price suggestion…" });
  (async () => {
    try {
      if (d?.gas) {
        gasHint.textContent = defaultLimit && fallbackPrice
          ? `Default gas: ${defaultLimit} limit · ${fallbackPrice} price (LUX)`
          : "Gas is set.";
        return;
      }
      const resp = await actions?.send?.({ type: "DUSK_UI_GET_CACHED_GAS_PRICE" });
      if (resp?.error) throw new Error(resp.error.message ?? "Failed to fetch gas price");
      const stats = resp?.result ?? resp;
      const median = String(stats?.median ?? stats?.average ?? "1");
      gasHint.textContent = `Gas price suggestion (LUX): median ${median}`;
      if (defaultLimit) gasEditor.setGas({ limit: defaultLimit, price: median });
      else if (fallbackPrice) gasEditor.setGas({ limit: defaultLimit, price: fallbackPrice });
    } catch {
      gasHint.textContent = "Gas price unavailable (using defaults).";
      if (defaultLimit && fallbackPrice) {
        gasEditor.setGas({ limit: defaultLimit, price: fallbackPrice });
      }
    }
  })().catch(() => {});

  const amountLine = () => {
    if (kind === TX_KIND.UNSTAKE) {
      if (!d.amountLux) return "All stake";
      return `${fmtLux(d.amountLux)} DUSK`;
    }
    if (kind === TX_KIND.WITHDRAW_REWARD) {
      if (!d.amountLux) return "All rewards";
      return `${fmtLux(d.amountLux)} DUSK`;
    }
    return d.amountLux ? `${fmtLux(d.amountLux)} DUSK` : "—";
  };

  confirmBtn.addEventListener("click", async () => {
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Sending…";

    try {
      const gas = gasEditor.readFinalGas();
      state.stakeDraft.gas = gas;
      const params = {
        kind,
        profileIndex: d.stakeProfileIndex ?? d.profileIndex,
        ...(d.amountLux ? { amount: d.amountLux } : {}),
        ownerProfileIndex: d.ownerProfileIndex,
        payment: d.payment || FUNDING_PUBLIC,
        gas: gas || undefined,
      };

      const res = await actions?.send?.({ type: "DUSK_UI_SEND_TX", params });
      if (res?.error) throw new Error(res.error.message ?? "Transaction failed");
      if (!res?.ok) throw new Error("Transaction failed");

      const hash = res.result?.hash ?? "";
      const sh = hash && hash.length > 18 ? `${hash.slice(0, 10)}…${hash.slice(-8)}` : hash;
      actions?.showToast?.(sh ? `Transaction submitted: ${sh}` : "Transaction submitted", 2500);

      try {
        if (state.staking) state.staking.loaded = false;
      } catch {
        // ignore
      }

      state.stakeDraft = null;
      state.highlightTx = hash || null;
      state.route = "activity";
      state.needsRefresh = true;
      await actions?.render?.({ forceRefresh: true });
    } catch (e) {
      actions?.showToast?.(e?.message ?? String(e), 3000);
      confirmBtn.disabled = false;
      confirmBtn.textContent = "Confirm";
    }
  });

  return [
    subnav({ title: "Review", onBack: goBack }),
    h("div", { class: "row" }, [
      h("div", { class: "muted", text: `You are about to ${kindLabel.toLowerCase()}` }),
      h("div", { class: "box tx-summary" }, [
        h("div", { class: "muted", text: kindLabel }),
        h("div", { class: "balance-amount", text: amountLine() }),
        h("div", { class: "muted", text: `Stake account ${d.stakeProfileLabel ?? profileLabel(d.stakeProfileIndex ?? d.profileIndex)}` }),
        h("div", { class: "muted", text: `Owner ${d.ownerProfileLabel ?? profileLabel(d.ownerProfileIndex)}` }),
        h("div", { class: "muted", text: `Gas paid by ${d.fundingLabel ?? fundingLabel(d.payment)}` }),
        d.amountMode === "max" ? h("div", { class: "muted", text: "Max leaves room for the estimated fee." }) : null,
        d.amountMode === "all" && kind === TX_KIND.UNSTAKE
          ? h("div", { class: "muted", text: "Unstake the full position." })
          : null,
        d.amountMode === "all" && kind === TX_KIND.WITHDRAW_REWARD
          ? h("div", { class: "muted", text: "Claim all rewards." })
          : null,
        d.amountLux ? h("div", { class: "muted", text: `Lux: ${String(d.amountLux)}` }) : null,
      ].filter(Boolean)),
      gasEditor,
      gasHint,
      h("div", { class: "btnrow" }, [cancelBtn, confirmBtn]),
    ]),
  ];
}
