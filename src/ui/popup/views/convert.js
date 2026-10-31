import {
  formatDusk,
  formatDuskExact,
  formatFee,
  formatLuxToDusk,
  parseDuskToLux,
  safeBigInt,
} from "../../../shared/amount.js";
import { TX_KIND } from "../../../shared/constants.js";
import { getDefaultGas, getMinimumGas } from "../../../shared/txDefaults.js";
import { h } from "../../lib/dom.js";
import { subnav } from "../../components/Subnav.js";
import "../../components/GasEditor.js";
import { amountField } from "../../components/AmountField.js";
import { balance, balancesHidden } from "../../components/Balance.js";
import { fieldLabel, submitOnGasEnter } from "../../components/FormControls.js";
import { gasFeeLux, reviewGas, startingGas } from "../../components/NetworkGas.js";
import { profileNameEl, withReviewWallet } from "../../components/ProfileName.js";
import { segmented } from "../../components/Segmented.js";
import { sendFromReview } from "./sent.js";

// Shield moves DUSK from the profile's public balance to its shielded one,
// Unshield back: one large amount field, what's available after the fee with
// Max, then Review.

const flowLine = (kind) =>
  kind === TX_KIND.SHIELD
    ? "From your public balance to your shielded balance"
    : "From your shielded balance to your public balance";

export function convertFormView(ov, { state, actions } = {}) {
  const draft = state.draft || {};
  const kind = draft.kind === TX_KIND.UNSHIELD ? TX_KIND.UNSHIELD : TX_KIND.SHIELD;
  const hidden = balancesHidden(ov);

  // The fee Review starts from, so Max matches what Review asks.
  const feeLux = gasFeeLux(
    startingGas({ defaultGas: getDefaultGas(kind), minLimit: getMinimumGas(kind)?.limit, customGas: ov?.customGas, gas: draft.gas })
  );

  // What it can move: the public balance, or the shielded one that can be
  // spent now, less the fee.
  const pubLux = safeBigInt(ov?.balance?.value, 0n);
  const shSpendLux =
    ov?.shieldedBalance?.spendable != null
      ? safeBigInt(ov.shieldedBalance.spendable, 0n)
      : safeBigInt(ov?.shieldedBalance?.value, 0n);
  const availRaw = kind === TX_KIND.SHIELD ? pubLux : shSpendLux;
  const avail = availRaw > feeLux ? availRaw - feeLux : 0n;

  const syncDraft = () => {
    state.draft = {
      ...(state.draft || {}),
      kind,
      amountDusk: String(field.input.value || ""),
      gas: state.draft?.gas,
    };
  };

  const field = amountField({
    label: "Amount",
    value: typeof draft.amountDusk === "string" ? draft.amountDusk : "",
    onInput: () => {
      check();
      syncDraft();
    },
    onEnter: () => nextBtn.click(),
  });

  // The amount as typed, checked as it is typed: an error under the field.
  function check({ required = false } = {}) {
    const raw = String(field.input.value ?? "").trim();
    if (!raw) {
      field.setError(required ? "Enter an amount." : "");
      return null;
    }
    let lux;
    try {
      lux = safeBigInt(parseDuskToLux(raw), 0n);
    } catch {
      field.setError("Enter an amount such as 1 or 0.5.");
      return null;
    }
    if (lux <= 0n) {
      field.setError("Enter an amount greater than 0.");
      return null;
    }
    if (lux > avail) {
      field.setError(
        kind === TX_KIND.SHIELD
          ? "That's more than your public balance, with the network fee."
          : "That's more than your shielded balance, with the network fee."
      );
      return null;
    }
    field.setError("");
    return lux;
  }

  const maxBtn = h("button", {
    class: "mini-btn",
    type: "button",
    text: "Max",
    title: "All of it, less the network fee",
    disabled: avail <= 0n,
    onclick: () => {
      // The real amount, with balances hidden too: it's what gets moved.
      field.setValue(formatLuxToDusk(avail));
      check();
      syncDraft();
      field.input.focus();
    },
  });
  const available = h("div", { class: "amount-avail" }, [
    h("span", { class: "amount-avail__text" }, [
      feeLux > 0n ? "Available after fees " : "Available ",
      balance(hidden, formatDusk(avail)),
      " DUSK",
    ]),
    maxBtn,
  ]);
  const feeNote = feeLux > 0n ? h("div", { class: "amount-fee-note", text: `Network fee up to ${formatFee(feeLux, { max: true })} DUSK` }) : null;

  const nextBtn = h("button", {
    class: "btn-primary",
    text: "Review",
    onclick: async () => {
      const lux = check({ required: true });
      if (lux == null) {
        field.input.focus();
        return;
      }
      state.draft = {
        kind,
        amountLux: lux.toString(),
        amountDusk: String(field.input.value ?? "").trim(),
        gas: draft?.gas,
      };
      state.route = "convert_confirm";
      await actions?.render?.();
    },
  });

  // Shield or Unshield: the same screen, the other way.
  const modeTabs = segmented({
    label: "Direction",
    items: [
      { id: TX_KIND.SHIELD, text: "Shield" },
      { id: TX_KIND.UNSHIELD, text: "Unshield" },
    ],
    selected: kind,
    onSelect: (next) => {
      state.draft = { ...(state.draft || {}), kind: next };
      actions?.render?.().catch(() => {});
    },
  });

  return [
    subnav({
      title: "Shield",
      onBack: () => {
        state.route = "home";
        state.draft = null;
        actions?.render?.().catch(() => {});
      },
    }),
    h("div", { class: "row convert-form" }, [
      modeTabs,
      h("p", { class: "convert-flow", text: `${flowLine(kind)}.` }),
      fieldLabel(field.input, "Amount"),
      h("div", { class: "amount-entry send-amount" }, [field.el, field.error, available, feeNote].filter(Boolean)),
      h("div", { class: "btnrow" }, [nextBtn]),
    ]),
  ];
}

