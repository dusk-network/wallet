// The requests this profile made in Receive on this network, kept on this
// device (shared/paymentRequests.js), each marked by what came in after it
// (app-core's matchRequests) in the words the web wallet uses: Waiting, Paid,
// Check, or Paid twice, with each payment to open in Activity: read back to
// the oldest request not paid, past the page Activity shows. While one waits,
// the history is read again every 30 seconds, as the web wallet does, the
// shielded too once its notes synced.

import { CLOCK_SKEW_MS, matchRequests } from "@dusk-network/app-core/requests";

import { formatDuskExact } from "../../../shared/amount.js";
import { chainIdForNode, networkKeyOf } from "../../../shared/nodeNetwork.js";
import { forgetRequest, keepRequestsPaid, listRequests } from "../../../shared/paymentRequests.js";
import { balance, balancesHidden } from "../../components/Balance.js";
import { bracketTitle } from "../../components/BracketTitle.js";
import { safeTextEl } from "../../components/SafeText.js";
import { h } from "../../lib/dom.js";
import { activityRows, activitySince, lookForPayments, selected } from "../activity.js";
import { whenAtText } from "./txRow.js";

/** How often the history is read again while a request shown waits. */
export const LOOK_MS = 30_000;

/** The network key requests are kept under: "mainnet", "testnet", or another. */
export function requestNetwork(ov) {
  const nodeUrl = String(ov?.nodeUrl ?? "");
  return networkKeyOf(Number.isInteger(ov?.chainId) ? ov.chainId : chainIdForNode(nodeUrl), nodeUrl);
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

// What matched, in words: a memo someone else wrote quoted as Send shows one.
function matchedLine(match, again, hidden) {
  const when = match?.at ? ` ${whenAtText(match.at)}` : "";
  if (!match || match.state === "waiting") return ["Nothing matching has come in."];
  if (match.matched === "amount-memo") return [again.length ? `Amount and memo match ${again.length + 1} payments.` : `Amount and memo match a payment${when}.`];
  if (match.matched === "amount") {
    return match.memo ? [`Same amount${when}, with another memo: "`, safeTextEl(match.memo), `". Check it's this one.`] : [`Same amount${when}, with no memo. Check it's this one.`];
  }
  return [hidden ? `Same memo${when}. Check it's this one.` : `Same memo${when}, for ${formatDuskExact(String(match.lux ?? 0n))} DUSK. Check it's this one.`];
}

function requestRow(request, match, { hidden, address, state, actions, walletId }) {
  // The payments with all a request asks, after the one that paid it: paid twice, or more.
  const again = match?.state === "paid" ? (match.more ?? []).filter((payment) => payment.matched === "amount-memo") : [];
  const [word, tone] = again.length ? ["Paid twice", "warn"] : match?.state === "paid" ? ["Paid", "ok"] : match?.state === "check" ? ["Check", "warn"] : ["Waiting", "muted"];
  const payments = match?.hash ? [{ hash: match.hash }, ...again] : [];
  const open = (hash) => {
    state.txDetailHash = hash;
    state.txDetailFrom = "receive";
    state.route = "tx";
    actions?.render?.()?.catch?.(() => {});
  };
  const remove = () =>
    forgetRequest(walletId, request.id)
      .then((list) => requestKept(state, list))
      .catch(() => actions?.showToast?.("Couldn't remove the request. Try again."))
      .finally(() => actions?.render?.()?.catch?.(() => {}));
  return h("li", { class: "request-row" }, [
    h("div", { class: "request-row__head" }, [
      h("span", { class: "request-row__amount" }, request.lux === null ? ["Any amount"] : [balance(hidden, formatDuskExact(request.lux)), " DUSK"]),
      h("span", { class: `request-state request-state--${tone}`, text: word }),
    ]),
    h("div", { class: "request-row__sub" }, [
      request.memo ? h("span", { class: "request-row__memo" }, ["“", safeTextEl(request.memo), "” · "]) : null,
      `${request.to === address ? "Shielded" : "Public"}, asked ${whenAtText(request.at)}`,
    ].filter(Boolean)),
    h("p", { class: "request-row__match" }, matchedLine(match, again, hidden)),
    h("div", { class: "request-row__actions" }, [
      ...payments.map(({ hash }, i) =>
        h("button", { class: "text-btn chain-link", type: "button", text: payments.length > 1 ? `Payment ${i + 1}` : "See payment", onclick: () => open(hash) })
      ),
      h("button", { class: "text-btn", type: "button", text: "Remove", "aria-label": `Remove the request${request.memo ? ` "${request.memo}"` : ""}`, onclick: remove }),
    ]),
  ]);
}

/**
 * The profile's requests on this network, or null for none.
 * @returns {HTMLElement | null}
 */
export function requestsSection(ov, { state, actions } = {}) {
  const kept = keptRequests(ov, { state, actions });
  const { account, profileIndex } = selected(ov);
  const address = String(ov?.addresses?.[profileIndex] ?? "");
  const network = requestNetwork(ov);
  const mine = kept.list.filter((request) => request.network === network && (request.to === account || (address && request.to === address)));
  if (!mine.length) return null;
  // Back to the oldest request not paid yet, a payment a little before it too (app-core's skew).
  const open = mine.filter((request) => !request.paid);
  const since = open.length ? Math.min(...open.map((request) => request.at)) - CLOCK_SKEW_MS : null;
  const matches = matchRequests(mine, requestRows(ov, { state, actions }, kept, since));
  // What paid a request stays paid once its payment is too far back to read.
  if (mine.some((request) => !request.paid && matches.get(request.id)?.state === "paid")) {
    keepRequestsPaid(kept.walletId, matches)
      .then((list) => requestKept(state, list))
      .catch(() => {});
  }
  const waiting = mine.filter((request) => matches.get(request.id)?.state !== "paid");
  if (waiting.length) lookSoon(state, actions, { shielded: waiting.some((request) => address && request.to === address) });
  const hidden = balancesHidden(ov);
  return h("section", { class: "box receive-requests" }, [
    h("div", { class: "section-head" }, [bracketTitle({ text: "Requests" })]),
    h("ul", { class: "group request-list" }, mine.map((request) => requestRow(request, matches.get(request.id), { hidden, address, state, actions, walletId: kept.walletId }))),
  ]);
}
