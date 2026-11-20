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
import { MEANWHILE_READ_MS, SEND_CANCELLED_TEXT } from "../../../shared/waitingSends.js";
import { CHECKING_MEANWHILE_TEXT, againDraft, checksMeanwhile, sameSentMeanwhile, sentMeanwhileText } from "../../lib/waiting.js";
import { ownProfileName } from "../../components/ProfileName.js";
import { whenAtText } from "./txRow.js";

// After Confirm the popup shows the transaction's steps rather than going home
// with a toast: Sending while the wallet signs it and hands it to the network,
// Sent once the network took it, then Completed or Failed as the wallet's
// watcher reports. The watcher's events come through app.js, which writes
// them on `state.sent`; the overview's record of the transaction fills in
// what an event left out.

const FINAL = new Set(["executed", "failed", "removed"]);

// Why a send stopped before it went to the wallet: a switch started meanwhile.
const SWITCHED = "The network, profile or wallet changed meanwhile.";

export { sendRefused };

let sentSeq = 0;

// A payment's own ID, by which it's called off while it waits.
function newSendId() {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `send-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }
}

// Offline, as the browser says.
const offline = () => globalThis.navigator?.onLine === false;

// A payment from Send waiting for the network it couldn't reach, before it
// went out, as the web wallet says it: it goes out once the network answers.
const waitingText = () =>
  offline() ? "Offline. Nothing sent yet; it goes out once the network answers." : "Network not answering. Nothing sent yet; it goes out once it answers.";

/** What's said of a payment from Send handed to the network without a clear answer: it's looked up, and sent once if it didn't go. */
export const UNCLEAR_TEXT = "It may have gone out already; if not, it goes out once the network answers.";

// The same, offline.
const UNCLEAR_OFFLINE_TEXT = `Offline. ${UNCLEAR_TEXT}`;

/** What's said of a payment the person chose not to send, in no colour: nothing left (Chen's: a red Send failed). */
export const NOT_SENT_CHOSEN_TEXT = "Not sent. Nothing left your wallet.";

/** What Don't send says where the wallet didn't answer it. */
export const CANCEL_FAILED_TEXT = "Couldn't stop it. Try again.";

/** What Don't send says of a payment that went out meanwhile. */
export const WENT_ALREADY_TEXT = "It went out already.";

// The Sent screens whose Details are open, kept as the screen redraws.
const detailsOpen = new WeakSet();

// A payment held for Send it too, as the overview keeps it, with what its
// account sent meanwhile; and that said, the recipient named as the Sent
// screen names this one's, a profile of the wallet's by its name.
const heldRecordOf = (sent, ov) => (Array.isArray(ov?.waitingSends) ? ov.waitingSends : []).find((send) => send?.sendId === sent?.sendId) ?? null;
// Held, as the wallet just said (`heldAt`), while the overview Sent is drawn
// from is older: its record not held yet, or not there. What the account sent
// is being read then, the wallet having marked it held as it began, and Sent
// is drawn again with the answer (round 40's review: Send it too and Don't
// send were on, with "something else", till the new overview came). Read as
// long as the node is given, and a little.
const heldChecking = (sent, record, now = Date.now()) =>
  checksMeanwhile(record, now) || (!record?.held && now - (Number(sent?.heldAt) || 0) < MEANWHILE_READ_MS + 5_000);
function heldText(sent, ov) {
  const record = heldRecordOf(sent, ov);
  if (heldChecking(sent, record)) return CHECKING_MEANWHILE_TEXT;
  const to = sent?.to && typeof sent.to === "object" ? sent.to : null;
  const toText = (address) => {
    if (to && address === to.address) return to.name || to.short || shortAddress(address);
    const own = ownProfileName(ov, address);
    return own ? `your ${own}` : shortAddress(address);
  };
  return sentMeanwhileText(record, { toText, whenText: whenAtText, hidden: balancesHidden(ov) });
}

/**
 * In the app on a phone, what leaving it does to a payment waiting for the
 * network: the app signs and sends only while it's open, so it goes out once
 * the app's opened again, unless Android closes the app first, when it's
 * asked to be sent (Sofía's: it said it would go, and after Android closed
 * the app, Home said Not sent, with Send it now); with Lock when I leave the
 * app on, the wallet locks as it's left, and the payment isn't sent (Home
 * offers Send it now).
 * @param {object} [ov] - the overview
 */
export const appLeaveText = (ov) =>
  ov?.lockOnLeave === true
    ? "If you leave the app, it locks and this isn't sent."
    : "If you leave the app, it goes out when you reopen it, or asks first if Android closed it.";

/**
 * What's said of one the person chose not to send whose hand-over had no clear
 * answer: it may still arrive, and is followed (Astra's: never "nothing left").
 */
export const NOT_SENT_FOLLOWED_TEXT = "It won't be sent again. If it still arrives, it shows here.";

/** What's said once one the person chose not to send arrived after all. */
export const WENT_AFTER_ALL_TEXT = "A payment you chose not to send went out after all.";

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
  const { phase, status, error, blockHeight } = sentStatus(sent, ov);

  if (phase === "not_sent") {
    // Called off by the person: said plainly, in no colour.
    if (String(error ?? "") === SEND_CANCELLED_TEXT) {
      return [
        { label: "Not sent", state: "upcoming", sub: "Nothing left your wallet." },
        { label: "Sent", state: "upcoming", sub: "" },
        { label: "Completed", state: "upcoming", sub: "" },
      ];
    }
    // Where the reason says nothing left the wallet, there's no fee to say.
    const reason = reasonText(error);
    return [
      { label: "Not sent", state: "failed", sub: /Nothing left your wallet\.$/.test(reason) ? reason : [reason, "No fee charged."].filter(Boolean).join(" ") },
      { label: "Sent", state: "upcoming", sub: "" },
      { label: "Completed", state: "upcoming", sub: "" },
    ];
  }
  if (phase === "unconfirmed") {
    return [
      {
        label: "Not confirmed",
        state: "unknown",
        sub: [reasonText(error), "It may have gone out: check Activity before you send again."].filter(Boolean).join(" "),
      },
      { label: "Sent", state: "upcoming", sub: "" },
      { label: "Completed", state: "upcoming", sub: "" },
    ];
  }
  if (phase === "sending" && sent?.held) {
    // Its account sent something else while it waited: it goes only on Send it too.
    return [
      { label: "Held", state: "unknown", sub: heldText(sent, ov) },
      { label: "Sent", state: "upcoming", sub: "" },
      { label: "Completed", state: "upcoming", sub: "" },
    ];
  }
  if (phase === "sending") {
    // A payment from Send waits for the network; any other send is tried
    // once. One handed over may have gone out, whatever the network does now.
    const unclear = sent?.handedOver && (sent?.waits || offline());
    const waits = !unclear && (sent?.waits || (offline() && sent?.sendId));
    const sub = unclear
      ? offline()
        ? UNCLEAR_OFFLINE_TEXT
        : UNCLEAR_TEXT
      : waits
        ? waitingText()
        : offline()
          ? "You're offline, so it can't reach the network."
          : "";
    return [
      { label: waits ? "Waiting" : "Sending", state: "current", sub },
      { label: "Sent", state: "upcoming", sub: "" },
      { label: "Completed", state: "upcoming", sub: "" },
    ];
  }

  // When it was sent, and from which balance, are under Details (sentView).
  const sending = { label: "Sending", state: "done", sub: "" };
  if (status === "executed") {
    const height = safeBigInt(blockHeight ?? 0, 0n);
    return [
      sending,
      { label: "Sent", state: "done", sub: "" },
      { label: "Completed", state: "done", sub: height > 0n ? `In block ${groupThousands(height.toString())}` : "" },
    ];
  }
  if (status === "failed") {
    // The fee it was charged is said once, in its row (sentView).
    return [
      sending,
      { label: "Sent", state: "done", sub: "" },
      { label: "Failed", state: "failed", sub: txErrorText(error) || reasonText(error) || "It didn't go through." },
    ];
  }
  if (status === "removed") {
    return [
      sending,
      { label: "Sent", state: "done", sub: "" },
      { label: "Failed", state: "failed", sub: "The network dropped it before it ran. No fee charged." },
    ];
  }
  return [
    sending,
    {
      label: "Sent",
      state: "current",
      sub: offline()
        ? "No connection. It's looked up again once you're back online."
        : sent?.lookingUp
          ? "Looking it up again…"
          : status === "unknown"
            ? "Taking longer than usual. It can still go through."
            : "Waiting for a block, about 10 s",
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
 * @param {boolean} [opts.canWait] - a payment from Send: where it can't reach
 *   the network before it goes out, it waits for it, with Don't send, and
 *   goes out once it answers (shared/waitingSends.js)
 * @returns {Promise<object | null>} the Sent screen's state, or null when the
 *   password it needed wasn't given, and the Review stays
 */
export async function sendFromReview({ state, actions, message, summary, backRoute, doneRoute = "home", onSent, unchanged, canWait = false }) {
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
    // A payment that waits for the network, by which it's called off; whether
    // it waits now; whether it was handed over, from when it may have gone;
    // and whether it's held for Send it too, its account having sent
    // something else meanwhile.
    sendId: canWait ? newSendId() : "",
    waits: false,
    handedOver: false,
    held: false,
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
      res = await actions?.send?.({
        ...boundToReview(message, review),
        ...(sendTicket ? { sendTicket } : {}),
        // What's kept of it while it waits: the most its fee costs, as Review said it.
        ...(sent.sendId ? { sendId: sent.sendId, feeCapLux: String(summary?.feeCapLux ?? "0") } : {}),
      });
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
    // Said here, a payment that waited and then failed isn't said again on
    // Home; one the wallet stopped as it locked or switched is, once it's open,
    // and one sent again from Home's Send it now stays said there.
    if (sent.sendId && went === false && !res?.error?.data?.cancelled && !message?.replaces) {
      Promise.resolve(actions?.send?.({ type: "DUSK_UI_DROP_UNSENT", sendId: sent.sendId })).catch(() => {});
    }
  } else {
    sent.phase = "sent";
    sent.waits = false;
    sent.held = false;
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
    // Left before the network answered: the refusal still has to be said; one
    // called off, plainly, and one sent again in its place, not at all.
    const reason = reasonText(sent.error);
    if (res?.error?.data?.inPlace) {
      // Sent from its Review in its place.
    } else if (res?.error?.data?.cancelled) {
      actions?.showToast?.(NOT_SENT_CHOSEN_TEXT);
    } else {
      actions?.showToast?.({
        text: `${sent.title || "Transaction"} failed. ${reason ? `${reason} ` : ""}No fee charged.`,
        tone: "bad",
      });
    }
  } else if (sent.phase === "unconfirmed") {
    actions?.showToast?.({
      text: `${sent.title || "Transaction"} may not have gone through. Check Activity before you send again.`,
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
/** What Sent says once notices will come, in the app: Android looks for the send once the app's left. */
export const NOTICE_COMES_TEXT = "You'll get a notice when it arrives.";

/**
 * What Sent says once notices will come in Firefox on a phone, which stops
 * the wallet once Firefox is left: one line for the send and its notice. The
 * wallet runs in its Keep open tab there: closing that stops it.
 */
export const FIREFOX_NOTICE_COMES_TEXT = "It goes on if you close the wallet, while its Keep open tab stays open; its notice comes only while the wallet stays open.";

// That the send goes on with the wallet closed: in the extension. Kept on
// purpose: a popup closes at any click outside it, and nothing else on the
// screen says the send survives that.
const CLOSE_WALLET_TEXT = "You can close the wallet.";

// The same where there's no popup to close.
const LEAVE_SCREEN_TEXT = "You can leave this screen.";

/** The same in Firefox on a phone, whose wallet runs in its Keep open tab: closing that stops it. */
export const KEEP_OPEN_TEXT = "You can close the wallet; this goes on while its Keep open tab stays open.";

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
  // In Firefox, that the send goes on with the wallet closed is said here,
  // with the notice: once notices come, in one line that says both.
  const closing = () => (firefox ? [h("p", { class: "sent-note", text: KEEP_OPEN_TEXT })] : []);
  const draw = () => {
    if (notices.state === null) {
      el.replaceChildren(...closing(), askButton("Tell me when it arrives", false));
    } else if (notices.state === "asked" || notices.state === "on") {
      el.replaceChildren(h("p", { class: "sent-note", text: firefox ? FIREFOX_NOTICE_COMES_TEXT : NOTICE_COMES_TEXT }));
    } else if (notices.state === "off") {
      el.replaceChildren(
        ...closing(),
        firefox
          ? h("div", { class: "sent-notices__off" }, [h("p", { class: "sent-note", text: "Notices are off." }), askButton("Ask again", true)])
          : h("p", { class: "sent-note", text: "Notices are off. To get them, allow notifications for Dusk Wallet in your phone's settings." })
      );
      // Said, on this send's Sent: the next one's reads that it was.
      notices.said ??= Promise.resolve(actions?.send?.({ type: "DUSK_UI_NOTICES_SAID" })).catch(() => {});
    } else if (notices.state === "off-said" && firefox) {
      // Said once: from then on, the tap that asks again, and nothing more.
      el.replaceChildren(...closing(), askButton("Tell me when it arrives", true));
    } else {
      el.replaceChildren(...closing());
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

  // The fee, said once. Where nothing went out, or the network dropped it,
  // the step says no fee was charged; a failed one says what it was charged,
  // at most the cap while that isn't known.
  const feeRow = (() => {
    if (phase === "not_sent" || status === "removed") return null;
    if (phase === "unconfirmed") return capLux > 0n ? ["Fee", ["Up to ", balance(hidden, formatFee(capLux, { max: true })), " DUSK, if it went out"]] : null;
    const label = status === "failed" ? "Fee charged" : "Fee";
    if (feePaid != null) return [label, [balance(hidden, formatDuskExact(feePaid)), " DUSK"]];
    if (capLux > 0n) return [label, ["Up to ", balance(hidden, formatFee(capLux, { max: true })), " DUSK"]];
    return null;
  })();

  const kv = (label, value) =>
    h("div", { class: "kv" }, [h("span", { class: "kv-label", text: label }), h("span", { class: "kv-value" }, [].concat(value))]);

  // What it got or gave back, and the fee.
  const rows = h("div", { class: "group" }, [
    ...(sent.sozu && status === "executed" ? sozuLines(sent, sozu, hidden) : []).map(({ label, value }) => kv(label, value)),
    feeRow ? kv(feeRow[0], feeRow[1]) : null,
  ].filter(Boolean));

  // What decides nothing once it's confirmed, under Details: its transaction
  // ID, its memo, and when it was sent, from which balance.
  const sentAt = phase === "sent" ? [clock(sent.sentAt || sent.startedAt), sent.from].filter(Boolean).join(" · ") : "";
  const detailRows = [
    sent.hash
      ? kv("Transaction ID", [h("span", { class: "mono", title: sent.hash, text: shortAddress(sent.hash) }), copyBtn])
      : null,
    sent.memo ? kv("Memo", safeTextEl(sent.memo)) : null,
    sentAt ? kv("Sent at", sentAt) : null,
  ].filter(Boolean);
  // Open or closed as it was left: the screen redraws as the steps move on.
  const details = detailRows.length
    ? h("details", { class: "advanced", open: detailsOpen.has(sent) }, [
        h("summary", { text: "Details" }),
        h("div", { class: "advanced-body" }, [h("div", { class: "group group--inset" }, detailRows)]),
      ])
    : null;
  details?.addEventListener("toggle", () => (details.open ? detailsOpen.add(sent) : detailsOpen.delete(sent)));

  // Nothing sent: Back to review leads, to fix it and try again. Not
  // confirmed: Done leads, and Back is there once Activity says it didn't go.
  const notSent = phase === "not_sent" && Boolean(sent.backRoute);
  const unconfirmed = phase === "unconfirmed" && Boolean(sent.backRoute);
  const done = h("button", {
    class: notSent || (phase === "sending" && sent.sendId && sent.held) ? "btn-outline sent-secondary" : "btn-primary",
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
  // A payment waiting for the network: called off from here with Don't send,
  // until it's handed over.
  const cancel =
    phase === "sending" && sent.sendId && (sent.waits || offline()) && !sent.handedOver
      ? h("button", {
          class: "btn-outline sent-secondary sent-cancel",
          type: "button",
          text: "Don't send",
          onclick: async (event) => {
            const button = event?.currentTarget;
            if (button) button.disabled = true;
            const res = await Promise.resolve(actions?.send?.({ type: "DUSK_UI_CANCEL_SEND", sendId: sent.sendId })).catch(() => null);
            // Called off, it says Not sent as the send's answer comes; gone out, it goes on.
            if (!res?.result?.cancelled) {
              if (button) button.disabled = false;
              actions?.showToast?.(res?.error ? CANCEL_FAILED_TEXT : WENT_ALREADY_TEXT);
            }
          },
        })
      : null;
  // Held, its account having sent something else while it waited: the two
  // answers are the screen's, first and full size, Done after them (Chen's:
  // Done was the biggest). Send it too opens its Review, as Send it now does
  // (Chen's: it paid at once); Don't send calls it off. Where what was sent
  // meanwhile is this same payment, Don't send leads.
  const held = phase === "sending" && sent.sendId && sent.held;
  const heldRecord = held ? heldRecordOf(sent, ov) : null;
  const same = held && sameSentMeanwhile(heldRecord);
  // While what the account sent is read, both wait for it.
  const checking = held && heldChecking(sent, heldRecord);
  const heldActions = held
    ? [
        h("button", {
          class: same ? "btn-outline" : "btn-primary",
          type: "button",
          text: "Send it too",
          disabled: !heldRecord || checking,
          onclick: () => {
            if (!heldRecord) return;
            state.draft = againDraft(heldRecord, ov, { hidden: balancesHidden(ov) });
            state.sent = null;
            state.route = "confirm";
            actions?.render?.()?.catch?.(() => {});
          },
        }),
        h("button", {
          class: same ? "btn-primary" : "btn-outline",
          type: "button",
          text: "Don't send",
          disabled: checking,
          onclick: async (event) => {
            const button = event?.currentTarget;
            if (button) button.disabled = true;
            const res = await Promise.resolve(actions?.send?.({ type: "DUSK_UI_CANCEL_SEND", sendId: sent.sendId })).catch(() => null);
            // Called off, it says Not sent as the send's answer comes.
            if (!res?.result?.cancelled) {
              if (button) button.disabled = false;
              actions?.showToast?.(res?.error ? CANCEL_FAILED_TEXT : WENT_ALREADY_TEXT);
            }
          },
        }),
      ]
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
        [h("span", { text: "View in explorer" }), h("span", { class: "btn-ico", html: iconSvg("ext") })]
      )
    : null;

  // That it goes on: in Firefox on a phone with what's said of its notice
  // (noticeOffer). In the app on a phone, one waiting for the network goes
  // out only while the app's open, which it says.
  const waitsHere = phase === "sending" && (sent.waits || offline()) && !sent.handedOver;
  const note = final || held || (isPhone() && !isTauriRuntime())
    ? null
    : h("p", {
        class: "sent-note",
        text: isExtensionRuntime()
          ? CLOSE_WALLET_TEXT
          : isPhone() && waitsHere
            ? appLeaveText(ov)
            : LEAVE_SCREEN_TEXT,
      });

  return [
    h("div", { class: "sent", "data-phase": phase, "data-status": status }, [
      head,
      note,
      final || held ? null : noticeOffer({ state, actions }),
      stepper,
      rows.children.length ? rows : null,
      details,
      h("div", { class: "sent-actions" }, (notSent ? [back, done] : unconfirmed ? [done, back] : held ? [...heldActions, done] : cancel ? [cancel, done] : [done, explorer]).filter(Boolean)),
    ].filter(Boolean)),
  ];
}
