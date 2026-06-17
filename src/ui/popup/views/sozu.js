import {
  UI_DISPLAY_DECIMALS,
  formatLuxShort,
  formatLuxToDusk,
  parseDuskToLux,
  safeBigInt,
} from "../../../shared/amount.js";
import { TX_KIND } from "../../../shared/constants.js";
import {
  buildSozuDepositTx,
  buildSozuWithdrawTx,
  makeSozuStDuskToken,
  parseSozuPoolState,
  parseSozuPosition,
} from "../../../shared/sozuAdapter.js";
import { getSozuConfig } from "../../../shared/sozuConfig.js";
import { getDefaultGas } from "../../../shared/txDefaults.js";
import { h } from "../../lib/dom.js";
import { subnav } from "../../components/Subnav.js";
import "../../components/GasEditor.js";

function networkKey(ov) {
  const name = String(ov?.networkName ?? "").trim().toLowerCase();
  if (name === "mainnet") return "mainnet";
  if (name === "testnet") return "testnet";
  return name || "custom";
}

function fmtLux(value) {
  return formatLuxShort(value ?? "0", UI_DISPLAY_DECIMALS);
}

function sozuState(state) {
  return (state.sozu ??= {
    action: "deposit",
    depositAmountDusk: "",
    withdrawAmountDusk: "",
    loaded: false,
    loading: false,
    error: null,
    profileIndex: null,
    status: null,
    pool: null,
    position: null,
  });
}

function parseAmountLux(raw) {
  const amount = parseDuskToLux(String(raw ?? "").trim());
  if (safeBigInt(amount, 0n) <= 0n) throw new Error("Enter an amount greater than 0.");
  return amount;
}

function draftAmountLux(draft) {
  const deposit = safeBigInt(draft?.deposit ?? 0, 0n);
  if (deposit > 0n) return deposit;
  return safeBigInt(draft?.fnArgsAmountLux ?? 0, 0n);
}

function defaultContractCallFeeLux() {
  const gas = getDefaultGas(TX_KIND.CONTRACT_CALL, { privacy: "public" });
  return safeBigInt(gas?.limit, 0n) * safeBigInt(gas?.price, 1n);
}

function gasQuickControls({ actions, draft, defaultLimit, fallbackPrice, gasEditor }) {
  const gasHint = h("div", { class: "muted", text: "Loading gas price suggestion…" });
  const btnAuto = h("button", {
    class: "btn-outline",
    type: "button",
    text: "Auto",
    onclick: () => gasEditor.setGas(null),
  });
  const btnLow = h("button", { class: "btn-outline", type: "button", text: "Low", disabled: true });
  const btnRec = h("button", { class: "btn-outline", type: "button", text: "Recommended", disabled: true });
  const btnHigh = h("button", { class: "btn-outline", type: "button", text: "High", disabled: true });
  const gasQuickRow = h("div", { class: "gas-quick-row" }, [btnAuto, btnLow, btnRec, btnHigh]);

  (async () => {
    try {
      if (draft?.gas) {
        gasHint.textContent = defaultLimit && fallbackPrice
          ? `Default gas: ${defaultLimit} limit · ${fallbackPrice} price (LUX)`
          : "Gas is set.";
        return;
      }

      const resp = await actions?.send?.({ type: "DUSK_UI_GET_CACHED_GAS_PRICE" });
      if (resp?.error) throw new Error(resp.error.message ?? "Failed to fetch gas price");
      const stats = resp?.result ?? resp;
      const min = String(stats?.min ?? "1");
      const median = String(stats?.median ?? stats?.average ?? "1");
      const max = String(stats?.max ?? median);

      gasHint.textContent = `Gas price (LUX): min ${min} · median ${median} · max ${max}`;
      gasEditor.helpText =
        (defaultLimit
          ? `Suggested gas price comes from the node mempool. Default limit: ${defaultLimit}. `
          : "Suggested gas price comes from the node mempool. ") +
        "Max fee shown is limit × price. Clear both to use wallet defaults.";

      const apply = (price) => {
        if (!defaultLimit) return;
        gasEditor.setGas({ limit: defaultLimit, price: String(price ?? "") });
      };

      btnLow.disabled = !defaultLimit;
      btnRec.disabled = !defaultLimit;
      btnHigh.disabled = !defaultLimit;
      btnLow.onclick = () => apply(min);
      btnRec.onclick = () => apply(median);
      btnHigh.onclick = () => apply(max);
      if (defaultLimit) gasEditor.setGas({ limit: defaultLimit, price: median });
    } catch {
      gasHint.textContent = "Gas price unavailable (using defaults).";
      if (defaultLimit && fallbackPrice) {
        gasEditor.setGas({ limit: defaultLimit, price: fallbackPrice });
      }
    }
  })().catch(() => {});

  return { gasHint, gasQuickRow };
}

