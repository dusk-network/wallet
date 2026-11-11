import { migrationsOf, transferLedger } from "@dusk-network/app-core/bridge";

import { formatDuskExact, formatFee, groupThousands } from "../../../shared/amount.js";
import { TX_KIND } from "../../../shared/constants.js";
import { explorerTxUrl } from "../../../shared/explorer.js";
import { arrivalUrl, awaitingArrival, depositLux } from "../../../shared/bridgeArrival.js";
import { chainIdForNode, networkTextOf, nameCheckNote } from "../../../shared/nodeNetwork.js";
import { getTxMeta } from "../../../shared/txStore.js";
import { activityOwnersOf } from "../../../shared/activityStore.js";
import { activityNetworkKey } from "../../../shared/activityHistory.js";
import { walletLabel } from "../../../shared/wallets.js";
import { networks } from "@dusk-network/networks";
import { contractLabel } from "../../../shared/knownCalls.js";
import { openUrl } from "../../../platform/index.js";
import { h } from "../../lib/dom.js";
import { contractIdText, shortAddress, shortEvmHash, siteName } from "../../lib/strings.js";
import { subnav } from "../../components/Subnav.js";
import { iconSvg } from "../../components/ActionIcon.js";
import { balance, balancesHidden } from "../../components/Balance.js";
import { contractValueEl, copyContractButton } from "../../components/ContractValue.js";
import { copyButton as copyWordsButton } from "../../components/CopyButton.js";
import { profileNameEl } from "../../components/ProfileName.js";
import { safeTextEl } from "../../components/SafeText.js";
import { stDuskLines, txErrorText, txRecoveryReasonLabel, txStatusWord } from "./txDisplay.js";
import { amountEl, contactNames, copyButton, dateText, describeTx, nameParts, txIconSvg } from "./txRow.js";
import { reasonText } from "./sent.js";
import { activityKey, activityRows, loadActivityDetail, sozuFactOf } from "../activity.js";
import { migrationFactOf } from "../migrationFacts.js";
import { waiting } from "../../components/Waiting.js";

// A transaction's details: a centred summary (who, how much, its status),
// then its date, memo, fee, the profile it left or reached, and its ID, which
// opens Dusk's explorer; a transfer to another chain that arrived adds when, and its
// transaction there. Block, gas, finality and a call's contract sit under
// Technical details, labelled as in every Dusk app. A row shows an amount short;
// here it's exact, the fee too. Hide balances hides the amount; the fee stays.

const STATUS_ICON = { ok: "check", bad: "alert", pending: "clock" };

