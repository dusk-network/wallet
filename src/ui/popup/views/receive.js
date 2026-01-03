import { h } from "../../lib/dom.js";
import { copyToClipboard } from "../../lib/clipboard.js";
import { subnav } from "../../components/Subnav.js";
import { qrCodeEl } from "../../components/QrCode.js";
import { parseDuskToLux } from "../../../shared/amount.js";
import {
  buildDuskUri,
  chainIdFromNodeUrlDecimal,
  chainLabel,
} from "../../../shared/duskUri.js";

function normalizeRequestAmount(amountStr) {
  const raw = String(amountStr ?? "").trim();
  if (!raw) return "";

  // Allow users to type a trailing '.' (e.g. "1.") without marking it invalid.
  let s = raw;
  if (s.endsWith(".")) s = s.slice(0, -1);

  // "." becomes empty after trimming '.' -> treat as invalid.
  if (!s) return null;

  // Basic format guard.
  if (!/^\d+(\.\d+)?$/.test(s)) return null;

  // Enforce max 9 decimals (LUX precision) so we don't silently truncate.
  const parts = s.split(".");
  if (parts[1] && parts[1].length > 9) return null;

  // Validate using the canonical parser.
  try {
    parseDuskToLux(s);
  } catch {
    return null;
  }

  return s;
}

function isTauriMobileLike() {
  try {
    const runtime = document?.body?.dataset?.runtime;
    if (runtime !== "tauri") return false;
    // The desktop app can be resized small, the intent here is "mobile UI".
    return !!window?.matchMedia?.("(max-width: 600px)")?.matches;
  } catch {
    return false;
  }
}