function stDuskWatchKey(profileIndex, contractId) {
  return `${Number(profileIndex) || 0}:${String(contractId ?? "").toLowerCase()}`;
}

function canonicalContractId(contractId) {
  const raw = String(contractId ?? "").trim().toLowerCase();
  if (/^0x[0-9a-f]{64}$/.test(raw)) return raw;
  if (/^[0-9a-f]{64}$/.test(raw)) return `0x${raw}`;
  return raw;
}

function maybeAutoWatchStDusk({ state, actions, st, status, profileIndex }) {
  const contractId = status?.contracts?.["staked-dusk"];
  const balance = safeBigInt(status?.position?.stDuskBalanceLux ?? 0, 0n);
  if (!contractId || balance <= 0n) return;

  const key = stDuskWatchKey(profileIndex, contractId);
  if (st.autoStDuskWatchKey === key || st.autoStDuskWatchPending === key) return;

  st.autoStDuskWatchPending = key;
  actions?.send?.({
    type: "DUSK_UI_ASSETS_WATCH_TOKEN",
    profileIndex,
    token: makeSozuStDuskToken(contractId),
  })
    ?.then((resp) => {
      if (resp?.error) throw new Error(resp.error.message ?? "Failed to add stDUSK");
      st.autoStDuskWatchKey = key;
      if (state.assets) state.assets.loaded = false;
    })
    ?.catch(() => {
      // Auto-watch should never break the liquid staking panel.
    })
    ?.finally(() => {
      if (st.autoStDuskWatchPending === key) st.autoStDuskWatchPending = "";
      actions?.render?.().catch(() => {});
    });
}

function ensureSozuLoaded(ov, { state, actions } = {}) {
  const st = sozuState(state);
  const idx = Number(ov?.selectedAccountIndex ?? 0) || 0;
  const stale = !st.loaded || st.profileIndex !== idx;
  if (!stale || st.loading) return st;

  st.loading = true;
  st.error = null;
  actions?.send?.({ type: "DUSK_UI_GET_SOZU_STATUS", profileIndex: idx })
    ?.then((resp) => {
      if (resp?.error) throw new Error(resp.error.message ?? "Failed to load Sozu status");
      st.status = resp?.result ?? resp ?? null;
      st.pool = st.status?.pool ?? null;
      st.position = st.status?.position ?? null;
      st.profileIndex = idx;
      st.loaded = true;
      st.loading = false;
      maybeAutoWatchStDusk({ state, actions, st, status: st.status, profileIndex: idx });
      actions?.render?.().catch(() => {});
    })
    ?.catch((e) => {
      st.error = e?.message ?? String(e);
      st.loaded = false;
      st.loading = false;
      actions?.render?.().catch(() => {});
    });
  return st;
}

