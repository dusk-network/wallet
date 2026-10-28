import { STAKE_CONTRACT, TRANSFER_CONTRACT } from "../../../shared/activityHistory.js";
import { formatFee, groupThousands, safeBigInt } from "../../../shared/amount.js";
import { TX_KIND } from "../../../shared/constants.js";
import { lookupPrimaryName } from "../../../shared/duskNames.js";
import { explorerTxUrl } from "../../../shared/explorer.js";
import { networkNameFromNodeUrl } from "../../../shared/network.js";
import { openUrl } from "../../../platform/index.js";
import { h } from "../../lib/dom.js";
import { copyToClipboard } from "../../lib/clipboard.js";
import { truncateMiddle } from "../../lib/strings.js";
import { subnav } from "../../components/Subnav.js";
import { iconSvg } from "../../components/ActionIcon.js";
import { balancesHidden } from "../../components/Balance.js";
import { txErrorText, txRecoveryReasonLabel, txStatusWord } from "./txDisplay.js";
import { amountEl, contactNames, copyButton, dateText, describeTx, txIconSvg, txTime } from "./txRow.js";
import { reasonText } from "./sent.js";
import { activityRows, loadActivityDetail } from "../activity.js";

// A transaction's details: a centred summary (who, how much, its status),
// then its date, memo, fee, the profile it left or reached, and its ID, which
// opens Dusk's explorer. Block, gas and finality sit under Technical details.
// Hide balances hides the amount; the fee stays.

const STATUS_ICON = { ok: "check", bad: "alert", pending: "clock" };

// What the status word doesn't say: whether to wait, what may still hold, and
// for one that didn't go through, that its amount never left.
function statusNote(tx, desc, hidden) {
  const shielded = String(tx?.privacy ?? "").toLowerCase() === "shielded";
  const a = desc.amount;
  const stayed = !desc.unsent || !a || a.text ? "" : hidden ? " The amount stayed in your wallet." : ` The ${a.value} ${a.unit} stayed in your wallet.`;
  switch (desc.status) {
    case "submitted":
      return "Waiting for a block, usually about 10 seconds.";
    case "mempool":
      return "Still waiting to go through. Don't retry yet.";
    case "unknown":
      // Final on chain, its outcome not looked up yet; or the wallet's own
      // send it stopped waiting for.
      return tx?.source === "archive" || tx?.source === "both"
        ? "It is final on chain. Its outcome is still being looked up."
        : "The wallet stopped waiting for a result. That doesn't mean it failed.";
    case "removed":
      return `The network dropped it before it ran, so no fee was charged.${stayed}${shielded ? " Shielded funds may still be reserved locally." : ""}`;
    case "failed":
      return `${txErrorText(tx?.error) || reasonText(tx?.error) || "It ran but didn't go through."}${stayed}`;
    default:
      return "";
  }
}

const kv = (label, value, { className = "" } = {}) =>
  h("div", { class: ["kv", className].filter(Boolean).join(" ") }, [
    h("span", { class: "kv-label", text: label }),
    h("span", { class: "kv-value" }, [].concat(value)),
  ]);

const mono = (value, shown = value) => h("span", { class: "mono", title: value, text: shown });

// The profile a transaction left or reached: its name, or its verified .dusk
// name once looked up, and the balance: "alice.dusk · Public".
function profileValue(ov, tx, rail) {
  const raw = Number(tx?.profileIndex ?? ov?.selectedAccountIndex ?? 0);
  const idx = Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
  const own = String(ov?.accountNames?.[String(idx)] ?? "").trim();
  const nameEl = h("span", { text: own || `Profile ${idx + 1}` });
  const account = String(ov?.accounts?.[idx] ?? "");
  if (!own && account) {
    lookupPrimaryName(account, { nodeUrl: ov?.nodeUrl, stale: true })
      ?.then?.((name) => {
        if (name) nameEl.textContent = name;
      })
      ?.catch?.(() => {});
  }
  return h("span", {}, [nameEl, h("span", { class: "kv-muted", text: ` · ${rail}` })]);
}

function feeRow(tx, desc) {
  if (desc.status === "removed") return kv("Network fee", "None charged");
  if (tx?.feePaid != null && tx.feePaid !== "") return kv(desc.failed ? "Fee charged" : "Network fee", `${formatFee(tx.feePaid)} DUSK`);
  const limit = safeBigInt(tx?.gasLimit, 0n);
  const price = safeBigInt(tx?.gasPrice, 0n);
  if (desc.tone === "pending" && tx?.source !== "archive" && limit > 0n && price > 0n) {
    return kv("Network fee", `Up to ${formatFee(limit * price)} DUSK`);
  }
  return null;
}

