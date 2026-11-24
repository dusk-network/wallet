// The requests this profile made in Receive on this network, kept on this
// device (shared/paymentRequests.js), each marked by what came in after it
// (app-core's matchRequests) in the words the web wallet uses: Waiting, Paid,
// Check, or Paid twice, with each payment to open in Activity: read back to
// the oldest request not paid, past the page Activity shows. While they show,
// the history is read again every 30 seconds, as the web wallet does, the
// shielded too once its notes synced: one paid can be paid again.

import { formatDuskPlain } from "@dusk-network/app-core/amounts";
import { makePaymentLink } from "@dusk-network/app-core/payment-links";
import { CLOCK_SKEW_MS, matchRequests, refundOf, sentAlready } from "@dusk-network/app-core/requests";

import { amountForInput, formatDuskExact } from "../../../shared/amount.js";
import { chainIdFromNodeUrl } from "../../../shared/chain.js";
import { chainIdForNode, networkKeyOf } from "../../../shared/nodeNetwork.js";
import { forgetRequest, keepRequestsPaid, listRequests, sameRequest } from "../../../shared/paymentRequests.js";
import { balance, balancesHidden } from "../../components/Balance.js";
import { copyButton } from "../../components/CopyButton.js";
import { bracketTitle } from "../../components/BracketTitle.js";
import { safeTextEl } from "../../components/SafeText.js";
import { h } from "../../lib/dom.js";
import { activityKey, activityRows, activitySince, lookForPayments, selected } from "../activity.js";
import { onDayAtText, whenAtText } from "./txRow.js";
import { inCurrencyLine } from "../../lib/inCurrency.js";

/** How often the history is read again while a request shown waits. */
export const LOOK_MS = 30_000;

/**
 * The network requests are kept and matched under: a listed network's name,
 * and any other node's by the chain it signs for, as its request links say
 * it ("custom:dusk:42"), so two such chains' requests stay apart.
 */
export function requestNetwork(ov) {
  const nodeUrl = String(ov?.nodeUrl ?? "");
  const pinned = Number.isInteger(ov?.chainId) ? ov.chainId : chainIdForNode(nodeUrl);
  const key = networkKeyOf(pinned, nodeUrl);
  if (key !== "custom" && key !== "local") return key;
  return `${key}:${Number.isInteger(pinned) ? `dusk:${pinned}` : chainIdFromNodeUrl(nodeUrl)}`;
}

// The wallet's kept requests, read once a page and wallet, and drawn again when they come.
function keptRequests(ov, { state, actions }) {
  const walletId = String(ov?.accounts?.[0] ?? "");
  const kept = (state.requests ??= { walletId, list: [], loaded: false, loading: false });
  if (kept.walletId !== walletId) Object.assign(kept, { walletId, list: [], loaded: false, loading: false });
  if (!kept.loaded && !kept.loading && walletId) {
    kept.loading = true;
    listRequests(walletId)
      .then((list) => {
        if (state.requests !== kept || kept.walletId !== walletId) return;
        Object.assign(kept, { list, loaded: true, loading: false });
        actions?.render?.()?.catch?.(() => {});
      })
      .catch(() => Object.assign(kept, { loaded: true, loading: false }));
  }
  return kept;
}

/** Kept a request just made: the list shows it on the next draw. */
export function requestKept(state, list) {
  if (state.requests && Array.isArray(list)) Object.assign(state.requests, { list, loaded: true });
}

/** What a request's card says before one paid already is copied or shared again. */
export const paidAlreadyText = (at) => `This request was paid already, ${onDayAtText(at)}.`;

/**
 * When the request kept that asks what `asked` does was paid, as the list
 * last matched it or as it was kept paid; null where it wasn't, or there's
 * none.
 * @param {object} state - the popup's state
 * @param {{ lux: bigint | string | null, memo: string, network: string, to: string }} asked
 * @returns {number | null}
 */
