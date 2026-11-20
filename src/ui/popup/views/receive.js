import { h } from "../../lib/dom.js";
import { copyToClipboard } from "../../lib/clipboard.js";
import { subnav } from "../../components/Subnav.js";
import { copyButton, resetCopied } from "../../components/CopyButton.js";
import { downloadQrPng, qrCodeEl, qrPngBlob } from "../../components/QrCode.js";
import { saveToDownloads, shareText } from "../../../platform/native.js";
import { isTauriRuntime } from "../../../platform/runtime.js";
import { isPhone } from "../../lib/device.js";
import { duskNameEl } from "../../components/DuskName.js";
import { fullAddressEl } from "../../components/ShortAddress.js";
import { decimalInput, fieldLabel, textInput } from "../../components/FormControls.js";
import { segmented } from "../../components/Segmented.js";
import { displayText } from "@dusk-network/app-core/text";
import { requestFileName, stamped } from "../../lib/fileNames.js";
import { shortAddress } from "../../lib/strings.js";
import { inCurrencyLine } from "../../lib/inCurrency.js";
import { makePaymentLink, requestMessage } from "@dusk-network/app-core/payment-links";
import { rememberRequest } from "../../../shared/paymentRequests.js";
import { paidAsk, paidAtOf, requestKept, requestNetwork, requestsSection } from "./requests.js";
import { amountChoices, amountForInput, formatDuskExact } from "../../../shared/amount.js";
import { amountQuestionEls } from "../../components/AmountQuestion.js";
import { chainIdFromNodeUrl } from "../../../shared/chain.js";
import { lookupPrimaryName, lookupShieldedName } from "../../../shared/duskNames.js";
import { safeText } from "../../../shared/safeText.js";
import { numbersText, safeTextEl } from "../../components/SafeText.js";

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

// A test network's name, for a request's picture and its file; "" on Mainnet.
const testNetworkOf = (ov) => {
  const name = String(ov?.networkName ?? "");
  return name && name !== "Mainnet" ? name : "";
};

/**
 * What a request's picture says under its code, for whoever gets the picture
 * alone, as the web wallet's does: that it's a request, on which test network,
 * what it asks and its memo, and whom it pays.
 * @param {{ lux: bigint | null, memo: string, to: string, name?: string, network?: string }} asked
 */
