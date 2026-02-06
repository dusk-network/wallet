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

function stakeKindLabel(kind) {
  const k = String(kind ?? "").toLowerCase();
  if (k === TX_KIND.STAKE) return "Stake";
  if (k === TX_KIND.UNSTAKE) return "Unstake";
  if (k === TX_KIND.WITHDRAW_REWARD) return "Withdraw rewards";
  return "Staking";
}

function fmtLux(luxStr) {
  return formatLuxShort(luxStr, UI_DISPLAY_DECIMALS);
}

function fmtLuxFull(luxStr) {
  return formatLuxToDusk(luxStr);
}

function ensureStakeLoaded(ov, { state, actions } = {}) {
  const st = (state.staking ??= {
    loaded: false,
    loading: false,
    error: null,
    updatedAt: 0,
    profileIndex: null,
    minimumStakeLux: null,
    info: null,
    // form state
    stakeAmountDusk: "",
    unstakeAmountDusk: "",
    withdrawAmountDusk: "",
  });

  const idx = Number(ov?.selectedAccountIndex ?? 0) || 0;
  const stale = !st.loaded || st.profileIndex !== idx || Date.now() - Number(st.updatedAt || 0) > 15_000;
  if (!stale || st.loading) return st;

  st.loading = true;
  st.error = null;

  Promise.all([
    actions?.send?.({ type: "DUSK_UI_GET_MINIMUM_STAKE", profileIndex: idx }),
    actions?.send?.({ type: "DUSK_UI_GET_STAKE_INFO", profileIndex: idx }),
  ])
    .then(([minResp, infoResp]) => {
      if (minResp?.error) throw new Error(minResp.error.message ?? "Failed to load minimum stake");
      if (infoResp?.error) throw new Error(infoResp.error.message ?? "Failed to load stake info");

      st.minimumStakeLux = String(minResp?.result ?? minResp ?? "");
      st.info = infoResp?.result ?? infoResp ?? null;
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

export function stakeFormView(ov, { state, actions } = {}) {
  const st = ensureStakeLoaded(ov, { state, actions });

  const onBack = () => {
    state.route = "home";
    actions?.render?.().catch(() => {});
  };

  const info = st?.info ?? null;
  const hasStake = Boolean(info?.amount);

  const minLux = st?.minimumStakeLux != null ? safeBigInt(st.minimumStakeLux, 0n) : 0n;
  const minDusk = minLux > 0n ? fmtLux(minLux) : "—";

  const stakeTotalLux = safeBigInt(info?.amount?.total ?? 0, 0n);
  const stakeLockedLux = safeBigInt(info?.amount?.locked ?? 0, 0n);
  const stakeEligLux = safeBigInt(info?.amount?.eligibility ?? 0, 0n);
  const rewardLux = safeBigInt(info?.reward ?? 0, 0n);

  const summary = h("div", { class: "box" }, [
    h("div", { class: "hrow" }, [
      h("div", { class: "muted", text: "Minimum stake" }),
      h("code", { text: `${minDusk} DUSK`, title: minLux ? `Lux: ${minLux.toString()}` : "" }),
    ]),
    h("div", { class: "hrow" }, [
      h("div", { class: "muted", text: "Staked" }),
      h("code", {
        text: hasStake ? `${fmtLux(stakeTotalLux)} DUSK` : "—",
        title: hasStake ? `Lux: ${stakeTotalLux.toString()}` : "",
      }),
    ]),
    hasStake
      ? h("div", { class: "hrow" }, [
          h("div", { class: "muted", text: "Locked" }),
          h("code", { text: `${fmtLux(stakeLockedLux)} DUSK`, title: `Lux: ${stakeLockedLux.toString()}` }),
        ])
      : null,
    hasStake
      ? h("div", { class: "hrow" }, [
          h("div", { class: "muted", text: "Eligibility" }),
          h("code", { text: `${fmtLux(stakeEligLux)} DUSK`, title: `Lux: ${stakeEligLux.toString()}` }),
        ])
      : null,
    h("div", { class: "hrow" }, [
      h("div", { class: "muted", text: "Rewards" }),
      h("code", { text: `${fmtLux(rewardLux)} DUSK`, title: `Lux: ${rewardLux.toString()}` }),
    ]),
    hasStake
      ? h("div", { class: "hrow" }, [
          h("div", { class: "muted", text: "Faults" }),
          h("code", { text: `${Number(info?.faults ?? 0) || 0} / ${Number(info?.hardFaults ?? 0) || 0}` }),
        ])
      : null,
  ].filter(Boolean));

  const stakeInput = h("input", {
    placeholder: hasStake ? "Top up amount (DUSK)" : "Stake amount (DUSK)",
    value: String(st?.stakeAmountDusk ?? ""),
    oninput: (e) => {
      st.stakeAmountDusk = String(e?.target?.value ?? "");
    },
  });

  const unstakeInput = h("input", {
    placeholder: "Unstake amount (DUSK) or leave blank for all",
    value: String(st?.unstakeAmountDusk ?? ""),
    oninput: (e) => {
      st.unstakeAmountDusk = String(e?.target?.value ?? "");
    },
  });

  const withdrawInput = h("input", {
    placeholder: "Withdraw rewards (DUSK) or leave blank for all",
    value: String(st?.withdrawAmountDusk ?? ""),
    oninput: (e) => {
      st.withdrawAmountDusk = String(e?.target?.value ?? "");
    },
  });

  const makeDraft = (kind, amountLuxOrNull) => {
    state.stakeDraft = {
      kind,
      // string Lux or null (meaning "full" for unstake, or "all" for withdraw)
      amountLux: amountLuxOrNull,
      // persist last edited gas between reviews
      gas: state.stakeDraft?.gas ?? null,
    };
  };

  const reviewStakeBtn = h("button", {
    class: "btn-primary",
    text: hasStake ? "Review top up" : "Review stake",
    disabled: Boolean(st?.loading),
    onclick: () => {
      try {
        const luxStr = parseDuskToLux(String(stakeInput.value ?? "").trim());
        if (safeBigInt(luxStr, 0n) <= 0n) throw new Error("Amount must be > 0");
        makeDraft(TX_KIND.STAKE, luxStr);
        state.route = "stake_confirm";
        actions?.render?.().catch(() => {});
      } catch (e) {
        actions?.showToast?.(e?.message ?? String(e), 3000);
      }
    },
  });

  const reviewUnstakeBtn = h("button", {
    class: "btn-outline",
    text: "Review unstake",
    disabled: Boolean(st?.loading) || !hasStake,
    onclick: () => {
      try {
        const raw = String(unstakeInput.value ?? "").trim();
        const luxStr = raw ? parseDuskToLux(raw) : null; // null => full
        if (luxStr && safeBigInt(luxStr, 0n) <= 0n) throw new Error("Amount must be > 0");
        makeDraft(TX_KIND.UNSTAKE, luxStr);
        state.route = "stake_confirm";
        actions?.render?.().catch(() => {});
      } catch (e) {
        actions?.showToast?.(e?.message ?? String(e), 3000);
      }
    },
  });

  const reviewWithdrawBtn = h("button", {
    class: "btn-outline",
    text: "Review withdraw",
    disabled: Boolean(st?.loading) || rewardLux <= 0n,
    onclick: () => {
      try {
        const raw = String(withdrawInput.value ?? "").trim();
        const luxStr = raw ? parseDuskToLux(raw) : null; // null => all
        if (luxStr && safeBigInt(luxStr, 0n) <= 0n) throw new Error("Amount must be > 0");
        makeDraft(TX_KIND.WITHDRAW_REWARD, luxStr);
        state.route = "stake_confirm";
        actions?.render?.().catch(() => {});
      } catch (e) {
        actions?.showToast?.(e?.message ?? String(e), 3000);
      }
    },
  });

  const statusLine = st?.loading
    ? h("div", { class: "muted", text: "Loading staking info…" })
    : st?.error
    ? h("div", { class: "err", text: String(st.error) })
    : null;

  const note = h("div", {
    class: "muted",
    text:
      "Note: Dusk staking is account-based. Validator selection/delegation is TBD (it may not be meaningful in the same way as Ethereum).",
  });

  return [
    subnav({ title: "Staking", onBack }),
    h("div", { class: "row" }, [
      statusLine,
      summary,
      h("label", { text: hasStake ? "Top up stake" : "Create stake" }),
      stakeInput,
      reviewStakeBtn,
      h("label", { text: "Unstake" }),
      unstakeInput,
      reviewUnstakeBtn,
      h("label", { text: "Withdraw rewards" }),
      withdrawInput,
      reviewWithdrawBtn,
      note,
    ].filter(Boolean)),
  ];
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

  // Gas editor (collapsed by default)
  const defaultGas = getDefaultGas(kind);
  const defaultLimit =
    defaultGas?.limit !== undefined && defaultGas?.limit !== null ? String(defaultGas.limit) : "";
  const fallbackPrice =
    defaultGas?.price !== undefined && defaultGas?.price !== null ? String(defaultGas.price) : "";

  const gasEditor = document.createElement("dusk-gas-editor");
  gasEditor.maxDecimals = UI_DISPLAY_DECIMALS;
  gasEditor.helpText = "Max fee shown is limit × price. Clear both to use node defaults.";

  // Stake spends amount; unstake/withdraw do not.
  if (kind === TX_KIND.STAKE) {
    gasEditor.amountLux = String(d.amountLux ?? "0");
  } else {
    gasEditor.amountLux = "0";
  }

  gasEditor.setGas(d?.gas ?? null);

  const gasHint = h("div", { class: "muted", text: "Loading gas price suggestion…" });

  // Fire-and-forget: fetch suggested prices (cached for 30s).
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

      // Default to median for predictable UX.
      if (defaultLimit) {
        gasEditor.setGas({ limit: defaultLimit, price: median });
      } else if (fallbackPrice) {
        gasEditor.setGas({ limit: defaultLimit, price: fallbackPrice });
      }
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

      // For full-unstake and withdraw-all, omit amount (engine treats it as full/all).
      const params = {
        kind,
        ...(d.amountLux ? { amount: d.amountLux } : {}),
        gas: gas || undefined,
      };

      const res = await actions?.send?.({ type: "DUSK_UI_SEND_TX", params });
      if (res?.error) throw new Error(res.error.message ?? "Transaction failed");
      if (!res?.ok) throw new Error("Transaction failed");

      const hash = res.result?.hash ?? "";
      const sh = hash && hash.length > 18 ? `${hash.slice(0, 10)}…${hash.slice(-8)}` : hash;
      actions?.showToast?.(sh ? `Transaction submitted: ${sh}` : "Transaction submitted", 2500);

      // Reset local staking cache so the next visit reloads fresh values.
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
        d.amountLux ? h("div", { class: "muted", text: `Lux: ${String(d.amountLux)}` }) : null,
      ].filter(Boolean)),
      gasEditor,
      gasHint,
      h("div", { class: "btnrow" }, [cancelBtn, confirmBtn]),
    ]),
  ];
}

