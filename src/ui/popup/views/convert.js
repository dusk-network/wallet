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
import { createAmountSliderCard } from "../../components/AmountSliderCard.js";

function fmtAvail(lux) {
  try {
    return formatLuxShort(lux, UI_DISPLAY_DECIMALS);
  } catch {
    return "—";
  }
}

export function convertFormView(ov, { state, actions } = {}) {
  const draft = state.draft || {};
  const kind = draft.kind === TX_KIND.UNSHIELD ? TX_KIND.UNSHIELD : TX_KIND.SHIELD;

  const defaultGas = getDefaultGas(kind);
  const feeLux =
    defaultGas && defaultGas.limit != null && defaultGas.price != null
      ? safeBigInt(defaultGas.limit, 0n) * safeBigInt(defaultGas.price, 0n)
      : 0n;

  // Assigned later (we want to pass it into components as a live closure).
  let syncDraft = () => {};

  const amountCtl = createAmountSliderCard({
    initialAmountDusk: typeof draft.amountDusk === "string" ? draft.amountDusk : "",
    placeholder: "Amount (DUSK, e.g. 1.25)",
    actions,
    onAmountInput: () => syncDraft(),
    onAmountChange: () => syncDraft(),
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

  const info = h("div", { class: "box" }, [
    h("div", { class: "meta-pill", text: `${fromLabel} → ${toLabel}` }),
    h("div", {
      class: "muted",
      style: "margin-top:6px",
      text:
        `Available (${fromLabel}): ${fmtAvail(avail)} DUSK` +
        (feeLux > 0n ? ` · Fee cap: ${formatLuxShort(feeLux, UI_DISPLAY_DECIMALS)} DUSK` : ""),
    }),
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
      h("label", { text: "Amount" }),
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

  const confirmBtn = h("button", { class: "btn-primary", text: "Confirm" });
  const cancelBtn = h("button", {
    class: "btn-outline",
    text: "Cancel",
    onclick: () => {
      state.route = "convert";
      actions?.render?.().catch(() => {});
    },
  });

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
  gasEditor.helpText =
    "Max fee shown is limit × price. Clear both to use node defaults.";
  gasEditor.setGas(d?.gas ?? null);

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

  const gasQuickRow = h(
    "div",
    { style: "display:flex; gap:10px; flex-wrap:wrap; justify-content:flex-end;" },
    [btnAuto, btnLow, btnRec, btnHigh]
  );

  (async () => {
    try {
      if (d?.gas) {
        gasHint.textContent = "Gas override set.";
        btnLow.disabled = true;
        btnRec.disabled = true;
        btnHigh.disabled = true;
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
        "Max fee shown is limit × price. Clear both to use node defaults.";

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

      if (defaultLimit) {
        gasEditor.setGas({ limit: defaultLimit, price: median });
      }
    } catch {
      gasHint.textContent = "Gas price unavailable (using defaults).";
      if (defaultLimit && fallbackPrice) {
        gasEditor.setGas({ limit: defaultLimit, price: fallbackPrice });
      }
    }
  })().catch(() => {});

  confirmBtn.addEventListener("click", async () => {
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Sending…";

    try {
      const gas = gasEditor.readFinalGas();
      if (state.draft) state.draft.gas = gas;

      const res = await actions?.send?.({
        type: "DUSK_UI_SEND_TX",
        params: {
          kind,
          amount: d.amountLux,
          gas: gas || undefined,
        },
      });

      if (res?.error) throw new Error(res.error.message ?? "Transaction failed");
      if (!res?.ok) throw new Error("Transaction failed");

      const hash = res.result?.hash ?? "";
      try {
        const shortHash = hash && hash.length > 18 ? `${hash.slice(0, 10)}…${hash.slice(-8)}` : hash;
        actions?.showToast?.(shortHash ? `Transaction submitted: ${shortHash}` : "Transaction submitted", 2500);
      } catch {
        // ignore
      }

      state.route = "home";
      state.draft = null;
      state.needsRefresh = true;
      await actions?.render?.({ forceRefresh: true });
    } catch (e) {
      try {
        actions?.showToast?.(e?.message ?? String(e), 3000);
      } catch {
        // ignore
      }
      confirmBtn.disabled = false;
      confirmBtn.textContent = "Confirm";
    }
  });

  return [
    subnav({
      title: "Review",
      onBack: () => {
        state.route = "convert";
        actions?.render?.().catch(() => {});
      },
    }),
    h("div", { class: "row" }, [
      h("div", { class: "muted", text: kind === TX_KIND.SHIELD ? "You are about to shield" : "You are about to unshield" }),
      h("div", { class: "meta-pill", text: `${fromLabel} → ${toLabel}` }),
      h("div", { class: "home-balance" }, [
        h("div", {
          class: "balance-amount",
          text: d.amountDusk || formatLuxToDusk(d.amountLux),
        }),
        h("div", { class: "balance-sub", text: "DUSK" }),
      ]),
      gasEditor,
      gasHint,
      gasQuickRow,
      h("div", { class: "btnrow" }, [cancelBtn, confirmBtn]),
    ]),
  ].filter(Boolean);
}