function technicalRows(tx, ov, nodeUrl) {
  const kind = String(tx?.kind ?? "").toLowerCase();
  const num = (v) => (v != null && /^\d+$/.test(String(v)) ? groupThousands(String(v)) : null);
  const at = (label, ms) => (Number(ms) > 0 ? kv(label, dateText(Number(ms))) : null);
  const used = num(tx?.gasSpent);
  const limit = num(tx?.gasLimit);
  const finalKnown = ["archive", "both", "shielded"].includes(String(tx?.source ?? ""));
  return [
    kv("Network", nodeUrl ? networkNameFromNodeUrl(nodeUrl) : String(ov?.networkName ?? "Unknown")),
    num(tx?.blockHeight) ? kv("Block", num(tx.blockHeight)) : null,
    used || limit ? kv("Gas used", used && limit ? `${used} of ${limit}` : used ? used : `Limit ${limit}`) : null,
    num(tx?.gasPrice) ? kv("Gas price", `${num(tx.gasPrice)} LUX`) : null,
    finalKnown && ["executed", "failed"].includes(String(tx?.status ?? "")) ? kv("Finality", "Final") : null,
    kind === TX_KIND.CONTRACT_CALL && tx?.contractId ? kv("Contract", mono(String(tx.contractId), truncateMiddle(String(tx.contractId), 8, 8))) : null,
    tx?.fnName ? kv("Method", mono(String(tx.fnName))) : null,
    tx?.blockHash ? kv("Block hash", mono(String(tx.blockHash), truncateMiddle(String(tx.blockHash), 8, 8))) : null,
    at("Submitted", tx?.submittedAt),
    at("Seen in mempool", tx?.mempoolSeenAt),
    at("Last checked", tx?.lastCheckedAt),
    at("Dropped", tx?.removedAt),
    tx?.reservationStatus ? kv("Shielded reservation", String(tx.reservationStatus)) : null,
    tx?.recoveryReason ? kv("Why", txRecoveryReasonLabel(tx.recoveryReason), { className: "kv--wrap" }) : null,
    // The chain's own words for a failure; the summary says it plainly.
    String(tx?.status ?? "") === "failed" && tx?.error ? kv("Error", String(tx.error), { className: "kv--wrap" }) : null,
  ].filter(Boolean);
}

function explorerButton(url, actions, text = "View in Dusk explorer") {
  if (!url) return null;
  return h(
    "button",
    {
      class: "btn-outline tx-explorer-btn",
      type: "button",
      onclick: async () => {
        const ok = await openUrl(url);
        if (!ok) actions?.showToast?.("Couldn't open the explorer");
      },
    },
    [h("span", { text }), h("span", { class: "btn-ico", "aria-hidden": "true", html: iconSvg("ext") })]
  );
}