export function receiveView(ov, { state, actions } = {}) {
  const account = ov?.accounts?.[0] ?? "";
  const address = ov?.addresses?.[0] ?? "";

  const chainId = chainIdFromNodeUrlDecimal(ov?.nodeUrl ?? "");
  const netLabel = chainLabel(chainId) || (chainId ? `Chain ${chainId}` : "");

  // Persist request fields while the user navigates around.
  const r = (state.receive ??= { tab: "shielded", amountDusk: "", memo: "" });
  const tab = r.tab === "public" ? "public" : "shielded";

  // --- Public/Shielded toggle ----------------------------------------
  const btnShielded = h("button", {
    class: "btn-outline",
    type: "button",
    text: "Shielded",
    onclick: () => {
      // Persist any in-progress edits before switching.
      r.amountDusk = amountInput.value;
      r.memo = memoInput.value;
      r.tab = "shielded";
      actions?.render?.().catch(() => {});
    },
  });
  const btnPublic = h("button", {
    class: "btn-outline",
    type: "button",
    text: "Public",
    onclick: () => {
      r.amountDusk = amountInput.value;
      r.memo = memoInput.value;
      r.tab = "public";
      actions?.render?.().catch(() => {});
    },
  });
  btnShielded.classList.toggle("is-active", tab === "shielded");
  btnPublic.classList.toggle("is-active", tab === "public");

  const tabHelp = h("div", {
    class: "muted",
    text:
      tab === "shielded"
        ? "Shielded is recommended for private receiving."
        : "Public is compatible with dApps and transparent transfers.",
  });

  // --- Inputs: amount + memo ------------------------------------------
  const amountInput = h("input", {
    placeholder: "Amount (optional, DUSK — e.g. 1.25)",
    value: typeof r.amountDusk === "string" ? r.amountDusk : "",
    inputmode: "decimal",
  });
  const memoInput = h("input", {
    placeholder: "Memo / message (optional)",
    value: typeof r.memo === "string" ? r.memo : "",
  });
  const amountErr = h("div", { class: "err", style: "display:none" });

  const setAmountErr = (txt) => {
    if (!txt) {
      amountErr.style.display = "none";
      amountErr.textContent = "";
      return;
    }
    amountErr.style.display = "block";
    amountErr.textContent = String(txt);
  };

  // --- Preview ----------------------------------------------------------
  const previewMain = h("div", { class: "receive-preview-main" });
  const previewSub = h("div", { class: "muted" });
  const previewMemo = h("div", { class: "muted", style: "display:none" });
  const previewBox = h("div", { class: "box receive-preview" }, [
    h("div", { class: "muted", text: "Preview" }),
    previewMain,
    previewSub,
    previewMemo,
  ]);

  // --- QR / Link / Copy actions ----------------------------------------
  const qrBox = h("div", { class: "box qr-box" });
  const codeEl = h("code", { text: tab === "public" ? account : address });
  const rawBox = h("div", { class: "box" }, [codeEl]);

  let curUri = "";
  let curRecipient = "";

  const copyLinkBtn = h("button", {
    class: "btn-outline",
    text: "Copy request link",
    onclick: async () => {
      if (!curUri) return;
      const ok = await copyToClipboard(curUri);
      actions?.showToast?.(ok ? "Copied request link" : "Copy failed");
    },
  });

  const shareBtn = isTauriMobileLike()
    ? h("button", {
        class: "btn-outline",
        text: "Share",
        onclick: async () => {
          if (!curUri) return;

          const parts = [previewMain.textContent, previewSub.textContent];
          if (previewMemo.style.display !== "none" && previewMemo.textContent) {
            parts.push(previewMemo.textContent);
          }
          parts.push(curUri);
          const shareText = parts.filter(Boolean).join("\n");

          // Prefer native share sheet when available.
          if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
            try {
              await navigator.share({
                title: "Dusk request",
                text: shareText,
              });
              // Some platforms resolve even when user cancels.
              actions?.showToast?.("Shared");
              return;
            } catch (e) {
              // AbortError = user cancelled share sheet.
              if (e?.name === "AbortError") return;
              // Fall back to copy.
            }
          }

          const ok = await copyToClipboard(curUri);
          actions?.showToast?.(ok ? "Share not available — link copied" : "Copy failed");
        },
      })
    : null;

  const copyRawBtn = h("button", {
    class: "btn-outline",
    text: tab === "public" ? "Copy account" : "Copy address",
    onclick: async () => {
      if (!curRecipient) return;
      const ok = await copyToClipboard(curRecipient);
      actions?.showToast?.(ok ? "Copied" : "Copy failed");
    },
  });

  const btnRow = h("div", { class: "btnrow" }, [copyLinkBtn, shareBtn, copyRawBtn].filter(Boolean));

  const updateRequest = () => {
    // Persist raw input.
    r.amountDusk = amountInput.value;
    r.memo = memoInput.value;

    const norm = normalizeRequestAmount(amountInput.value);
    const valid = norm !== null;

    if (!valid) {
      setAmountErr("Invalid amount. Use e.g. 1 or 0.123 (max 9 decimals)");
    } else {
      setAmountErr("");
    }

    const amountForUri = valid ? norm : "";
    const memoVal = String(memoInput.value ?? "").trim();

    curRecipient = tab === "public" ? account : address;
    curUri = buildDuskUri({
      kind: tab,
      recipient: curRecipient,
      chainId,
      amountDusk: amountForUri || "",
      memo: memoVal || "",
    });

    // Update QR code in-place.
    // If the amount is invalid, show the raw recipient QR so scanning still works.
    qrBox.replaceChildren(qrCodeEl(valid && curUri ? curUri : curRecipient));
    codeEl.textContent = curRecipient || "(none)";

    // Preview message
    const kindLabel = tab === "public" ? "Public" : "Shielded";
    if (amountForUri) {
      previewMain.textContent = `Request ${amountForUri} DUSK`;
    } else {
      previewMain.textContent = "Request any amount";
    }
    previewSub.textContent = `${kindLabel}${netLabel ? ` • ${netLabel}` : ""}`;
    if (memoVal) {
      previewMemo.style.display = "";
      previewMemo.textContent = `Memo: ${memoVal}`;
    } else {
      previewMemo.style.display = "none";
      previewMemo.textContent = "";
    }

    // Disable request-link actions if invalid amount or no recipient.
    copyLinkBtn.disabled = !valid || !curUri;
    if (shareBtn) shareBtn.disabled = !valid || !curUri;
    copyRawBtn.disabled = !curRecipient;
  };

  // Debounce updates so typing feels smooth on mobile.
  let t = 0;
  const schedule = () => {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = 0;
      updateRequest();
    }, 120);
  };
  amountInput.addEventListener("input", schedule);
  memoInput.addEventListener("input", schedule);

  // Initial render
  updateRequest();

  const recipientLabel = tab === "public" ? "Public account" : "Shielded address";
  const note = h("div", {
    class: "muted",
    text: "Tip: the sender can paste a dusk: request link into Send (or scan the QR) to prefill the transfer.",
  });

  return [
    subnav({
      title: "Receive",
      onBack: () => {
        state.route = "home";
        actions?.render?.().catch(() => {});
      },
    }),
    h("div", { class: "row" }, [
      h("div", { class: "srp-toggle" }, [btnShielded, btnPublic]),
      tabHelp,

      h("label", { text: "Request amount (optional)" }),
      amountInput,
      amountErr,

      h("label", { text: "Memo / message (optional)" }),
      memoInput,

      previewBox,

      h("div", { class: "divider" }),
      h("div", { class: "muted", text: recipientLabel }),
      qrBox,
      rawBox,
      btnRow,
      note,
    ]),
  ].filter(Boolean);
}