export function convertConfirmView(ov, { state, actions } = {}) {
  const d = state.draft;
  if (!d) {
    state.route = "convert";
    return convertFormView(ov, { state, actions });
  }

  const kind = d.kind === TX_KIND.UNSHIELD ? TX_KIND.UNSHIELD : TX_KIND.SHIELD;
  const fromRail = kind === TX_KIND.SHIELD ? "Public" : "Shielded";
  const toRail = kind === TX_KIND.SHIELD ? "Shielded" : "Public";

  // Back returns to Shield with the draft, so Review has no Cancel.
  const confirmBtn = h("button", { class: "btn-primary", text: "Confirm" });

  // The network's gas price by default; Custom fee for gas of your own.
  const { defaultGas, editor: gasEditor, error: confirmError, readGas } = reviewGas({ kind, amountLux: d.amountLux, ov, actions, gas: d?.gas });

  confirmBtn.addEventListener("click", async () => {
    const gas = readGas();
    if (gas === false) return;
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
        line: `${fromRail} → ${toRail}`,
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

  const kv = (label, rail) =>
    h("div", { class: "kv" }, [
      h("span", { class: "kv-label", text: label }),
      h("span", { class: "kv-value" }, [h("span", {}, [withReviewWallet(profileNameEl(ov), actions?.review), h("span", { class: "kv-muted", text: ` · ${rail}` })])]),
    ]);

  return [
    subnav({
      title: "Review",
      onBack: () => {
        state.route = "convert";
        actions?.render?.().catch(() => {});
      },
    }),
    h("div", { class: "row convert-review" }, [
      h("div", { class: "review-head" }, [
        h("div", { class: "review-kind", text: kind === TX_KIND.SHIELD ? "Shield" : "Unshield" }),
        h("div", { class: "balance-amount" }, [formatDuskExact(d.amountLux), h("span", { class: "balance-unit", text: " DUSK" })]),
        h("div", { class: "review-line", text: flowLine(kind) }),
      ]),
      h("div", { class: "group" }, [kv("From", fromRail), kv("To", toRail)]),
      gasEditor,
      confirmError,
      h("div", { class: "btnrow" }, [confirmBtn]),
    ]),
  ];
}
