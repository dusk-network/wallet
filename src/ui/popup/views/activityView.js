// Activity on Home (the five newest rows and See all) and the full Activity
// view: a search, day groups, the All / Sent / Received / Staking / Bridge
// filters, Show more for older history, and Export for an accountant
// (activityExport.js).

import { amountsMeant } from "@dusk-network/app-core/amounts";
import { nameSkeleton } from "@dusk-network/app-core/names";
import { searchKey } from "@dusk-network/app-core/text";

import { explorerAccountUrl } from "../../../shared/explorer.js";
import { openUrl } from "../../../platform/index.js";
import { h } from "../../lib/dom.js";
import { textInput } from "../../components/FormControls.js";
import { waiting } from "../../components/Waiting.js";
import { iconSvg } from "../../components/ActionIcon.js";
import { balancesHidden } from "../../components/Balance.js";
import { bracketTitle } from "../../components/BracketTitle.js";
import { subnav } from "../../components/Subnav.js";
import { activityRows, hasMoreActivity, searchedActivity, showMoreActivity } from "../activity.js";
import { activityExportPanel } from "../activityExport.js";
import { ACTIVITY_FILTERS, clockText, contactNames, dayLabel, describeTx, inFilter, recentText, txRowEl, whenText } from "./txRow.js";

/** Rows Home shows. */
export const RECENT_ROWS = 5;

// A row's time for its day: its own, else an estimate from its block height
// (blocks come about every 10 seconds) until its details arrive.
function rowTime(row, state) {
  if (row.time) return row.time;
  const meta = state?.activity?.meta;
  if (!meta?.headAt || row.blockHeight === null) return 0;
  return meta.headAt - Math.max(0, Number(meta.finalized) - row.blockHeight) * 10_000;
}

const LOOKING = "Looking for your activity…";
// Nothing to show yet: say whether the history is still being looked for.
function emptyText(state, filter) {
  const a = state?.activity;
  if (a && (!a.loaded || a.syncing) && !a.error) return LOOKING;
  if (filter === "sent") return "Nothing sent yet.";
  if (filter === "received") return "Nothing received yet.";
  if (filter === "staking") return "No staking yet.";
  if (filter === "bridge") return "No bridge transfers yet.";
  return "No activity yet.";
}

const LOOKING_BACK = "Looking through all your activity…";
// Nothing found: what's searched covers the whole history once it's read,
// what's read so far where it can't be.
function searchedText(state, filter, query, searched) {
  const text = emptyText(state, filter);
  if (!query || text === LOOKING) return text;
  if (searched.reading && !searched.whole) return LOOKING_BACK;
  return !searched.whole && hasMoreActivity(state) ? "Nothing read so far matches that. Show more to look further back." : "Nothing in your activity matches that.";
}

const empty = (text) =>
  h("div", { class: "group" }, [text === LOOKING || text === LOOKING_BACK ? waiting(text, { tag: "p", className: "tx-empty" }) : h("p", { class: "tx-empty", text })]);

/**
 * Home's Activity: the newest rows, and See all.
 * @returns {HTMLElement}
 */
export function recentActivitySection(ov, { state, actions } = {}) {
  const hidden = balancesHidden(ov);
  const contactName = contactNames(state, actions, ov);
  const nodeUrl = String(ov?.nodeUrl ?? "");
  const rows = activityRows(ov, state);
  const recent = rows.slice(0, RECENT_ROWS);
  const now = Date.now();
  const when = (row) => whenText(row, (t) => recentText(t, now));

  const seeAll = rows.length
    ? h(
        "button",
        {
          class: "see-all chain-link",
          type: "button",
          onclick: () => {
            state.route = "activity";
            state.activityFilter = "all";
            actions?.render?.()?.catch?.(() => {});
          },
        },
        [h("span", { text: "See all" }), h("span", { class: "btn-ico", "aria-hidden": "true", html: iconSvg("chev-r") })]
      )
    : null;

  return h("section", { class: "box home-activity" }, [
    h("div", { class: "section-head" }, [bracketTitle({ text: "Activity" }), seeAll].filter(Boolean)),
    recent.length
      ? h("ul", { class: "group tx-list" }, recent.map((tx) => txRowEl(tx, { state, actions, hidden, nodeUrl, contactName, when })))
      : empty(emptyText(state, "all")),
  ]);
}

// A text by what it looks like (app-core's nameSkeleton), whatever its case and accents.
const lookKey = (text) => searchKey(nameSkeleton(String(text ?? "").toLowerCase()));

/**
 * Whether a row has what's searched for, in any case and with or without its
 * accents (app-core's searchKey): its name, contact or .dusk name, address,
 * memo as text, or transaction ID; and while balances show, its amount: of
 * DUSK by the amounts what's typed can mean, with either decimal mark
 * (app-core's amountsMeant), and a token's as it shows.
 */
export function inSearch(tx, desc, query, { hidden = false } = {}) {
  const q = searchKey(query);
  if (!q) return true;
  const memo = tx?.entry?.memoBinary === true ? "" : tx?.memo;
  const has = (field) => searchKey(field).includes(q);
  // A name holds what's typed, or looks as if it did in letters of another
  // script, as "Estudio Mаrta" with a Cyrillic а for "marta": a name marked
  // as looking like another is found with it, as the web wallet finds it.
  const looks = (field) => q.length >= 3 && lookKey(field).includes(lookKey(query));
  if ([desc.isAddress ? "" : desc.name, desc.alias].some(looks)) return true;
  if ([desc.name, desc.alias, desc.address, desc.recipient, desc.lead, tx?.counterparty, memo, tx?.hash].some(has)) return true;
  if (hidden || !desc.amount) return false;
  if (desc.amount.unit !== "DUSK" || desc.amount.text) return [desc.amount.value, desc.amount.exact, desc.amount.plain].some(has);
  const lux = typeof tx?.value === "bigint" ? tx.value : null;
  return lux !== null && amountsMeant(query).some(({ from, to }) => lux >= from && lux < to);
}

