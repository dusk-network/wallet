import { ProfileGenerator } from "@dusk/w3sper";
import { formatLuxShort, safeBigInt } from "../../../shared/amount.js";
import { explorerTxUrl } from "../../../shared/explorer.js";
import { networkNameFromNodeUrl } from "../../../shared/network.js";
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

function fmtDate(ts) {
  const n = Number(ts || 0);
  if (!n) return "";
  try {
    return new Date(n).toLocaleString();
  } catch {
    return String(n);
  }
}

function statusLabel(status) {
  const s = String(status ?? "").toLowerCase();
  if (s === "executed") return "Executed";
  if (s === "failed") return "Failed";
  return "Pending";
}

function describeTx(tx) {
  const kind = String(tx?.kind ?? "").toLowerCase();

  if (kind === "transfer") {
    const to = tx?.to ? String(tx.to) : "";
    const toType = to ? ProfileGenerator.typeOf(to) : "unknown";
    const transferType =
      toType === "address" ? "Shielded transfer" : toType === "account" ? "Public transfer" : "Transfer";

    const amountLux = tx?.amount;
    const amt = amountLux != null ? formatLuxShort(amountLux, 6) : "";

    return {
      kindLabel: transferType,
      title: amt ? `${amt} DUSK` : "—",
      subtitle: to ? `To: ${truncateMiddle(to, 12, 10)}` : "",
    };
  }

  if (kind === "shield") {
    const amountLux = tx?.amount;
    const amt = amountLux != null ? formatLuxShort(amountLux, 6) : "";
    return {
      kindLabel: "Shield",
      title: amt ? `${amt} DUSK` : "—",
      subtitle: "Public → Shielded",
    };
  }

  if (kind === "unshield") {
    const amountLux = tx?.amount;
    const amt = amountLux != null ? formatLuxShort(amountLux, 6) : "";
    return {
      kindLabel: "Unshield",
      title: amt ? `${amt} DUSK` : "—",
      subtitle: "Shielded → Public",
    };
  }

  if (kind === "contract_call") {
    const fnName = tx?.fnName ? String(tx.fnName) : "contract call";
    const contractId = tx?.contractId ? String(tx.contractId) : "";
    const depositLux = safeBigInt(tx?.deposit, 0n);
    const dep = depositLux > 0n ? formatLuxShort(depositLux, 6) : "";

    return {
      kindLabel: "Contract call",
      title: fnName,
      subtitle: contractId
        ? `Contract: ${truncateMiddle(contractId, 12, 10)}${dep ? ` • deposit ${dep} DUSK` : ""}`
        : dep
        ? `Deposit: ${dep} DUSK`
        : "",
    };
  }

  return { kindLabel: kind ? kind : "Transaction", title: shortHash(tx?.hash), subtitle: "" };
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

export function txDetailsView(ov, { state, actions } = {}) {
  const hash = String(state?.txDetailHash ?? "");
  const txs = Array.isArray(ov?.txs) ? ov.txs : [];
  const tx = txs.find((t) => String(t?.hash ?? "") === hash) || null;

  const backRoute = state?.txDetailFrom || "activity";
  const onBack = () => {
    state.txDetailHash = null;
    state.txDetailFrom = null;
    state.route = backRoute === "home" ? "home" : "activity";
    actions?.render?.().catch(() => {});
  };

  if (!hash) {
    return [
      subnav({ title: "Transaction", onBack }),
      h("div", { class: "row" }, [h("div", { class: "muted", text: "No transaction selected." })]),
    ];
  }

  if (!tx) {
    return [
      subnav({ title: "Transaction", onBack }),
      h("div", { class: "row" }, [
        h("div", { class: "muted", text: "Transaction not found in local activity." }),
        h("div", { class: "box" }, [h("code", { text: hash })]),
      ]),
    ];
  }

  const nodeUrl = String(tx?.nodeUrl ?? ov?.nodeUrl ?? "");
  const netName = nodeUrl ? networkNameFromNodeUrl(nodeUrl) : (ov?.networkName ?? "Unknown");
  const { kindLabel, title, subtitle } = describeTx(tx);

  const status = statusLabel(tx?.status);
  const statusPillClass =
    String(tx?.status ?? "").toLowerCase() === "executed"
      ? "meta-pill"
      : String(tx?.status ?? "").toLowerCase() === "failed"
      ? "meta-pill"
      : "meta-pill";

  const gasLimit = tx?.gasLimit != null ? safeBigInt(tx.gasLimit, 0n) : null;
  const gasPrice = tx?.gasPrice != null ? safeBigInt(tx.gasPrice, 0n) : null;
  const maxFeeLux =
    typeof gasLimit === "bigint" && typeof gasPrice === "bigint" && gasLimit > 0n && gasPrice > 0n
      ? gasLimit * gasPrice
      : null;

  const btnRow = h("div", { class: "btnrow" }, [
    h("button", {
      class: "btn-outline",
      text: "Copy hash",
      onclick: async () => {
        const ok = await copyToClipboard(hash);
        actions?.showToast?.(ok ? "Copied tx hash" : "Copy failed");
      },
    }),
    h("button", {
      class: "btn-primary",
      text: "View in Explorer",
      onclick: async () => {
        const ok = await openExplorer(nodeUrl, hash);
        if (!ok) actions?.showToast?.("No explorer available for this network");
      },
    }),
  ]);

  const kv = (label, valueNode) =>
    h("div", { class: "row" }, [
      h("div", { class: "muted", text: label }),
      valueNode,
    ]);

  const chips = h(
    "div",
    { style: "display:flex; gap:8px; flex-wrap:wrap; margin-bottom: 10px;" },
    [
      h("div", { class: "meta-pill", text: `Status: ${status}` }),
      h("div", { class: "meta-pill", text: `Type: ${kindLabel}` }),
      h("div", { class: "meta-pill", text: `Network: ${netName}` }),
    ]
  );

  const errorBox =
    String(tx?.status ?? "").toLowerCase() === "failed" && tx?.error
      ? h("div", { class: "err", text: String(tx.error) })
      : null;

  return [
    subnav({ title: "Transaction", onBack, backText: "← Activity" }),
    h("div", { class: "row" }, [
      chips,
      errorBox,
      h("div", { class: "box" }, [
        h("div", { class: "muted", text: kindLabel }),
        h("div", { class: "balance-amount", text: title }),
        subtitle ? h("div", { class: "muted", text: subtitle }) : null,
      ].filter(Boolean)),
      kv("Tx hash", h("div", { class: "box" }, [h("code", { text: hash })])),
      tx?.origin ? kv("Origin", h("div", { class: "box" }, [h("code", { text: String(tx.origin) })])) : null,
      tx?.to ? kv("To", h("div", { class: "box" }, [h("code", { text: String(tx.to) })])) : null,
      tx?.contractId
        ? kv("Contract", h("div", { class: "box" }, [h("code", { text: String(tx.contractId) })]))
        : null,
      tx?.fnName ? kv("Method", h("div", { class: "box" }, [h("code", { text: String(tx.fnName) })])) : null,
      tx?.deposit != null
        ? kv(
            "Deposit",
            h("div", { class: "box" }, [
              h("code", {
                text: `${formatLuxShort(tx.deposit, 6)} DUSK`,
              }),
            ])
          )
        : null,
      tx?.amount != null
        ? kv(
            "Amount",
            h("div", { class: "box" }, [
              h("code", {
                text: `${formatLuxShort(tx.amount, 6)} DUSK`,
              }),
            ])
          )
        : null,
      maxFeeLux != null
        ? kv(
            "Max fee",
            h("div", { class: "box" }, [
              h("code", { text: `${formatLuxShort(maxFeeLux, 6)} DUSK` }),
            ])
          )
        : gasLimit != null || gasPrice != null
        ? kv(
            "Gas",
            h("div", { class: "box" }, [
              h("code", {
                text: `limit ${gasLimit != null ? String(gasLimit) : "—"} · price ${
                  gasPrice != null ? String(gasPrice) : "—"
                } (LUX)`,
              }),
            ])
          )
        : null,
      tx?.submittedAt ? kv("Submitted", h("div", { class: "box" }, [h("code", { text: fmtDate(tx.submittedAt) })])) : null,
      btnRow,
    ].filter(Boolean)),
  ].filter(Boolean);
}
