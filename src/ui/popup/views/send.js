import { formatLuxToDusk, parseDuskToLux, safeBigInt } from "../../../shared/amount.js";
import { getDefaultGas } from "../../../shared/txDefaults.js";
import { ProfileGenerator } from "@dusk/w3sper";
import { h } from "../../lib/dom.js";
import { subnav } from "../../components/Subnav.js";
import "../../components/GasEditor.js";
import { openQrScanModal, parseDuskQrPayload } from "../../components/QrScanModal.js";
import {
  chainIdFromNodeUrlDecimal,
  chainLabel,
  normalizeChainId,
} from "../../../shared/duskUri.js";

export function sendFormView(ov, { state, actions } = {}) {
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

  const currentChain = normalizeChainId(chainIdFromNodeUrlDecimal(ov?.nodeUrl ?? ""));

  const warnChainMismatch = (reqChain) => {
    const want = normalizeChainId(reqChain);
    if (!want || !currentChain || want === currentChain) return;
    const wantLabel = chainLabel(want) || `Chain ${want}`;
    const curLabel = chainLabel(currentChain) || `Chain ${currentChain}`;
    actions?.showToast?.(`Request is for ${wantLabel}. You are on ${curLabel}.`, 4000);
  };

  const applyRequest = (req, { source = "request" } = {}) => {
    if (!req?.to) return false;

    const isDuskReq = req.kind === "public" || req.kind === "shielded";

    // Update DOM values
    to.value = req.to;

    if (isDuskReq) {
      // A full dusk: request link should define the form values.
      amount.value = req.amountDusk || "";
      memo.value = req.memo || "";
    } else {
      // A raw recipient QR should not clobber what the user already typed.
      if (req.amountDusk) amount.value = req.amountDusk;
      if (req.memo) memo.value = req.memo;
    }

    // Persist into draft so any toast-triggered render doesn't wipe the fields.
    const nextDraft = { ...(state.draft || {}) };
    nextDraft.to = to.value;

    if (isDuskReq) {
      nextDraft.amountDusk = amount.value;
      nextDraft.memo = memo.value;
    } else {
      if (req.amountDusk) nextDraft.amountDusk = amount.value;
      if (req.memo) nextDraft.memo = memo.value;
    }

    state.draft = nextDraft;

    warnChainMismatch(req.chainId);
    updateToType();

    // Show a small hint toast so user understands it worked.
    // (Toast triggers a render, hence why we persist draft first.)
    try {
      actions?.showToast?.(source === "qr" ? "Filled from QR" : "Request decoded", 1800);
    } catch {
      // ignore
    }

    return true;
  };

  const maybeDecodeRequest = (raw, { source = "request" } = {}) => {
    const s = String(raw || "").trim();
    if (!s) return false;
    const req = parseDuskQrPayload(s);
    if (!req) return false;
    return applyRequest(req, { source });
  };

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

    // Give quick feedback when the user pastes a dusk: request link.
    if (/^dusk:/i.test(v)) {
      toTypePill.style.display = "inline-flex";
      toTypePill.textContent = "Detected: Dusk request link";
      return;
    }
    const t = ProfileGenerator.typeOf(v);

    if (t === "account" || t === "address") {
      toTypePill.style.display = "inline-flex";
      toTypePill.textContent = t === "address" ? "Detected: Shielded address" : "Detected: Public account";
      return;
    }

    // Fallback: unknown format
    toTypePill.style.display = "inline-flex";
    toTypePill.textContent = "Detected: Unknown address format";
  };

  const syncDraft = () => {
    // Keep draft in sync so any toast-triggered re-render doesn't wipe inputs.
    state.draft = {
      ...(state.draft || {}),
      to: String(to.value || ""),
      amountDusk: String(amount.value || ""),
      memo: String(memo.value || ""),
      // preserve any gas edits the user may have made on the confirm screen
      gas: state.draft?.gas,
    };
  };

  to.addEventListener("input", () => {
    updateToType();
    syncDraft();
  });
  amount.addEventListener("input", syncDraft);
  memo.addEventListener("input", syncDraft);
  to.addEventListener("paste", (e) => {
    try {
      const txt = e?.clipboardData?.getData?.("text") ?? "";
      if (txt && /^dusk:/i.test(txt)) {
        e.preventDefault();
        if (!maybeDecodeRequest(txt, { source: "request" })) {
          // Fall back to normal paste
          to.value = txt;
        }
      }
    } catch {
      // ignore
    }
  });
  to.addEventListener("blur", () => {
    const v = String(to.value || "").trim();
    if (/^dusk:/i.test(v)) {
      maybeDecodeRequest(v, { source: "request" });
    }
  });
  updateToType();

  const scanBtn = h("button", {
    class: "icon-btn icon-only",
    type: "button",
    text: "▦",
    title: "Scan QR",
    onclick: async () => {
      try {
        const payload = await openQrScanModal({
          title: "Scan request",
          hint: "Scan a Dusk request QR (or choose an image)",
        });
        if (!payload) return;
        const ok = maybeDecodeRequest(payload, { source: "qr" });
        if (!ok) actions?.showToast?.("Unrecognized QR code", 2500);
      } catch (e) {
        actions?.showToast?.(e?.message ?? String(e), 3000);
      }
    },
  });

  const toRow = h("div", { class: "input-row" }, [to, scanBtn]);

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
        // Allow a dusk: request link to be pasted directly into the recipient field.
        const rawTo = to.value.trim();
        if (/^dusk:/i.test(rawTo)) {
          maybeDecodeRequest(rawTo, { source: "request" });
        }

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
    h("div", { class: "row" }, [
      h("label", { text: "To" }),
      toRow,
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
        state.route = "send";
        actions?.render?.().catch(() => {});
      },
    }),
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
