import {
  UI_DISPLAY_DECIMALS,
  formatDusk,
  formatFee,
  formatLuxToDusk,
  parseDuskToLux,
  safeBigInt,
} from "../../../shared/amount.js";
import { TX_KIND } from "../../../shared/constants.js";
import { getDefaultGas } from "../../../shared/txDefaults.js";
import { h } from "../../lib/dom.js";
import { subnav } from "../../components/Subnav.js";
import "../../components/GasEditor.js";
import { createAmountSliderCard } from "../../components/AmountSliderCard.js";
import { balance, balancesHidden } from "../../components/Balance.js";
import { fieldLabel, submitOnGasEnter } from "../../components/FormControls.js";
import { createGasQuickControls } from "../../components/GasQuickControls.js";
import {
  privacyFlowBadgeOptions,
  recipientBadge,
} from "../../components/RecipientBadge.js";
import { sendFromReview } from "./sent.js";

function fmtAvail(lux) {
  try {
    return formatDusk(lux, UI_DISPLAY_DECIMALS);
  } catch {
    return "—";
  }
}

export function convertFormView(ov, { state, actions } = {}) {
  const draft = state.draft || {};
  const kind = draft.kind === TX_KIND.UNSHIELD ? TX_KIND.UNSHIELD : TX_KIND.SHIELD;
  const hidden = balancesHidden(ov);

  const defaultGas = getDefaultGas(kind);
  const feeLux =
    defaultGas && defaultGas.limit != null && defaultGas.price != null
      ? safeBigInt(defaultGas.limit, 0n) * safeBigInt(defaultGas.price, 0n)
      : 0n;

  // Assigned later (we want to pass it into components as a live closure).
  let syncDraft = () => {};

  const amountCtl = createAmountSliderCard({
    initialAmountDusk: typeof draft.amountDusk === "string" ? draft.amountDusk : "",
    actions,
    onAmountInput: () => syncDraft(),
    onAmountChange: () => syncDraft(),
    onEnter: () => nextBtn.click(),
    hidden,
  });

  const amount = amountCtl.amountInput;
  const amountCard = amountCtl.el;

  syncDraft = () => {
    state.draft = {
      ...(state.draft || {}),
      kind,
      amountDusk: String(amount.value || ""),
      gas: state.draft?.gas,
    };
  };

  const errBox = h("div", { class: "err", style: "display:none" });
  const setErr = (txt) => {
    if (!txt) {
      errBox.style.display = "none";
      errBox.textContent = "";
      return;
    }
    errBox.style.display = "block";
    errBox.textContent = txt;
  };

  const setKind = (next) => {
    state.draft = {
      ...(state.draft || {}),
      kind: next,
    };
    actions?.render?.().catch(() => {});
  };

  // Basic availability hints
  const pubLux = safeBigInt(ov?.balance?.value, 0n);
  const shSpendLux =
    ov?.shieldedBalance?.spendable != null
      ? safeBigInt(ov.shieldedBalance.spendable, 0n)
      : safeBigInt(ov?.shieldedBalance?.value, 0n);
  const fromLabel = kind === TX_KIND.SHIELD ? "Public" : "Shielded";
  const toLabel = kind === TX_KIND.SHIELD ? "Shielded" : "Public";

  const availRaw = kind === TX_KIND.SHIELD ? pubLux : shSpendLux;
  const avail = availRaw > feeLux ? availRaw - feeLux : 0n;

  // Wire the shared MAX + slider component against the calculated maximum.
  amountCtl.setMaxLux(avail);

  // Worded as Send words them, the fee cap on a line of its own.
  const availLabel = kind === TX_KIND.SHIELD ? "Available (public)" : "Spendable (shielded)";
  const info = h("div", { class: "box" }, [
    recipientBadge({
      ...privacyFlowBadgeOptions({ from: fromLabel, to: toLabel }),
      className: "recipient-type-badge",
    }),
    h("div", { class: "muted", style: "margin-top:6px" }, [
      `${availLabel}: `,
      balance(hidden, fmtAvail(avail)),
      " DUSK",
    ]),
    feeLux > 0n
      ? h("div", { class: "muted", text: `Fee cap: ${formatFee(feeLux)} DUSK` })
      : null,
  ]);

  const nextBtn = h("button", {
    class: "btn-primary",
    text: "Review",
    onclick: async () => {
      try {
        setErr("");
        const amtLuxStr = parseDuskToLux(amount.value);
        const amtLux = BigInt(amtLuxStr);
        if (amtLux <= 0n) throw new Error("Amount must be > 0");

        // Friendly local pre-check (server will enforce anyway)
        if (amtLux > avail) {
          throw new Error(`Insufficient ${fromLabel.toLowerCase()} balance`);
        }

        const prevGas = draft?.gas;

        state.draft = {
          kind,
          amountLux: amtLuxStr,
          amountDusk: amount.value.trim(),
          gas: prevGas,
        };
        state.route = "convert_confirm";
        await actions?.render?.();
      } catch (e) {
        setErr(e?.message ?? String(e));
      }
    },
  });
  const modeTabs = h("div", { class: "tabs", style: `--seg-index: ${kind === TX_KIND.SHIELD ? 0 : 1};` }, [
    h(
      "button",
      {
        class: kind === TX_KIND.SHIELD ? "tab is-active" : "tab",
        onclick: () => setKind(TX_KIND.SHIELD),
      },
      [h("span", { text: "Shield" })]
    ),
    h(
      "button",
      {
        class: kind === TX_KIND.UNSHIELD ? "tab is-active" : "tab",
        onclick: () => setKind(TX_KIND.UNSHIELD),
      },
      [h("span", { text: "Unshield" })]
    ),
  ]);

  return [
    subnav({
      title: "Shield",
      onBack: () => {
        state.route = "home";
        state.draft = null;
        actions?.render?.().catch(() => {});
      },
    }),
    h("div", { class: "row" }, [
      modeTabs,
      info,
      fieldLabel(amount, "Amount"),
      amountCard,
      errBox,
      h("div", { class: "btnrow" }, [nextBtn]),
    ]),
  ].filter(Boolean);
}

