import { formatDusk, formatFee, groupThousands, safeBigInt } from "../../../shared/amount.js";
import { explorerTxUrl } from "../../../shared/explorer.js";
import { openUrl } from "../../../platform/index.js";
import { isExtensionRuntime } from "../../../platform/runtime.js";
import { h } from "../../lib/dom.js";
import { copyToClipboard } from "../../lib/clipboard.js";
import { shortAddress } from "../../lib/strings.js";
import { txErrorText } from "./txDisplay.js";
import { zonedClockText } from "../../lib/time.js";
import { iconSvg } from "../../components/ActionIcon.js";
import { balance, balancesHidden } from "../../components/Balance.js";

// After Confirm the popup shows the transaction's steps rather than going home
// with a toast: Sending while the wallet signs it and hands it to the network,
// Sent to the network once the network took it, then Completed or Failed as
// the wallet's watcher reports. The watcher's events come through app.js,
// which writes them on `state.sent`; the overview's record of the transaction
// fills in what an event left out.

const FINAL = new Set(["executed", "failed", "removed"]);

// Errors that mean the wallet or the node refused the transaction before it
// ran: nothing went out, so there is no fee. Anything else (a reply that got
// lost, a timeout, a failure after the hand-over) may have reached the network.
// "Wallet changed while …" is the engine finding another network, profile or
// wallet than the one the transaction was reviewed on.
const REFUSED =
  /wallet locked|wallet (or network )?changed while|invalid|insufficient|not enough|exceed|must be|minimum|too (low|high|small|large)|nonce|balance|rejected|refused|denied|does not accept|cannot include|not configured|is required|unauthori[sz]ed/i;

// Why a send stopped before it went to the wallet: a switch started meanwhile.
const SWITCHED = "The network or profile changed meanwhile.";

/**
 * Whether a send's error says it was refused before it ran (true), rather
 * than leaving open whether it reached the network.
 * @param {string} error
 */
export function sendRefused(error) {
  const text = String(error ?? "").trim();
  return Boolean(text) && REFUSED.test(text);
}

let sentSeq = 0;

// "13:21 CET": when it was sent, with the time zone it shows in.
function clock(ts) {
  return zonedClockText(Number(ts) || Date.now());
}

/** An error as a short sentence: one line, at most 140 characters, ending in a full stop. */
export function reasonText(error) {
  const text = String(error ?? "").trim().replace(/\s+/g, " ");
  if (!text) return "";
  const short = text.length > 140 ? `${text.slice(0, 139)}…` : text;
  return /[.!?…]$/.test(short) ? short : `${short}.`;
}

/**
 * What the Sent screen knows: `state.sent`, with the overview's record of the
 * transaction for whatever a watcher event didn't bring.
 * @param {object} sent - state.sent
 * @param {object} [ov] - the overview
 */
export function sentStatus(sent, ov) {
  const rec =
    sent?.hash && Array.isArray(ov?.txs) ? ov.txs.find((t) => String(t?.hash ?? "") === sent.hash) : null;
  const own = String(sent?.status ?? "").toLowerCase();
  const recorded = String(rec?.status ?? "").toLowerCase();
  // A final word wins, from whichever source has one.
  const status = FINAL.has(own) ? own : FINAL.has(recorded) ? recorded : own || recorded || "submitted";
  return {
    phase: sent?.phase ?? "sending",
    status,
    error: sent?.error || rec?.error || "",
    feePaid: sent?.feePaid ?? rec?.feePaid ?? null,
    blockHeight: sent?.blockHeight ?? rec?.blockHeight ?? null,
  };
}

/**
 * The three steps and where each stands: done, current, upcoming or failed.
 * @param {object} sent - state.sent
 * @param {object} [ov]
 * @returns {Array<{ label: string, state: "done"|"current"|"upcoming"|"failed", sub: string }>}
 */
