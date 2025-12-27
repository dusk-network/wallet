import { formatLuxShort, safeBigInt } from "../../../shared/amount.js";
import { explorerTxUrl } from "../../../shared/explorer.js";
import { h } from "../../lib/dom.js";
import { copyToClipboard } from "../../lib/clipboard.js";
import { truncateMiddle } from "../../lib/strings.js";
import { subnav } from "../../components/Subnav.js";

function shortHash(hash) {
  const hsh = String(hash ?? "");
  if (!hsh) return "";
  if (hsh.length <= 18) return hsh;
  return `${hsh.slice(0, 10)}…${hsh.slice(-8)}`;
}

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

async function openExplorer(nodeUrl, hash) {
  const url = explorerTxUrl(nodeUrl, hash);
  if (!url) return false;
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
    return false;
  }
}

function describeTx(tx) {
  const kind = String(tx?.kind ?? "").toLowerCase();

  if (kind === "transfer") {
    const amountLux = tx?.amount;
    const to = tx?.to ? String(tx.to) : "";
    const amt = amountLux != null ? formatLuxShort(amountLux, 6) : "";
    return {
      title: amt ? `Send ${amt} DUSK` : "Send",
      sub: to ? `to ${truncateMiddle(to, 10, 8)}` : "Transfer",
      icon: "↗",
    };
  }

  if (kind === "contract_call") {
    const fnName = tx?.fnName ? String(tx.fnName) : "contract call";
    const contractId = tx?.contractId ? String(tx.contractId) : "";
    const depositLux = safeBigInt(tx?.deposit, 0n);
    const dep = depositLux > 0n ? formatLuxShort(depositLux, 6) : "";

    return {
      title: `Call ${fnName}`,
      sub: contractId
        ? `contract ${truncateMiddle(contractId, 10, 8)}${dep ? ` • deposit ${dep} DUSK` : ""}`
        : dep
        ? `deposit ${dep} DUSK`
        : "Contract call",
      icon: "⬡",
    };
  }

  return {
    title: kind ? kind : "Transaction",
    sub: "",
    icon: "•",
  };
}

function statusLabel(status) {
  const s = String(status ?? "").toLowerCase();
  if (s === "executed") return "Executed";
  if (s === "failed") return "Failed";
  return "Pending";
}

function statusClass(status) {
  const s = String(status ?? "").toLowerCase();
  if (s === "executed") return "status-dot status-dot--ok";
  if (s === "failed") return "status-dot status-dot--bad";
  return "status-dot status-dot--pending";
}

function activityItem(tx, nodeUrl, { state, actions } = {}) {
  const { hash } = tx;
  const { title, sub, icon } = describeTx(tx);
  const st = String(tx?.status ?? "submitted");

  const left = h("div", { class: "activity-left" }, [
    h("div", { class: statusClass(st), title: statusLabel(st) }),
    h("div", { class: "activity-ico", text: icon }),
  ]);

  const main = h("div", { class: "activity-main" }, [
    h("div", { class: "activity-title" }, [
      h("span", { text: title }),
      h("span", { class: "activity-time", text: timeAgo(tx?.submittedAt) }),
    ]),
    h("div", { class: "activity-sub" }, [
      h("span", { text: sub || shortHash(hash) }),
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
      const ok = await openExplorer(nodeUrl, hash);
      if (!ok) actions?.showToast?.("No explorer available for this network");
    },
  });

  const right = h("div", { class: "activity-right" }, [btnOpen, btnCopy]);

  return h(
    "button",
    {
      class: state?.highlightTx && String(state.highlightTx) === String(hash)
        ? "activity-item is-highlight"
        : "activity-item",
      onclick: async () => {
        const ok = await openExplorer(nodeUrl, hash);
        if (!ok) {
          const copied = await copyToClipboard(hash);
          actions?.showToast?.(copied ? "Copied tx hash" : "No explorer available");
        }
      },
    },
    [left, main, right]
  );
}

export function activityView(ov, { state, actions } = {}) {
  const nodeUrl = String(ov?.nodeUrl ?? "");
  const txs = Array.isArray(ov?.txs) ? ov.txs : [];

  const list = txs.length
    ? h(
        "div",
        { class: "activity-list" },
        txs.map((tx) => activityItem(tx, nodeUrl, { state, actions }))
      )
    : h("div", { class: "muted", text: "No activity yet." });

  return [
    subnav({
      title: "Activity",
      onBack: () => {
        state.route = "home";
        actions?.render?.().catch(() => {});
      },
    }),
    h("div", { class: "row" }, [list]),
  ];
}
