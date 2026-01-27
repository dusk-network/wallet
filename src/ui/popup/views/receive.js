import { h } from "../../lib/dom.js";
import { copyToClipboard } from "../../lib/clipboard.js";
import { subnav } from "../../components/Subnav.js";
import { qrCodeEl } from "../../components/QrCode.js";
import { identiconEl } from "../../components/Identicon.js";
import { truncateMiddle } from "../../lib/strings.js";
import { parseDuskToLux } from "../../../shared/amount.js";
import {
  buildDuskUri,
  chainIdFromNodeUrlDecimal,
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
  const chipText = h("div", { class: "receive-chip-text" });
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
    [chipIcon, chipText, chipCopy]
  );

  // --- Request payment (progressive disclosure) -----------------------
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
          text: "When a request is set, the QR encodes a dusk: link so Send can auto‑fill.",
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
  let curCopyValue = recipient || "";
  let curCopyToast = tab === "public" ? "Copied account" : "Copied address";
  let wantRequest = false;

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

  const btnRow = h(
    "div",
    { class: shareBtn ? "btnrow btnrow--grid" : "btnrow" },
    shareBtn ? [copyBtn, shareBtn] : [copyBtn]
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
    chipText.textContent = curRecipient
      ? truncateMiddle(curRecipient, 10, 8)
      : "—";
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
    addressChip.disabled = !curRecipient;
    if (shareBtn) shareBtn.disabled = !curRecipient;
  }

  // Initial
  update();

  const note = h("div", {
    class: "muted",
    text: "Tip: paste or scan the QR in Send to auto‑fill the transaction.",
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
    ]),
  ].filter(Boolean);
}
