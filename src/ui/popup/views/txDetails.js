import { ProfileGenerator } from "@dusk/w3sper";
import { UI_DISPLAY_DECIMALS, formatLuxShort, safeBigInt } from "../../../shared/amount.js";
import { TX_KIND } from "../../../shared/constants.js";
import { explorerTxUrl } from "../../../shared/explorer.js";
import { networkNameFromNodeUrl } from "../../../shared/network.js";
import { openUrl } from "../../../platform/index.js";
import { h } from "../../lib/dom.js";
import { copyToClipboard } from "../../lib/clipboard.js";
import { shortHash, truncateMiddle } from "../../lib/strings.js";
import { subnav } from "../../components/Subnav.js";

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

  if (kind === TX_KIND.TRANSFER) {
    const to = tx?.to ? String(tx.to) : "";
    const toType = to ? ProfileGenerator.typeOf(to) : "unknown";
    const transferType =
      toType === "address" ? "Shielded transfer" : toType === "account" ? "Public transfer" : "Transfer";

    const amountLux = tx?.amount;
    const amt = amountLux != null ? formatLuxShort(amountLux, UI_DISPLAY_DECIMALS) : "";

    return {
      kindLabel: transferType,
      title: amt ? `${amt} DUSK` : "—",
      subtitle: to ? `To: ${truncateMiddle(to, 12, 10)}` : "",
    };
  }

  if (kind === TX_KIND.SHIELD) {
    const amountLux = tx?.amount;
    const amt = amountLux != null ? formatLuxShort(amountLux, UI_DISPLAY_DECIMALS) : "";
    return {
      kindLabel: "Shield",
      title: amt ? `${amt} DUSK` : "—",
      subtitle: "Public → Shielded",
    };
  }

  if (kind === TX_KIND.UNSHIELD) {
    const amountLux = tx?.amount;
    const amt = amountLux != null ? formatLuxShort(amountLux, UI_DISPLAY_DECIMALS) : "";
    return {
      kindLabel: "Unshield",
      title: amt ? `${amt} DUSK` : "—",
      subtitle: "Shielded → Public",
    };
  }

  if (kind === TX_KIND.CONTRACT_CALL) {
    const fnName = tx?.fnName ? String(tx.fnName) : "contract call";
    const contractId = tx?.contractId ? String(tx.contractId) : "";
    const depositLux = safeBigInt(tx?.deposit, 0n);
    const dep = depositLux > 0n ? formatLuxShort(depositLux, UI_DISPLAY_DECIMALS) : "";

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

  if (kind === TX_KIND.STAKE) {
    const amountLux = tx?.amount;
    const amt = amountLux != null ? formatLuxShort(amountLux, UI_DISPLAY_DECIMALS) : "";
    return {
      kindLabel: "Stake",
      title: amt ? `${amt} DUSK` : "—",
      subtitle: "Staking",
    };
  }

  if (kind === TX_KIND.UNSTAKE) {
    const amountLux = tx?.amount;
    const amt = amountLux != null ? formatLuxShort(amountLux, UI_DISPLAY_DECIMALS) : "";
    return {
      kindLabel: "Unstake",
      title: amt ? `${amt} DUSK` : "All stake",
      subtitle: "Staking",
    };
  }

  if (kind === TX_KIND.WITHDRAW_REWARD) {
    const amountLux = tx?.amount;
    const amt = amountLux != null ? formatLuxShort(amountLux, UI_DISPLAY_DECIMALS) : "";
    return {
      kindLabel: "Withdraw rewards",
      title: amt ? `${amt} DUSK` : "All rewards",
      subtitle: "Rewards",
    };
  }

  return { kindLabel: kind ? kind : "Transaction", title: shortHash(tx?.hash), subtitle: "" };
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
  const s = String(tx?.status ?? "").toLowerCase();
  const statusPillClass =
    s === "executed"
      ? "meta-pill meta-pill--ok"
      : s === "failed"
      ? "meta-pill meta-pill--bad"
      : "meta-pill meta-pill--pending";

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
        const url = explorerTxUrl(nodeUrl, hash);
        const ok = url ? await openUrl(url) : false;
        if (!ok) actions?.showToast?.("No explorer available for this network");
      },
    }),
  ]);

  const kvRow = (label, value, { mono = false, title } = {}) => {
    if (value == null) return null;
    const text = String(value);
    if (!text) return null;

    return h("div", { class: "tx-kv-row" }, [
      h("div", { class: "tx-kv-label", text: label }),
      h(
        "div",
        { class: mono ? "tx-kv-value tx-kv-value--mono" : "tx-kv-value" },
        [mono ? h("code", { text, title: title || text }) : h("span", { text, title: title || text })]
      ),
    ]);
  };

  const chips = h("div", { class: "tx-chips" }, [
    h("div", { class: statusPillClass, text: `Status: ${status}` }),
    h("div", { class: "meta-pill", text: `Type: ${kindLabel}` }),
    h("div", { class: "meta-pill", text: `Network: ${netName}` }),
  ]);

  const errorBox =
    String(tx?.status ?? "").toLowerCase() === "failed" && tx?.error
      ? h("div", { class: "err", text: String(tx.error) })
      : null;

  let accountLabel = null;
  try {
    const idxRaw = Number(tx?.profileIndex);
    const idx = Number.isFinite(idxRaw) && idxRaw >= 0 ? Math.floor(idxRaw) : null;
    if (idx !== null) {
      const name = String(ov?.accountNames?.[String(idx)] ?? "").trim();
      accountLabel = name ? `${name} (Profile ${idx + 1})` : `Profile ${idx + 1}`;
    }
  } catch {
    accountLabel = null;
  }

  const detailsRows = [
    kvRow("Tx hash", hash, { mono: true }),
    tx?.origin ? kvRow("Origin", String(tx.origin), { mono: true }) : null,
    accountLabel ? kvRow("Profile", accountLabel) : null,
    tx?.to ? kvRow("To", String(tx.to), { mono: true }) : null,
    tx?.contractId ? kvRow("Contract", String(tx.contractId), { mono: true }) : null,
    tx?.fnName ? kvRow("Method", String(tx.fnName), { mono: true }) : null,
    tx?.deposit != null ? kvRow("Deposit", `${formatLuxShort(tx.deposit, UI_DISPLAY_DECIMALS)} DUSK`) : null,
    tx?.amount != null ? kvRow("Amount", `${formatLuxShort(tx.amount, UI_DISPLAY_DECIMALS)} DUSK`) : null,
    maxFeeLux != null
      ? kvRow("Max fee", `${formatLuxShort(maxFeeLux, UI_DISPLAY_DECIMALS)} DUSK`)
      : gasLimit != null || gasPrice != null
      ? kvRow(
          "Gas",
          `limit ${gasLimit != null ? String(gasLimit) : "—"} · price ${gasPrice != null ? String(gasPrice) : "—"} LUX`,
          { mono: true }
        )
      : null,
    tx?.submittedAt ? kvRow("Submitted", fmtDate(tx.submittedAt)) : null,
  ].filter(Boolean);

  const detailsCard = detailsRows.length ? h("div", { class: "box tx-kv-card" }, detailsRows) : null;

  const kindNorm = String(tx?.kind ?? "").toLowerCase();
  const contractId = tx?.contractId ? String(tx.contractId) : "";
  const watchActions =
    kindNorm === TX_KIND.CONTRACT_CALL && contractId
      ? h("div", { class: "box" }, [
          h("div", { class: "muted", text: "Assets" }),
          h("div", { class: "muted", text: "Add this contract to your watched assets list." }),
          h("div", { class: "btnrow" }, [
            h("button", {
              class: "btn-outline",
              text: "Watch token",
              onclick: async () => {
                try {
                  state.assetAddToken = {
                    contractId,
                    loading: false,
                    error: null,
                    meta: null,
                  };
                  state.route = "asset_add_token";
                  await actions?.render?.();
                } catch {
                  // ignore
                }
              },
            }),
            h("button", {
              class: "btn-outline",
              text: "Import NFT",
              onclick: async () => {
                try {
                  state.assetAddNft = {
                    contractId,
                    tokenId: "",
                    loading: false,
                    error: null,
                    info: null,
                  };
                  state.route = "asset_add_nft";
                  await actions?.render?.();
                } catch {
                  // ignore
                }
              },
            }),
          ]),
        ])
      : null;

  return [
    subnav({ title: "Transaction", onBack, backText: "← Activity" }),
    h("div", { class: "row" }, [
      chips,
      errorBox,
      h("div", { class: "box tx-summary" }, [
        h("div", { class: "muted", text: kindLabel }),
        h("div", { class: "balance-amount", text: title }),
        subtitle ? h("div", { class: "muted", text: subtitle }) : null,
      ].filter(Boolean)),
      detailsCard,
      watchActions,
      btnRow,
    ].filter(Boolean)),
  ].filter(Boolean);
}
