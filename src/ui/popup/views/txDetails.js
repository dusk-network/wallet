import { formatDuskExact, formatFee, groupThousands, safeBigInt } from "../../../shared/amount.js";
import { TX_KIND } from "../../../shared/constants.js";
import { explorerTxUrl } from "../../../shared/explorer.js";
import { arrivalUrl } from "../../../shared/bridgeArrival.js";
import { networkNameFromNodeUrl } from "../../../shared/network.js";
import { labelForNode } from "../../../shared/nodeNetwork.js";
import { openUrl } from "../../../platform/index.js";
import { h } from "../../lib/dom.js";
import { copyToClipboard } from "../../lib/clipboard.js";
import { contractIdText, shortAddress, siteName } from "../../lib/strings.js";
import { subnav } from "../../components/Subnav.js";
import { iconSvg } from "../../components/ActionIcon.js";
import { balancesHidden } from "../../components/Balance.js";
import { profileNameEl } from "../../components/ProfileName.js";
import { txErrorText, txRecoveryReasonLabel, txStatusWord } from "./txDisplay.js";
import { amountEl, contactNames, copyButton, dateText, describeTx, nameParts, shortEvmAddress, txIconSvg, txTime } from "./txRow.js";
import { reasonText } from "./sent.js";
import { activityRows, loadActivityDetail } from "../activity.js";

// A transaction's details: a centred summary (who, how much, its status),
// then its date, memo, fee, the profile it left or reached, and its ID, which
// opens Dusk's explorer. Block, gas, finality and a call's contract sit under
// Technical details. Hide balances hides the amount; the fee stays.

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

// The profile a transaction left or reached, by its name as the header shows
// it, and the balance: "alice.dusk · Public".
function profileValue(ov, tx, rail) {
  return h("span", {}, [profileNameEl(ov, { index: tx?.profileIndex }), h("span", { class: "kv-muted", text: ` · ${rail}` })]);
}

function feeRow(tx, desc) {
  if (desc.status === "removed") return kv("Network fee", "None charged");
  if (tx?.feePaid != null && tx.feePaid !== "") return kv(desc.failed ? "Fee charged" : "Network fee", `${formatFee(tx.feePaid)} DUSK`);
  const limit = safeBigInt(tx?.gasLimit, 0n);
  const price = safeBigInt(tx?.gasPrice, 0n);
  if (desc.tone === "pending" && tx?.source !== "archive" && limit > 0n && price > 0n) {
    return kv("Network fee", `Up to ${formatFee(limit * price, { max: true })} DUSK`);
  }
  return null;
}