export function paidAtOf(state, asked) {
  const kept = sameRequest(state?.requests?.list, asked);
  const at = kept ? (kept.paid?.at ?? state.requests.paidAt?.get(kept.id)) : null;
  return Number.isFinite(at) ? at : null;
}

// Whether the system asks for less motion (prefers-reduced-motion).
const lessMotion = () => Boolean(globalThis.window?.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);

/**
 * Asks before a request paid already is copied or shared again, on its own
 * card, so nothing hides it: "This request was paid already, on <date>."
 * with Copy anyway, Share anyway or Save anyway, and Cancel; only its
 * anyway gives it out (Sofía's, Nandini's, Marek's and Chen's: Copy said only
 * Copied, Share sent a fresh "asks you to pay" for an invoice paid twice, and
 * in the app the one toast that said so hid under Android's clipboard preview).
 * Asked with a press, it comes into view, its buttons too (Sofía's, Nandini's
 * and Marek's: it opened below the popup's edge, and the phone's, so the press
 * seemed to do nothing). What's asked stays through a redraw
 * (`holder.asking`), left where it is.
 * @param {object} holder - where the question asked is kept: state.requests, or Receive's form
 * @param {string} key - whose question: a request's ID, or the form's
 * @param {Record<string, { verb: string, go: () => void }>} acts - what each button gives out, by name
 * @returns {{ el: HTMLElement, open: (act: string, at: number) => void }}
 */
export function paidAsk(holder, key, acts) {
  const el = h("div", { class: "callout warn request-paid-ask", role: "alert", hidden: true });
  const close = () => {
    if (holder?.asking?.key === key) holder.asking = null;
    el.hidden = true;
    el.replaceChildren();
  };
  // The question for `act`, open; false where there's none to ask.
  const show = (act, at) => {
    const { verb, go } = acts[act] ?? {};
    if (!go || !Number.isFinite(at)) return false;
    if (holder) holder.asking = { key, act, at };
    el.replaceChildren(
      h("p", { class: "request-paid-ask__text", text: paidAlreadyText(at) }),
      h("div", { class: "request-paid-ask__actions" }, [
        h("button", {
          class: "btn-outline",
          type: "button",
          text: `${verb} anyway`,
          onclick: () => {
            close();
            go();
          },
        }),
        h("button", { class: "btn-outline", type: "button", text: "Cancel", onclick: close }),
      ])
    );
    el.hidden = false;
    return true;
  };
  // Scrolled the least that shows it all: smoothly, as Request payment comes
  // into view, but at once where less motion is asked for.
  const open = (act, at) => {
    if (show(act, at)) el.scrollIntoView?.({ block: "nearest", behavior: lessMotion() ? "auto" : "smooth" });
  };
  if (holder?.asking?.key === key) show(holder.asking.act, holder.asking.at);
  return { el, open };
}

// Reads the history again in 30 seconds, while Receive still shows: the sync's
// redraw asks again. For a shielded request, the overview first, which starts
// a sync of the notes; their history is read again once one is done.
function lookSoon(state, actions, { shielded = false } = {}) {
  const kept = state.requests;
  if (!kept || kept.lookTimer) return;
  kept.lookTimer = setTimeout(async () => {
    kept.lookTimer = 0;
    if (state.route !== "receive") return;
    if (shielded) await Promise.resolve(actions?.render?.({ forceRefresh: true })).catch(() => {});
    if (state.route === "receive") lookForPayments(state.overview, { state, render: actions?.render });
  }, LOOK_MS);
}

// The page's rows, and older ones a read past it kept: newest first, each once.
function mergedEntries(page, older) {
  const seen = new Set(page.map((entry) => entry.hash));
  return [...page, ...older.filter((entry) => !seen.has(entry.hash))].sort((x, y) => (y.blockHeight ?? 0) - (x.blockHeight ?? 0));
}