export function sozuLiquidStakingView(ov, { state, actions } = {}) {
  const st = ensureSozuLoaded(ov, { state, actions });
  const staticCfg = getSozuConfig(networkKey(ov));
  const liveStatus = st.status;
  const cfg = liveStatus?.configured && liveStatus?.contracts?.pool
    ? { networkKey: liveStatus.networkKey, contracts: liveStatus.contracts }
    : staticCfg;
  const pool = st.pool ? parseSozuPoolState(st.pool) : null;
  const position = st.position ? parseSozuPosition(st.position) : null;
  const publicBalanceLux = safeBigInt(liveStatus?.publicBalance?.value ?? 0, 0n);
  const poolBalanceLux = safeBigInt(position?.poolBalanceLux ?? 0, 0n);
  const publicFeeLux = defaultContractCallFeeLux();
  const maxStakeLux = publicBalanceLux > publicFeeLux ? publicBalanceLux - publicFeeLux : 0n;
  const maxUnstakeLux = poolBalanceLux > 0n ? poolBalanceLux : 0n;
  const disabledReason = cfg
    ? ""
    : liveStatus?.reason || "Sozu liquid staking is not configured for this network.";
  const makeDraft = (kind) => {
    try {
      if (!cfg) throw new Error(disabledReason);
      const amountLux = parseAmountLux(
        kind === "withdraw" ? st.withdrawAmountDusk : st.depositAmountDusk
      );
      if (kind === "withdraw" && amountLux > maxUnstakeLux) {
        throw new Error("Unstake amount exceeds pool balance.");
      }
      if (kind !== "withdraw" && amountLux > maxStakeLux) {
        throw new Error("Stake amount exceeds public balance after gas.");
      }
      state.sozuDraft = {
        ...(kind === "withdraw"
          ? buildSozuWithdrawTx({ config: cfg, amountLux })
          : buildSozuDepositTx({ config: cfg, amountLux })),
        profileIndex: Number(ov?.selectedAccountIndex ?? 0) || 0,
        fnArgsAmountLux: amountLux.toString(),
        label: kind === "withdraw" ? "Unstake from Sozu" : "Stake with Sozu",
      };
      state.route = "sozu_confirm";
      actions?.render?.().catch(() => {});
    } catch (e) {
      actions?.showToast?.(e?.message ?? String(e), 3000);
    }
  };

  const addStDuskToken = async () => {
    try {
      const contractId = cfg?.contracts?.["staked-dusk"];
      if (!contractId) throw new Error("stDUSK token contract is not available from Sozu discovery.");
      const resp = await actions?.send?.({
        type: "DUSK_UI_ASSETS_WATCH_TOKEN",
        profileIndex: Number(ov?.selectedAccountIndex ?? 0) || 0,
        token: makeSozuStDuskToken(contractId),
      });
      if (resp?.error) throw new Error(resp.error.message ?? "Failed to add stDUSK");
      st.autoStDuskWatchKey = stDuskWatchKey(Number(ov?.selectedAccountIndex ?? 0) || 0, contractId);
      if (state.assets) state.assets.loaded = false;
      actions?.showToast?.("stDUSK added to Assets.", 2200);
      actions?.render?.({ forceRefresh: true }).catch(() => {});
    } catch (e) {
      actions?.showToast?.(e?.message ?? String(e), 3000);
    }
  };

  const actionTabs = h("div", {
    class: "tabs tabs--mini sozu-action-tabs",
    style: `--seg-index: ${st.action === "deposit" ? 0 : 1};`,
  }, [
    h("button", {
      class: st.action === "deposit" ? "tab is-active" : "tab",
      disabled: !cfg,
      onclick: () => {
        st.action = "deposit";
        actions?.render?.().catch(() => {});
      },
    }, [h("span", { text: "Stake" })]),
    h("button", {
      class: st.action === "withdraw" ? "tab is-active" : "tab",
      disabled: !cfg,
      onclick: () => {
        st.action = "withdraw";
        actions?.render?.().catch(() => {});
      },
    }, [h("span", { text: "Unstake" })]),
  ]);

  const isWithdraw = st.action === "withdraw";
  const maxActionLux = isWithdraw ? maxUnstakeLux : maxStakeLux;
  const setMaxAmount = () => {
    if (maxActionLux <= 0n) {
      actions?.showToast?.(
        isWithdraw
          ? "No pool balance available to unstake."
          : "No public balance remains after the estimated gas fee.",
        3000
      );
      return;
    }
    if (isWithdraw) st.withdrawAmountDusk = formatLuxToDusk(maxActionLux);
    else st.depositAmountDusk = formatLuxToDusk(maxActionLux);
    actions?.render?.().catch(() => {});
  };
  const amountInput = h("input", {
    id: "sozu-action-amount",
    name: "sozuActionAmount",
    placeholder: `${isWithdraw ? "Unstake" : "Stake"} amount (DUSK)`,
    value: isWithdraw ? st.withdrawAmountDusk : st.depositAmountDusk,
    disabled: !cfg,
    oninput: (e) => {
      if (isWithdraw) st.withdrawAmountDusk = String(e?.target?.value ?? "");
      else st.depositAmountDusk = String(e?.target?.value ?? "");
    },
  });
  const stDuskContractId = cfg?.contracts?.["staked-dusk"];
  const hasStDusk = safeBigInt(position?.stDuskBalanceLux ?? 0, 0n) > 0n;
  const currentProfileIndex = Number(ov?.selectedAccountIndex ?? 0) || 0;
  const currentStDuskWatchKey = stDuskContractId
    ? stDuskWatchKey(currentProfileIndex, stDuskContractId)
    : "";
  const stDuskPending = hasStDusk && currentStDuskWatchKey && st.autoStDuskWatchPending === currentStDuskWatchKey;
  const stDuskAutoAdded =
    hasStDusk &&
    currentStDuskWatchKey &&
    st.autoStDuskWatchKey === currentStDuskWatchKey;
  const openStDuskAsset = () => {
    if (!stDuskContractId || !stDuskAutoAdded) return;
    state.assetTokenContractId = canonicalContractId(stDuskContractId);
    state.route = "asset_token";
    actions?.render?.().catch(() => {});
  };

  return h("div", { class: "box sozu-panel" }, [
    h("div", { class: "sozu-hero" }, [
      h("div", { class: "sozu-brand-row" }, [
        h("div", { class: "sozu-title", text: "Sozu" }),
        h("span", { class: "stake-badge stake-badge--third-party", text: "Third-party" }),
      ]),
      h("div", { class: "sozu-subtitle" }, [
        h("span", { text: "Stake DUSK through Sozu." }),
        h("a", {
          class: "sozu-link",
          href: "https://sozu.fi/",
          target: "_blank",
          rel: "noreferrer",
          text: "sozu.fi",
          title: "Open Sozu website",
        }),
      ]),
    ]),
    cfg ? null : h("div", { class: "err", text: disabledReason }),
    st.loading ? h("div", { class: "muted", text: "Loading Sozu pool and position…" }) : null,
    st.error ? h("div", { class: "err", text: st.error }) : null,
    cfg && liveStatus?.reason ? h("div", { class: "muted", text: liveStatus.reason }) : null,
    h("div", { class: "stake-metrics sozu-stats" }, [
      position
        ? h("div", { class: "hrow" }, [
            h("div", { class: "muted", text: "Pool balance" }),
            h("code", { text: `${fmtLux(position.poolBalanceLux)} DUSK` }),
          ])
        : h("div", { class: "muted", text: "No Sozu pool balance loaded." }),
      liveStatus?.publicBalance
        ? h("div", { class: "hrow" }, [
            h("div", { class: "muted", text: "Available" }),
            h("code", { text: `${fmtLux(liveStatus.publicBalance.value)} DUSK` }),
          ])
        : null,
      position
        ? h(stDuskAutoAdded ? "button" : "div", {
            class: stDuskAutoAdded ? "hrow sozu-stat-link" : "hrow",
            type: stDuskAutoAdded ? "button" : undefined,
            "aria-label": stDuskAutoAdded ? "Open stDUSK in Assets" : undefined,
            title: stDuskAutoAdded ? "Open stDUSK in Assets" : undefined,
            onclick: stDuskAutoAdded ? openStDuskAsset : undefined,
          }, [
            h("div", { class: "muted", text: "stDUSK" }),
            h("code", { text: `${fmtLux(position.stDuskBalanceLux)} stDUSK` }),
          ])
        : null,
      pool
        ? h("div", { class: "hrow" }, [
            h("div", { class: "muted", text: "Rate" }),
            h("code", { text: pool.exchangeRate == null ? "Unavailable" : String(pool.exchangeRate) }),
          ])
        : h("div", { class: "muted", text: "Pool data loads from Sozu contracts after connection." }),
    ].filter(Boolean)),
    stDuskContractId
      ? stDuskAutoAdded
        ? null
        : stDuskPending
        ? h("div", { class: "muted", text: "Adding stDUSK to Assets…" })
        : h("button", {
            class: "btn-outline",
            text: "Add stDUSK to Assets",
            onclick: addStDuskToken,
          })
      : null,
    h("div", { class: "sozu-action-card" }, [
      actionTabs,
      h("label", { for: "sozu-action-amount", text: isWithdraw ? "Unstake amount" : "Stake amount" }),
      h("div", { class: "sozu-amount-row" }, [
        amountInput,
        h("button", {
          class: "btn-outline",
          type: "button",
          text: "Max",
          disabled: !cfg || maxActionLux <= 0n,
          title: isWithdraw
            ? "Use the full pool balance."
            : "Use public balance minus the estimated gas fee.",
          onclick: setMaxAmount,
        }),
      ]),
      h("button", {
        class: "btn-primary",
        text: isWithdraw ? "Review Sozu unstake" : "Review Sozu stake",
        disabled: !cfg,
        onclick: () => makeDraft(isWithdraw ? "withdraw" : "deposit"),
      }),
    ]),
  ].filter(Boolean));
}