export function sentSteps(sent, ov) {
  const { phase, status, error, feePaid, blockHeight } = sentStatus(sent, ov);
  const sentLine = [clock(sent?.sentAt || sent?.startedAt), sent?.from].filter(Boolean).join(" · ");
  const capLux = safeBigInt(sent?.feeCapLux ?? 0, 0n);
  const charged = feePaid != null ? `Fee charged: ${formatFee(feePaid)} DUSK.` : capLux > 0n ? `Fee charged: up to ${formatFee(capLux, { max: true })} DUSK.` : "";

  if (phase === "not_sent") {
    return [
      { label: "Not sent", state: "failed", sub: [reasonText(error), "No fee was charged."].filter(Boolean).join(" ") },
      { label: "Sent to the network", state: "upcoming", sub: "" },
      { label: "Completed", state: "upcoming", sub: "" },
    ];
  }
  if (phase === "unconfirmed") {
    return [
      {
        label: "Not confirmed",
        state: "unknown",
        sub: [reasonText(error), "It may still have reached the network: check Activity before you send it again."]
          .filter(Boolean)
          .join(" "),
      },
      { label: "Sent to the network", state: "upcoming", sub: "" },
      { label: "Completed", state: "upcoming", sub: "" },
    ];
  }
  if (phase === "sending") {
    return [
      { label: "Sending", state: "current", sub: "Signing it and handing it to the network" },
      { label: "Sent to the network", state: "upcoming", sub: "" },
      { label: "Completed", state: "upcoming", sub: "" },
    ];
  }

  const sending = { label: "Sending", state: "done", sub: sentLine };
  if (status === "executed") {
    const height = safeBigInt(blockHeight ?? 0, 0n);
    return [
      sending,
      { label: "Sent to the network", state: "done", sub: "" },
      { label: "Completed", state: "done", sub: height > 0n ? `In block ${groupThousands(height.toString())}` : "" },
    ];
  }
  if (status === "failed") {
    return [
      sending,
      { label: "Sent to the network", state: "done", sub: "" },
      {
        label: "Failed",
        state: "failed",
        sub: [txErrorText(error) || reasonText(error) || "It didn't go through.", charged].filter(Boolean).join(" "),
      },
    ];
  }
  if (status === "removed") {
    return [
      sending,
      { label: "Sent to the network", state: "done", sub: "" },
      { label: "Failed", state: "failed", sub: "The network dropped it before it ran. No fee was charged." },
    ];
  }
  return [
    sending,
    {
      label: "Sent to the network",
      state: "current",
      sub:
        status === "unknown"
          ? "Taking longer than usual. It can still go through; the explorer shows where it is."
          : "Waiting for a block, usually about 10 seconds",
    },
    { label: "Completed", state: "upcoming", sub: "" },
  ];
}

/**
 * Writes what the wallet's watcher reports (a DUSK_UI_TX_STATUS message) on
 * the Sent screen's state when it is about that transaction.
 * @param {object|null} sent - state.sent
 * @param {object} msg - { hash, status, error?, feePaid?, blockHeight? }
 * @returns {boolean} whether it was the Sent screen's transaction
 */
export function noteTxStatus(sent, msg) {
  const hash = String(msg?.hash ?? "");
  if (!sent || !hash || sent.hash !== hash) return false;
  sent.status = String(msg?.status ?? "").toLowerCase() || sent.status;
  // Only a failure's error is a reason to show; other statuses carry the
  // watcher's own codes.
  if (sent.status === "failed" && msg?.error) sent.error = String(msg.error);
  if (msg?.feePaid != null) sent.feePaid = String(msg.feePaid);
  if (msg?.blockHeight != null) sent.blockHeight = String(msg.blockHeight);
  return true;
}

/** Whether the steps have stopped: completed, failed, or never sent. */
export function sentIsFinal(sent, ov) {
  const { phase, status } = sentStatus(sent, ov);
  return phase === "not_sent" || phase === "unconfirmed" || (phase === "sent" && FINAL.has(status));
}

/**
 * One sentence for screen readers when the steps move on.
 * @param {object} sent
 * @param {object} [ov]
 */
export function sentAnnouncement(sent, ov) {
  const steps = sentSteps(sent, ov);
  const at = steps.find((s) => s.state === "failed") ?? steps.filter((s) => s.state !== "upcoming").at(-1);
  return at ? [at.label, at.sub].filter(Boolean).join(". ") : "";
}

/**
 * Sends a reviewed transaction and shows the Sent screen at once. A send the
 * network didn't take stays on the Sent screen with why, and Back returns to
 * the review with everything as it was.
 *
 * @param {object} opts
 * @param {object} opts.state
 * @param {object} opts.actions - send, render, announce
 * @param {object} opts.message - the DUSK_UI_SEND_TX message
 * @param {object} opts.summary - what the screen shows: title; amountLux (DUSK),
 *   amountDisplay and unit (a token), or amountText; to ({ name, address, short })
 *   or line; from; memo; feeCapLux
 * @param {string} opts.backRoute - the review, for Back after a send the network didn't take
 * @param {string} [opts.doneRoute] - where Done goes
 * @param {(hash: string) => void} [opts.onSent] - once the network took it
 * @param {() => boolean} [opts.unchanged] - asked just before the transaction
 *   goes to the wallet: false when the network or profile changed since the
 *   review, and then it isn't sent
 * @returns {Promise<object>} the Sent screen's state
 */