// What came in since `since`, past Activity's page: read again as the page
// changes, and drawn again once read. The page alone until then.
function requestRows(ov, { state, actions }, kept, since) {
  const a = state.activity;
  if (!a?.loaded || since === null) return activityRows(ov, state);
  const deep = (kept.deep ??= {});
  if ((deep.after !== a.entries || deep.since !== since) && !deep.reading) {
    const after = a.entries;
    const key = a.key;
    deep.reading = true;
    activitySince({ state }, since)
      .then((whole) => Object.assign(deep, { after, key, since, whole }))
      .catch(() => Object.assign(deep, { after, key, since, whole: null }))
      .finally(() => {
        deep.reading = false;
        actions?.render?.()?.catch?.(() => {});
      });
  }
  // Only what was read for this account: another profile's never pays this one's requests.
  const whole = deep.key === a.key ? deep.whole : null;
  return whole ? activityRows(ov, state, { ...whole, entries: mergedEntries(a.entries, whole.entries), meta: a.meta, shielded: a.shielded }) : activityRows(ov, state);
}

// What matched, in words: a memo someone else wrote quoted as Send shows one,
// and what came in on a request paid, as one of any amount is paid with any.
function matchedLine(request, match, again, hidden) {
  const when = match?.at ? ` ${whenAtText(match.at)}` : "";
  if (!match || match.state === "waiting") return ["Nothing matching has come in."];
  if (match.matched === "amount-memo") {
    const what = request.lux === null ? "Its memo matches" : "Amount and memo match";
    if (again.length) return [`${what} ${again.length + 1} payments.`];
    return typeof match.lux === "bigint" ? [`${what} a payment of `, balance(hidden, formatDuskExact(String(match.lux))), ` DUSK${when}.`] : [`${what} a payment${when}.`];
  }
  if (match.matched === "amount") {
    return match.memo ? [`Same amount${when}, with another memo: "`, safeTextEl(match.memo), `". Check it's this one.`] : [`Same amount${when}, with no memo. Check it's this one.`];
  }
  return [hidden ? `Same memo${when}. Check it's this one.` : `Same memo${when}, for ${formatDuskExact(String(match.lux ?? 0n))} DUSK. Check it's this one.`];
}

/**
 * Whether a payment out went after the payment it would pay back came in: by
 * their blocks where both have one, else by their times; one on its way, sent
 * from here, does. Not one whose outcome isn't known: it may never have gone.
 * As the web wallet tells a refund from one before it.
 * @param {object} refund - an Activity row
 * @param {object | undefined} payment - the row of the payment it pays back
 */
const sentAfter = (refund, payment) =>
  typeof refund.blockHeight !== "number"
    ? refund.status === "pending" || refund.status === "executed"
    : typeof payment?.blockHeight === "number"
      ? refund.blockHeight > payment.blockHeight
      : (refund.time ?? 0) > (payment?.time ?? 0);

/**
 * The payments that paid requests again, by their hashes: what Send back
 * would send (app-core's refundOf), and the refund sent already, as Send
 * would say it's sent again, sent after the payment came in. A refund is one
 * payment's only, the newest's first.
 * @returns {Map<string, { back: { to: string, lux: bigint, memo: string } | null, sent: object | null }>}
 */
function refundsOf(requests, matches, rows) {
  const taken = new Set();
  const owed = requests
    .flatMap((request) => {
      const match = matches.get(request.id);
      const again = match?.state === "paid" ? (match.more ?? []).filter((payment) => payment.matched === "amount-memo") : [];
      return again.map((payment) => ({ payment, request }));
    })
    .sort((x, y) => (y.payment.at ?? 0) - (x.payment.at ?? 0));
  return new Map(
    owed.map(({ payment, request }) => {
      const back = refundOf(request, payment, rows);
      const paidIn = rows.find((row) => row.hash === payment.hash);
      const sent = back ? sentAlready(rows.filter((row) => !taken.has(row.hash) && sentAfter(row, paidIn)), back) : null;
      if (sent) taken.add(sent.hash);
      return [payment.hash, { back, sent }];
    })
  );
}

