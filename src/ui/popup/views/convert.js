import { formatLuxToDusk, parseDuskToLux, safeBigInt } from "../../../shared/amount.js";
import { getDefaultGas } from "../../../shared/txDefaults.js";
import { h } from "../../lib/dom.js";
import { subnav } from "../../components/Subnav.js";
import "../../components/GasEditor.js";

function fmtAvail(lux) {
  try {
    const full = formatLuxToDusk(lux);
    return full;
  } catch {
    return "—";
  }
}

export function convertFormView(ov, { state, actions } = {}) {
  const draft = state.draft || {};
  const kind = (draft.kind === "unshield" ? "unshield" : "shield");

  const amount = h("input", {
    placeholder: "Amount (DUSK, e.g. 1.25)",
    value: typeof draft.amountDusk === "string" ? draft.amountDusk : "",
  });

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
  const shSpendLux = safeBigInt(ov?.shieldedBalance?.spendable ?? ov?.shieldedBalance?.value, 0n);
  const fromLabel = kind === "shield" ? "Public" : "Shielded";
  const toLabel = kind === "shield" ? "Shielded" : "Public";
  const avail = kind === "shield" ? pubLux : shSpendLux;

  const info = h("div", { class: "box" }, [
    h("div", { class: "muted", text: "Shield" }),
    h("div", { class: "meta-pill", text: `${fromLabel} → ${toLabel}` }),
    h("div", { class: "muted", style: "margin-top:6px", text: `Available (${fromLabel}): ${fmtAvail(avail)} DUSK` }),
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

  const modeTabs = h("div", { class: "tabs" }, [
    h(
      "button",
      {
        class: kind === "shield" ? "tab is-active" : "tab",
        onclick: () => setKind("shield"),
      },
      [h("span", { text: "Shield" })]
    ),
    h(
      "button",
      {
        class: kind === "unshield" ? "tab is-active" : "tab",
        onclick: () => setKind("unshield"),
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
      amount,
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

  const kind = d.kind === "unshield" ? "unshield" : "shield";
  const fromLabel = kind === "shield" ? "Public" : "Shielded";
  const toLabel = kind === "shield" ? "Shielded" : "Public";

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
  const gasEditor = document.createElement("dusk-gas-editor");
  gasEditor.amountLux = d.amountLux;
  gasEditor.maxDecimals = 6;
  gasEditor.helpText = defaultGas
    ? `Default gas: ${defaultGas.limit} limit · ${defaultGas.price} price (LUX). Max fee shown is limit × price. Clear both to use node defaults.`
    : "Max fee shown is limit × price. Clear both to use node defaults.";
  gasEditor.setGas(d?.gas ?? defaultGas ?? null);

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
      h("div", { class: "muted", text: kind === "shield" ? "You are about to shield" : "You are about to unshield" }),
      h("div", { class: "meta-pill", text: `${fromLabel} → ${toLabel}` }),
      h("div", { class: "home-balance" }, [
        h("div", {
          class: "balance-amount",
          text: d.amountDusk || formatLuxToDusk(d.amountLux),
        }),
        h("div", { class: "balance-sub", text: "DUSK" }),
      ]),
      gasEditor,
      h("div", { class: "btnrow" }, [cancelBtn, confirmBtn]),
    ]),
  ].filter(Boolean);
}
