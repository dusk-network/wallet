// Activity on Home (the five newest rows and See all) and the full Activity
// view: day groups, the All / Sent / Received / Staking filters, Show more
// for older history, and Export for the rows listed (activityExport.js).

import { explorerAccountUrl } from "../../../shared/explorer.js";
import { openUrl } from "../../../platform/index.js";
import { h } from "../../lib/dom.js";
import { iconSvg } from "../../components/ActionIcon.js";
import { balancesHidden } from "../../components/Balance.js";
import { bracketTitle } from "../../components/BracketTitle.js";
import { subnav } from "../../components/Subnav.js";
import { activityRows, hasMoreActivity, showMoreActivity } from "../activity.js";
import { activityExportPanel } from "../activityExport.js";
import { ACTIVITY_FILTERS, blockTimes, clockText, contactNames, dayLabel, describeTx, inFilter, recentText, txRowEl, txTime, whenText } from "./txRow.js";

/** Rows Home shows. */
export const RECENT_ROWS = 5;

// A row's time for its day: its own, else an estimate from its block height
// (blocks come about every 10 seconds) until its details arrive.
function rowTime(tx, state, times) {
  const own = txTime(tx) || times?.get(Number(tx?.blockHeight)) || 0;
  if (own) return own;
  const meta = state?.activity?.meta;
  const height = Number(tx?.blockHeight);
  if (!meta?.headAt || !Number.isFinite(height)) return 0;
  return meta.headAt - Math.max(0, Number(meta.finalized) - height) * 10_000;
}

// Nothing to show yet: say whether the history is still being looked for.
function emptyText(state, filter) {
  const a = state?.activity;
  if (a && (!a.loaded || a.syncing) && !a.error) return "Looking for your activity…";
  if (filter === "sent") return "Nothing sent yet.";
  if (filter === "received") return "Nothing received yet.";
  if (filter === "staking") return "No staking yet.";
  return "No activity yet.";
}

const empty = (text) => h("div", { class: "group" }, [h("p", { class: "tx-empty", text })]);

/**
 * Home's Activity: the newest rows, and See all.
 * @returns {HTMLElement}
 */
export function recentActivitySection(ov, { state, actions } = {}) {
  const hidden = balancesHidden(ov);
  const contactName = contactNames(state, actions);
  const nodeUrl = String(ov?.nodeUrl ?? "");
  const rows = activityRows(ov, state);
  const recent = rows.slice(0, RECENT_ROWS);
  const now = Date.now();
  const times = blockTimes(rows);
  const when = (tx) => whenText(tx, { times, format: (t) => recentText(t, now) });

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

/**
 * The full Activity view.
 * @returns {HTMLElement[]}
 */
export function activityView(ov, { state, actions } = {}) {
  const hidden = balancesHidden(ov);
  const contactName = contactNames(state, actions);
  const filter = ACTIVITY_FILTERS.some((f) => f.id === state?.activityFilter) ? state.activityFilter : "all";
  const nodeUrl = String(ov?.nodeUrl ?? "");
  const all = activityRows(ov, state);
  const times = blockTimes(all);
  const rows = all.filter((tx) => inFilter(describeTx(tx, { contactName, nodeUrl }), filter));
  const when = (tx) => whenText(tx, { times, format: clockText });

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
    const t = rowTime(tx, state, times);
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

  // Older history: kept rows past this page, or the next sync of older blocks.
  const more = hasMoreActivity(state)
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

  // Export: the rows listed, as a CSV file, from a panel under the head.
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
      ex.open ? activityExportPanel(ov, rows, { state, actions, nodeUrl }) : null,
      chips,
      ...(groups.length ? groups : [empty(emptyText(state, filter))]),
      more,
      explorer,
    ].filter(Boolean)),
  ];
}