function requestRow(request, match, { ov, hidden, address, state, actions, walletId, rows, rowOf, rowBack, context, refunds, linkOf, message, share = null, earlier = false }) {
  // The payments with all a request asks, after the one that paid it: paid twice, or more.
  const again = match?.state === "paid" ? (match.more ?? []).filter((payment) => payment.matched === "amount-memo") : [];
  // A request of any amount says what came in, plainly: a lux is no green Paid.
  const cameIn = typeof match?.lux === "bigint" ? [balance(hidden, formatDuskExact(String(match.lux))), " DUSK"] : ["Paid"];
  const [word, tone] = earlier
    ? ["Not checked", "muted"]
    : again.length
      ? ["Paid twice", "warn"]
      : match?.state === "paid"
        ? match.anyAmount
          ? [cameIn, "plain"]
          : ["Paid", "ok"]
        : match?.state === "check"
          ? ["Check", "warn"]
          : ["Waiting", "muted"];
  // Paid once, its payment to see; paid more often, each in a list of its own.
  const payments = match?.hash && !again.length ? [{ at: match.at, hash: match.hash }] : [];
  // Opens a payment's details at once, with its row as found here (Activity's
  // page has none past it), read back to its time where it isn't, for the
  // transaction still selected in the context it was found in.
  const open = (hash, at) => {
    const known = rowOf(hash);
    const supplied = (state.txDetailRow = { context, hash, reading: !known, row: known ?? null });
    state.txDetailHash = hash;
    state.txDetailFrom = "receive";
    state.route = "tx";
    actions?.render?.()?.catch?.(() => {});
    if (known) return;
    rowBack(hash, at)
      .catch(() => undefined)
      .then((row) => {
        if (state.txDetailRow !== supplied) return;
        Object.assign(supplied, { reading: false, row: row ?? null });
        if (state.route === "tx" && state.txDetailHash === hash) actions?.render?.()?.catch?.(() => {});
      });
  };
  // Send, filled in to pay a payment that paid it again back: to whoever sent it, what it brought, the request's memo.
  const sendBack = ({ lux, memo, to }) => {
    state.draft = { to, amountDusk: amountForInput(formatDuskPlain(lux)), memo };
    state.route = "send";
    actions?.render?.()?.catch?.(() => {});
  };
  // Paid twice or more: each payment, what it brought and when, to see, and those after the first to send back.
  const paidTimes = again.length ? [{ at: match.at, hash: match.hash, lux: match.lux }, ...again] : [];
  // When each came in to the second: two in the same minute read apart.
  const paymentList = paidTimes.length
    ? h(
        "ul",
        { class: "request-row__payments", "aria-label": "Payments for this request" },
        paidTimes.map((payment, i) => {
          const when = payment.at ? whenAtText(payment.at, Date.now(), { seconds: true }) : "at a time not known";
          const amount = typeof payment.lux === "bigint" ? formatDuskExact(String(payment.lux)) : "";
          const said = [amount && !hidden ? `${amount} DUSK` : "", when].filter(Boolean).join(" ");
          // Sent back already: when, and no Send back to send it twice.
          const refund = i ? refunds.get(payment.hash) : null;
          const sentBack = refund?.sent ? `Sent back ${refund.sent.time ? whenAtText(refund.sent.time, Date.now(), { seconds: true }) : ""}`.trim() : "";
          return h("li", { class: "request-payment" }, [
            h("span", { class: "request-payment__what" }, [amount ? [balance(hidden, amount), " DUSK "] : null, when].flat().filter(Boolean)),
            h("span", { class: "request-payment__actions" }, [
              h("button", { class: "text-btn chain-link", type: "button", text: "See payment", "aria-label": `See the payment of ${said}`, onclick: () => open(payment.hash, payment.at) }),
              sentBack
                ? h("span", { class: "request-payment__sent", text: sentBack })
                : refund?.back
                  ? h("button", { class: "text-btn", type: "button", text: "Send back", "aria-label": `Send back the payment of ${said}`, onclick: () => sendBack(refund.back) })
                  : null,
            ].filter(Boolean)),
          ]);
        })
      )
    : null;
  const remove = () =>
    forgetRequest(walletId, request.id)
      .then((list) => requestKept(state, list))
      .catch(() => actions?.showToast?.("Couldn't remove the request. Try again."))
      .finally(() => actions?.render?.()?.catch?.(() => {}));
  // What it asks comes to in your currency now, on mainnet, hidden with the balances.
  const inCurrency = inCurrencyLine(ov, "request-row__in-currency");
  inCurrency.set(hidden ? null : request.lux);
  // Paid already: said with when beside its Copy and Share, which ask first on the card.
  const paidAt = !earlier && match?.state === "paid" && Number.isFinite(match.at) ? match.at : null;
  const what = `${request.lux === null ? "any amount" : hidden ? "a hidden amount" : `${formatDuskExact(request.lux)} DUSK`}${request.memo ? `, ${request.memo}` : ""}`;
  // Its words and its link, as its Share gives them and the form's Copy
  // request does (Sofía's and Chen's: Copy link gave the bare link, and Share
  // the whole message).
  const copyRequest = message && linkOf(request)
    ? copyButton({
        value: () => message(request),
        label: `Copy the request for ${what}`,
        text: "Copy request",
        className: "text-btn",
        failText: "Copy failed",
        onFail: actions?.showToast,
        hold: () => {
          if (paidAt === null) return false;
          ask.open("copy", paidAt);
          return true;
        },
      })
    : null;
  const ask = paidAsk(state.requests, request.id, {
    copy: { verb: "Copy", go: () => copyRequest?.pressAnyway() },
    share: { verb: "Share", go: () => share?.(request) },
  });
  return h("li", { class: "request-row" }, [
    h("div", { class: "request-row__head" }, [
      h("span", { class: "request-row__amount" }, request.lux === null ? ["Any amount"] : [balance(hidden, formatDuskExact(request.lux)), " DUSK"]),
      h("span", { class: `request-state request-state--${tone}` }, [word].flat()),
    ]),
    inCurrency.el,
    h("div", { class: "request-row__sub" }, [
      request.memo ? h("span", { class: "request-row__memo" }, ["“", safeTextEl(request.memo), "” · "]) : null,
      `${request.to === address ? "Shielded" : "Public"}, asked ${whenAtText(request.at)}`,
    ].filter(Boolean)),
    h("p", { class: "request-row__match" }, earlier ? ["Made by an earlier version for a node it didn't name, so payments aren't checked against it."] : matchedLine(request, match, again, hidden)),
    paymentList,
    h("div", { class: "request-row__actions" }, [
      ...payments.map(({ at, hash }) => h("button", { class: "text-btn chain-link", type: "button", text: "See payment", onclick: () => open(hash, at) })),
      paidAt === null ? null : h("span", { class: "request-row__paid", text: `${again.length ? "Paid twice, first" : "Paid"} ${whenAtText(paidAt)}` }),
      // The request to copy again, as the web wallet's list has it.
      copyRequest,
      // In the app, its own Share beside it: its words, its link and its QR code, as it was asked.
      share && linkOf(request)
        ? h("button", {
            class: "text-btn",
            type: "button",
            text: "Share",
            "aria-label": `Share the request for ${what}`,
            onclick: () => (paidAt === null ? share(request) : ask.open("share", paidAt)),
          })
        : null,
      h("button", { class: "text-btn", type: "button", text: "Remove", "aria-label": `Remove the request${request.memo ? ` "${request.memo}"` : ""}`, onclick: remove }),
    ].filter(Boolean)),
    ask.el,
  ]);
}

