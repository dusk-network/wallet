import {
  UI_DISPLAY_DECIMALS,
  formatLuxToDusk,
  formatLuxShort,
  safeBigInt,
} from "../../../shared/amount.js";
import { TX_KIND } from "../../../shared/constants.js";
import { explorerTxUrl } from "../../../shared/explorer.js";
import { h } from "../../lib/dom.js";
import { copyToClipboard } from "../../lib/clipboard.js";
import { truncateMiddle } from "../../lib/strings.js";
import { openUrl, platform } from "../../../platform/index.js";
import { assetsSectionsView } from "./assets.js";
import { txActivityStatusLabel, txKindRailLabel } from "./txDisplay.js";

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
    shieldStatusTitle = `Reserved ${formatLuxShort(reservedLux, UI_DISPLAY_DECIMALS)} DUSK`;
  }

  // MetaMask-like main tabs. We keep the route as the source of truth so
  // deep-links like `?route=activity&tx=...` continue to work.
  const activeTab = state?.route === "activity" ? "activity" : "assets";
  const switchTab = (tab) => {
    if (!state) return;
    state.highlightTx = null;
    state.route = tab === "activity" ? "activity" : "home";
    actions?.render?.().catch(() => {});
  };

  // Connected site label (compact). We intentionally don't spend a full card
  // on this; the account chip already signals the account, and connection is
  // shown as a small inline label.
  let connHost = null;
  let connConnected = false;
  if (platform.capabilities.dapp) {
    const origin = ov?.activeOrigin;
    connConnected = Boolean(origin && ov?.activeConnected);
    if (typeof origin === "string" && (origin.startsWith("https://") || origin.startsWith("http://"))) {
      try {
        connHost = new URL(origin).hostname;
      } catch {
        connHost = origin;
      }
    }
  }

  const connInline = connHost
    ? h("div", { class: "balance-site", title: ov?.activeOrigin ?? "" }, [
        h("div", {
          class: [
            "conn-dot",
            connConnected ? "conn-dot--on" : "",
            "conn-dot--sm",
          ].filter(Boolean).join(" "),
        }),
        h("div", {
          class: "balance-site-text",
          text: `${connConnected ? "Connected" : "Site"}: ${connHost}`,
        }),
      ])
    : null;

  // Home hero shows the total once shielded is available.
  const heroAmt = hasTotal ? totalDusk : balDusk;
  const heroAmtTitle = hasTotal ? totalFull : balFull;
  const heroLabel = hasTotal ? "Total balance" : "Public balance";

  const balanceLabel = h("div", { class: "balance-sub balance-label" }, [h("span", { text: heroLabel })]);

  const balanceSubRow = h("div", { class: "balance-subrow" }, [balanceLabel, connInline].filter(Boolean));
  const balanceSplit = h("div", { class: "balance-split" }, [
    h("div", { class: "balance-split-item" }, [
      h("span", { class: "balance-split-label", text: "Public" }),
      h("span", { class: "balance-split-value", text: balDusk, title: balFull }),
    ]),
    showShielded
      ? h("div", { class: "balance-split-item" }, [
          h("span", {
            class: "balance-split-label",
            text: shieldStatus ? `Shielded · ${shieldStatus}` : "Shielded",
            title: shieldStatusTitle,
          }),
          h("span", { class: "balance-split-value", text: shieldDusk, title: shieldFull }),
        ])
      : null,
  ].filter(Boolean));

  const actionBtn = (label, ico, onClick) =>
    h(
      "button",
      {
        class: "action-btn",
        onclick: onClick,
      },
      [
        h("div", { class: "action-btn-ico", text: ico }),
        h("div", { class: "action-btn-label", text: label }),
      ]
    );

  const actionBar = h("div", { class: "action-bar" }, [
    actionBtn("Send", "↑", () => {
      state.route = "send";
      state.draft = null;
      actions?.render?.().catch(() => {});
    }),
    actionBtn("Receive", "↓", () => {
      state.route = "receive";
      actions?.render?.().catch(() => {});
    }),
    actionBtn("Shield", "✦", () => {
      state.route = "convert";
      state.draft = { kind: TX_KIND.SHIELD, amountDusk: "", amountLux: "" };
      actions?.render?.().catch(() => {});
    }),
    actionBtn("Stake", "△", () => {
      state.route = "stake";
      actions?.render?.().catch(() => {});
    }),
  ]);

  const dashboardTopbar = h("div", { class: "dashboard-topbar" }, [
    h("div", { class: "dashboard-title", text: activeTab === "activity" ? "History" : "Dashboard" }),
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

  // Balance hero is a single surface block. Action buttons are intentionally
  // rendered *outside* this container (more MetaMask-like, less "card-in-card").
  const hero = h("div", { class: "home-balance home-hero" }, [
    balanceSubRow,
    h("div", { class: "balance-amount", text: heroAmt, title: heroAmtTitle }),
    balanceSplit,
    ov?.balanceError
      ? h("div", { class: "muted", text: `Balance error: ${ov.balanceError}` })
      : null,
  ].filter(Boolean));

  // Activity list
  const txs = Array.isArray(ov?.txs) ? ov.txs : [];
  const nodeUrl = String(ov?.nodeUrl ?? "");

  // Pending count (for a small Activity tab badge).
  const pendingCount = txs.reduce((n, tx) => {
    const s = String(tx?.status ?? "submitted").toLowerCase();
    return s === "submitted" || s === "mempool" ? n + 1 : n;
  }, 0);

  const statusClass = (status) => {
    const s = String(status ?? "").toLowerCase();
    if (s === "executed") return "status-dot status-dot--ok";
    if (s === "failed") return "status-dot status-dot--bad";
    if (s === "removed" || s === "unknown") return "status-dot status-dot--bad";
    return "status-dot status-dot--pending";
  };

  const statusLabel = (status) => {
    return txActivityStatusLabel(status);
  };

  const describe = (tx) => {
    const kind = String(tx?.kind ?? "").toLowerCase();
    if (kind === TX_KIND.TRANSFER) {
      const amt = tx?.amount != null ? formatLuxShort(tx.amount, UI_DISPLAY_DECIMALS) : "";
      const to = tx?.to ? truncateMiddle(String(tx.to), 10, 8) : "";
      return {
        title: to ? `Sent to ${to}` : "Sent DUSK",
        sub: txKindRailLabel(tx),
        amount: amt ? `-${amt} DUSK` : "",
        tone: "out",
        icon: "↑",
      };
    }
    if (kind === TX_KIND.SHIELD) {
      const amt = tx?.amount != null ? formatLuxShort(tx.amount, UI_DISPLAY_DECIMALS) : "";
      return {
        title: "Shielded transfer",
        sub: "Phoenix · PLONK proof verified",
        amount: amt ? `${amt} DUSK` : "—",
        tone: "shield",
        icon: "✦",
      };
    }
    if (kind === TX_KIND.UNSHIELD) {
      const amt = tx?.amount != null ? formatLuxShort(tx.amount, UI_DISPLAY_DECIMALS) : "";
      return {
        title: "Unshielded transfer",
        sub: "Phoenix → Moonlight",
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
        title: "Stake delegated",
        sub: "Hyperstaking · ~10s finality",
        amount: amt ? `-${amt} DUSK` : "",
        tone: "out",
        icon: "△",
      };
    }
    if (kind === TX_KIND.UNSTAKE) {
      const amt = tx?.amount != null ? formatLuxShort(tx.amount, UI_DISPLAY_DECIMALS) : "";
      return {
        title: "Stake withdrawn",
        sub: tx?.amount != null ? "Hyperstaking" : "All stake",
        amount: amt ? `${amt} DUSK` : "—",
        tone: "in",
        icon: "△",
      };
    }
    if (kind === TX_KIND.WITHDRAW_REWARD) {
      const amt = tx?.amount != null ? formatLuxShort(tx.amount, UI_DISPLAY_DECIMALS) : "";
      return {
        title: "Rewards withdrawn",
        sub: tx?.amount != null ? "Epoch rewards" : "All rewards",
        amount: amt ? `+${amt} DUSK` : "—",
        tone: "in",
        icon: "↓",
      };
    }
    return { title: "Transaction", sub: "", amount: "—", tone: "neutral", icon: "•" };
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

    const subText = [sub || (hash ? truncateMiddle(hash, 10, 8) : ""), acctLabel]
      .filter(Boolean)
      .join(" · ");

    const left = h("div", { class: "activity-left activity-tx-left" }, [
      h("div", { class: statusClass(st), title: st }),
      h("div", { class: `activity-ico activity-ico--${tone || "neutral"}`, text: icon }),
    ]);

    const main = h("div", { class: "activity-main" }, [
      h("div", { class: "activity-title" }, [
        h("span", { text: title }),
        h("span", { class: `activity-status activity-status--${isPending ? "pending" : stLower}`, text: statusLabel(st) }),
      ]),
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
    const timeEl = h("div", {
      class: "activity-time",
      text: tx?.submittedAt ? timeAgo(tx.submittedAt) : "",
    });

    const cls = [
      "activity-item",
      "activity-tx-item",
      isPending ? "is-pending" : "",
      stLower === "executed" ? "is-executed" : "",
      stLower === "failed" ? "is-failed" : "",
      stLower === "removed" || stLower === "unknown" ? "is-failed" : "",
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
          state.txDetailFrom = state.route || "activity";
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

  const viewAll = h("button", {
    class: "activity-view-all",
    text: "View all →",
    onclick: (e) => {
      e?.stopPropagation?.();
      switchTab("activity");
    },
  });

  const activityFull = h("div", { class: "activity-card activity-card--tx" }, [
    h("div", { class: "activity-card-head" }, [
      h("div", { class: "activity-section-label", text: "Recent transactions" }),
      viewAll,
    ]),
    txs.length
      ? h("div", { class: "activity-list" }, txs.map((tx) => txRow(tx)))
      : h("div", { class: "muted", text: "No activity yet." }),
  ]);

  const tabs = h(
    "div",
    {
      class: "tabs",
      style: `--seg-index: ${activeTab === "assets" ? 0 : 1};`,
    },
    [
    h(
      "button",
      {
        class: activeTab === "assets" ? "tab is-active" : "tab",
        onclick: () => switchTab("assets"),
      },
      [h("span", { text: "Assets" })]
    ),
    h(
      "button",
      {
        class: activeTab === "activity" ? "tab is-active" : "tab",
        onclick: () => switchTab("activity"),
      },
      [
        h("span", { text: "Activity" }),
        pendingCount > 0
          ? h("span", {
              class: "tab-badge",
              text: pendingCount > 9 ? "9+" : String(pendingCount),
              title: `${pendingCount} pending`,
            })
          : null,
      ].filter(Boolean)
    ),
    ]
  );

  const tabContent = activeTab === "activity"
    ? [activityFull]
    : assetsSectionsView(ov, { state, actions });

  // Full mode should feel like an app dashboard, while popup remains a compact
  // single-column wallet. CSS handles the responsive collapse.
  return [
    h("div", { class: "wallet-dashboard" }, [
      dashboardTopbar,
      hero,
      h("div", { class: "dashboard-actions" }, [
        h("div", { class: "dashboard-section-label", text: "Actions" }),
        actionBar,
      ]),
      tabs,
      ...tabContent,
    ]),
  ];
}