// What the status word doesn't say: whether to wait, what may still hold, and
// for one that didn't go through, that its amount never left.
function statusNote(tx, desc, hidden) {
  const shielded = tx?.privacy === "shielded";
  const a = desc.amount;
  const stayed = !desc.unsent || !a || a.text ? "" : hidden ? " The amount stayed in your wallet." : ` The ${a.exact ?? a.value} ${a.unit} stayed in your wallet.`;
  if (tx?.dropped) {
    return `The network dropped it before it ran, so no fee was charged.${stayed}${shielded ? " Shielded funds may still be reserved locally." : ""}`;
  }
  switch (desc.status) {
    case "pending":
      if (globalThis.navigator?.onLine === false) return "No connection. It's looked up again once you're back online.";
      return tx?.sent?.status === "mempool" ? "Still waiting to go through. Don't retry yet." : "Waiting for a block, usually about 10 seconds.";
    case "unknown":
      // Final on chain, its outcome not looked up yet; or the wallet's own
      // send it stopped waiting for.
      return tx?.source !== "sent"
        ? "It is final on chain. Its outcome is still being looked up."
        : "The wallet stopped waiting for a result. That doesn't mean it failed.";
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

// A fee, hidden as amounts are with Hide balances.
const feeValue = (text, hidden) => h("span", {}, [balance(hidden, text), " DUSK"]);

function feeRow(tx, desc, hidden) {
  if (tx?.dropped) return kv("Network fee", "None charged");
  if (tx?.fee != null) return kv(desc.failed ? "Fee charged" : "Network fee", feeValue(formatDuskExact(tx.fee), hidden));
  const limit = tx?.gasLimit ?? 0n;
  const price = tx?.gasPrice ?? 0n;
  if (desc.tone === "pending" && tx?.source === "sent" && limit > 0n && price > 0n) {
    return kv("Network fee", h("span", {}, ["Up to ", feeValue(formatFee(limit * price, { max: true }), hidden)]));
  }
  return null;
}

function technicalRows(tx, ov, nodeUrl, showToast, hidden) {
  const num = (v) => (v != null && /^\d+$/.test(String(v)) ? groupThousands(String(v)) : null);
  const at = (label, ms) => (Number(ms) > 0 ? kv(label, dateText(Number(ms))) : null);
  const used = num(tx?.gasSpent);
  const limit = num(tx?.gasLimit);
  // What only the wallet's own record of it says: how it got there, and how
  // the wallet watched it until the chain's history had it.
  const sent = tx?.sent ?? {};
  const watch = tx?.source === "sent" ? sent : {};
  return [
    kv("Network", nodeUrl ? networkTextOf(nodeUrl) : String(ov?.networkName ?? "Unknown")),
    num(tx?.blockHeight) ? kv("Block", mono(num(tx.blockHeight))) : null,
    used || limit ? kv("Gas used", h("span", {}, [balance(hidden, used && limit ? `${used} of ${limit}` : used ? used : `Limit ${limit}`)])) : null,
    num(tx?.gasPrice) ? kv("Gas price", `${num(tx.gasPrice)} LUX`) : null,
    tx?.source !== "sent" && ["executed", "failed"].includes(tx?.status) ? kv("Finality", "Final") : null,
    tx?.kind === TX_KIND.CONTRACT_CALL && tx?.contractId ? kv("Contract", contractValue(String(tx.contractId), nodeUrl || ov?.nodeUrl, showToast)) : null,
    tx?.fnName ? kv("Method", safeTextEl(String(tx.fnName), { mono: true })) : null,
    tx?.blockHash ? kv("Block hash", mono(String(tx.blockHash), shortAddress(String(tx.blockHash)))) : null,
    at("Submitted", tx?.submittedAt),
    at("Seen in mempool", watch.mempoolSeenAt),
    at("Last checked", watch.lastCheckedAt),
    at("Dropped", watch.removedAt),
    sent.reservationStatus ? kv("Shielded reservation", String(sent.reservationStatus)) : null,
    watch.recoveryReason ? kv("Why", txRecoveryReasonLabel(watch.recoveryReason), { className: "kv--wrap" }) : null,
    // The chain's own words for a failure; the summary says it plainly.
    String(tx?.status ?? "") === "failed" && tx?.error ? kv("Error", String(tx.error), { className: "kv--wrap" }) : null,
  ].filter(Boolean);
}

// A call's contract: what the network calls it, as the explorer does, then
// its short ID and Copy.
function contractValue(raw, nodeUrl, showToast) {
  const id = contractIdText(raw);
  return contractValueEl(contractLabel(raw, nodeUrl), mono(id, contractIdText(raw, { short: true })), copyContractButton(id, showToast));
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

// A bridge transfer's own amounts, exact and the same in every Dusk app
// (transferLedger): what it sent and the bridge's fee, then the network's, which
// `feeRow` says, then what arrives, or is on its way. What arrives is said only
// while it can: not of what the bridge doesn't pay, or past the week it's looked for.
// One that failed, or was dropped before it ran, sent nothing. A migration's
// payout says what the migration paid on its own chain (`evm`), to the wei,
// and which transactions that counts.
function ledgerRows(tx, desc, nodeUrl, hidden, evm) {
  const received = desc.arrival ? desc.payout?.received ?? depositLux(tx) : undefined;
  const ledger = transferLedger({ row: tx, received, failed: desc.unsent, evm });
  if (!ledger) return null;
  const row = (label, line, note) =>
    line ? kv(label, h("span", {}, [balance(hidden, line.exact), ` ${line.coin}`, note ? h("span", { class: "kv-muted", text: ` · ${note}` }) : null].filter(Boolean))) : null;
  const coming = ledger.received && (!ledger.received.expected || desc.payout || awaitingArrival(tx, nodeUrl));
  const counts = ledger.gas?.parts ? (ledger.gas.parts.includes("approval") ? "approval and migration" : "migration") : "";
  return {
    before: [row("Sent", ledger.sent), row("Bridge fee", ledger.bridgeFee)],
    after: [coming ? row(ledger.received.expected ? "You receive" : "Received", ledger.received) : null, evm ? row(`Fee on ${tx.route.chain.name}`, ledger.gas, counts) : null],
  };
}

// A network's node, by the key its history is kept under (activityNetworkKey):
// Mainnet's and Testnet's own node, any other node's origin.
const nodeOfNetwork = (network) => (network === "mainnet" || network === "testnet" ? String(networks[network]?.urls?.node ?? "") : network);

// Where a transaction is, for one that isn't in this profile's activity (a
// notice tapped after a switch of network, wallet or profile): the record the
// wallet kept as it sent it, or once that's gone, the history it's kept in.
// Its network by the key its history is kept under, as the history's writer
// keys it. Read once for the transaction shown, and drawn again when it's read.
function whereOf(hash, { state, actions }) {
  if (state.txDetailWhere?.hash === hash) return state.txDetailWhere.where;
  const read = (state.txDetailWhere = { hash, where: null });
  Promise.all([getTxMeta(hash).catch(() => null), activityOwnersOf(hash).catch(() => [])])
    .then(([meta, owners]) => {
      if (state.txDetailWhere !== read) return;
      if (meta?.nodeUrl) {
        const nodeUrl = String(meta.nodeUrl);
        const chainId = Number.isInteger(meta.chainId) ? meta.chainId : chainIdForNode(nodeUrl) ?? undefined;
        read.where = { network: activityNetworkKey(nodeUrl), nodeUrl, chainId, walletId: String(meta.walletId ?? ""), profileIndex: meta.profileIndex };
      } else if (owners.length) {
        // `network::account`: the account has no "::", a node's origin may.
        const owner = owners[0];
        const at = owner.lastIndexOf("::");
        const network = owner.slice(0, at);
        const nodeUrl = nodeOfNetwork(network);
        read.where = { network, nodeUrl, chainId: chainIdForNode(nodeUrl) ?? undefined, account: owner.slice(at + 2) };
      } else return;
      actions?.render?.()?.catch?.(() => {});
    })
    .catch(() => {});
  return null;
}

// Whether it's on the network the wallet is on, by the same key.
const onThisNetwork = (where, ov) => where.network === activityNetworkKey(String(ov?.nodeUrl ?? ""));

// What's said of where it is: another network, wallet or profile.
function elsewhereText(where, ov) {
  if (!where) return "";
  if (!onThisNetwork(where, ov)) {
    const [there, here] = [where.nodeUrl ? networkTextOf(where.nodeUrl) : "", networkTextOf(String(ov?.nodeUrl ?? ""))];
    return there && here ? `This transaction is on ${there}. You are on ${here}.` : "This transaction is on another network.";
  }
  const own = (Array.isArray(ov?.accounts) ? ov.accounts : []).map(String);
  const wallets = Array.isArray(ov?.wallets) ? ov.wallets : [];
  // Its wallet, by its ID or by the account whose history has it.
  const otherWallet = where.account ? !own.includes(where.account) : Boolean(where.walletId) && where.walletId !== own[0];
  if (otherWallet) {
    const wallet = wallets.find((w) => (where.account ? (w?.accounts ?? []).map(String).includes(where.account) : w?.walletId === where.walletId));
    return wallet ? `This transaction is in ${walletLabel(wallet)}.` : "This transaction is in another wallet.";
  }
  const profile = where.account ? own.indexOf(where.account) : where.profileIndex;
  if (Number.isInteger(profile) && profile !== (Number(ov?.selectedAccountIndex ?? 0) || 0)) return "This transaction is in another profile.";
  return "";
}

export function txDetailsView(ov, { state, actions } = {}) {
  const hash = String(state?.txDetailHash ?? "");
  const txs = activityRows(ov, state);
  // Or the row a screen gave it, found past Activity's page (Receive's
  // requests): only in the context it was found in, dropped in another.
  if (state?.txDetailRow && state.txDetailRow.context !== activityKey(ov)) state.txDetailRow = null;
  const given = state?.txDetailRow && String(state.txDetailRow.hash ?? "") === hash.toLowerCase() ? state.txDetailRow : null;
  const tx = txs.find((t) => String(t?.hash ?? "") === hash.toLowerCase()) || given?.row || null;
  // A synced entry not looked up yet gets its time, outcome and fee now, and
  // a deposit to DuskEVM its address there.
  if (tx?.source === "public") {
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

  const nodeUrl = String(tx?.sent?.nodeUrl ?? ov?.nodeUrl ?? "");
  const explorerUrl = explorerTxUrl(nodeUrl, hash);

  // Still read for, past Activity's page.
  if (!tx && given?.reading) return [nav, waiting("Looking for this transaction…", { tag: "p", className: "tx-missing" })];

  if (!tx) {
    // Where it is, and its explorer is its network's.
    const at = whereOf(hash.toLowerCase(), { state, actions });
    const where = elsewhereText(at, ov);
    // Another network's explorer, where it has one.
    const url = at && !onThisNetwork(at, ov) ? explorerTxUrl(at.nodeUrl, hash, at.chainId) : explorerUrl;
    return [
      nav,
      h("div", { class: "tx-detail" }, [
        h("p", { class: "tx-missing", text: where || "This transaction isn't in your activity." }),
        h("div", { class: "group" }, [kv("Transaction ID", mono(hash, shortAddress(hash)))]),
        explorerButton(url, actions),
      ].filter(Boolean)),
    ];
  }

  const hidden = balancesHidden(ov);
  const desc = describeTx(tx, { contactName: contactNames(state, actions, ov), nodeUrl });
  const { kind } = tx;
  const showToast = actions?.showToast;

  // Who: the other side's name with its short address and Copy, a saved
  // contact's .dusk name before it; an address without a name shows in full
  // mono, Copy beside it; a deposit to DuskEVM is "To" the address it paid
  // there, Copy beside it; a transfer through a bridge's account shows that
  // account under it. A call's contract is under Technical details.
  const via = desc.via?.address ? desc.via : null;
  const other = via ? via.address : !desc.evm && desc.address && !desc.isAddress ? desc.address : "";
  const otherAlias = via ? (via.isAddress ? "" : via.name) : desc.alias;
  // The name's a node the wallet doesn't know's word.
  const nameNote = nameCheckNote(nodeUrl) ? h("p", { class: "tx-hero-note", role: "note", text: nameCheckNote(nodeUrl) }) : null;
  const hero = h("div", { class: "tx-hero" }, [
    h("span", { class: "row-icon tx-hero-icon", "aria-hidden": "true", html: txIconSvg(desc.icon) }),
    desc.lead ? h("div", { class: "tx-hero-lead", text: desc.lead }) : null,
    h("div", { class: "tx-hero-name-line" }, [
      h("h2", { class: desc.isAddress ? "tx-hero-name mono" : "tx-hero-name", title: desc.isAddress || desc.evm ? desc.address : undefined }, nameParts(desc)),
      desc.isAddress || desc.evm ? copyButton(desc.address, { label: desc.evm ? `Copy ${desc.evmChain} address` : "Copy address", showToast }) : null,
    ].filter(Boolean)),
    other
      ? h("div", { class: "tx-hero-addr" }, [
          otherAlias ? h("span", { class: "tx-hero-alias", text: `${otherAlias} · ` }) : null,
          mono(other, shortAddress(other)),
          copyButton(other, { label: "Copy address", showToast }),
        ].filter(Boolean))
      : null,
    tx?.counterpartyName || tx?.toName ? nameNote : null,
    amountEl(desc.amount, hidden, "tx-hero-amount", { exact: true }),
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
  const rail = tx.privacy === "shielded" ? "Shielded" : "Public";
  const ownRows =
    kind === TX_KIND.SHIELD
      ? [kv("From", profileValue(ov, tx, "Public")), kv("To", profileValue(ov, tx, "Shielded"))]
      : kind === TX_KIND.UNSHIELD
      ? [kv("From", profileValue(ov, tx, "Shielded")), kv("To", profileValue(ov, tx, "Public"))]
      : [kv(tx?.direction === "in" ? "To" : "From", profileValue(ov, tx, rail))];

  // The site that asked for it. The wallet records its own transactions'
  // origin as "Wallet": they come from no site, so they show none.
  const origin = String(tx.sent?.origin ?? "");
  const site = origin && origin.toLowerCase() !== "wallet" ? siteName(origin) : "";

  const when = tx.time;
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
  // Copy, in words, saying Copied on itself; a failed copy says so in a toast.
  const copyWords = (value, label, failText) =>
    copyWordsButton({ value, label, text: "Copy", className: "mini-btn", failText, onFail: showToast });
  const copyId = copyWords(hash, "Copy transaction ID", "Couldn't copy the transaction ID");

  // Where a transfer to another chain went, in full, with Copy.
  const evmRow = desc.recipient
    ? kv(
        `${desc.evmChain} recipient`,
        [
          h("span", { class: "mono", text: desc.recipient }),
          copyWords(desc.recipient, `Copy ${desc.evmChain} address`, "Couldn't copy the address"),
        ],
        { className: "kv--wrap tx-evm-recipient" }
      )
    : null;

  // Where it arrived: its transaction there, which opens that chain's explorer.
  const arrivalLink = desc.arrival ? arrivalUrl(nodeUrl, desc.arrival, tx?.route) : null;
  const arrivalChain = desc.evmChain || "DuskEVM";
  // A transaction on another chain, which opens that chain's explorer.
  const chainTxRow = (chain, hash, link) =>
    kv(`${chain} transaction`, [
      h("button", {
        class: "text-btn tx-id chain-link",
        type: "button",
        title: link ? `Open in ${chain} explorer` : hash,
        "aria-label": link ? `${chain} transaction ${shortEvmHash(hash)}, open in ${chain} explorer` : `${chain} transaction ${shortEvmHash(hash)}`,
        disabled: !link,
        text: shortEvmHash(hash),
        onclick: async () => {
          const ok = link ? await openUrl(link) : false;
          if (!ok) showToast?.("Couldn't open the explorer");
        },
      }),
      copyWords(hash, `Copy ${chain} transaction ID`, "Couldn't copy the transaction ID"),
    ]);
  const arrivalRow = desc.arrival ? chainTxRow(arrivalChain, desc.arrival, arrivalLink) : null;
  // A migration's payout names the migration in its memo, as text: its transaction there, and what it paid there.
  const [migration] = migrationsOf([tx]);
  const migrated = Boolean(migration);
  const migratedRow = migrated ? chainTxRow(tx.route.chain.name, migration.hash, `${String(tx.route.chain.explorerUrl ?? "").replace(/\/+$/, "")}/tx/${migration.hash}`) : null;
  const evm = migrated ? migrationFactOf(ov, tx, { render: actions?.render }) : undefined;

  const ledger = ledgerRows(tx, desc, nodeUrl, hidden, evm);
  // A stake's or an unstake's stDUSK with Sozu, once the pool's event is read.
  const stDusk = stDuskLines(tx?.sozu ? sozuFactOf(ov, tx, { render: actions?.render }) : undefined, hidden);
  const rows = h("div", { class: "group" }, [
    when ? kv("Date", dateText(when)) : null,
    ...stDusk.map(({ label, value }) => kv(label, value)),
    desc.arrivedAt ? kv("Arrived", dateText(desc.arrivedAt)) : null,
    evmRow,
    ...(ledger?.before ?? []),
    ledger ? feeRow(tx, desc, hidden) : null,
    ...(ledger?.after ?? []),
    // A memo that is the recipient on another chain shows as that.
    migratedRow,
    // Anyone can send a memo: neutralized, so it can't read as something it isn't.
    tx?.memo && !migrated && String(tx.memo).trim() !== desc.recipient ? kv("Memo", safeTextEl(tx.memo), { className: "kv--wrap" }) : null,
    ledger ? null : feeRow(tx, desc, hidden),
    ...ownRows,
    site ? kv("Site", site) : null,
    kv("Transaction ID", [idButton, copyId]),
    arrivalRow,
  ].filter(Boolean));

  // Technical details stay open across redraws (a sync can redraw this view).
  const tech = h("details", { class: "advanced tx-tech", open: Boolean(state?.txTechOpen) }, [
    h("summary", { text: "Technical details" }),
    h("div", { class: "group group--inset" }, technicalRows(tx, ov, nodeUrl, showToast, hidden)),
  ]);
  tech.addEventListener("toggle", () => {
    if (state) state.txTechOpen = tech.open;
  });

  // A call's details offer no Add token or Import NFT: Assets has both.
  return [
    nav,
    h("div", { class: "tx-detail" }, [
      hero,
      rows,
      tech,
      explorerButton(explorerUrl, actions),
      explorerButton(arrivalLink, actions, `View in ${arrivalChain} explorer`),
    ].filter(Boolean)),
  ];
}