export function txDetailsView(ov, { state, actions } = {}) {
  const hash = String(state?.txDetailHash ?? "");
  const txs = activityRows(ov, state);
  const tx = txs.find((t) => String(t?.hash ?? "") === hash.toLowerCase()) || null;
  // A synced entry not looked up yet gets its time, outcome and fee now.
  if ((tx?.source === "archive" || tx?.source === "both") && !tx.detailsAt) {
    loadActivityDetail({ state, render: actions?.render }, tx.hash);
  }

  const backRoute = state?.txDetailFrom || "home";
  const onBack = () => {
    state.txDetailHash = null;
    state.txDetailFrom = null;
    state.route = backRoute;
    actions?.render?.()?.catch?.(() => {});
  };
  const nav = subnav({ title: "Transaction", onBack });

  if (!hash) {
    return [nav, h("p", { class: "tx-missing", text: "No transaction selected." })];
  }

  const nodeUrl = String(tx?.nodeUrl ?? ov?.nodeUrl ?? "");
  const explorerUrl = explorerTxUrl(nodeUrl, hash);

  if (!tx) {
    return [
      nav,
      h("div", { class: "tx-detail" }, [
        h("p", { class: "tx-missing", text: "This transaction isn't in your activity." }),
        h("div", { class: "group" }, [kv("Transaction ID", mono(hash, truncateMiddle(hash, 8, 8)))]),
        explorerButton(explorerUrl, actions),
      ].filter(Boolean)),
    ];
  }

  const hidden = balancesHidden(ov);
  const desc = describeTx(tx, { contactName: contactNames(state, actions), nodeUrl });
  const kind = String(tx?.kind ?? "").toLowerCase();
  const showToast = actions?.showToast;

  // Who: the other side's name with its short address and Copy; an address
  // without a name shows in full mono, Copy beside it; a contract call shows
  // the contract.
  const other =
    desc.address && !desc.isAddress
      ? desc.address
      : kind === TX_KIND.CONTRACT_CALL && !desc.address && tx?.contractId
      ? String(tx.contractId)
      : "";
  const otherLabel = kind === TX_KIND.CONTRACT_CALL && other === String(tx?.contractId ?? "") ? "Copy contract ID" : "Copy address";
  const hero = h("div", { class: "tx-hero" }, [
    h("span", { class: "row-icon tx-hero-icon", "aria-hidden": "true", html: txIconSvg(desc.icon) }),
    desc.lead ? h("div", { class: "tx-hero-lead", text: desc.lead }) : null,
    h("div", { class: "tx-hero-name-line" }, [
      h("h2", { class: desc.isAddress ? "tx-hero-name mono" : "tx-hero-name", title: desc.isAddress ? desc.address : undefined, text: desc.name }),
      desc.isAddress ? copyButton(desc.address, { showToast }) : null,
    ].filter(Boolean)),
    other
      ? h("div", { class: "tx-hero-addr" }, [mono(other, truncateMiddle(other, 6, 6)), copyButton(other, { label: otherLabel, showToast })])
      : null,
    amountEl(desc.amount, hidden, "tx-hero-amount"),
    h("div", { class: `tx-hero-status is-${desc.tone}` }, [
      h("span", { class: "btn-ico", "aria-hidden": "true", html: iconSvg(STATUS_ICON[desc.tone] ?? "clock") }),
      // The row's word, or Completed, which rows leave out.
      h("span", { text: desc.statusWord || txStatusWord(desc.status) }),
    ]),
    (() => {
      const note = statusNote(tx, desc, hidden);
      return note ? h("p", { class: "tx-hero-note", text: note }) : null;
    })(),
  ].filter(Boolean));

  // The profile's side: what it sent from, or received on.
  const shielded = String(tx?.privacy ?? "").toLowerCase() === "shielded";
  const rail = shielded ? "Shielded" : "Public";
  const ownRows =
    kind === TX_KIND.SHIELD
      ? [kv("From", profileValue(ov, tx, "Public")), kv("To", profileValue(ov, tx, "Shielded"))]
      : kind === TX_KIND.UNSHIELD
      ? [kv("From", profileValue(ov, tx, "Shielded")), kv("To", profileValue(ov, tx, "Public"))]
      : [kv(tx?.direction === "in" ? "To" : "From", profileValue(ov, tx, rail))];

  let site = "";
  try {
    site = tx?.origin ? new URL(String(tx.origin)).host || String(tx.origin) : "";
  } catch {
    site = String(tx?.origin ?? "");
  }

  const when = txTime(tx);
  const idButton = h("button", {
    class: "text-btn tx-id",
    type: "button",
    title: explorerUrl ? "Open in Dusk explorer" : hash,
    "aria-label": explorerUrl ? `Transaction ${truncateMiddle(hash, 8, 8)}, open in Dusk explorer` : undefined,
    disabled: !explorerUrl,
    text: truncateMiddle(hash, 8, 8),
    onclick: async () => {
      const ok = explorerUrl ? await openUrl(explorerUrl) : false;
      if (!ok) showToast?.("Couldn't open the explorer");
    },
  });
  const copyId = h("button", {
    class: "mini-btn",
    type: "button",
    text: "Copy",
    "aria-label": "Copy transaction ID",
    onclick: async () => {
      const ok = await copyToClipboard(hash);
      showToast?.(ok ? "Transaction ID copied" : "Couldn't copy the transaction ID");
    },
  });

  const rows = h("div", { class: "group" }, [
    when ? kv("Date", dateText(when)) : null,
    tx?.memo ? kv("Memo", String(tx.memo), { className: "kv--wrap" }) : null,
    feeRow(tx, desc),
    ...ownRows,
    site ? kv("Site", site) : null,
    kv("Transaction ID", [idButton, copyId]),
  ].filter(Boolean));

  // Technical details stay open across redraws (a sync can redraw this view).
  const tech = h("details", { class: "advanced tx-tech", open: Boolean(state?.txTechOpen) }, [
    h("summary", { text: "Technical details" }),
    h("div", { class: "group group--inset" }, technicalRows(tx, ov, nodeUrl)),
  ]);
  tech.addEventListener("toggle", () => {
    if (state) state.txTechOpen = tech.open;
  });

  // A contract's token or NFT, to follow in Assets: not the network's own
  // transfer and stake contracts.
  const contractId = tx?.contractId ? String(tx.contractId) : "";
  const network = [TRANSFER_CONTRACT, STAKE_CONTRACT].includes(contractId.toLowerCase().replace(/^0x/, ""));
  const assets =
    kind === TX_KIND.CONTRACT_CALL && contractId && !network && !["staking", "bridge"].includes(desc.category)
      ? h("div", { class: "tx-assets" }, [
          h("button", {
            class: "btn-outline",
            type: "button",
            text: "Add token",
            onclick: () => {
              state.assetAddToken = { contractId, loading: false, error: null, meta: null };
              state.route = "asset_add_token";
              actions?.render?.()?.catch?.(() => {});
            },
          }),
          h("button", {
            class: "btn-outline",
            type: "button",
            text: "Import NFT",
            onclick: () => {
              state.assetAddNft = { contractId, tokenId: "", loading: false, error: null, info: null };
              state.route = "asset_add_nft";
              actions?.render?.()?.catch?.(() => {});
            },
          }),
        ])
      : null;

  return [nav, h("div", { class: "tx-detail" }, [hero, rows, tech, assets, explorerButton(explorerUrl, actions)].filter(Boolean))];
}