export function sozuConfirmView(ov, { state, actions } = {}) {
  const draft = state.sozuDraft;
  if (!draft) {
    state.route = "stake";
    return sozuLiquidStakingView(ov, { state, actions });
  }

  const st = sozuState(state);
  const liveStatus = st.status;
  const publicBalance = safeBigInt(liveStatus?.publicBalance?.value ?? 0, 0n);
  const draftNeeds = draftAmountLux(draft);
  const draftFeeLux = defaultContractCallFeeLux();
  const fundingProfileLabel = `Profile ${Number(draft.profileIndex ?? 0) + 1}`;
  const stakeRequiredLux = draft.fnName === "sozu_stake" ? draftNeeds + draftFeeLux : draftFeeLux;
  const submitDisabled =
    st.submitting ||
    (draft.fnName === "sozu_stake" && stakeRequiredLux > publicBalance) ||
    publicBalance <= 0n;
  const submitDisabledReason = publicBalance <= 0n
    ? "Public DUSK is required for gas."
    : draft.fnName === "sozu_stake" && stakeRequiredLux > publicBalance
    ? "Stake amount exceeds public balance after gas."
    : "";

  const goBack = () => {
    state.route = "stake";
    actions?.render?.().catch(() => {});
  };
  const cancelBtn = h("button", { class: "btn-outline", text: "Cancel", onclick: goBack });
  const confirmBtn = h("button", {
    class: "btn-primary",
    text: st.submitting ? "Sending…" : "Confirm",
    disabled: submitDisabled,
  });

  const defaultGas = getDefaultGas(TX_KIND.CONTRACT_CALL, { privacy: draft.privacy || "public" });
  const defaultLimit =
    defaultGas?.limit !== undefined && defaultGas?.limit !== null ? String(defaultGas.limit) : "";
  const fallbackPrice =
    defaultGas?.price !== undefined && defaultGas?.price !== null ? String(defaultGas.price) : "";
  const gasEditor = document.createElement("dusk-gas-editor");
  gasEditor.maxDecimals = UI_DISPLAY_DECIMALS;
  gasEditor.amountLux = "0";
  gasEditor.extraLux = [String(draft.deposit ?? "0")];
  gasEditor.helpText = "Max fee shown is limit × price. Clear both to use wallet defaults.";
  gasEditor.setGas(draft?.gas ?? null);
  const { gasHint, gasQuickRow } = gasQuickControls({
    actions,
    draft,
    defaultLimit,
    fallbackPrice,
    gasEditor,
  });

  confirmBtn.addEventListener("click", async () => {
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Sending…";
    try {
      const gas = gasEditor.readFinalGas();
      state.sozuDraft.gas = gas;
      const params = { ...state.sozuDraft, gas: gas || undefined };
      const resp = await actions?.send?.({
        type: "DUSK_UI_SEND_TX",
        params,
        asset: { kind: "sozu", action: params.fnName, pool: params.contractId },
      });
      if (resp?.error) throw new Error(resp.error.message ?? "Sozu transaction failed");
      if (!resp?.ok) throw new Error("Sozu transaction failed");

      const hash = resp.result?.hash ?? "";
      const shortHash = hash && hash.length > 18 ? `${hash.slice(0, 10)}…${hash.slice(-8)}` : hash;
      actions?.showToast?.(shortHash ? `Transaction submitted: ${shortHash}` : "Transaction submitted", 2500);
      state.sozuDraft = null;
      st.loaded = false;
      st.loading = false;
      state.highlightTx = hash || null;
      state.route = "activity";
      state.needsRefresh = true;
      await actions?.render?.({ forceRefresh: true });
    } catch (e) {
      actions?.showToast?.(e?.message ?? String(e), 3500);
      confirmBtn.disabled = submitDisabled;
      confirmBtn.textContent = "Confirm";
    } finally {
      st.submitting = false;
    }
  });

  return [
    subnav({ title: "Review", onBack: goBack }),
    h("div", { class: "row" }, [
      h("div", { class: "box tx-summary" }, [
        h("div", { class: "muted", text: draft.label ?? "Sozu transaction" }),
        h("div", { class: "balance-amount", text: `${fmtLux(draftNeeds.toString())} DUSK` }),
        h("div", { class: "muted", text: `Gas: ${fundingProfileLabel} public balance` }),
      ].filter(Boolean)),
      submitDisabledReason ? h("div", { class: "err", text: submitDisabledReason }) : null,
      gasEditor,
      gasHint,
      gasQuickRow,
      h("div", { class: "btnrow" }, [cancelBtn, confirmBtn]),
    ]),
  ];
}
