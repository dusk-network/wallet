import { formatDuskExact, formatFee, groupThousands, safeBigInt } from "../../../shared/amount.js";
import { explorerTxUrl } from "../../../shared/explorer.js";
import { isNodeReply, nodeRefusalText } from "../../../shared/nodeRefusal.js";
import { openUrl } from "../../../platform/index.js";
import { isExtensionRuntime, isTauriRuntime } from "../../../platform/runtime.js";
import { isPhone } from "../../lib/device.js";
import { h } from "../../lib/dom.js";
import { shortAddress } from "../../lib/strings.js";
import { stDuskLines, txErrorText } from "./txDisplay.js";
import { zonedClockText } from "../../lib/time.js";
import { iconSvg } from "../../components/ActionIcon.js";
import { copyButton } from "../../components/CopyButton.js";
import { balance, balancesHidden } from "../../components/Balance.js";
import { walletNameOf } from "../../components/ProfileName.js";
import { askSendPassword } from "../../components/SendPasswordDialog.js";
import { SEND_PASSWORD_WAITS } from "../../../shared/errors.js";
import { safeTextEl } from "../../components/SafeText.js";
import { connectionLost, sendRefused, sentOf } from "../../../shared/sendOutcome.js";

// After Confirm the popup shows the transaction's steps rather than going home
// with a toast: Sending while the wallet signs it and hands it to the network,
// Sent to the network once the network took it, then Completed or Failed as
// the wallet's watcher reports. The watcher's events come through app.js,
// which writes them on `state.sent`; the overview's record of the transaction
// fills in what an event left out.

const FINAL = new Set(["executed", "failed", "removed"]);

// Why a send stopped before it went to the wallet: a switch started meanwhile.
const SWITCHED = "The network, profile or wallet changed meanwhile.";

export { sendRefused };

let sentSeq = 0;

// Offline, as the browser says.
const offline = () => globalThis.navigator?.onLine === false;

// "13:21 CET": when it was sent, with the time zone it shows in.
function clock(ts) {
  return zonedClockText(Number(ts) || Date.now());
}

