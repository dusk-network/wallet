import {
  UI_DISPLAY_DECIMALS,
  formatLuxShort,
  parseDuskToLux,
  safeBigInt,
} from "../../../shared/amount.js";
import {
  buildSozuDepositTx,
  buildSozuWithdrawTx,
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
    pool: null,
    position: null,
  });
}

function parseAmountLux(raw) {
  const amount = parseDuskToLux(String(raw ?? "").trim());
  if (safeBigInt(amount, 0n) <= 0n) throw new Error("Enter an amount greater than 0.");
  return amount;
}

export function sozuLiquidStakingView(ov, { state, actions } = {}) {
  const st = sozuState(state);
  const cfg = getSozuConfig(networkKey(ov));
  const pool = st.pool ? parseSozuPoolState(st.pool) : null;
  const position = st.position ? parseSozuPosition(st.position) : null;
  const disabledReason = cfg ? "" : "Sozu liquid staking is not configured for this network.";

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
        label: kind === "withdraw" ? "Withdraw from Sozu" : "Deposit into Sozu",
      };
      actions?.showToast?.("Sozu transaction draft ready.", 1800);
      actions?.render?.().catch(() => {});
    } catch (e) {
      actions?.showToast?.(e?.message ?? String(e), 3000);
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
    cfg
      ? h("div", { class: "hrow" }, [
          h("div", { class: "muted", text: "Pool contract" }),
          h("code", { text: `${cfg.contracts.pool.slice(0, 10)}…${cfg.contracts.pool.slice(-8)}` }),
        ])
      : h("div", { class: "err", text: disabledReason }),
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
      ? h("div", { class: "muted", text: `${state.sozuDraft.label}: ${state.sozuDraft.fnName}` })
      : null,
  ].filter(Boolean));
}
