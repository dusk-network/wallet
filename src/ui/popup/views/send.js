import { formatLuxToDusk, parseDuskToLux, safeBigInt } from "../../../shared/amount.js";
import { getDefaultGas } from "../../../shared/txDefaults.js";
import { ProfileGenerator } from "@dusk/w3sper";
import { h } from "../../lib/dom.js";
import { bannerView } from "../../components/Banner.js";
import { subnav } from "../../components/Subnav.js";
import "../../components/GasEditor.js";

export function sendFormView(_ov, { state, actions } = {}) {
  const draft = state.draft || {};

  const to = h("input", {
    placeholder: "Recipient (account or shielded address)",
    value: typeof draft.to === "string" ? draft.to : "",
  });
  const amount = h("input", {
    placeholder: "Amount (DUSK, e.g. 1.25)",
    value: typeof draft.amountDusk === "string" ? draft.amountDusk : "",
  });
  const memo = h("input", {
    placeholder: "Memo (optional)",
    value: typeof draft.memo === "string" ? draft.memo : "",
  });

  // Lightweight recipient-type detection (public account vs shielded address)
  // so the user understands what kind of transfer they'll create.
  const toTypePill = h("div", { class: "meta-pill", style: "display:none" });
  const updateToType = () => {
    const v = String(to.value || "").trim();
    if (!v) {
      toTypePill.style.display = "none";
      toTypePill.textContent = "";
      return;
    }
    const t = ProfileGenerator.typeOf(v);
    toTypePill.style.display = "inline-flex";
    if (t === "account") {
      toTypePill.textContent = "Detected: Public account";
    } else if (t === "address") {
      toTypePill.textContent = "Detected: Shielded address";
    } else {
      toTypePill.textContent = "Detected: Unknown address format";
    }
  };
  to.addEventListener("input", updateToType);
  updateToType();

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

  const nextBtn = h("button", {
    class: "btn-primary",
    text: "Review",
    onclick: async () => {
      try {
        setErr("");
        const toVal = to.value.trim();
        if (!toVal) throw new Error("Recipient is required");

        const amtLux = parseDuskToLux(amount.value);
        const memoVal = memo.value.trim();

        // Keep any previously edited gas settings if the user goes back and forth.
        const prevGas = draft?.gas;

        state.draft = {
          to: toVal,
          amountLux: amtLux,
          amountDusk: amount.value.trim(),
          memo: memoVal,
          gas: prevGas,
        };
        state.route = "confirm";
        await actions?.render?.();
      } catch (e) {
        setErr(e?.message ?? String(e));
      }
    },
  });

  return [
    subnav({
      title: "Send",
      onBack: () => {
        state.route = "home";
        state.draft = null;
        actions?.render?.().catch(() => {});
      },
    }),
    bannerView(state.banner),
    h("div", { class: "row" }, [
      h("label", { text: "To" }),
      to,
      toTypePill,
      h("label", { text: "Amount" }),
      amount,
      h("label", { text: "Memo" }),
      memo,
      errBox,
      h("div", { class: "btnrow" }, [nextBtn]),
    ]),
  ].filter(Boolean);
}

export function sendConfirmView(ov, { state, actions } = {}) {
  const d = state.draft;
  if (!d) {
    state.route = "send";
    return sendFormView(ov, { state, actions });
  }

  const recType = ProfileGenerator.typeOf(String(d.to || "").trim());
  const txTypeLabel = recType === "address" ? "Shielded transfer" : "Public transfer";

  const confirmBtn = h("button", { class: "btn-primary", text: "Confirm" });
  const cancelBtn = h("button", {
    class: "btn-outline",
    text: "Cancel",
    onclick: () => {
      state.route = "send";
      actions?.render?.().catch(() => {});
    },
  });

  // Gas editor (collapsed by default)
  const defaultGas = getDefaultGas("transfer");
  const gasEditor = document.createElement("dusk-gas-editor");
  gasEditor.amountLux = d.amountLux;
  gasEditor.maxDecimals = 6;
  gasEditor.helpText = defaultGas
    ? `Default gas: ${defaultGas.limit} limit · ${defaultGas.price} price (LUX). Max fee shown is limit × price. Clear both to use node defaults.`
    : "Max fee shown is limit × price. Clear both to use node defaults.";

  // Prefer persisted draft gas, otherwise show defaults.
  gasEditor.setGas(d?.gas ?? defaultGas ?? null);

  confirmBtn.addEventListener("click", async () => {
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Sending…";
    state.banner = null;

    try {
      const gas = gasEditor.readFinalGas();

      // Persist edits so Back/forward keeps them.
      if (state.draft) state.draft.gas = gas;

      const res = await actions?.send?.({
        type: "DUSK_UI_SEND_TX",
        params: {
          kind: "transfer",
          to: d.to,
          amount: d.amountLux,
          memo: d.memo || undefined,
          gas: gas || undefined,
        },
      });

      if (res?.error) throw new Error(res.error.message ?? "Transfer failed");
      if (!res?.ok) throw new Error("Transfer failed");

      const hash = res.result?.hash ?? "";
      state.banner = {
        kind: "ok",
        text: hash ? `Sent!\nTx hash: ${hash}` : "Sent!",
      };
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
      state.banner = { kind: "error", text: e?.message ?? String(e) };
      confirmBtn.disabled = false;
      confirmBtn.textContent = "Confirm";
      await actions?.render?.();
    }
  });

  return [
    subnav({
      title: "Review",
      onBack: () => {
        state.route = "send";
        actions?.render?.().catch(() => {});
      },
    }),
    bannerView(state.banner),
    h("div", { class: "row" }, [
      h("div", { class: "muted", text: "You are about to send" }),
      h("div", { class: "meta-pill", text: `Type: ${txTypeLabel}` }),
      h("div", { class: "home-balance" }, [
        h("div", {
          class: "balance-amount",
          text: d.amountDusk || formatLuxToDusk(d.amountLux),
        }),
        h("div", { class: "balance-sub", text: "DUSK" }),
      ]),
      h("div", { class: "muted", text: "To" }),
      h("div", { class: "box" }, [h("code", { text: d.to })]),
      d.memo
        ? h("div", { class: "row" }, [
            h("div", { class: "muted", text: "Memo" }),
            h("div", { class: "box" }, [h("code", { text: d.memo })]),
          ])
        : h("div"),
      gasEditor,
      h("div", { class: "btnrow" }, [cancelBtn, confirmBtn]),
    ]),
  ].filter(Boolean);
}