/** An error as a short sentence: one line, at most 140 characters, ending in a full stop. */
export function reasonText(error) {
  const text = String(error ?? "").trim().replace(/\s+/g, " ");
  if (!text) return "";
  // What the wallet's transaction builder says, in words.
  if (/failed to deserialize/i.test(text)) return "The wallet couldn't read the address. Check it and try again.";
  if (/failed to (archive|unarchive)|unknown error code/i.test(text)) return "The wallet couldn't build this transaction.";
  // The node's connection, as the browser reports it: no signal, or a node down.
  if (connectionLost(text)) return "Couldn't reach the network.";
  // The wallet's own words on a node it won't sign for, whole.
  if (/nothing was signed/i.test(text)) return text;
  // A node's reply never shows as it came: JSON, cut off in the middle.
  if (isNodeReply(text)) return nodeRefusalText(text);
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
  // A send whose hand-over gave no clear answer, that the node has after all: it went.
  const found = sent?.phase === "unconfirmed" && Boolean(sent?.hash) && ["executed", "failed", "mempool"].includes(status);
  return {
    phase: found ? "sent" : (sent?.phase ?? "sending"),
    status,
    error: (found ? "" : sent?.error) || rec?.error || "",
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
  const charged =
    feePaid == null && capLux <= 0n
      ? ""
      : balancesHidden(ov)
        ? "A fee was charged."
        : feePaid != null
          ? `Fee charged: ${formatDuskExact(feePaid)} DUSK.`
          : `Fee charged: up to ${formatFee(capLux, { max: true })} DUSK.`;

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
      sub: offline()
        ? "No connection. It's looked up again once you're back online."
        : status === "unknown"
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
 * What a screen was drawn for: the wallet (by its first public account, with
 * its profiles' accounts, and with more than one wallet its name as shown),
 * the profile and the network of the overview it was built from, and the
 * popup's context then. render() makes one for each screen it draws
 * (`actions.review`): what the screen does, and the wallet a Review names, is
 * for that.
 * @param {object} ov - the overview the screen is built from
 * @param {object} state - the popup's state
 */
export function reviewOf(ov, state) {
  const accounts = ov?.isUnlocked !== false && Array.isArray(ov?.accounts) ? ov.accounts.map(String) : [];
  return Object.freeze({
    walletId: String(accounts[0] ?? ""),
    walletName: accounts.length ? walletNameOf(ov) : "",
    accounts: Object.freeze(accounts),
    profileIndex: Number(ov?.selectedAccountIndex ?? 0) || 0,
    nodeUrl: String(ov?.nodeUrl ?? ""),
    context: state?.context,
  });
}

// The transaction, for the wallet and the network its Review was drawn for
// alone: the background refuses it from another wallet (`walletId`), and the
// engine signs it only for that wallet, profile, account and network
// (`_approvalContext`, the one a site's send carries too).
function boundToReview(message, review) {
  const params = message?.params && typeof message.params === "object" ? message.params : {};
  const asked = Number(params.profileIndex);
  const profileIndex = Number.isFinite(asked) && asked >= 0 ? Math.floor(asked) : review.profileIndex;
  const _approvalContext = params._approvalContext ?? {
    walletId: review.walletId,
    profileIndex,
    account: review.accounts[profileIndex] ?? "",
    nodeUrl: review.nodeUrl,
  };
  return { ...message, walletId: review.walletId, params: { ...params, _approvalContext } };
}

// Above the amount chosen in Settings, the password first, over the Review:
// what the wallet gives for it goes with the send, and the wallet checks it again
// as it goes. "" when it isn't asked, null when it wasn't given. An answer that
// doesn't come asks nothing here: the wallet refuses the send all the same.
async function sendPasswordFor(message, { state, actions }) {
  if (state?.overview?.sendPasswordLimit == null) return "";
  const { params } = message;
  const res = await actions?.send?.({ type: "DUSK_UI_SEND_PASSWORD_ASKS", params }).catch(() => null);
  const asked = res?.error ? null : res?.result;
  if (!asked) return "";
  return askSendPassword({
    limit: asked.limit,
    always: asked.always,
    check: async (password) => {
      const proved = await actions.send({ type: "DUSK_UI_SEND_PASSWORD_PROVE", password, params });
      if (proved?.error) throw new Error(proved.error.message);
      return String(proved?.result ?? "");
    },
  });
}

/**
 * Sends a reviewed transaction and shows the Sent screen at once. A send the
 * network didn't take stays on the Sent screen with why, and Back returns to
 * the review with everything as it was. It goes for what the Review was drawn
 * for (`actions.review`, reviewOf), never for what the popup reads since.
 *
 * @param {object} opts
 * @param {object} opts.state
 * @param {object} opts.actions - send, render, announce, and the Review's `review`
 * @param {object} opts.message - the DUSK_UI_SEND_TX message
 * @param {object} opts.summary - what the screen shows: title; amountLux (DUSK),
 *   amountDisplay and unit (a token), or amountText; to ({ name, address, short })
 *   or line; from; memo; feeCapLux
 * @param {string} opts.backRoute - the review, for Back after a send the network didn't take
 * @param {string} [opts.doneRoute] - where Done goes
 * @param {(hash: string) => void} [opts.onSent] - once the network took it
 * @param {() => boolean} [opts.unchanged] - asked just before the transaction
 *   goes to the wallet: false when what it was reviewed for changed, and then
 *   it isn't sent
 * @returns {Promise<object | null>} the Sent screen's state, or null when the
 *   password it needed wasn't given, and the Review stays
 */
export async function sendFromReview({ state, actions, message, summary, backRoute, doneRoute = "home", onSent, unchanged }) {
  const sendTicket = await sendPasswordFor(message, { state, actions });
  if (sendTicket === null) {
    actions?.showToast?.(SEND_PASSWORD_WAITS);
    return null;
  }
  // A switch of network, profile or wallet since the Review was drawn, here
  // or in another window, gave the popup another context.
  const review = actions?.review;
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
    nodeUrl: String(review?.nodeUrl ?? ""),
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
  const switched = !review?.walletId || state.context !== review.context || (typeof unchanged === "function" && !unchanged());
  let res;
  if (!switched) {
    try {
      res = await actions?.send?.({ ...boundToReview(message, review), ...(sendTicket ? { sendTicket } : {}) });
    } catch (e) {
      res = { error: { message: e?.message ?? String(e) } };
    }
  }

  if (switched) {
    sent.error = SWITCHED;
    sent.phase = "not_sent";
  } else if (res?.error || !res?.ok) {
    sent.error = String(res?.error?.message ?? "");
    // Nothing went out, or it may have: then by its ID, to look it up once the node answers.
    const went = sentOf(res?.error ?? { message: sent.error });
    sent.phase = went === false ? "not_sent" : "unconfirmed";
    if (went === "unknown" && res?.error?.data?.hash) sent.hash = String(res.error.data.hash);
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

// What a completed stake or unstake with Sozu got or gave back, or, its
// pool's event not read yet, that it's coming: never nothing.
function sozuLines(sent, fact, hidden) {
  // Its block's figure is the one the chain made, final or not yet: as it is.
  if (fact) return stDuskLines(fact, hidden);
  return [{ label: sent.sozu === "unstake" ? "You gave back" : "You got", value: "stDUSK and rate coming in a moment" }];
}

const STATE_WORDS = { done: "Done: ", current: "Now: ", failed: "Failed: ", unknown: "Unclear: ", upcoming: "Next: " };

/**
 * The Sent screen: what was sent, its steps, its transaction ID and fee, and
 * Done. Amounts and the fee hide with Hide balances. A stake or an unstake
 * with Sozu says what it got or gave back in stDUSK once it completed and the
 * pool's event is read (`sozu`, what app.js reads from its block), and that
 * they're coming till then.
 */
/** What Sent says once notices will come: a phone's browser stops the wallet once it's left. */
export const NOTICE_COMES_TEXT = "You'll get a notice when it arrives, while the wallet stays open.";

/**
 * On a phone, while a send is on its way: Tell me when it arrives, which alone
 * has the phone ask for notices (shared/phoneNotices.js), and after that, that
 * one will come. Once they're off, the app says so once, and where to turn
 * them on; Firefox, whose own question brings them back, offers Ask again,
 * and asks only when it's tapped.
 * @returns {HTMLElement | null}
 */
function noticeOffer({ state, actions }) {
  if (!isPhone()) return null;
  // Where notices stand, read again for each send: Android answers after the
  // tap, and its settings can change it. Notices being off is said on one
  // send's Sent, kept as its hash comes.
  if (state.notices?.for !== state.sent) state.notices = { for: state.sent, state: undefined };
  const notices = state.notices;
  const el = h("div", { class: "sent-notices" });
  const askButton = (text, again) => {
    const ask = h("button", {
      class: "btn-outline sent-notices__ask",
      type: "button",
      text,
      onclick: async () => {
        ask.disabled = true;
        // The send it's for, which the app's Android looks for once the wallet's left.
        const res = await actions?.send?.({ type: "DUSK_UI_NOTICES_ASK", hash: state.sent?.hash || undefined, ...(again ? { again: true } : {}) })?.catch?.(() => null);
        notices.state = res?.state ?? "asked";
        draw();
      },
    });
    return ask;
  };
  const firefox = !isTauriRuntime();
  const draw = () => {
    if (notices.state === null) {
      el.replaceChildren(askButton("Tell me when it arrives", false));
    } else if (notices.state === "asked" || notices.state === "on") {
      el.replaceChildren(h("p", { class: "sent-note", text: NOTICE_COMES_TEXT }));
    } else if (notices.state === "off") {
      el.replaceChildren(
        firefox
          ? h("div", { class: "sent-notices__off" }, [h("p", { class: "sent-note", text: "Notices are off." }), askButton("Ask again", true)])
          : h("p", { class: "sent-note", text: "Notices are off. To get them, allow notifications for Dusk Wallet in your phone's settings." })
      );
      // Said, on this send's Sent: the next one's reads that it was.
      notices.said ??= Promise.resolve(actions?.send?.({ type: "DUSK_UI_NOTICES_SAID" })).catch(() => {});
    } else if (notices.state === "off-said" && firefox) {
      // Said once: from then on, the tap that asks again, and nothing more.
      el.replaceChildren(askButton("Tell me when it arrives", true));
    } else {
      el.replaceChildren();
    }
  };
  if (notices.state === undefined) {
    Promise.resolve(actions?.send?.({ type: "DUSK_UI_NOTICES" }))
      .then((res) => {
        notices.state = res?.state ?? null;
        draw();
      })
      .catch(() => {});
  }
  draw();
  return el;
}

export function sentView(ov, { state, actions, sozu } = {}) {
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
          balance(hidden, formatDuskExact(sent.amountLux)),
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
    ? copyButton({
        value: sent.hash,
        label: "Copy transaction ID",
        text: "Copy",
        className: "mini-btn",
        failText: "Couldn't copy the transaction ID",
        onFail: actions?.showToast,
      })
    : null;

  const feeRow = (() => {
    if (phase === "not_sent" || status === "removed") return ["Network fee", "None charged"];
    if (phase === "unconfirmed") return capLux > 0n ? ["Network fee", ["Up to ", balance(hidden, formatFee(capLux, { max: true })), " DUSK, if it went out"]] : null;
    if (feePaid != null) return [status === "failed" ? "Fee charged" : "Network fee", [balance(hidden, formatDuskExact(feePaid)), " DUSK"]];
    if (capLux > 0n) return ["Network fee", ["Up to ", balance(hidden, formatFee(capLux, { max: true })), " DUSK"]];
    return null;
  })();

  const kv = (label, value) =>
    h("div", { class: "kv" }, [h("span", { class: "kv-label", text: label }), h("span", { class: "kv-value" }, [].concat(value))]);

  const details = h("div", { class: "group" }, [
    ...(sent.sozu && status === "executed" ? sozuLines(sent, sozu, hidden) : []).map(({ label, value }) => kv(label, value)),
    sent.hash
      ? kv("Transaction ID", [h("span", { class: "mono", title: sent.hash, text: shortAddress(sent.hash) }), copyBtn])
      : null,
    sent.memo ? kv("Memo", safeTextEl(sent.memo)) : null,
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
  // The phone's Back: back to review when nothing went, else Done.
  (notSent ? back : done).setAttribute("data-back", "");
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
      final ? null : noticeOffer({ state, actions }),
      stepper,
      details.children.length ? details : null,
      h("div", { class: "sent-actions" }, (notSent ? [back, done] : unconfirmed ? [done, back] : [done, explorer]).filter(Boolean)),
    ].filter(Boolean)),
  ];
}
