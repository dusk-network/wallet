import {
  UI_DISPLAY_DECIMALS,
  formatLuxShort,
  parseDuskToLux,
  safeBigInt,
} from "../../../shared/amount.js";
import {
  buildSozuDepositTx,
  buildSozuWithdrawTx,
  estimateSozuPositionValue,
  parseSozuPoolState,
  parseSozuPosition,
} from "../../../shared/sozuAdapter.js";
import { getSozuConfig } from "../../../shared/sozuConfig.js";
import { h } from "../../lib/dom.js";

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
  const estimatedValueLux = position && pool
    ? estimateSozuPositionValue(position, pool)
    : liveStatus?.estimatedValueLux ?? "0";
  const disabledReason = cfg
    ? ""
    : liveStatus?.reason || "Sozu liquid staking is not configured for this network.";
  const configSource = liveStatus?.source === "hub"
    ? "Hub discovered"
    : liveStatus?.source === "fallback"
    ? "Hardcoded fallback"
    : cfg
    ? "Hardcoded"
    : "Unavailable";

  const makeDraft = (kind) => {
    try {
      if (!cfg) throw new Error(disabledReason);
      const amountLux = parseAmountLux(
        kind === "withdraw" ? st.withdrawAmountDusk : st.depositAmountDusk
      );
      state.sozuDraft = {
        ...(kind === "withdraw"
          ? buildSozuWithdrawTx({ config: cfg, amountLux })
          : buildSozuDepositTx({ config: cfg, amountLux })),
        profileIndex: Number(ov?.selectedAccountIndex ?? 0) || 0,
        fnArgsAmountLux: amountLux.toString(),
        label: kind === "withdraw" ? "Withdraw from Sozu" : "Deposit into Sozu",
      };
      actions?.showToast?.("Sozu transaction draft ready.", 1800);
      actions?.render?.().catch(() => {});
    } catch (e) {
      actions?.showToast?.(e?.message ?? String(e), 3000);
    }
  };

  const submitDraft = async () => {
    const draft = state.sozuDraft;
    if (!draft) return;
    try {
      st.submitting = true;
      actions?.render?.().catch(() => {});
      const resp = await actions?.send?.({
        type: "DUSK_UI_SEND_TX",
        params: draft,
        asset: { kind: "sozu", action: draft.fnName, pool: draft.contractId },
      });
      if (resp?.error) throw new Error(resp.error.message ?? "Sozu transaction failed");
      actions?.showToast?.("Sozu transaction submitted.", 2500);
      state.sozuDraft = null;
      st.loaded = false;
      st.loading = false;
    } catch (e) {
      actions?.showToast?.(e?.message ?? String(e), 3500);
    } finally {
      st.submitting = false;
      actions?.render?.().catch(() => {});
    }
  };

  const actionTabs = h("div", { class: "btnrow" }, [
    h("button", {
      class: st.action === "deposit" ? "btn-primary" : "btn-outline",
      text: "Deposit",
      disabled: !cfg,
      onclick: () => {
        st.action = "deposit";
        actions?.render?.().catch(() => {});
      },
    }),
    h("button", {
      class: st.action === "withdraw" ? "btn-primary" : "btn-outline",
      text: "Withdraw",
      disabled: !cfg,
      onclick: () => {
        st.action = "withdraw";
        actions?.render?.().catch(() => {});
      },
    }),
  ]);

  const isWithdraw = st.action === "withdraw";
  const publicBalance = safeBigInt(liveStatus?.publicBalance?.value ?? 0, 0n);
  const draftNeeds = draftAmountLux(state.sozuDraft);
  const submitDisabled =
    !state.sozuDraft ||
    st.submitting ||
    (state.sozuDraft?.fnName === "sozu_stake" && draftNeeds > publicBalance) ||
    publicBalance <= 0n;
  const submitDisabledReason = !state.sozuDraft
    ? ""
    : publicBalance <= 0n
    ? "This transaction needs public DUSK for gas."
    : state.sozuDraft.fnName === "sozu_stake" && draftNeeds > publicBalance
    ? "Deposit amount exceeds the available public balance."
    : "";
  const amountInput = h("input", {
    id: "sozu-action-amount",
    name: "sozuActionAmount",
    placeholder: `${isWithdraw ? "Withdraw" : "Deposit"} amount (DUSK)`,
    value: isWithdraw ? st.withdrawAmountDusk : st.depositAmountDusk,
    disabled: !cfg,
    oninput: (e) => {
      if (isWithdraw) st.withdrawAmountDusk = String(e?.target?.value ?? "");
      else st.depositAmountDusk = String(e?.target?.value ?? "");
    },
  });

  return h("div", { class: "box" }, [
    h("div", { class: "muted", text: "Liquid staking with Sozu" }),
    h("div", { class: "balance-amount", text: "Stake without running a node" }),
    h("div", {
      class: "muted",
      text: "This uses Sozu contracts, not native provisioner staking.",
    }),
    h("div", { class: "hrow" }, [
      h("div", { class: "muted", text: "Network" }),
      h("code", { text: String(liveStatus?.networkKey ?? networkKey(ov)) }),
    ]),
    h("div", { class: "hrow" }, [
      h("div", { class: "muted", text: "Config" }),
      h("code", { text: configSource }),
    ]),
    cfg
      ? h("div", { class: "hrow" }, [
          h("div", { class: "muted", text: "Pool contract" }),
          h("code", { text: `${cfg.contracts.pool.slice(0, 10)}…${cfg.contracts.pool.slice(-8)}` }),
        ])
      : h("div", { class: "err", text: disabledReason }),
    st.loading ? h("div", { class: "muted", text: "Loading Sozu pool and position…" }) : null,
    st.error ? h("div", { class: "err", text: st.error }) : null,
    cfg && liveStatus?.reason ? h("div", { class: "muted", text: liveStatus.reason }) : null,
    pool
      ? h("div", { class: "hrow" }, [
          h("div", { class: "muted", text: "Pool exchange rate" }),
          h("code", { text: pool.exchangeRate == null ? "Unavailable" : String(pool.exchangeRate) }),
        ])
      : h("div", { class: "muted", text: "Pool state will load from Sozu contracts when connected." }),
    position
      ? h("div", { class: "hrow" }, [
          h("div", { class: "muted", text: "Your Sozu shares" }),
          h("code", { text: `${fmtLux(position.shareBalanceLux)} sDUSK` }),
        ])
      : h("div", { class: "muted", text: "No local Sozu position loaded." }),
    position && pool
      ? h("div", { class: "hrow" }, [
          h("div", { class: "muted", text: "Estimated DUSK value" }),
          h("code", { text: `${fmtLux(estimatedValueLux)} DUSK` }),
        ])
      : null,
    liveStatus?.publicBalance
      ? h("div", { class: "hrow" }, [
          h("div", { class: "muted", text: "Available public balance" }),
          h("code", { text: `${fmtLux(liveStatus.publicBalance.value)} DUSK` }),
        ])
      : null,
    actionTabs,
    h("label", { for: "sozu-action-amount", text: isWithdraw ? "Withdraw amount" : "Deposit amount" }),
    amountInput,
    h("div", { class: "btnrow" }, [
      h("button", {
        class: "btn-primary",
        text: isWithdraw ? "Review withdraw" : "Review deposit",
        disabled: !cfg,
        onclick: () => makeDraft(isWithdraw ? "withdraw" : "deposit"),
      }),
    ]),
    state.sozuDraft
      ? h("div", { class: "box" }, [
          h("div", { class: "muted", text: "Review Sozu transaction" }),
          h("div", { class: "hrow" }, [
            h("div", { class: "muted", text: "Action" }),
            h("code", { text: state.sozuDraft.label }),
          ]),
          h("div", { class: "hrow" }, [
            h("div", { class: "muted", text: "Amount" }),
            h("code", { text: `${fmtLux(draftNeeds.toString())} DUSK` }),
          ]),
          h("div", { class: "hrow" }, [
            h("div", { class: "muted", text: "Method" }),
            h("code", { text: state.sozuDraft.fnName }),
          ]),
          h("div", { class: "hrow" }, [
            h("div", { class: "muted", text: "Funding" }),
            h("code", { text: `Profile ${Number(ov?.selectedAccountIndex ?? 0) + 1} public` }),
          ]),
          h("div", { class: "muted", text: "The wallet will apply public contract-call gas defaults when submitting." }),
          submitDisabledReason ? h("div", { class: "err", text: submitDisabledReason }) : null,
          h("div", { class: "btnrow" }, [
            h("button", {
              class: "btn-primary",
              text: st.submitting ? "Submitting…" : "Submit Sozu transaction",
              disabled: submitDisabled,
              onclick: submitDraft,
            }),
          ]),
        ].filter(Boolean))
      : null,
  ].filter(Boolean));
}
