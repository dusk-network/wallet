import { clampDecimals, formatLuxToDusk, formatLuxShort, safeBigInt } from "../../../shared/amount.js";
import { explorerTxUrl } from "../../../shared/explorer.js";
import { h } from "../../lib/dom.js";
import { copyToClipboard } from "../../lib/clipboard.js";
import { truncateMiddle } from "../../lib/strings.js";
import { bannerView } from "../../components/Banner.js";
import { platform } from "../../../platform/index.js";

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

export function homeView(ov, { state, actions } = {}) {
  const hasBalance = Boolean(ov?.balance?.value);
  const balFull = hasBalance ? formatLuxToDusk(ov.balance.value) : "—";
  const balDusk = hasBalance ? clampDecimals(balFull, 4) : "—";

  // Optional shielded balance (not available in this MVP).
  const shieldLux = ov?.shieldedBalance?.value ?? ov?.shieldedBalance;
  const hasShielded = shieldLux !== undefined && shieldLux !== null;
  const shieldFull = hasShielded ? formatLuxToDusk(shieldLux) : "—";
  const shieldDusk = hasShielded ? clampDecimals(shieldFull, 4) : "—";

  // MetaMask-like main tabs. We keep the route as the source of truth so
  // deep-links like `?route=activity&tx=...` continue to work.
  const activeTab = state?.route === "activity" ? "activity" : "assets";
  const switchTab = (tab) => {
    if (!state) return;
    state.highlightTx = null;
    state.route = tab === "activity" ? "activity" : "home";
    actions?.render?.().catch(() => {});
  };

  // Connected site label (compact).
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

  const balanceSubRow = h(
    "div",
    { class: "balance-subrow" },
    [
      h("div", { class: "balance-sub", text: "DUSK (public)" }),
      connInline,
    ].filter(Boolean)
  );

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
    actionBtn("Send", "↗", () => {
      state.route = "send";
      state.banner = null;
      state.draft = null;
      actions?.render?.().catch(() => {});
    }),
    actionBtn("Receive", "⤓", () => {
      state.route = "receive";
      state.banner = null;
      actions?.render?.().catch(() => {});
    }),
  ]);

  const hero = h("div", { class: "home-balance home-hero" }, [
    h("div", { class: "balance-amount", text: balDusk, title: balFull }),
    balanceSubRow,
    ov?.balanceError
      ? h("div", { class: "muted", text: `Balance error: ${ov.balanceError}` })
      : null,
    actionBar,
  ].filter(Boolean));

  // Activity list
  const txs = Array.isArray(ov?.txs) ? ov.txs : [];
  const nodeUrl = String(ov?.nodeUrl ?? "");

  const pendingCount = txs.reduce((n, tx) => {
    const s = String(tx?.status ?? "submitted").toLowerCase();
    if (s === "executed" || s === "failed") return n;
    return n + 1;
  }, 0);

  const openExplorer = async (hash) => {
    const url = explorerTxUrl(nodeUrl, hash);
    if (url) {
      try {
        if (chrome?.tabs?.create) {
          await chrome.tabs.create({ url });
          return true;
        }
      } catch {
        // ignore
      }
      try {
        window.open(url, "_blank", "noopener,noreferrer");
        return true;
      } catch {
        // ignore
      }
    }
    return false;
  };

  const statusClass = (status) => {
    const s = String(status ?? "").toLowerCase();
    if (s === "executed") return "status-dot status-dot--ok";
    if (s === "failed") return "status-dot status-dot--bad";
    return "status-dot status-dot--pending";
  };

  const describe = (tx) => {
    const kind = String(tx?.kind ?? "").toLowerCase();
    if (kind === "transfer") {
      const amt = tx?.amount != null ? formatLuxShort(tx.amount, 6) : "";
      return {
        title: amt ? `Send ${amt} DUSK` : "Send",
        sub: tx?.to ? truncateMiddle(String(tx.to), 10, 8) : "",
        icon: "↗",
      };
    }
    if (kind === "contract_call") {
      const fn = tx?.fnName ? String(tx.fnName) : "contract call";
      const dep = safeBigInt(tx?.deposit, 0n);
      const depS = dep > 0n ? formatLuxShort(dep, 6) : "";
      return {
        title: `Call ${fn}`,
        sub: depS ? `deposit ${depS} DUSK` : "",
        icon: "⬡",
      };
    }
    return { title: "Transaction", sub: "", icon: "•" };
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
    const { title, sub, icon } = describe(tx);
    const hash = String(tx?.hash ?? "");
    const st = String(tx?.status ?? "submitted");
    const isHighlight = state?.highlightTx && String(state.highlightTx) === hash;
    const pulse = pulseClassFor(hash);

    const left = h("div", { class: "activity-left" }, [
      h("div", { class: statusClass(st), title: st }),
      h("div", { class: "activity-ico", text: icon }),
    ]);

    const main = h("div", { class: "activity-main" }, [
      h("div", { class: "activity-title" }, [
        h("span", { text: title }),
        tx?.submittedAt ? h("span", { class: "activity-time", text: timeAgo(tx.submittedAt) }) : null,
      ].filter(Boolean)),
      h("div", { class: "activity-sub" }, [
        h("span", { text: sub || (hash ? truncateMiddle(hash, 10, 8) : "") }),
        st === "failed" && tx?.error
          ? h("span", { class: "activity-err", text: ` • ${String(tx.error).slice(0, 80)}` })
          : null,
      ].filter(Boolean)),
    ]);

    const btnCopy = h("button", {
      class: "icon-btn icon-only",
      text: "⧉",
      title: "Copy tx hash",
      onclick: async (e) => {
        e?.stopPropagation?.();
        const ok = await copyToClipboard(hash);
        actions?.showToast?.(ok ? "Copied tx hash" : "Copy failed");
      },
    });

    const btnOpen = h("button", {
      class: "icon-btn icon-only",
      text: "↗",
      title: "View in Explorer",
      onclick: async (e) => {
        e?.stopPropagation?.();
        const ok = await openExplorer(hash);
        if (!ok) actions?.showToast?.("No explorer available for this network");
      },
    });

    const right = h("div", { class: "activity-right" }, [btnOpen, btnCopy]);

    const cls = ["activity-item", isHighlight ? "is-highlight" : "", pulse].filter(Boolean).join(" ");

    return h(
      "button",
      {
        class: cls,
        onclick: async () => {
          const ok = await openExplorer(hash);
          if (!ok) {
            const copied = await copyToClipboard(hash);
            actions?.showToast?.(copied ? "Copied tx hash" : "No explorer available");
          }
        },
      },
      [left, main, right]
    );
  };

  const activityFull = h("div", { class: "activity-card" }, [
    txs.length
      ? h("div", { class: "activity-list" }, txs.map((tx) => txRow(tx)))
      : h("div", { class: "muted", text: "No activity yet." }),
  ]);

  const tabs = h("div", { class: "tabs" }, [
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
  ]);

  const assetsCard = h("div", { class: "box assets-card" }, [
    h("div", { class: "asset-row" }, [
      h("div", { class: "asset-ico", text: "D" }),
      h("div", { class: "asset-main" }, [
        h("div", { class: "asset-sym", text: "DUSK" }),
        h("div", { class: "asset-name", text: "Dusk" }),
      ]),
      h("div", { class: "asset-bal" }, [
        h("div", { class: "asset-amt", text: balDusk, title: balFull }),
        h("div", { class: "asset-sub", text: "Public" }),
      ]),
    ]),
    hasShielded
      ? h("div", { class: "asset-row" }, [
          h("div", { class: "asset-ico", text: "◈" }),
          h("div", { class: "asset-main" }, [
            h("div", { class: "asset-sym", text: "DUSK" }),
            h("div", { class: "asset-name", text: "Shielded" }),
          ]),
          h("div", { class: "asset-bal" }, [
            h("div", { class: "asset-amt", text: shieldDusk, title: shieldFull }),
            h("div", { class: "asset-sub", text: "Shielded" }),
          ]),
        ])
      : null,
  ]);

  return [
    bannerView(state.banner),
    hero,
    tabs,
    ...(activeTab === "activity" ? [activityFull] : [assetsCard]),
  ].filter(Boolean);
}