export async function sendFromReview({ state, actions, message, summary, backRoute, doneRoute = "home", onSent, unchanged }) {
  const sent = {
    id: ++sentSeq,
    ...summary,
    phase: "sending",
    status: "",
    hash: "",
    error: "",
    feePaid: null,
    blockHeight: null,
    startedAt: Date.now(),
    sentAt: 0,
    // The explorer of the network it went to, whatever the popup switches to.
    nodeUrl: String(state.overview?.nodeUrl ?? ""),
    backRoute,
    doneRoute,
  };
  state.sent = sent;
  state.route = "sent";
  // A redraw that fails must not keep the transaction from going out.
  try {
    await actions?.render?.();
  } catch {
    // The screen catches up on the next draw.
  }

  // The Sent screen was drawn first: a switch begun meanwhile stops it here.
  const switched = typeof unchanged === "function" && !unchanged();
  let res;
  if (!switched) {
    try {
      res = await actions?.send?.(message);
    } catch (e) {
      res = { error: { message: e?.message ?? String(e) } };
    }
  }

  if (switched) {
    sent.error = SWITCHED;
    sent.phase = "not_sent";
  } else if (res?.error || !res?.ok) {
    sent.error = String(res?.error?.message ?? "");
    sent.phase = sendRefused(sent.error) ? "not_sent" : "unconfirmed";
  } else {
    sent.phase = "sent";
    sent.status = "submitted";
    sent.hash = String(res.result?.hash ?? "");
    sent.sentAt = Date.now();
    // Activity marks it when the popup goes back home.
    state.highlightTx = sent.hash || null;
    try {
      onSent?.(sent.hash);
    } catch {
      // Clearing drafts must not stop the screen.
    }
  }

  if (state.sent === sent && state.route === "sent") {
    actions?.announce?.(sentAnnouncement(sent, state.overview));
    state.needsRefresh = true;
    try {
      await actions?.render?.({ forceRefresh: true });
    } catch {
      // The screen catches up on the next draw.
    }
  } else if (sent.phase === "not_sent") {
    // Left before the network answered: the refusal still has to be said.
    const reason = reasonText(sent.error);
    actions?.showToast?.({
      text: `${sent.title || "Transaction"} failed. ${reason ? `${reason} ` : ""}No fee was charged.`,
      tone: "bad",
    });
  } else if (sent.phase === "unconfirmed") {
    actions?.showToast?.({
      text: `${sent.title || "Transaction"} may not have gone through. Check Activity before you send it again.`,
      tone: "bad",
    });
  }
  return sent;
}

function stepMark(stepState) {
  if (stepState === "done") return h("span", { class: "step-mark", html: iconSvg("check") });
  if (stepState === "failed") return h("span", { class: "step-mark", html: iconSvg("close") });
  if (stepState === "unknown") return h("span", { class: "step-mark", html: iconSvg("alert") });
  return h("span", { class: "step-mark" });
}

const STATE_WORDS = { done: "Done: ", current: "Now: ", failed: "Failed: ", unknown: "Unclear: ", upcoming: "Next: " };

/**
 * The Sent screen: what was sent, its steps, its transaction ID and fee, and
 * Done. Amounts hide with Hide balances; the fee doesn't.
 */
