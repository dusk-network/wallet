import {
  UI_DISPLAY_DECIMALS,
  formatLuxToDusk,
  formatLuxShort,
  groupThousands,
  safeBigInt,
} from "../../../shared/amount.js";
import { TX_KIND } from "../../../shared/constants.js";
import { listAddressBook } from "../../../shared/addressBook.js";
import { explorerAccountUrl, explorerTxUrl } from "../../../shared/explorer.js";
import { h } from "../../lib/dom.js";
import { copyToClipboard } from "../../lib/clipboard.js";
import { truncateMiddle } from "../../lib/strings.js";
import { openUrl } from "../../../platform/index.js";
import { assetsSectionsView } from "./assets.js";
import { txActivityStatusLabel, txKindRailLabel, txStatusTone } from "./txDisplay.js";
import { bracketTitle } from "../../components/BracketTitle.js";
import { recipientBadge } from "../../components/RecipientBadge.js";
import { subnav } from "../../components/Subnav.js";
import { actionIcon, iconSvg } from "../../components/ActionIcon.js";
import { balance, balancesHidden } from "../../components/Balance.js";
import { activityRows, hasMoreActivity, showMoreActivity } from "../activity.js";

function timeAgo(ts) {
  const t = Number(ts || 0);
  if (!t) return "";
  const ms = Date.now() - t;
  if (ms < 0) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${Math.max(1, s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const hhr = Math.floor(m / 60);
  if (hhr < 24) return `${hhr}h`;
  const d = Math.floor(hhr / 24);
  return `${d}d`;
}

function formatTokenUnits(units, decimals, { maxFrac = 6 } = {}) {
  const u = safeBigInt(units, 0n);
  let d = Number(decimals ?? 0);
  if (!Number.isFinite(d) || d < 0) d = 0;
  d = Math.min(64, Math.floor(d));

  const s = u.toString();
  if (d === 0) return s;

  const pad = s.length <= d ? "0".repeat(d - s.length + 1) + s : s;
  const intPart = pad.slice(0, -d) || "0";
  let frac = pad.slice(-d);

  // Trim trailing zeros, then clamp.
  frac = frac.replace(/0+$/, "");
  if (typeof maxFrac === "number" && maxFrac >= 0 && frac.length > maxFrac) {
    frac = frac.slice(0, maxFrac).replace(/0+$/, "");
  }

  return frac ? `${intPart}.${frac}` : intPart;
}

export function homeView(ov, { state, actions } = {}) {
  const hidden = balancesHidden(ov);
  const hasBalance = Boolean(ov?.balance?.value);
  const pubLux = safeBigInt(ov?.balance?.value, 0n);
  const balFull = hasBalance ? formatLuxToDusk(pubLux) : "—";
  const balDusk = hasBalance ? formatLuxShort(pubLux, UI_DISPLAY_DECIMALS) : "—";

  // Shielded balance
  // If we can't compute it yet (sync in progress), we still show the row
  // and surface progress in the subtitle.
  const shieldedSync = ov?.shieldedSync || null;
  const shieldedError = ov?.shieldedError ? String(ov.shieldedError) : "";
  const shieldLux = ov?.shieldedBalance?.value ?? ov?.shieldedBalance;
  const hasShieldValue = shieldLux !== undefined && shieldLux !== null;
  // Always show the shielded row for Dusk. If values aren't available yet,
  // we show placeholders + sync state.
  const showShielded = true;
  const shieldFull = hasShieldValue ? formatLuxToDusk(shieldLux) : "—";
  const shieldDusk = hasShieldValue ? formatLuxShort(shieldLux, UI_DISPLAY_DECIMALS) : "—";

  // Total (public + shielded) is only meaningful once shielded value is known.
  const shieldLuxBI = hasShieldValue ? safeBigInt(shieldLux, 0n) : null;

  // When a shielded tx is pending we reserve notes locally to prevent
  // double-spends. That can make the *available* shielded balance drop to 0
  // until the change note is discovered. We keep the hero/asset amount based
  // on the total (value), and show a small "Pending" hint when applicable.
  const shieldSpendLux = ov?.shieldedBalance?.spendable;
  const hasShieldSpendable = shieldSpendLux !== undefined && shieldSpendLux !== null;
  const shieldSpendBI = hasShieldSpendable ? safeBigInt(shieldSpendLux, 0n) : null;
  const reservedLux =
    typeof shieldLuxBI === "bigint" && typeof shieldSpendBI === "bigint"
      ? shieldLuxBI > shieldSpendBI
        ? shieldLuxBI - shieldSpendBI
        : 0n
      : 0n;
  const hasTotal = hasBalance && typeof shieldLuxBI === "bigint";
  const totalLux = hasTotal ? pubLux + shieldLuxBI : null;
  const totalFull = hasTotal ? formatLuxToDusk(totalLux) : null;
  const totalDusk = hasTotal ? formatLuxShort(totalLux, UI_DISPLAY_DECIMALS) : null;

  // Shielded status suffix shown in Assets breakdown.
  // We only show a suffix when *not* fully healthy, to avoid "Shielded • Shielded".
  let shieldStatus = null;
  let shieldStatusTitle = shieldedError || shieldedSync?.lastError || undefined;
  if (shieldedSync?.state === "idle") {
    const n = Number(shieldedSync?.notes ?? 0);
    if (n <= 0) shieldStatus = "Not synced";
  } else if (shieldedSync?.state === "syncing") {
    const p = Number(shieldedSync.progress ?? 0);
    const pct = Math.max(0, Math.min(100, Math.round(p * 100)));
    // Avoid the UX trap where we show a hard "0%" for a long time.
    // If progress is >0 but rounds to 0, display "<1%" instead.
    shieldStatus = pct === 0 && p > 0 ? "Syncing <1%" : `Syncing ${pct}%`;
  } else if (shieldedSync?.state === "error") {
    shieldStatus = "Sync failed";
  }

  if (shieldedError && shieldedSync?.state !== "syncing") {
    shieldStatus = "Unavailable";
  }

  // If everything is synced and error-free but we have locally reserved notes,
  // show a small hint.
  if (!shieldStatus && reservedLux > 0n) {
    shieldStatus = "Pending";
    shieldStatusTitle = hidden ? undefined : `Reserved ${formatLuxShort(reservedLux, UI_DISPLAY_DECIMALS)} DUSK`;
  }

  // Home hero shows the total once shielded is available.
  const heroAmt = hasTotal ? totalDusk : balDusk;
  const heroAmtTitle = hasTotal ? totalFull : balFull;
  const heroLabel = hasTotal ? "Total balance" : "Public balance";

  // Refresh, moved here from the header, sits with the balance it reloads.
  const refreshBtn = h("button", {
    class: "balance-refresh",
    type: "button",
    html: iconSvg("refresh"),
    title: "Refresh",
    "aria-label": "Refresh",
    onclick: () => actions?.refresh?.()?.catch?.(() => {}),
  });
  // Hide balances: every balance shows as •••• until it's pressed again. Its
  // name stays; aria-pressed says whether they're hidden.
  const eyeBtn = h("button", {
    class: "balance-eye",
    type: "button",
    html: iconSvg(hidden ? "eye-off" : "eye"),
    title: "Hide balances",
    "aria-label": "Hide balances",
    "aria-pressed": hidden,
    onclick: async () => {
      // At once and for the rest of this popup, then saved for the next one.
      state.hideBalances = !hidden;
      if (state.overview) state.overview.hideBalances = !hidden;
      // The page redraws, the eye with it: the focus stays on the eye.
      actions
        ?.render?.()
        ?.then?.(() => document.querySelector("button.balance-eye")?.focus?.())
        ?.catch?.(() => {});
      try {
        const res = await actions?.send?.({ type: "DUSK_UI_SET_HIDE_BALANCES", hideBalances: !hidden });
        if (res?.error) throw new Error(res.error.message);
      } catch (e) {
        actions?.showToast?.(e?.message || "Couldn't save Hide balances.", 2500);
      }
    },
  });
  // "Total balance", then the eye and Refresh.
  const balanceLabel = h("div", { class: "balance-label" }, [
    h("span", { class: "balance-label__text", text: heroLabel }),
    eyeBtn,
    refreshBtn,
  ]);

  // "Public 1,484.92 · Shielded 0" under the total.
  const balanceSplit = h("div", { class: "balance-split" }, [
    h("div", { class: "balance-split-item" }, [
      h("span", { class: "balance-split-label", text: "Public" }),
      h("span", { class: "balance-split-value", title: hidden ? undefined : groupThousands(balFull) }, [
        balance(hidden, groupThousands(balDusk)),
      ]),
    ]),
    showShielded
      ? h("div", { class: "balance-split-item" }, [
          h("span", {
            class: "balance-split-label",
            text: shieldStatus ? `Shielded · ${shieldStatus}` : "Shielded",
            title: shieldStatusTitle,
          }),
          h("span", { class: "balance-split-value", title: hidden ? undefined : groupThousands(shieldFull) }, [
            balance(hidden, groupThousands(shieldDusk)),
          ]),
        ])
      : null,
  ].filter(Boolean));

  const actionBtn = (label, icon, onClick) =>
    h(
      "button",
      {
        class: "action-btn",
        onclick: onClick,
      },
      [
        actionIcon(icon),
        h("div", { class: "action-btn-label", text: label }),
      ]
    );

  const actionBar = h("div", { class: "action-bar" }, [
    actionBtn("Send", "send", () => {
      state.route = "send";
      state.draft = null;
      actions?.render?.().catch(() => {});
    }),
    actionBtn("Receive", "receive", () => {
      state.route = "receive";
      actions?.render?.().catch(() => {});
    }),
    actionBtn("Shield", "shield", () => {
      state.route = "convert";
      state.draft = { kind: TX_KIND.SHIELD, amountDusk: "", amountLux: "" };
      actions?.render?.().catch(() => {});
    }),
    actionBtn("Stake", "stake", () => {
      state.route = "stake";
      // Staking opens on its overview.
      if (state.staking) state.staking.screen = "overview";
      actions?.render?.().catch(() => {});
    }),
  ]);

  const dashboardTopbar = h("div", { class: "dashboard-topbar" }, [
    bracketTitle({ class: "dashboard-title", text: "Dashboard" }),
    h("div", { class: "dashboard-top-actions" }, [
      h("button", {
        class: "btn-outline dashboard-top-action",
        text: "Receive",
        onclick: () => {
          state.route = "receive";
          actions?.render?.().catch(() => {});
        },
      }),
      h("button", {
        class: "btn-primary dashboard-top-action",
        text: "Send",
        onclick: () => {
          state.route = "send";
          state.draft = null;
          actions?.render?.().catch(() => {});
        },
      }),
    ]),
  ]);

  // The balance sits on the page, the amount large with a muted unit; the
  // round actions follow it.
  const heroText = groupThousands(heroAmt);
  const hero = h("div", { class: "home-balance home-hero" }, [
    balanceLabel,
    h(
      "div",
      {
        class: !hidden && heroText.length > 11 ? "balance-amount is-long" : "balance-amount",
        title: hidden ? undefined : groupThousands(heroAmtTitle),
      },
      [balance(hidden, heroText), heroAmt === "—" ? null : h("span", { class: "balance-unit", text: " DUSK" })].filter(Boolean)
    ),
    balanceSplit,
    ov?.balanceError
      ? h("div", { class: "muted", text: `Balance error: ${ov.balanceError}` })
      : null,
  ].filter(Boolean));

  // Activity list: this wallet's transactions with the account's history.
  const txs = activityRows(ov, state);
  const nodeUrl = String(ov?.nodeUrl ?? "");
  const accountIndexRaw = Number(ov?.selectedAccountIndex ?? 0);
  const accountIndex = Number.isFinite(accountIndexRaw) && accountIndexRaw >= 0 ? Math.floor(accountIndexRaw) : 0;
  const publicAccount = String(ov?.accounts?.[accountIndex] ?? ov?.accounts?.[0] ?? "").trim();
  const publicHistoryUrl = explorerAccountUrl(nodeUrl, publicAccount);

  const contactByAddress = new Map();
  try {
    const ab = state?.addressBook;
    if (ab?.loaded && Array.isArray(ab.items)) {
      for (const entry of ab.items) {
        const addr = String(entry?.address ?? "").trim();
        if (!addr) continue;
        contactByAddress.set(addr.toLowerCase(), entry);
      }
    } else if (state && !ab?.loading) {
      state.addressBook = {
        ...(ab || {}),
        loading: true,
      };
      listAddressBook()
        .then((items) => {
          state.addressBook = {
            ...(state.addressBook || {}),
            loaded: true,
            loading: false,
            error: null,
            items,
          };
          actions?.render?.().catch(() => {});
        })
        .catch(() => {
          state.addressBook = {
            ...(state.addressBook || {}),
            loading: false,
          };
        });
    }
  } catch {
    // ignore contact badge loading failures
  }

  const statusClass = (status) => {
    return `status-dot status-dot--${txStatusTone(status)}`;
  };

  const statusLabel = (status) => {
    return txActivityStatusLabel(status);
  };

  // The other side of a transfer: the .dusk name typed when sending, else its
  // verified .dusk name, else its address.
  const party = (tx, addr) => {
    const name = String((tx?.direction === "in" ? "" : tx?.toName) || tx?.counterpartyName || "").trim();
    return name || (addr ? truncateMiddle(String(addr), 10, 8) : "");
  };

  const describe = (tx) => {
    const kind = String(tx?.kind ?? "").toLowerCase();
    if (kind === TX_KIND.TRANSFER) {
      const amt = tx?.amount != null ? formatLuxShort(tx.amount, UI_DISPLAY_DECIMALS) : "";
      if (tx?.direction === "in") {
        const from = party(tx, tx?.from);
        return {
          title: from ? `Received from ${from}` : "Received DUSK",
          sub: txKindRailLabel(tx),
          amount: amt ? `+${amt} DUSK` : "",
          tone: "in",
          icon: "↓",
        };
      }
      if (tx?.direction === "self") {
        return { title: "Sent to yourself", sub: txKindRailLabel(tx), amount: amt ? `${amt} DUSK` : "", tone: "neutral", icon: "↑" };
      }
      const to = party(tx, tx?.to);
      return {
        title: to ? `Sent to ${to}` : "Sent DUSK",
        sub: txKindRailLabel(tx),
        amount: amt ? `-${amt} DUSK` : "",
        tone: "out",
        icon: "↑",
      };
    }
    // Named as the Shield view and the transaction details name them.
    if (kind === TX_KIND.SHIELD) {
      const amt = tx?.amount != null ? formatLuxShort(tx.amount, UI_DISPLAY_DECIMALS) : "";
      return {
        title: "Shield",
        sub: "Public → Shielded",
        amount: amt ? `${amt} DUSK` : "—",
        tone: "shield",
        icon: "✦",
      };
    }
    if (kind === TX_KIND.UNSHIELD) {
      const amt = tx?.amount != null ? formatLuxShort(tx.amount, UI_DISPLAY_DECIMALS) : "";
      return {
        title: "Unshield",
        sub: "Shielded → Public",
        amount: amt ? `${amt} DUSK` : "—",
        tone: "shield",
        icon: "✦",
      };
    }
    if (kind === TX_KIND.CONTRACT_CALL) {
      const asset = tx?.asset && typeof tx.asset === "object" ? tx.asset : null;
      if (asset && String(asset?.type ?? "") === "DRC20") {
        const sym = String(asset?.symbol ?? "").trim() || "Token";
        const op = String(asset?.op ?? "").toLowerCase();

        if (op === "transfer") {
          const amt = formatTokenUnits(asset?.valueUnits ?? asset?.value ?? "0", asset?.decimals ?? 0, { maxFrac: 6 });
          const to = asset?.to ? truncateMiddle(String(asset.to), 10, 8) : "";
          return {
            title: to ? `Sent ${sym} to ${to}` : `Sent ${sym}`,
            sub: "Moonlight",
            amount: amt ? `-${amt} ${sym}` : "",
            tone: "out",
            icon: "↑",
          };
        }

        if (op === "approve") {
          const isMax = Boolean(asset?.isMax);
          const amt = isMax
            ? "MAX"
            : formatTokenUnits(asset?.valueUnits ?? asset?.value ?? "0", asset?.decimals ?? 0, { maxFrac: 6 });
          const spender = asset?.spender ? truncateMiddle(String(asset.spender), 10, 8) : "";
          const sub = [spender ? `spender ${spender}` : "", amt ? `amount ${amt}` : ""].filter(Boolean).join(" · ");
          return {
            title: `Approve ${sym}`,
            sub,
            amount: isMax ? "MAX" : amt,
            tone: "neutral",
            icon: "·",
          };
        }

        return { title: `Call ${sym}`, sub: String(tx?.fnName ?? ""), amount: "—", tone: "neutral", icon: "◇" };
      }

      if (asset && String(asset?.type ?? "") === "DRC721") {
        const sym = String(asset?.symbol ?? "").trim() || "NFT";
        const tokenId = asset?.tokenId != null ? String(asset.tokenId) : "";
        const op = String(asset?.op ?? "").toLowerCase();
        const title = tokenId ? `${sym} #${tokenId}` : sym;
        const sub = op ? op : String(tx?.fnName ?? "");
        return { title, sub, amount: "—", tone: "neutral", icon: "◇" };
      }

      const fn = tx?.fnName ? String(tx.fnName) : "contract call";
      const dep = safeBigInt(tx?.deposit, 0n);
      const depS = dep > 0n ? formatLuxShort(dep, UI_DISPLAY_DECIMALS) : "";
      return {
        title: `Call ${fn}`,
        sub: depS ? `deposit ${depS} DUSK` : "",
        amount: depS ? `-${depS} DUSK` : "—",
        tone: depS ? "out" : "neutral",
        icon: "◇",
      };
    }
    if (kind === TX_KIND.STAKE) {
      const amt = tx?.amount != null ? formatLuxShort(tx.amount, UI_DISPLAY_DECIMALS) : "";
      return {
        title: "Stake",
        sub: "Native staking",
        amount: amt ? `-${amt} DUSK` : "",
        tone: "out",
        icon: "△",
      };
    }
    if (kind === TX_KIND.UNSTAKE) {
      const amt = tx?.amount != null ? formatLuxShort(tx.amount, UI_DISPLAY_DECIMALS) : "";
      return {
        title: "Unstake",
        sub: tx?.amount != null ? "Native staking" : "Full stake",
        amount: amt ? `${amt} DUSK` : "—",
        tone: "in",
        icon: "△",
      };
    }
    if (kind === TX_KIND.WITHDRAW_REWARD) {
      const amt = tx?.amount != null ? formatLuxShort(tx.amount, UI_DISPLAY_DECIMALS) : "";
      return {
        title: "Claim rewards",
        sub: tx?.amount != null ? "Native staking rewards" : "All rewards",
        amount: amt ? `+${amt} DUSK` : "—",
        tone: "in",
        icon: "↓",
      };
    }
    return { title: "Transaction", sub: "", amount: "—", tone: "neutral", icon: "•" };
  };

  const contactForTx = (tx) => {
    const asset = tx?.asset && typeof tx.asset === "object" ? tx.asset : null;
    const addr = String(tx?.to || tx?.from || asset?.to || "").trim();
    if (!addr) return null;
    const entry = contactByAddress.get(addr.toLowerCase());
    const name = String(entry?.name ?? "").trim();
    if (!name) return null;
    return { address: addr, name };
  };

  const pulseClassFor = (hash) => {
    try {
      const p = state?.txPulse;
      if (!p || !hash) return "";
      if (String(p.hash) !== String(hash)) return "";
      if (Date.now() - Number(p.at || 0) > 2500) return "";
      return p.kind === "bad" ? "is-pulse-bad" : "is-pulse-ok";
    } catch {
      return "";
    }
  };

  const txRow = (tx) => {
    const { title, sub, amount, tone, icon } = describe(tx);
    const contact = contactForTx(tx);
    const hash = String(tx?.hash ?? "");
    const st = String(tx?.status ?? "submitted");
    const stLower = st.toLowerCase();
    const isPending = stLower === "submitted" || stLower === "mempool";
    const isHighlight = state?.highlightTx && String(state.highlightTx) === hash;
    const pulse = pulseClassFor(hash);

    // Profile label (use stored profileIndex when available).
    let acctLabel = "";
    try {
      const idxRaw = Number(tx?.profileIndex);
      const idx = Number.isFinite(idxRaw) && idxRaw >= 0 ? Math.floor(idxRaw) : null;
      if (idx !== null) {
        const name = String(ov?.accountNames?.[String(idx)] ?? "").trim();
        acctLabel = name || `Profile ${idx + 1}`;
      }
    } catch {
      acctLabel = "";
    }

    const fee = tx?.feePaid != null
      ? `${formatLuxShort(tx.feePaid, UI_DISPLAY_DECIMALS)} DUSK fee`
      : "";
    const subText = [sub || (hash ? truncateMiddle(hash, 10, 8) : ""), acctLabel, fee]
      .filter(Boolean)
      .join(" · ");

    const left = h("div", { class: "activity-left activity-tx-left" }, [
      h("div", { class: statusClass(st), title: st }),
      h("div", { class: `activity-ico activity-ico--${tone || "neutral"}`, text: icon }),
    ]);

    const main = h("div", { class: "activity-main" }, [
      h("div", { class: "activity-title" }, [
        h("span", { text: title }),
        contact
          ? recipientBadge({
              kind: "contact",
              label: contact.name,
              seed: contact.address,
              title: `Saved contact: ${contact.name}`,
              className: "activity-contact-badge",
            })
          : null,
        h("span", { class: `activity-status activity-status--${isPending ? "pending" : stLower}`, text: statusLabel(st) }),
      ].filter(Boolean)),
      h("div", { class: "activity-sub" }, [
        h("span", { text: subText }),
        stLower === "failed" && tx?.error
          ? h("span", { class: "activity-err", text: ` • ${String(tx.error).slice(0, 80)}` })
          : null,
      ].filter(Boolean)),
    ]);

    const amountEl = h("div", {
      class: `activity-amount activity-amount--${tone || "neutral"}`,
      text: amount || "—",
    });
    const at = tx?.timestamp ?? tx?.submittedAt;
    const timeEl = h("div", {
      class: "activity-time",
      text: at ? timeAgo(at) : "",
    });

    const cls = [
      "activity-item",
      "activity-tx-item",
      isPending ? "is-pending" : "",
      stLower === "removed" || stLower === "unknown" ? "is-pending" : "",
      stLower === "executed" ? "is-executed" : "",
      stLower === "failed" ? "is-failed" : "",
      isHighlight ? "is-highlight" : "",
      pulse,
    ]
      .filter(Boolean)
      .join(" ");

    const openDetails = async () => {
      // Open in-app details view (MetaMask-like) instead of forcing an explorer tab.
      try {
        if (state) {
          state.txDetailHash = hash;
          state.txDetailFrom = state.route === "activity" ? "activity" : "home";
          state.route = "tx";
          actions?.render?.().catch(() => {});
          return;
        }
      } catch {
        // ignore
      }

      // Fallback: open explorer (or copy hash) if we can't navigate.
      const url = explorerTxUrl(nodeUrl, hash);
      const ok = url ? await openUrl(url) : false;
      if (!ok) {
        const copied = await copyToClipboard(hash);
        actions?.showToast?.(copied ? "Copied tx hash" : "No explorer available");
      }
    };

    return h(
      "div",
      {
        class: cls,
        role: "button",
        tabindex: "0",
        onclick: openDetails,
        onkeydown: (e) => {
          if (e?.key === "Enter" || e?.key === " ") {
            e.preventDefault();
            openDetails();
          }
        },
      },
      [left, main, amountEl, timeEl]
    );
  };

  const publicHistoryButton = publicHistoryUrl
    ? h("button", {
        class: "btn-outline activity-public-history",
        text: "History ↗",
        onclick: async (e) => {
          e?.stopPropagation?.();
          const ok = await openUrl(publicHistoryUrl);
          if (!ok) actions?.showToast?.("Explorer unavailable");
        },
      })
    : null;
  const publicHistoryActions = publicHistoryButton ? [publicHistoryButton] : [];

  const viewAllButton = h("button", {
    class: "activity-view-all",
    text: "View all",
    onclick: (e) => {
      e?.stopPropagation?.();
      state.route = "activity";
      actions?.render?.().catch(() => {});
    },
  });

  const activityHeader = ({ actions: headerActions, title, note }) =>
    h("div", { class: "activity-card-head" }, [
      h("div", { class: "activity-head-copy" }, [
        bracketTitle({ class: "activity-section-label", text: title }),
        note ? h("div", { class: "activity-head-note", text: note }) : null,
      ].filter(Boolean)),
      headerActions?.length ? h("div", { class: "activity-head-actions" }, headerActions) : null,
    ].filter(Boolean));

  const activityList = (items, emptyText) =>
    items.length
      ? h("div", { class: "activity-list" }, items.map((tx) => txRow(tx)))
      : h("div", { class: "muted", text: emptyText });

  if (state?.route === "activity") {
    const onBack = () => {
      state.route = "home";
      actions?.render?.().catch(() => {});
    };

    // Older history: kept rows past this page, or the next sync of older blocks.
    const showMore = hasMoreActivity(state)
      ? h("div", { class: "activity-card-footer" }, [
          h("button", {
            class: "activity-view-all",
            text: "Show more",
            onclick: (e) => {
              e?.stopPropagation?.();
              showMoreActivity({ state, render: actions?.render }).catch(() => {});
            },
          }),
        ])
      : null;

    return [
      subnav({
        title: "Activity",
        onBack,
        backText: "← Dashboard",
        actions: publicHistoryActions,
      }),
      h("div", { class: "wallet-dashboard" }, [
        h("div", { class: "activity-card activity-card--tx" }, [
          activityList(txs, "No activity yet."),
          showMore,
        ].filter(Boolean)),
      ]),
    ];
  }

  const recentTxs = txs.slice(0, 5);
  const activityFull = h("div", { class: "activity-card activity-card--tx" }, [
    activityHeader({
      title: "Recent activity",
      actions: publicHistoryActions,
    }),
    activityList(recentTxs, "No activity yet."),
    // View all only when it shows more than the card does.
    txs.length > recentTxs.length ? h("div", { class: "activity-card-footer" }, [viewAllButton]) : null,
  ].filter(Boolean));

  // Full mode should feel like an app dashboard, while popup remains a compact
  // single-column wallet. CSS handles the responsive collapse.
  return [
    h("div", { class: "wallet-dashboard" }, [
      dashboardTopbar,
      hero,
      h("div", { class: "dashboard-actions" }, [
        bracketTitle({ class: "dashboard-section-label", text: "Actions" }),
        actionBar,
      ]),
      ...assetsSectionsView(ov, { state, actions }),
      activityFull,
    ]),
  ];
}
