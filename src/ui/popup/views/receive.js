import { h } from "../../lib/dom.js";
import { copyToClipboard } from "../../lib/clipboard.js";
import { subnav } from "../../components/Subnav.js";
import { downloadQrPng, qrCodeEl } from "../../components/QrCode.js";
import { identiconEl } from "../../components/Identicon.js";
import { decimalInput, textInput } from "../../components/FormControls.js";
import { parseDuskToLux } from "../../../shared/amount.js";
import { chainIdFromNodeUrl } from "../../../shared/chain.js";
import {
  buildDuskUri,
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

function qrFilename({ request, tab } = {}) {
  const rail = tab === "public" ? "public" : "shielded";
  return request ? `dusk-${rail}-request-qr.png` : `dusk-${rail}-receive-qr.png`;
}

export function receiveView(ov, { state, actions } = {}) {
  const accounts = Array.isArray(ov?.accounts) ? ov.accounts : [];
  const addresses = Array.isArray(ov?.addresses) ? ov.addresses : [];
  const idxRaw = Number(ov?.selectedAccountIndex ?? 0);
  const idx = Number.isFinite(idxRaw) && idxRaw >= 0 ? Math.floor(idxRaw) : 0;

  const account = accounts[idx] ?? accounts[0] ?? "";
  const address = addresses[idx] ?? addresses[0] ?? "";

  const chainId = chainIdFromNodeUrl(ov?.nodeUrl ?? "");

  // Persist request fields while the user navigates around.
  const r = (state.receive ??= {
    tab: "shielded",
    requestOpen: false,
    amountDusk: "",
    memo: "",
  });
  const tab = r.tab === "public" ? "public" : "shielded";

  // Current recipient string
  const recipient = tab === "public" ? account : address;
  const recipientLabel = tab === "public" ? "account" : "address";

  // --- Public/Shielded toggle (segmented) -----------------------------
  const tabShielded = h("button", {
    class: "tab",
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
  const tabPublicBtn = h("button", {
    class: "tab",
    type: "button",
    text: "Public",
    onclick: () => {
      r.amountDusk = amountInput.value;
      r.memo = memoInput.value;
      r.tab = "public";
      actions?.render?.().catch(() => {});
    },
  });

  const segIndex = tab === "public" ? 1 : 0;
  tabShielded.classList.toggle("is-active", segIndex === 0);
  tabPublicBtn.classList.toggle("is-active", segIndex === 1);

  const tabToggle = h(
    "div",
    {
      class: "tabs tabs--mini",
      style: `--seg-index:${segIndex}; --seg-count:2;`,
      title: "Choose the receiving address type",
    },
    [tabShielded, tabPublicBtn]
  );

  // --- QR + chip -------------------------------------------------------
  const qrCard = h("div", { class: "box qr-box receive-qr-card" });

  const chipIcon = h("div", { class: "receive-chip-icon" });
  const chipKind = h("div", { class: "receive-chip-kind" });
  const chipText = h("code", { class: "receive-chip-text" });
  const chipMain = h("div", { class: "receive-chip-main" }, [chipKind, chipText]);
  const chipCopy = h("div", { class: "receive-chip-copy", text: "⧉" });
  const addressChip = h(
    "button",
    {
      class: "receive-chip",
      type: "button",
      title: recipient ? `${recipient}` : "",
      onclick: async () => {
        if (!curRecipient) return;
        const ok = await copyToClipboard(curRecipient);
        actions?.showToast?.(ok ? `Copied ${recipientLabel}` : "Copy failed");
      },
    },
    [chipIcon, chipMain, chipCopy]
  );

  // --- Request payment (progressive disclosure) -----------------------
  const amountInput = decimalInput({
    placeholder: "Amount (optional, DUSK)",
    value: typeof r.amountDusk === "string" ? r.amountDusk : "",
    onEnter: () => memoInput.focus(),
  });
  const memoInput = textInput({
    placeholder: "Memo (optional)",
    value: typeof r.memo === "string" ? r.memo : "",
    onEnter: () => copyBtn.click(),
  });
  const amountErr = h("div", { class: "err", style: "display:none" });

  const summaryMeta = h("span", { class: "muted", text: "Optional" });
  const summaryChev = h("span", { class: "accordion-chev", text: "▾", "aria-hidden": "true" });

  const requestDetails = h(
    "details",
    { class: "receive-accordion", open: !!r.requestOpen },
    [
      h(
        "summary",
        { class: "receive-accordion__summary" },
        [
          h("span", { class: "receive-accordion__title", text: "Request payment" }),
          h("span", { class: "receive-accordion__meta" }, [summaryMeta, summaryChev]),
        ]
      ),
      h("div", { class: "receive-accordion__body" }, [
        h("label", { text: "Amount (optional)" }),
        amountInput,
        amountErr,
        h("label", { text: "Memo (optional)" }),
        memoInput,
        h("div", {
          class: "muted",
          text: "The QR updates to a dusk: request link.",
        }),
      ]),
    ]
  );

  requestDetails.addEventListener("toggle", () => {
    r.requestOpen = requestDetails.open;
    update();
  });

  const setAmountErr = (txt) => {
    if (!txt) {
      amountErr.style.display = "none";
      amountErr.textContent = "";
      return;
    }
    amountErr.style.display = "block";
    amountErr.textContent = String(txt);
  };

  // --- Actions ---------------------------------------------------------
  let curRecipient = recipient || "";
  let curUri = "";
  let curQrValue = recipient || "";
  let curCopyValue = recipient || "";
  let curCopyToast = tab === "public" ? "Copied account" : "Copied address";
  let wantRequest = false;
  let qrMenuOpen = false;

  const qrMenu = h("div", { class: "qr-context-menu", style: "display:none" });

  const downloadCurrentQr = async () => {
    if (!curQrValue) return;
    try {
      await downloadQrPng(curQrValue, qrFilename({ request: wantRequest, tab: r.tab }));
      actions?.showToast?.("Downloaded QR PNG");
    } catch (e) {
      actions?.showToast?.(e?.message ?? "QR download failed", 2500);
    }
  };

  const hideQrMenu = () => {
    qrMenuOpen = false;
    qrMenu.style.display = "none";
    document.removeEventListener("click", closeQrMenuFromDocument);
    document.removeEventListener("keydown", closeQrMenuFromKeyboard);
  };

  const closeQrMenuFromDocument = (e) => {
    if (qrMenu.contains(e.target)) return;
    hideQrMenu();
  };

  const closeQrMenuFromKeyboard = (e) => {
    if (e.key === "Escape") hideQrMenu();
  };

  const showQrMenu = (event) => {
    if (!curQrValue) return;
    event.preventDefault();
    qrMenuOpen = true;
    qrMenu.style.display = "block";
    qrMenu.style.left = `${Math.max(8, event.clientX)}px`;
    qrMenu.style.top = `${Math.max(8, event.clientY)}px`;
    setTimeout(() => {
      document.addEventListener("click", closeQrMenuFromDocument);
      document.addEventListener("keydown", closeQrMenuFromKeyboard);
    }, 0);
  };

  const downloadMenuItem = h("button", {
    class: "qr-context-menu__item",
    type: "button",
    text: "Download QR PNG",
    onclick: () => {
      hideQrMenu();
      downloadCurrentQr();
    },
  });
  qrMenu.appendChild(downloadMenuItem);

  qrCard.title = "Right-click for QR options";
  qrCard.addEventListener("contextmenu", (e) => {
    showQrMenu(e);
  });

  const copyBtn = h("button", {
    class: "btn-primary",
    text: tab === "public" ? "Copy account" : "Copy address",
    onclick: async () => {
      if (!curCopyValue) return;
      const ok = await copyToClipboard(curCopyValue);
      actions?.showToast?.(ok ? curCopyToast : "Copy failed");
    },
  });

  const shareBtn = isTauriMobileLike()
    ? h("button", {
        class: "btn-outline",
        text: "Share",
        onclick: async () => {
          const shareValue = wantRequest && curUri ? curUri : curRecipient;
          if (!shareValue) return;

          // Prefer native share sheet when available.
          if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
            try {
              await navigator.share({
                title: "Dusk request",
                text: shareValue,
              });
              actions?.showToast?.("Shared");
              return;
            } catch (e) {
              if (e?.name === "AbortError") return;
            }
          }

          const ok = await copyToClipboard(shareValue);
          actions?.showToast?.(ok ? "Share not available — copied" : "Copy failed");
        },
      })
    : null;

  const downloadBtn = h("button", {
    class: "btn-outline",
    text: "Download QR PNG",
    onclick: downloadCurrentQr,
  });

  const btnRow = h(
    "div",
    { class: "btnrow btnrow--grid" },
    shareBtn ? [copyBtn, shareBtn, downloadBtn] : [copyBtn, downloadBtn]
  );

  // --- Live update -----------------------------------------------------
  let t = 0;
  const schedule = () => {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = 0;
      update();
    }, 100);
  };

  amountInput.addEventListener("input", () => {
    r.amountDusk = amountInput.value;
    schedule();
  });

  memoInput.addEventListener("input", () => {
    r.memo = memoInput.value;
    schedule();
  });

  function update() {
    curRecipient = (r.tab === "public" ? account : address) || "";
    wantRequest = false;

    // Update chip
    chipIcon.replaceChildren(identiconEl(curRecipient || "dusk"));
    chipKind.textContent = r.tab === "public" ? "Public account" : "Shielded address";
    chipText.textContent = curRecipient || "—";
    addressChip.title = curRecipient || "";

    // Validate request fields
    const norm = normalizeRequestAmount(amountInput.value);
    const amountValid = norm !== null;
    const memoVal = String(memoInput.value ?? "").trim();

    // Only show amount errors when the request panel is open and the user typed something.
    if (requestDetails.open && norm === null) {
      setAmountErr("Invalid amount (max 9 decimals)");
    } else {
      setAmountErr("");
    }

    const amountForUri = amountValid ? norm : "";
    const hasReq = !!memoVal || !!amountForUri;

    curUri = amountValid
      ? buildDuskUri({
          kind: r.tab === "public" ? "public" : "shielded",
          recipient: curRecipient,
          chainId,
          amountDusk: amountForUri || "",
          memo: memoVal || "",
        })
      : "";

    wantRequest = !!(requestDetails.open && amountValid && hasReq && curUri);

    // QR encodes the request only when the request panel is open and has content.
    const qrValue = wantRequest ? curUri : curRecipient;
    curQrValue = qrValue || "";
    qrCard.replaceChildren(qrCodeEl(qrValue || ""));

    // Copy button is smart: address by default, request when configured.
    if (wantRequest) {
      copyBtn.textContent = "Copy request link";
      curCopyValue = curUri;
      curCopyToast = "Copied request link";
      summaryMeta.textContent = amountForUri
        ? `${amountForUri} DUSK`
        : memoVal
          ? "With memo"
          : "Optional";
    } else {
      copyBtn.textContent = r.tab === "public" ? "Copy account" : "Copy address";
      curCopyValue = curRecipient;
      curCopyToast = r.tab === "public" ? "Copied account" : "Copied address";
      summaryMeta.textContent = hasReq ? "Configured" : "Optional";
    }

    copyBtn.disabled = !curCopyValue;
    downloadBtn.disabled = !curQrValue;
    if (!curQrValue) hideQrMenu();
    addressChip.disabled = !curRecipient;
    if (shareBtn) shareBtn.disabled = !curRecipient;
  }

  // Initial
  update();

  const note = h("div", {
    class: "muted",
    text: "Send can read this QR directly.",
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
      tabToggle,
      qrCard,
      addressChip,
      btnRow,
      requestDetails,
      note,
      qrMenu,
    ]),
  ].filter(Boolean);
}