export function sentView(ov, { state, actions } = {}) {
  const sent = state?.sent;
  if (!sent) return [];
  const hidden = balancesHidden(ov);
  const { phase, status, feePaid } = sentStatus(sent, ov);
  const steps = sentSteps(sent, ov);
  const final = sentIsFinal(sent, ov);
  const capLux = safeBigInt(sent.feeCapLux ?? 0, 0n);
  const explorerUrl = sent.hash ? explorerTxUrl(String(sent.nodeUrl || ov?.nodeUrl || ""), sent.hash) : null;

  // The amount in DUSK, or in a token's units, hidden with Hide balances; or
  // words such as "All rewards" when the wallet doesn't know the amount.
  const amountEl =
    sent.amountLux != null && safeBigInt(sent.amountLux, 0n) > 0n
      ? h("div", { class: "sent-amount" }, [
          balance(hidden, formatDusk(sent.amountLux)),
          h("span", { class: "balance-unit", text: " DUSK" }),
        ])
      : sent.amountDisplay
        ? h("div", { class: "sent-amount" }, [
            balance(hidden, sent.amountDisplay),
            h("span", { class: "balance-unit", text: ` ${sent.unit || ""}` }),
          ])
        : sent.amountText
          ? h("div", { class: "sent-amount sent-amount--text", text: sent.amountText })
          : null;

  // "to alice-shop.dusk qxwSid…kQ2Bgr", or what the transaction does.
  const to = sent.to && typeof sent.to === "object" ? sent.to : null;
  const line = to
    ? h("div", { class: "sent-line" }, [
        "to ",
        to.name ? h("b", { text: to.name }) : null,
        to.name ? " " : null,
        h("span", { class: "mono", title: to.address, text: to.short || shortAddress(String(to.address ?? "")) }),
      ].filter(Boolean))
    : sent.line
      ? h("div", { class: "sent-line", text: sent.line })
      : null;

  const head = h("div", { class: "sent-head" }, [
    h("h1", { class: "sent-kind", text: sent.title || "Transaction" }),
    amountEl,
    line,
  ].filter(Boolean));

  const stepper = h(
    "ol",
    { class: "stepper", "aria-label": "Progress" },
    steps.map((step) =>
      h("li", { class: `step is-${step.state}`, "aria-current": step.state === "current" ? "step" : undefined }, [
        stepMark(step.state),
        h("div", { class: "step-body" }, [
          h("div", { class: "step-title" }, [h("span", { class: "sr-only", text: STATE_WORDS[step.state] }), step.label]),
          step.sub ? h("div", { class: "step-sub", text: step.sub }) : null,
        ].filter(Boolean)),
      ])
    )
  );

  const copyBtn = sent.hash
    ? h("button", {
        class: "mini-btn",
        type: "button",
        text: "Copy",
        "aria-label": "Copy transaction ID",
        onclick: async () => {
          const ok = await copyToClipboard(sent.hash);
          actions?.showToast?.(ok ? "Transaction ID copied" : "Couldn't copy the transaction ID");
        },
      })
    : null;

  const feeRow = (() => {
    if (phase === "not_sent" || status === "removed") return ["Network fee", "None charged"];
    if (phase === "unconfirmed") return capLux > 0n ? ["Network fee", `Up to ${formatFee(capLux, { max: true })} DUSK, if it went out`] : null;
    if (feePaid != null) return [status === "failed" ? "Fee charged" : "Network fee", `${formatFee(feePaid)} DUSK`];
    if (capLux > 0n) return ["Network fee", `Up to ${formatFee(capLux, { max: true })} DUSK`];
    return null;
  })();

  const kv = (label, value) =>
    h("div", { class: "kv" }, [h("span", { class: "kv-label", text: label }), h("span", { class: "kv-value" }, [].concat(value))]);

  const details = h("div", { class: "group" }, [
    sent.hash
      ? kv("Transaction ID", [h("span", { class: "mono", title: sent.hash, text: shortAddress(sent.hash) }), copyBtn])
      : null,
    sent.memo ? kv("Memo", sent.memo) : null,
    feeRow ? kv(feeRow[0], feeRow[1]) : null,
  ].filter(Boolean));

  // Nothing sent: Back to review leads, to fix it and try again. Not
  // confirmed: Done leads, and Back is there once Activity says it didn't go.
  const notSent = phase === "not_sent" && Boolean(sent.backRoute);
  const unconfirmed = phase === "unconfirmed" && Boolean(sent.backRoute);
  const done = h("button", {
    class: notSent ? "btn-outline sent-secondary" : "btn-primary",
    type: "button",
    text: "Done",
    onclick: () => {
      const route = sent.doneRoute || "home";
      state.sent = null;
      state.route = route;
      state.needsRefresh = true;
      actions?.render?.({ forceRefresh: true })?.catch?.(() => {});
    },
  });
  const back = notSent || unconfirmed
    ? h("button", {
        class: notSent ? "btn-primary" : "btn-outline sent-secondary",
        type: "button",
        text: "Back to review",
        onclick: () => {
          state.sent = null;
          state.route = sent.backRoute;
          actions?.render?.()?.catch?.(() => {});
        },
      })
    : null;
  const explorer = explorerUrl
    ? h(
        "button",
        {
          class: "btn-outline sent-secondary",
          type: "button",
          onclick: async () => {
            const ok = await openUrl(explorerUrl);
            if (!ok) actions?.showToast?.("Couldn't open the explorer");
          },
        },
        [h("span", { text: "View in Dusk explorer" }), h("span", { class: "btn-ico", html: iconSvg("ext") })]
      )
    : null;

  const note = final
    ? null
    : h("p", {
        class: "sent-note",
        text: isExtensionRuntime()
          ? "You can close the wallet; this continues in the background."
          : "You can leave this screen; this continues in the background.",
      });

  return [
    h("div", { class: "sent", "data-phase": phase, "data-status": status }, [
      head,
      note,
      stepper,
      details.children.length ? details : null,
      h("div", { class: "sent-actions" }, (notSent ? [back, done] : unconfirmed ? [done, back] : [done, explorer]).filter(Boolean)),
    ].filter(Boolean)),
  ];
}