function technicalRows(tx, ov, nodeUrl, showToast) {
  const kind = String(tx?.kind ?? "").toLowerCase();
  const num = (v) => (v != null && /^\d+$/.test(String(v)) ? groupThousands(String(v)) : null);
  const at = (label, ms) => (Number(ms) > 0 ? kv(label, dateText(Number(ms))) : null);
  const used = num(tx?.gasSpent);
  const limit = num(tx?.gasLimit);
  const finalKnown = ["archive", "both", "shielded"].includes(String(tx?.source ?? ""));
  return [
    kv("Network", nodeUrl ? networkNameFromNodeUrl(nodeUrl) : String(ov?.networkName ?? "Unknown")),
    num(tx?.blockHeight) ? kv("Block", mono(num(tx.blockHeight))) : null,
    used || limit ? kv("Gas used", used && limit ? `${used} of ${limit}` : used ? used : `Limit ${limit}`) : null,
    num(tx?.gasPrice) ? kv("Gas price", `${num(tx.gasPrice)} LUX`) : null,
    // The fee to the last LUX: the summary rounds it to 4 decimals.
    safeBigInt(tx?.feePaid, 0n) > 0n ? kv("Exact fee", `${formatDuskExact(tx.feePaid)} DUSK`) : null,
    finalKnown && ["executed", "failed"].includes(String(tx?.status ?? "")) ? kv("Finality", "Final") : null,
    kind === TX_KIND.CONTRACT_CALL && tx?.contractId ? kv("Contract", contractValue(String(tx.contractId), nodeUrl || ov?.nodeUrl, showToast)) : null,
    tx?.fnName ? kv("Method", mono(String(tx.fnName))) : null,
    tx?.blockHash ? kv("Block hash", mono(String(tx.blockHash), shortAddress(String(tx.blockHash)))) : null,
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

// A call's contract: what the network's file calls it, where it does, then
// its short ID and Copy.
function contractValue(raw, nodeUrl, showToast) {
  const label = labelForNode(String(nodeUrl ?? ""), raw);
  const id = contractIdText(raw);
  return [label ? `${label} · ` : null, mono(id, contractIdText(raw, { short: true })), copyContract(id, showToast)];
}

// Copy beside a call's contract, as an icon.
function copyContract(id, showToast) {
  return h("button", {
    class: "copy-ico",
    type: "button",
    title: "Copy contract ID",
    "aria-label": "Copy contract ID",
    html: iconSvg("copy"),
    onclick: async () => {
      const ok = await copyToClipboard(id);
      showToast?.(ok ? "Contract ID copied" : "Couldn't copy the contract ID");
    },
  });
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
  // A synced entry not looked up yet gets its time, outcome and fee now, and
  // a deposit to DuskEVM its address there.
  if (tx?.source === "archive" || tx?.source === "both") {
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
        h("div", { class: "group" }, [kv("Transaction ID", mono(hash, shortAddress(hash)))]),
        explorerButton(explorerUrl, actions),
      ].filter(Boolean)),
    ];
  }

  const hidden = balancesHidden(ov);
  const desc = describeTx(tx, { contactName: contactNames(state, actions), nodeUrl });
  const kind = String(tx?.kind ?? "").toLowerCase();
  const showToast = actions?.showToast;

  // Who: the other side's name with its short address and Copy, a saved
  // contact's .dusk name before it; an address without a name shows in full
  // mono, Copy beside it; a deposit to DuskEVM is "To" the DuskEVM address it
  // paid, Copy beside it. A call's contract is under Technical details.
  const other = !desc.evm && desc.address && !desc.isAddress ? desc.address : "";
  const hero = h("div", { class: "tx-hero" }, [
    h("span", { class: "row-icon tx-hero-icon", "aria-hidden": "true", html: txIconSvg(desc.icon) }),
    desc.lead ? h("div", { class: "tx-hero-lead", text: desc.lead }) : null,
    h("div", { class: "tx-hero-name-line" }, [
      h("h2", { class: desc.isAddress ? "tx-hero-name mono" : "tx-hero-name", title: desc.isAddress || desc.evm ? desc.address : undefined }, nameParts(desc)),
      desc.isAddress || desc.evm ? copyButton(desc.address, { label: desc.evm ? "Copy DuskEVM address" : "Copy address", showToast }) : null,
    ].filter(Boolean)),
    other
      ? h("div", { class: "tx-hero-addr" }, [
          desc.alias ? h("span", { class: "tx-hero-alias", text: `${desc.alias} · ` }) : null,
          mono(other, shortAddress(other)),
          copyButton(other, { label: "Copy address", showToast }),
        ].filter(Boolean))
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

  // The site that asked for it. The wallet records its own transactions'
  // origin as "Wallet": they come from no site, so they show none.
  const origin = String(tx?.origin ?? "");
  const site = origin && origin.toLowerCase() !== "wallet" ? siteName(origin) : "";

  const when = txTime(tx);
  const idButton = h("button", {
    class: "text-btn tx-id chain-link",
    type: "button",
    title: explorerUrl ? "Open in Dusk explorer" : hash,
    "aria-label": explorerUrl ? `Transaction ${shortAddress(hash)}, open in Dusk explorer` : undefined,
    disabled: !explorerUrl,
    text: shortAddress(hash),
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

  // Where a deposit to DuskEVM went, in full, with Copy.
  const evmRow = desc.evm
    ? kv(
        "DuskEVM recipient",
        [
          h("span", { class: "mono", text: desc.address }),
          h("button", {
            class: "mini-btn",
            type: "button",
            text: "Copy",
            "aria-label": "Copy DuskEVM address",
            onclick: async () => {
              const ok = await copyToClipboard(desc.address);
              showToast?.(ok ? "Address copied" : "Couldn't copy the address");
            },
          }),
        ],
        { className: "kv--wrap tx-evm-recipient" }
      )
    : null;

  // Where a deposit to DuskEVM arrived: its transaction there, which opens DuskEVM's explorer.
  const arrivalLink = desc.arrival ? arrivalUrl(nodeUrl, desc.arrival) : null;
  const arrivalRow = desc.arrival
    ? kv("DuskEVM transaction", [
        h("button", {
          class: "text-btn tx-id chain-link",
          type: "button",
          title: arrivalLink ? "Open in DuskEVM explorer" : desc.arrival,
          "aria-label": arrivalLink ? `DuskEVM transaction ${shortEvmAddress(desc.arrival)}, open in DuskEVM explorer` : undefined,
          disabled: !arrivalLink,
          text: shortEvmAddress(desc.arrival),
          onclick: async () => {
            const ok = arrivalLink ? await openUrl(arrivalLink) : false;
            if (!ok) showToast?.("Couldn't open the explorer");
          },
        }),
        h("button", {
          class: "mini-btn",
          type: "button",
          text: "Copy",
          "aria-label": "Copy DuskEVM transaction ID",
          onclick: async () => {
            const ok = await copyToClipboard(desc.arrival);
            showToast?.(ok ? "Transaction ID copied" : "Couldn't copy the transaction ID");
          },
        }),
      ])
    : null;

  const rows = h("div", { class: "group" }, [
    when ? kv("Date", dateText(when)) : null,
    evmRow,
    tx?.memo ? kv("Memo", String(tx.memo), { className: "kv--wrap" }) : null,
    feeRow(tx, desc),
    ...ownRows,
    site ? kv("Site", site) : null,
    kv("Transaction ID", [idButton, copyId]),
    arrivalRow,
  ].filter(Boolean));

  // Technical details stay open across redraws (a sync can redraw this view).
  const tech = h("details", { class: "advanced tx-tech", open: Boolean(state?.txTechOpen) }, [
    h("summary", { text: "Technical details" }),
    h("div", { class: "group group--inset" }, technicalRows(tx, ov, nodeUrl, showToast)),
  ]);
  tech.addEventListener("toggle", () => {
    if (state) state.txTechOpen = tech.open;
  });

  // A call's details offer no Add token or Import NFT: Assets has both.
  return [nav, h("div", { class: "tx-detail" }, [hero, rows, tech, explorerButton(explorerUrl, actions)].filter(Boolean))];
}