/**
 * The full Activity view.
 * @returns {HTMLElement[]}
 */
export function activityView(ov, { state, actions } = {}) {
  const hidden = balancesHidden(ov);
  const contactName = contactNames(state, actions, ov);
  const filter = ACTIVITY_FILTERS.some((f) => f.id === state?.activityFilter) ? state.activityFilter : "all";
  const nodeUrl = String(ov?.nodeUrl ?? "");
  const query = String(state?.activitySearch ?? "").trim();
  // A search covers the whole history, read whole as it's typed; what's read so far meanwhile.
  const searched = query ? searchedActivity(ov, { state, render: actions?.render }) : { whole: null, reading: false };
  const rows = activityRows(ov, state, searched.whole).filter((tx) => {
    const desc = describeTx(tx, { contactName, nodeUrl });
    return inFilter(desc, filter) && inSearch(tx, desc, query, { hidden });
  });
  const when = (row) => whenText(row, clockText);

  // Drawn again as it's typed in: the redraw keeps the field's focus and caret (app.js).
  const search = textInput({
    class: "activity-search",
    type: "search",
    placeholder: "Search",
    "aria-label": "Search activity",
    value: String(state?.activitySearch ?? ""),
  });
  search.addEventListener("input", () => {
    state.activitySearch = search.value;
    actions?.render?.()?.catch?.(() => {});
  });

  const chips = h(
    "div",
    { class: "filter-chips", role: "group", "aria-label": "Show" },
    ACTIVITY_FILTERS.map((f) =>
      h("button", {
        class: "filter-chip",
        type: "button",
        text: f.label,
        "aria-pressed": f.id === filter,
        // The redraw keeps the focus on the chip (app.js).
        onclick: () => {
          if (f.id === filter) return;
          state.activityFilter = f.id;
          actions?.render?.()?.catch?.(() => {});
        },
      })
    )
  );

  // Rows by day, newest first, as activityRows sorts them.
  const now = Date.now();
  const days = [];
  for (const tx of rows) {
    const t = rowTime(tx, state);
    const label = t ? dayLabel(t, now) : "Earlier";
    const last = days[days.length - 1];
    if (last?.label === label) last.rows.push(tx);
    else days.push({ label, rows: [tx] });
  }

  const groups = days.map(({ label, rows: dayRows }) =>
    h("section", { class: "tx-day" }, [
      h("h2", { class: "tx-day-label", text: label }),
      h("ul", { class: "group tx-list" }, dayRows.map((tx) => txRowEl(tx, { state, actions, hidden, nodeUrl, contactName, when }))),
    ])
  );

  // Older history: kept rows past this page, or the next sync of older blocks;
  // none for a search, which reads it all.
  const more = hasMoreActivity(state) && !(query && (searched.whole || searched.reading))
    ? h("button", {
        class: "btn-outline tx-more",
        type: "button",
        text: state?.activity?.syncing ? "Loading…" : "Show more",
        disabled: Boolean(state?.activity?.syncing),
        onclick: (e) => {
          const btn = e?.currentTarget;
          if (btn) {
            btn.disabled = true;
            btn.textContent = "Loading…";
          }
          showMoreActivity({ state, render: actions?.render })
            .catch(() => {})
            .finally(() => actions?.render?.()?.catch?.(() => {}));
        },
      })
    : null;

  // The account's page on Dusk's explorer, for history beyond this wallet.
  const accountIdx = Math.max(0, Math.floor(Number(ov?.selectedAccountIndex) || 0));
  const explorerUrl = explorerAccountUrl(nodeUrl, String(ov?.accounts?.[accountIdx] ?? ""));
  const explorer = explorerUrl
    ? h(
        "button",
        {
          class: "text-btn tx-explorer chain-link",
          type: "button",
          onclick: async () => {
            const ok = await openUrl(explorerUrl);
            if (!ok) actions?.showToast?.("Couldn't open the explorer");
          },
        },
        [h("span", { text: "View in Dusk explorer" }), h("span", { class: "btn-ico", "aria-hidden": "true", html: iconSvg("ext") })]
      )
    : null;

  // Export: a file for an accountant, from a panel under the head.
  const ex = (state.activityExport ??= { open: false, withContacts: false });
  const exportToggle = h("button", {
    class: "btn-outline activity-export-toggle",
    type: "button",
    text: "Export",
    "aria-expanded": ex.open,
    "aria-controls": "activity-export",
    onclick: () => {
      ex.open = !ex.open;
      actions?.render?.()?.catch?.(() => {});
    },
  });

  return [
    subnav({
      title: "Activity",
      actions: [exportToggle],
      onBack: () => {
        state.route = "home";
        actions?.render?.()?.catch?.(() => {});
      },
    }),
    h("div", { class: "activity-page" }, [
      ex.open ? activityExportPanel(ov, { state, actions }) : null,
      search,
      chips,
      ...(groups.length ? groups : [empty(searchedText(state, filter, query, searched))]),
      groups.length && searched.reading && !searched.whole ? empty(LOOKING_BACK) : null,
      more,
      explorer,
    ].filter(Boolean)),
  ];
}