/**
 * The profile's requests on this network, or null for none.
 * @param {object} ov
 * @param {{ state: object, actions?: object, message?: (request: object) => string, share?: ((request: object) => void) | null }} opts -
 *   `message`: what a request gives out, copied or shared: its words and link (Receive's); `share`: the app's Share
 * @returns {HTMLElement | null}
 */
export function requestsSection(ov, { state, actions, message = null, share = null } = {}) {
  const kept = keptRequests(ov, { state, actions });
  const { account, profileIndex } = selected(ov);
  const address = String(ov?.addresses?.[profileIndex] ?? "");
  const network = requestNetwork(ov);
  const kind = network.split(":")[0];
  // Kept before chains were told apart, for a custom node or one on this
  // machine: it names no chain, so it's shown on any such node, never matched.
  const earlier = (request) => (request.network === "custom" || request.network === "local") && request.network === kind;
  const ours = (request) => request.network === network || earlier(request);
  const shown = kept.list.filter((request) => ours(request) && (request.to === account || (address && request.to === address)));
  if (!shown.length) return null;
  const mine = shown.filter((request) => !earlier(request));
  // Back to the oldest request not paid yet, a payment a little before it too (app-core's skew).
  const open = mine.filter((request) => !request.paid);
  const since = open.length ? Math.min(...open.map((request) => request.at)) - CLOCK_SKEW_MS : null;
  const rows = requestRows(ov, { state, actions }, kept, since);
  const matches = matchRequests(mine, rows);
  // When each paid, as matched now: Receive's form asks before giving one out again too.
  kept.paidAt = new Map([...matches].filter(([, match]) => match?.state === "paid" && Number.isFinite(match.at)).map(([id, match]) => [id, match.at]));
  const rowOf = (hash) => rows.find((row) => row.hash === hash);
  // A paid request's payment, past the page once it's kept paid: read back to its time.
  const rowBack = async (hash, at) => {
    const a = state.activity;
    const whole = a && Number.isFinite(at) ? await activitySince({ state }, at - CLOCK_SKEW_MS).catch(() => null) : null;
    if (!whole || state.activity !== a) return undefined;
    return activityRows(ov, state, { ...whole, entries: mergedEntries(a.entries, whole.entries), meta: a.meta, shielded: a.shielded }).find((row) => row.hash === hash);
  };
  // What paid a request stays paid once its payment is too far back to read, with what it paid.
  const keep = (request) => matches.get(request.id)?.state === "paid" && (!request.paid || (!request.paid.lux && typeof matches.get(request.id)?.lux === "bigint"));
  if (mine.some(keep)) {
    keepRequestsPaid(kept.walletId, matches)
      .then((list) => requestKept(state, list))
      .catch(() => {});
  }
  // While a request shows, what comes in for it is looked for: one waiting, and
  // one paid, which can be paid again.
  if (mine.length) lookSoon(state, actions, { shielded: mine.some((request) => address && request.to === address) });
  const hidden = balancesHidden(ov);
  const refunds = refundsOf(mine, matches, rows);
  // A request's link, as it was copied: on the network it was made on, this one.
  const chainId = Number.isInteger(ov?.chainId) ? ov.chainId : chainIdFromNodeUrl(String(ov?.nodeUrl ?? ""));
  const linkOf = ({ lux, memo, to }) => {
    const made = makePaymentLink({ amountLux: lux === null ? "" : String(lux), memo, network: chainId, to });
    return made.ok ? (made.https ?? made.dusk) : "";
  };
  return h("section", { class: "box receive-requests" }, [
    h("div", { class: "section-head" }, [bracketTitle({ text: "Requests" })]),
    h(
      "ul",
      { class: "group request-list" },
      shown.map((request) =>
        requestRow(request, earlier(request) ? undefined : matches.get(request.id), { ov, hidden, address, state, actions, walletId: kept.walletId, rows, rowOf, rowBack, context: activityKey(ov), refunds, linkOf, message, share, earlier: earlier(request) })
      )
    ),
  ]);
}
