import { h } from "../../lib/dom.js";
import { copyToClipboard } from "../../lib/clipboard.js";
import { subnav } from "../../components/Subnav.js";
import { copyButton, resetCopied } from "../../components/CopyButton.js";
import { downloadQrPng, qrCodeEl } from "../../components/QrCode.js";
import { duskNameEl } from "../../components/DuskName.js";
import { shortAddressEl } from "../../components/ShortAddress.js";
import { decimalInput, fieldLabel, textInput } from "../../components/FormControls.js";
import { segmented } from "../../components/Segmented.js";
import { formatDuskPlain } from "@dusk-network/app-core/amounts";
import { makePaymentLink } from "@dusk-network/app-core/payment-links";
import { amountForInput } from "../../../shared/amount.js";
import { chainIdFromNodeUrl } from "../../../shared/chain.js";
import { lookupPrimaryName, lookupShieldedName } from "../../../shared/duskNames.js";

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
  const rail = tab === "shielded" ? "shielded" : "public";
  return request ? `dusk-${rail}-request-qr.png` : `dusk-${rail}-receive-qr.png`;
}

let nameNotes = 0;

export function receiveView(ov, { state, actions } = {}) {
  const accounts = Array.isArray(ov?.accounts) ? ov.accounts : [];
  const addresses = Array.isArray(ov?.addresses) ? ov.addresses : [];
  const idxRaw = Number(ov?.selectedAccountIndex ?? 0);
  const idx = Number.isFinite(idxRaw) && idxRaw >= 0 ? Math.floor(idxRaw) : 0;

  const account = accounts[idx] ?? accounts[0] ?? "";
  const address = addresses[idx] ?? addresses[0] ?? "";

  // The network a request is for: the chain this node signs for, or for one that hasn't said, its own ID.
  const chainId = Number.isInteger(ov?.chainId) ? ov.chainId : chainIdFromNodeUrl(ov?.nodeUrl ?? "");

  // Persist request fields while the user navigates around.
  const r = (state.receive ??= {
    tab: "public",
    requestOpen: false,
    amountDusk: "",
    memo: "",
  });
  const tab = r.tab === "shielded" ? "shielded" : "public";

  // Current recipient string
  const recipient = tab === "public" ? account : address;

  // --- Public or shielded: a tab list that says which is picked -------
  const tabToggle = segmented({
    label: "Receive to",
    className: "tabs--mini",
    items: [
      { id: "public", text: "Public" },
      { id: "shielded", text: "Shielded" },
    ],
    selected: tab,
    onSelect: (next) => {
      // Persist any in-progress edits before switching.
      r.amountDusk = amountInput.value;
      r.memo = memoInput.value;
      r.tab = next;
      actions?.render?.().catch(() => {});
    },
  });

  // --- QR, then the name and the address, each with a copy button -----
  const qrCard = h("div", { class: "box qr-box receive-qr-card" });

  // An icon button that copies what `value` gives and says Copied on itself.
  const copyIcon = (label, value) =>
    copyButton({ value, label, className: "receive-copy", failText: "Copy failed", onFail: actions?.showToast });

  // The account's verified .dusk name; beside the shielded address only when the name pays there too.
  const nameLookup =
    tab === "public"
      ? lookupPrimaryName(account, { nodeUrl: ov?.nodeUrl })
      : lookupShieldedName(account, address, { nodeUrl: ov?.nodeUrl });
  let shownName = "";

  // What people reach through that name, said under it.
  const nameNote = h("p", {
    class: "receive-name-note",
    id: `receive-name-note-${++nameNotes}`,
    hidden: true,
  });

  const nameField = h("div", { class: "receive-field", hidden: true }, [
    duskNameEl(nameLookup, { className: "receive-field__name" }),
    copyIcon("Copy name", () => shownName),
  ]);
  nameLookup.then((name) => {
    if (!name) return;
    shownName = name;
    nameNote.textContent =
      tab === "public"
        ? `People who send to ${name} reach this public account.`
        : `People who pay ${name} choose public or shielded. Anyone can see this address belongs to ${name}.`;
    nameField.hidden = false;
    nameNote.hidden = false;
  });

  const copyAddress = copyIcon("Copy address", () => recipient);
  copyAddress.disabled = !recipient;
  const addressField = h("div", { class: "receive-field" }, [
    recipient
      ? shortAddressEl(recipient, { className: "receive-field__address" })
      : h("code", { class: "receive-field__address", text: "—" }),
    copyAddress,
  ]);

  // --- Request payment (progressive disclosure) -----------------------
  const amountInput = decimalInput({
    placeholder: `Optional, e.g. ${amountForInput("1.25")} DUSK`,
    value: typeof r.amountDusk === "string" ? r.amountDusk : "",
    onEnter: () => memoInput.focus(),
  });
  const memoInput = textInput({
    placeholder: "Optional",
    value: typeof r.memo === "string" ? r.memo : "",
    onEnter: () => copyRequestBtn.click(),
  });
  const amountErr = h("div", { class: "field-error receive-amount-error", role: "alert", hidden: true });
  const memoErr = h("div", { class: "field-error memo-error", role: "alert", hidden: true });
  const linkErr = h("div", { class: "field-error", role: "alert", hidden: true });
  const linkNote = h("div", { class: "muted" });

  // The request link's copy, which Enter in the memo presses; on once the QR holds a request.
  const copyRequestBtn = copyButton({
    value: () => (wantRequest ? curLink : ""),
    label: "Copy request link",
    text: "Copy request link",
    className: "btn-outline",
    failText: "Copy failed",
    onFail: actions?.showToast,
  });

  // What the QR asks for, once it holds a request.
  const summaryMeta = h("span", { class: "receive-request__meta" });

  const requestDetails = h(
    "details",
    { class: "advanced receive-request", open: !!r.requestOpen },
    [
      h("summary", {}, [h("span", { text: "Request payment" }), summaryMeta]),
      h("div", { class: "advanced-body" }, [
        fieldLabel(amountInput, "Amount"),
        amountInput,
        amountErr,
        fieldLabel(memoInput, "Memo"),
        memoInput,
        memoErr,
        linkErr,
        linkNote,
        copyRequestBtn,
      ]),
    ]
  );

  requestDetails.addEventListener("toggle", () => {
    r.requestOpen = requestDetails.open;
    update();
  });

  const sayUnder = (el, text) => {
    el.textContent = text;
    el.hidden = !text;
  };

  // --- Actions ---------------------------------------------------------
  const curRecipient = recipient || "";
  // The link a payer gets, which opens the web wallet's Send, and the one the QR
  // holds for a wallet to read: the same request.
  let curLink = "";
  let curUri = "";
  let curQrValue = recipient || "";
  let wantRequest = false;
  let qrMenuOpen = false;

  const qrMenu = h("div", { class: "qr-context-menu", style: "display:none" });

  const downloadCurrentQr = async () => {
    if (!curQrValue) return;
    try {
      await downloadQrPng(curQrValue, qrFilename({ request: wantRequest, tab }));
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

  const shareBtn = isTauriMobileLike()
    ? h("button", {
        class: "btn-outline",
        text: "Share",
        onclick: async () => {
          const shareValue = wantRequest && curLink ? curLink : curRecipient;
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
    shareBtn ? [shareBtn, downloadBtn] : [downloadBtn]
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
    wantRequest = false;

    // The checks Send has, so the link is one the payer can use. Said only with the panel open.
    const made = makePaymentLink({ to: curRecipient, amount: amountInput.value, memo: memoInput.value, network: chainId });
    const valid = made.ok;
    sayUnder(amountErr, requestDetails.open ? made.problems.amount ?? "" : "");
    sayUnder(memoErr, requestDetails.open ? made.problems.memo ?? "" : "");
    sayUnder(linkErr, requestDetails.open && curRecipient ? made.problems.to ?? "" : "");

    const memoVal = String(memoInput.value ?? "").trim();
    const hasReq = !!memoVal || made.lux !== null;
    const asked = curLink;

    curUri = made.dusk;
    // Where the network has no web wallet, the one link there is.
    curLink = made.https ?? made.dusk;
    linkNote.textContent = made.https ? "The QR holds what you ask for. The link opens the web wallet's Send, filled in." : "The QR holds what you ask for.";
    linkNote.hidden = !made.ok;
    // Copied was about the link before.
    if (curLink !== asked) resetCopied(copyRequestBtn);

    wantRequest = !!(requestDetails.open && valid && hasReq && curUri);

    // QR encodes the request only when the request panel is open and has content.
    const qrValue = wantRequest ? curUri : curRecipient;
    curQrValue = qrValue || "";
    qrCard.replaceChildren(qrCodeEl(qrValue || ""));

    // The fields copy the name and the address; the request link is copied here.
    copyRequestBtn.disabled = !wantRequest;
    if (wantRequest) {
      summaryMeta.textContent = made.lux !== null ? `${amountForInput(formatDuskPlain(made.lux))} DUSK` : "With memo";
    } else {
      summaryMeta.textContent = hasReq && valid ? "Configured" : "";
    }

    downloadBtn.disabled = !curQrValue;
    if (!curQrValue) hideQrMenu();
    if (shareBtn) shareBtn.disabled = !curRecipient;
  }

  // Initial
  update();

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
      h("div", { class: "receive-fields" }, [nameField, addressField]),
      nameNote,
      btnRow,
      requestDetails,
      qrMenu,
    ]),
  ].filter(Boolean);
}