export function convertConfirmView(ov, { state, actions } = {}) {
  const d = state.draft;
  if (!d) {
    state.route = "convert";
    return convertFormView(ov, { state, actions });
  }

  const kind = d.kind === TX_KIND.UNSHIELD ? TX_KIND.UNSHIELD : TX_KIND.SHIELD;
  const fromLabel = kind === TX_KIND.SHIELD ? "Public" : "Shielded";
  const toLabel = kind === TX_KIND.SHIELD ? "Shielded" : "Public";

  // Back returns to Shield with the draft, so Review has no Cancel.
  const confirmBtn = h("button", { class: "btn-primary", text: "Confirm" });

  const defaultGas = getDefaultGas(kind);
  const defaultLimit =
    defaultGas?.limit !== undefined && defaultGas?.limit !== null
      ? String(defaultGas.limit)
      : "";
  const fallbackPrice =
    defaultGas?.price !== undefined && defaultGas?.price !== null
      ? String(defaultGas.price)
      : "";

  const gasEditor = document.createElement("dusk-gas-editor");
  gasEditor.amountLux = d.amountLux;
  gasEditor.maxDecimals = UI_DISPLAY_DECIMALS;
  gasEditor.setGas(d?.gas ?? null);

  // The gas price line and the presets open with the fee's Edit.
  createGasQuickControls({
    actions,
    defaultLimit,
    fallbackPrice,
    gas: d?.gas,
    gasEditor,
    overrideHint: "Gas override set.",
  });

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

    const capGas = gas ?? defaultGas;
    await sendFromReview({
      state,
      actions,
      message: {
        type: "DUSK_UI_SEND_TX",
        params: {
          kind,
          amount: d.amountLux,
          gas: gas || undefined,
        },
      },
      summary: {
        title: kind === TX_KIND.SHIELD ? "Shield" : "Unshield",
        amountLux: d.amountLux,
        line: `${fromLabel} → ${toLabel}`,
        from: kind === TX_KIND.SHIELD ? "from your public balance" : "from your shielded balance",
        feeCapLux: (safeBigInt(capGas?.limit, 0n) * safeBigInt(capGas?.price, 0n)).toString(),
      },
      backRoute: "convert_confirm",
      doneRoute: "home",
      onSent: () => {
        // Done with, unless a newer draft took its place meanwhile.
        if (state.draft === d) state.draft = null;
      },
    });
    confirmBtn.disabled = false;
  });
  submitOnGasEnter(gasEditor, confirmBtn);

  return [
    subnav({
      title: "Review",
      onBack: () => {
        state.route = "convert";
        actions?.render?.().catch(() => {});
      },
    }),
    h("div", { class: "row" }, [
      recipientBadge({
        ...privacyFlowBadgeOptions({ from: fromLabel, to: toLabel }),
        className: "recipient-type-badge",
      }),
      h("div", { class: "home-balance" }, [
        h("div", {
          class: "balance-amount",
          text: d.amountDusk || formatLuxToDusk(d.amountLux),
        }),
        h("div", { class: "balance-sub", text: "DUSK" }),
      ]),
      gasEditor,
      confirmError,
      h("div", { class: "btnrow" }, [confirmBtn]),
    ]),
  ].filter(Boolean);
}