export function requestCaption({ lux, memo, to, name = "", network = "" }) {
  return [
    { size: 44, weight: 600, text: `Dusk payment request${network ? ` · ${network}` : ""}` },
    { size: 64, weight: 600, text: lux === null || lux === undefined ? "Any amount" : `${formatDuskExact(lux)} DUSK` },
    memo ? { size: 40, text: displayText(memo, { isolate: true }).text } : null,
    { size: 36, text: `To ${name ? `${name} · ` : ""}${shortAddress(to)}` },
  ].filter(Boolean);
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

  // Persist request fields while the user navigates around, for the profile,
  // wallet and network they were typed for: a switch of any starts them over;
  // a lock and its unlock, the same wallet's, don't.
  const owner = [accounts[0] ?? "", idx].join(" ");
  const switched = state.receive && state.receive.context !== state.context && state.context?.reason !== "lock";
  if (state.receive && (switched || (state.receive.owner ?? owner) !== owner)) state.receive = null;
  const r = (state.receive ??= {
    tab: "public",
    requestOpen: false,
    amountDusk: "",
    memo: "",
    context: state.context,
    owner,
  });
  Object.assign(r, { context: state.context, owner });
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

  // --- QR, then the name with its copy button, and the address in full ---
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

  // The address to read whole, and a button that copies it and says Copied in
  // words; named for what it gives, as each Copy and Share here is (Nandini's
  // and Sofía's: a request filled in, the first Copy and the first of two
  // Shares gave a client the bare address).
  const copyAddress = copyButton({
    value: () => recipient,
    label: "Copy address",
    text: "Copy address",
    className: "btn-outline receive-copy-address",
    failText: "Copy failed",
    onFail: actions?.showToast,
  });
  copyAddress.disabled = !recipient;
  const addressField = h("div", { class: "receive-field receive-field--address" }, [
    recipient
      ? fullAddressEl(recipient, { className: "receive-field__address" })
      : h("code", { class: "receive-field__address", text: "—" }),
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
  // What it asks comes to in your currency, on mainnet: the link stays in DUSK.
  const amountInCurrency = inCurrencyLine(ov, "receive-in-currency");
  const memoErr = h("div", { class: "field-error memo-error", role: "alert", hidden: true });
  // A memo with what changes how it reads, or digits that may not read as they
  // look: as the payer will see it, its codes and what to check, under the field.
  const memoShown = h("div", { class: "receive-memo-shown", role: "status", hidden: true });
  const linkErr = h("div", { class: "field-error", role: "alert", hidden: true });
  const linkNote = h("div", { class: "muted" });

  // The requests made here, drawn again on their own as one is kept, so what's pressed stays as it is.
  const requestsHost = h("div", { class: "receive-requests-host" });
  const drawRequests = () =>
    requestsHost.replaceChildren(...[requestsSection(ov, { state, actions, message: (request) => listedRequest(request)?.text ?? "", share: isTauriMobileLike() ? shareKept : null })].filter(Boolean));
  // What the form asks, as the list keeps a request.
  const askedNow = () => ({ lux: curLux, memo: curMemo, network: requestNetwork(ov), to: curRecipient });
  // When the request the form holds was paid, where it's one paid already; else null.
  const paidNow = () => (wantRequest ? paidAtOf(state, askedNow()) : null);
  // Keeps what's asked in the list as it leaves the wallet: copied, shared or
  // downloaded. Sofía's: Copy request link on an invoice paid already made a
  // second, waiting one with its number, which a client could pay again. One
  // paid already is asked of first (paidAsk) and goes as its link, the same
  // one: nothing new is kept (rememberRequest keeps none twice).
  const keepRequest = () => {
    if (!wantRequest) return;
    const asked = askedNow();
    if (paidAtOf(state, asked) !== null) return;
    rememberRequest(String(ov?.accounts?.[0] ?? ""), asked)
      .then((list) => {
        requestKept(state, list);
        drawRequests();
      })
      .catch(() => {});
  };

  // What Share and Copy give for a request, in both wallets' words
  // (app-core's requestMessage): who asks, what for, on which test network,
  // its memo, then the link. Who asks: the profile's verified .dusk name,
  // else the name given it here, else no one by name.
  const asker = () => shownName || String(ov?.accountNames?.[String(idx)] ?? "").trim() || null;
  const requestText = () =>
    requestMessage({
      name: asker(),
      lux: curLux,
      memo: curMemo,
      link: curLink,
      network: testNetworkOf(ov),
    });

  // A request paid already, given out again from the form or the buttons by
  // the address: asked of first, under the buttons pressed (paidAsk).
  const askFirst = (ask, act) => {
    const at = paidNow();
    if (at === null) return false;
    ask.open(act, at);
    return true;
  };
  // The request's copy, which Enter in the memo presses; on once the QR
  // holds a request. On a phone it stays above the keyboard with the field
  // being typed in (keyboard.js), as Send's Review does.
  const copyRequestBtn = copyButton({
    value: () => (wantRequest ? requestText() : ""),
    label: "Copy request",
    text: "Copy request",
    className: "btn-outline",
    failText: "Copy failed",
    onFail: actions?.showToast,
    onCopied: keepRequest,
    hold: () => askFirst(formAsk, "copy"),
    attrs: { "data-next": "" },
  });
  // In the app, the request's own Share, beside its Copy (Chen's and Sofía's:
  // Share sat up by the address, half under the header once the memo was typed).
  const shareTheRequest = async () => {
    if (!wantRequest || !curLink) return;
    if (await shareRequest({ text: requestText(), qrValue: curQrValue, lux: curLux, memo: curMemo, to: curRecipient })) keepRequest();
  };
  const shareRequestBtn = isTauriMobileLike()
    ? h("button", {
        class: "btn-outline",
        type: "button",
        text: "Share request",
        onclick: () => {
          if (!askFirst(formAsk, "share")) shareTheRequest();
        },
      })
    : null;
  const requestActions = shareRequestBtn ? h("div", { class: "btnrow receive-request__actions" }, [copyRequestBtn, shareRequestBtn]) : copyRequestBtn;
  // The form's question, and the one for the buttons by the address, kept with the form through a redraw.
  const formAsk = paidAsk(r, "form", {
    copy: { verb: "Copy", go: () => copyRequestBtn.pressAnyway() },
    share: { verb: "Share", go: () => shareTheRequest() },
  });

  // That a request is filled in, while the form is closed: open, its fields say what it asks.
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
        amountInCurrency.el,
        fieldLabel(memoInput, "Memo"),
        memoInput,
        memoErr,
        memoShown,
        linkErr,
        linkNote,
        requestActions,
        formAsk.el,
      ]),
    ]
  );

  // Opened with a tap: the form in view, at its Amount (Sofía's: it opened
  // below the screen's edge), not on a redraw that finds it open.
  let opening = false;
  requestDetails.querySelector("summary")?.addEventListener("click", () => {
    opening = !requestDetails.open;
  });
  requestDetails.addEventListener("toggle", () => {
    r.requestOpen = requestDetails.open;
    placeAddressRow();
    update();
    if (opening && requestDetails.open) {
      opening = false;
      requestDetails.scrollIntoView?.({ block: "start", behavior: "smooth" });
      amountInput.focus?.();
    }
  });

  const sayUnder = (el, text) => {
    el.textContent = text;
    el.hidden = !text;
  };

  // Through the phone's share sheet: the app's own, else the browser's; copied
  // where neither can. Whether it went.
  const shareOut = async (text, title, picture = {}) => {
    if (await shareText(text, title, picture)) return true;
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      try {
        await navigator.share({ title, text });
        actions?.showToast?.("Shared");
        return true;
      } catch (e) {
        if (e?.name === "AbortError") return false;
      }
    }
    const ok = await copyToClipboard(text);
    actions?.showToast?.(ok ? "Share not available — copied" : "Copy failed");
    return ok;
  };
  // A request as it goes: a few words of what it asks, its link, and its QR
  // code's picture, the one Save QR saves.
  const shareRequest = async ({ text, qrValue, lux, memo, to }) => {
    const network = testNetworkOf(ov);
    let picture = {};
    try {
      const caption = requestCaption({ lux, memo, to, name: shownName, network });
      picture = { image: new Uint8Array(await (await qrPngBlob(qrValue, { caption })).arrayBuffer()), name: requestFileName({ lux, memo }, { network }) };
    } catch {
      // Its words and link alone.
    }
    return shareOut(text, "Dusk payment request", picture);
  };
  // One in the list, as it was asked: its words and link, which its Share and
  // its Copy request both give, as the form's do, and its QR code's link.
  const listedRequest = (request) => {
    const made = makePaymentLink({ to: request.to, amountLux: request.lux === null ? "" : String(request.lux), memo: request.memo, network: chainId });
    if (!made.ok) return null;
    const lux = request.lux === null ? null : BigInt(request.lux);
    return { lux, qrValue: made.dusk, text: requestMessage({ name: asker(), lux, memo: request.memo, link: made.https ?? made.dusk, network: testNetworkOf(ov) }) };
  };
  const shareKept = (request) => {
    const listed = listedRequest(request);
    if (listed) shareRequest({ text: listed.text, qrValue: listed.qrValue, lux: listed.lux, memo: request.memo, to: request.to }).catch(() => {});
  };

  // --- Actions ---------------------------------------------------------
  const curRecipient = recipient || "";
  // The link a payer gets, which opens the web wallet's Send, and the one the QR
  // holds for a wallet to read: the same request.
  let curLink = "";
  let curUri = "";
  // The dusk: link of what the QR holds, which opens Send in the app.
  let curAppLink = "";
  let curQrValue = recipient || "";
  let wantRequest = false;
  // What the request asks, as its link says it.
  let curLux = null;
  let curMemo = "";
  let qrMenuOpen = false;

  const qrMenu = h("div", { class: "qr-context-menu", style: "display:none" });

  const downloadCurrentQr = async () => {
    if (!curQrValue) return;
    try {
      // Named by what it asks and when it was made; a request's picture says what it asks under its code.
      const network = testNetworkOf(ov);
      const name = wantRequest
        ? requestFileName({ lux: curLux, memo: curMemo }, { network })
        : stamped(`dusk-${network ? `${network.toLowerCase()}-` : ""}${tab === "shielded" ? "shielded" : "public"}-receive-qr.png`);
      const opts = wantRequest ? { caption: requestCaption({ lux: curLux, memo: curMemo, to: curRecipient, name: shownName, network }) } : {};
      // The app saves it in the phone's Downloads, and says the name Android gave it; a page, as a download.
      const saved = isTauriRuntime() ? await saveToDownloads(name, "image/png", new Uint8Array(await (await qrPngBlob(curQrValue, opts)).arrayBuffer())) : false;
      if (saved) {
        actions?.showToast?.(`QR saved to Downloads as ${saved}`);
      } else {
        await downloadQrPng(curQrValue, name, opts);
        actions?.showToast?.("QR saved");
      }
      keepRequest();
    } catch (e) {
      actions?.showToast?.(e?.message ?? "Couldn't save the QR.", 2500);
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
    text: "Save QR",
    onclick: () => {
      hideQrMenu();
      downloadCurrentQr();
    },
  });
  qrMenu.appendChild(downloadMenuItem);

  // A phone's long press opens the same menu as a right-click.
  qrCard.title = isPhone() ? "Long-press for QR options" : "Right-click for QR options";
  qrCard.addEventListener("contextmenu", (e) => {
    showQrMenu(e);
  });

  const shareBtn = isTauriMobileLike()
    ? h("button", {
        class: "btn-outline",
        type: "button",
        text: "Share address",
        // The account or address, through the phone's share sheet; a request has its own Share, beside its Copy.
        onclick: async () => {
          if (curRecipient) await shareOut(curRecipient, "Dusk address");
        },
      })
    : null;

  // In the app, beside Share: the dusk: link, which a phone with the app opens in its Send.
  const appLinkBtn = isTauriMobileLike()
    ? copyButton({
        value: () => curAppLink,
        label: "Copy app link",
        text: "Copy app link",
        className: "btn-outline",
        failText: "Copy failed",
        onFail: actions?.showToast,
        onCopied: keepRequest,
        hold: () => askFirst(rowAsk, "app"),
      })
    : null;

  const downloadBtn = h("button", {
    class: "btn-outline",
    type: "button",
    text: "Save QR",
    onclick: () => {
      if (!askFirst(rowAsk, "download")) downloadCurrentQr();
    },
  });

  const btnRow = h(
    "div",
    { class: "btnrow btnrow--grid receive-address-actions" },
    [copyAddress, shareBtn, appLinkBtn, downloadBtn].filter(Boolean)
  );
  const rowAsk = paidAsk(r, "row", {
    ...(appLinkBtn ? { app: { verb: "Copy", go: () => appLinkBtn.pressAnyway() } } : {}),
    download: { verb: "Save", go: () => downloadCurrentQr() },
  });
  // While a request is being made, its Copy and Share come first: the
  // address's buttons go below the form, and back above it once it's closed.
  const placeAddressRow = () => {
    const parent = requestDetails.parentNode;
    if (!parent) return;
    const anchor = requestDetails.open ? requestDetails.nextSibling : requestDetails;
    parent.insertBefore(btnRow, anchor);
    parent.insertBefore(rowAsk.el, btnRow.nextSibling);
  };

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
    // An amount that could be read two ways: the question, with a button for each reading.
    const twoWays = requestDetails.open && made.problems.amount ? amountChoices(amountInput.value) : null;
    if (twoWays) {
      amountErr.replaceChildren(
        ...amountQuestionEls(twoWays, {
          onPick: (picked) => {
            amountInput.value = picked;
            r.amountDusk = picked;
            amountInput.focus();
            update();
          },
        })
      );
      amountErr.hidden = false;
    } else {
      sayUnder(amountErr, requestDetails.open ? made.problems.amount ?? "" : "");
    }
    sayUnder(memoErr, requestDetails.open ? made.problems.memo ?? "" : "");
    sayUnder(linkErr, requestDetails.open && curRecipient ? made.problems.to ?? "" : "");

    const memoVal = String(memoInput.value ?? "").trim();
    const { checks } = safeText(memoVal);
    const flagged = Boolean(memoVal && (checks.hidden || numbersText(checks)));
    memoShown.replaceChildren(...(flagged ? [safeTextEl(memoVal)] : []));
    memoShown.hidden = !flagged;
    const hasReq = !!memoVal || made.lux !== null;
    curLux = made.lux;
    amountInCurrency.set(made.ok ? made.lux : null);
    curMemo = memoVal;
    const asked = curLink;

    curUri = made.dusk;
    // Where the network has no web wallet, the one link there is.
    curLink = made.https ?? made.dusk;
    linkNote.textContent = made.https ? "The QR holds the request. The link opens the web wallet's Send, filled in." : "The QR holds the request.";
    linkNote.hidden = !made.ok;
    // Copied was about the link before.
    if (curLink !== asked) resetCopied(copyRequestBtn);

    wantRequest = !!(requestDetails.open && valid && hasReq && curUri);

    // QR encodes the request only when the request panel is open and has content.
    const qrValue = wantRequest ? curUri : curRecipient;
    curAppLink = wantRequest ? curUri : (curRecipient && makePaymentLink({ to: curRecipient, network: chainId }).dusk) || "";
    curQrValue = qrValue || "";
    qrCard.replaceChildren(qrCodeEl(qrValue || ""));

    // The fields copy the name and the address; the request is copied here,
    // its Copy and Share the ones that lead while it's made.
    copyRequestBtn.disabled = !wantRequest;
    if (shareRequestBtn) shareRequestBtn.disabled = !wantRequest;
    for (const button of [copyRequestBtn, shareRequestBtn].filter(Boolean)) button.className = wantRequest ? "btn-primary" : "btn-outline";
    summaryMeta.textContent = !wantRequest && hasReq && valid ? "Configured" : "";

    downloadBtn.disabled = !curQrValue;
    if (!curQrValue) hideQrMenu();
    if (shareBtn) shareBtn.disabled = !curRecipient;
    if (appLinkBtn) appLinkBtn.disabled = !curAppLink;
  }

  // Initial
  update();
  drawRequests();

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
      ...(requestDetails.open ? [requestDetails, btnRow, rowAsk.el] : [btnRow, rowAsk.el, requestDetails]),
      requestsHost,
      qrMenu,
    ]),
  ].filter(Boolean);
}
