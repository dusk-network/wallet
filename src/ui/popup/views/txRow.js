// Activity's rows, on Home and in the full Activity view: a direction icon,
// the other side's name first, a saved contact's own before its .dusk name
// (else its short address in mono, with Copy on hover or focus), "Sent ·
// 14:32" under it, and the amount with DUSK on the right. Known contract
// calls say what they did: "Registered a .dusk name". A status word shows only while its outcome isn't known. One that failed or
// was dropped says so under the name, "Failed · nothing sent · fee 0.0037
// DUSK paid", and its amount shows muted, without a sign: nothing left.
// Hide balances hides that fee too.

import { formatDusk, formatFee, safeBigInt } from "../../../shared/amount.js";
import { TX_KIND } from "../../../shared/constants.js";
import { bridgeTransfer } from "../../../shared/bridge.js";
import { knownCall } from "../../../shared/knownCalls.js";
import { listAddressBook } from "../../../shared/addressBook.js";
import { SOZU_FN } from "../../../shared/sozuAdapter.js";
import { h } from "../../lib/dom.js";
import { copyToClipboard } from "../../lib/clipboard.js";
import { shortAddress, truncateMiddle } from "../../lib/strings.js";
import { iconSvg } from "../../components/ActionIcon.js";
import { HIDDEN_BALANCE, balance } from "../../components/Balance.js";
import { MONTHS, clockText, dateText } from "../../lib/time.js";
import { txStatusTone, txStatusWord } from "./txDisplay.js";

export const MINUS = "−";

/** A DuskEVM address as EVM wallets and the approval window shorten it: "0xAB84…C86F". */
export const shortEvmAddress = (address) => truncateMiddle(String(address ?? ""), 6, 4);

/** Activity's filters, in order. */
export const ACTIVITY_FILTERS = Object.freeze([
  { id: "all", label: "All" },
  { id: "sent", label: "Sent" },
  { id: "received", label: "Received" },
  { id: "staking", label: "Staking" },
]);

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_MS = 24 * 60 * 60 * 1000;

// "14:32", and a transaction's Date row in full with its time zone, "26 Oct
// 2026, 14:32 CET".
export { clockText, dateText };

const startOfDay = (ms) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** A day group's title: "Today", "Yesterday", "Fri, 24 Oct", or with its year when it isn't this one. */
export function dayLabel(ms, now = Date.now()) {
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / DAY_MS);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  const d = new Date(ms);
  const year = d.getFullYear() === new Date(now).getFullYear() ? "" : ` ${d.getFullYear()}`;
  return `${DAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}${year}`;
}

/** When, on Home's short list: "Just now", "5 min ago", "14:32", "Yesterday", "24 Oct". */
export function recentText(ms, now = Date.now()) {
  const ago = now - ms;
  if (ago < 60_000) return "Just now";
  if (ago < 60 * 60_000) return `${Math.floor(ago / 60_000)} min ago`;
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / DAY_MS);
  if (days <= 0) return clockText(ms);
  if (days === 1) return "Yesterday";
  const d = new Date(ms);
  const year = d.getFullYear() === new Date(now).getFullYear() ? "" : ` ${d.getFullYear()}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${year}`;
}

/** A row's time: the block's, else when this wallet sent it; 0 when neither is known yet. */
export function txTime(tx) {
  return Number(tx?.timestamp ?? tx?.finalizedAt ?? tx?.executedAt ?? tx?.submittedAt) || 0;
}

/**
 * The block times Activity knows, by height, from the rows that have theirs:
 * the rows of one block share its time.
 * @param {object[]} rows
 * @returns {Map<number, number>}
 */
export function blockTimes(rows) {
  const times = new Map();
  for (const row of rows ?? []) {
    const height = Number(row?.blockHeight);
    const t = Number(row?.timestamp) || 0;
    if (Number.isFinite(height) && t > 0 && !times.has(height)) times.set(height, t);
  }
  return times;
}

/** What a synced row says in place of its time until its outcome comes. */
export const SYNCING = "Syncing…";

/**
 * When a row happened, for the line under its name, through `format`: its
 * own time, else its block's when another row of that block has it. A synced
 * row whose outcome isn't looked up yet gets its time with it: "Syncing…"
 * meanwhile.
 * @param {object} tx
 * @param {{ times?: Map<number, number>, format: (ms: number) => string }} opts
 * @returns {string}
 */
export function whenText(tx, { times, format }) {
  const t = txTime(tx) || times?.get(Number(tx?.blockHeight)) || 0;
  if (t) return format(t);
  return tx?.source === "archive" && !tx?.detailsAt ? SYNCING : "";
}

const positive = (lux) => /^\d+$/.test(String(lux ?? "")) && safeBigInt(lux, 0n) > 0n;

function tokenUnits(units, decimals) {
  const u = safeBigInt(units, 0n).toString();
  const d = Math.min(64, Math.max(0, Math.floor(Number(decimals) || 0)));
  if (!d) return u;
  const pad = u.padStart(d + 1, "0");
  const frac = pad.slice(-d).replace(/0+$/, "").slice(0, 6).replace(/0+$/, "");
  return frac ? `${pad.slice(0, -d)}.${frac}` : pad.slice(0, -d);
}

/**
 * Everything a row says about a transaction.
 * @param {object} tx - an Activity row (activity.js activityRows)
 * @param {{ contactName?: (address: string) => string, nodeUrl?: string }} [ctx] - `nodeUrl`:
 *   the overview's network, for a record that doesn't name its own
 * @returns {{
 *   icon: "out"|"in"|"stake"|"bridge"|"shield"|"call",
 *   category: "sent"|"received"|"staking"|"bridge"|"other",
 *   lead: string, name: string, alias: string, address: string|null, isAddress: boolean, generic: boolean,
 *   word: string, note: string,
 *   amount: { sign: string, value: string, unit: string } | null,
 *   status: string, tone: "ok"|"bad"|"pending"|"neutral", statusWord: string|null,
 *   failed: boolean, unsent: boolean, fee: string|null,
 * }}
 */
export function describeTx(tx, { contactName, nodeUrl } = {}) {
  const kind = String(tx?.kind ?? "").toLowerCase();
  const dir = tx?.direction;
  const asset = tx?.asset && typeof tx.asset === "object" ? tx.asset : null;
  const fn = String(tx?.fnName ?? asset?.action ?? "");

  // The other side: a saved contact's own name, with its .dusk name (as
  // typed when sending, else verified) beside it; else the .dusk name; else
  // its short address.
  const party = (address, typed = "") => {
    const addr = String(address ?? "").trim();
    const contact = String((addr && contactName?.(addr)) ?? "").trim();
    const dusk = [typed, tx?.counterpartyName].map((s) => String(s ?? "").trim()).find(Boolean) ?? "";
    if (contact) {
      const alias = dusk && dusk.toLowerCase() !== contact.toLowerCase() ? dusk : "";
      return { name: contact, alias, address: addr || null, isAddress: false };
    }
    if (dusk) return { name: dusk, address: addr || null, isAddress: false };
    if (addr) return { name: shortAddress(addr), address: addr, isAddress: true };
    return null;
  };
  const dusk = (lux, sign) => (positive(lux) ? { sign, value: formatDusk(lux), unit: "DUSK" } : null);

  let d;
  const bridge = bridgeTransfer(tx, tx?.nodeUrl || nodeUrl);
  // A known contract's call, by what it did.
  const named =
    kind === TX_KIND.CONTRACT_CALL
      ? knownCall({ contractId: tx?.contractId, fnName: fn, nodeUrl: tx?.nodeUrl || nodeUrl, registeredName: tx?.registeredName })
      : null;
  if (bridge) {
    const value = tx?.amount ?? tx?.deposit;
    // A deposit's DuskEVM address, read from its call: the one the wallet
    // approved, or the chain's record of it.
    const evm = /^0x[0-9a-fA-F]{40}$/.test(String(tx?.bridgeTo ?? "")) ? String(tx.bridgeTo) : null;
    // DUSK that left for DuskEVM is under Sent too, and DUSK back from it under Received.
    d =
      bridge === "to"
        ? {
            icon: "bridge",
            category: "bridge",
            alsoUnder: "sent",
            lead: evm ? "Bridge to DuskEVM" : "Bridge",
            name: evm ? `To ${shortEvmAddress(evm)}` : "To DuskEVM",
            word: evm ? "Bridge to DuskEVM" : "Bridge",
            address: evm,
            evm: Boolean(evm),
            amount: dusk(positive(tx?.deposit) ? tx.deposit : value, MINUS),
          }
        : bridge === "from"
        ? { icon: "bridge", category: "bridge", alsoUnder: "received", lead: "Bridge", name: "From DuskEVM", word: "Bridge", amount: dusk(value, "+") }
        : {
            icon: "bridge",
            category: "bridge",
            lead: "Bridge",
            name: /^prove/i.test(fn) ? "Prove withdrawal" : /^finalize/i.test(fn) ? "Finalize withdrawal" : "DuskEVM bridge",
            word: "Bridge",
            amount: null,
          };
  } else if (kind === TX_KIND.TRANSFER) {
    if (dir === "in") {
      const p = party(tx?.from);
      d = { icon: "in", category: "received", lead: p ? "Received from" : "", ...(p ?? { name: "Received", generic: true }), word: "Received", amount: dusk(tx?.amount, "+") };
    } else if (dir === "self") {
      d = { icon: "out", category: "sent", lead: "Sent", name: "To yourself", word: "Sent", amount: dusk(tx?.amount, "") };
    } else {
      const p = party(tx?.to, tx?.toName);
      d = { icon: "out", category: "sent", lead: p ? "Sent to" : "", ...(p ?? { name: "Sent", generic: true }), word: "Sent", amount: dusk(tx?.amount, MINUS) };
    }
  } else if (kind === TX_KIND.SHIELD || kind === TX_KIND.UNSHIELD) {
    const shield = kind === TX_KIND.SHIELD;
    d = {
      icon: "shield",
      category: "other",
      name: shield ? "Shield" : "Unshield",
      word: shield ? "Public to shielded" : "Shielded to public",
      amount: dusk(tx?.amount, ""),
    };
  } else if (kind === TX_KIND.STAKE) {
    d = { icon: "stake", category: "staking", lead: "Native staking", name: "Stake", word: "Staking", amount: dusk(tx?.amount, MINUS) };
  } else if (kind === TX_KIND.UNSTAKE) {
    d = { icon: "stake", category: "staking", lead: "Native staking", name: "Unstake", word: "Staking", amount: dusk(tx?.amount, "+") };
  } else if (kind === TX_KIND.WITHDRAW_REWARD) {
    d = { icon: "stake", category: "staking", lead: "Native staking", name: "Claim rewards", word: "Staking", amount: dusk(tx?.amount, "+") };
  } else if (fn === SOZU_FN.STAKE || fn === SOZU_FN.UNSTAKE) {
    const stake = fn === SOZU_FN.STAKE;
    d = {
      icon: "stake",
      category: "staking",
      lead: "Liquid staking",
      name: stake ? "Staked with Sozu" : "Unstaked from Sozu",
      word: "Staking",
      amount: stake ? dusk(positive(tx?.deposit) ? tx.deposit : tx?.amount, MINUS) : dir === "in" ? dusk(tx?.amount, "+") : null,
    };
  } else if (asset && String(asset.type ?? "") === "DRC20") {
    const sym = String(asset.symbol ?? "").trim() || "Token";
    const op = String(asset.op ?? "").toLowerCase();
    const units = tokenUnits(asset.valueUnits ?? asset.value ?? "0", asset.decimals);
    if (op === "transfer") {
      const p = party(asset.to);
      d = {
        icon: "out",
        category: "sent",
        lead: p ? "Sent to" : "",
        ...(p ?? { name: `Sent ${sym}`, generic: true }),
        word: "Sent",
        amount: units !== "0" ? { sign: MINUS, value: units, unit: sym } : null,
      };
    } else if (op === "approve") {
      // Whom it lets spend the token, as a counterparty; an allowance of 0 takes it back.
      const p = party(asset.spender);
      const revoke = !asset.isMax && units === "0" && (asset.valueUnits ?? asset.value) != null;
      d = {
        icon: "call",
        category: "sent",
        ...(p ? { ...p, lead: revoke ? `Revoked ${sym} for` : `Approved ${sym} for` } : { name: `${revoke ? "Revoke" : "Approve"} ${sym}` }),
        word: revoke ? "Revoke" : "Approval",
        amount: asset.isMax
          ? { sign: "", value: "Unlimited", unit: sym, text: true }
          : units !== "0" || revoke
          ? { sign: "", value: units, unit: sym }
          : null,
      };
    } else {
      d = { icon: "call", category: "sent", name: `${sym} ${fn || "call"}`, word: "Contract", amount: null };
    }
  } else if (asset && String(asset.type ?? "") === "DRC721") {
    const sym = String(asset.symbol ?? "").trim() || "NFT";
    const id = asset.tokenId != null ? ` #${asset.tokenId}` : "";
    d = { icon: "call", category: "sent", name: `${sym}${id}`, word: "NFT", amount: null };
  } else if (named) {
    const value = positive(tx?.deposit) ? tx.deposit : tx?.amount;
    d = {
      icon: positive(value) ? "out" : "call",
      category: dir === "in" ? "received" : "sent",
      lead: named.app,
      name: named.label,
      word: named.app,
      amount: dusk(value, dir === "in" ? "+" : MINUS),
    };
  } else if (kind === TX_KIND.CONTRACT_CALL) {
    const value = positive(tx?.deposit) ? tx.deposit : tx?.amount;
    const moved = positive(value);
    d = {
      icon: moved ? "out" : "call",
      category: dir === "in" ? "received" : "sent",
      name: fn ? `Call ${fn}` : "Contract call",
      word: "Contract",
      amount: dusk(value, dir === "in" ? "+" : MINUS),
    };
  } else {
    d = { icon: "call", category: "other", name: "Transaction", word: "", amount: dusk(tx?.amount, "") };
  }

  const status = String(tx?.status ?? "submitted").toLowerCase();
  // A row the archive has is final on chain, its outcome looked up after.
  const final = tx?.source === "archive" || tx?.source === "both";
  const tone = txStatusTone(status, { final });
  const failed = status === "failed";
  // Failed, or dropped before it ran: the amount stayed in the wallet.
  const unsent = failed || status === "removed";
  const amount = d.amount && unsent ? { ...d.amount, sign: "", muted: true } : d.amount;
  return {
    lead: "",
    alias: "",
    address: null,
    isAddress: false,
    evm: false,
    generic: false,
    alsoUnder: "",
    ...d,
    note: String(tx?.privacy ?? "").toLowerCase() === "shielded" && kind !== TX_KIND.SHIELD && kind !== TX_KIND.UNSHIELD ? "Shielded" : "",
    status,
    tone,
    amount,
    statusWord: tone === "ok" ? null : txStatusWord(status, { final }),
    failed,
    unsent,
    fee: tx?.feePaid != null && tx.feePaid !== "" ? formatFee(tx.feePaid) : null,
  };
}

/** Whether a row shows under an Activity filter: its own, or one it also counts under. */
export function inFilter(desc, filter) {
  if (!filter || filter === "all") return true;
  return desc.category === filter || desc.alsoUnder === filter;
}

/**
 * A row's name for h(): a deposit to DuskEVM's "To 0x5A3d…8a01", its
 * address in mono, else the name as it is.
 */
export function nameParts(desc) {
  return desc.evm ? ["To ", h("span", { class: "mono", text: shortEvmAddress(desc.address) })] : [desc.name];
}

/** The amount as text, "−25 DUSK", or "•••• DUSK" while balances are hidden. */
export function amountText(amount, hidden) {
  if (!amount) return "";
  if (hidden && !amount.text) return `${HIDDEN_BALANCE} ${amount.unit}`;
  return `${amount.sign}${amount.value} ${amount.unit}`;
}

/** The amount for h(): the number (hidden with Hide balances), then its unit, muted. */
export function amountEl(amount, hidden, className = "tx-amount") {
  if (!amount) return null;
  return h("div", { class: amount.muted ? `${className} is-muted` : className }, [
    amount.text ? `${amount.sign}${amount.value}` : balance(hidden, `${amount.sign}${amount.value}`),
    h("span", { class: "tx-unit", text: ` ${amount.unit}` }),
  ]);
}

/** A direction icon's SVG. */
export function txIconSvg(icon) {
  const name = { out: "arr-out", in: "arr-in", stake: "stake", bridge: "bridge", shield: "shield", call: "call" }[icon] ?? "call";
  return iconSvg(name);
}

/**
 * The line under the name: "Sent · Shielded · 14:32", or for one that failed,
 * "Failed · nothing sent · fee 0.0037 DUSK paid". With Hide balances on
 * (`hidden`), the fee is hidden as amounts are, "fee •••• DUSK paid", and
 * `spoken` says so in words for a screen reader: "fee hidden".
 * @param {object} desc - describeTx's
 * @param {string} when
 * @param {{ hidden?: boolean, spoken?: boolean }} [opts]
 */
export function subText(desc, when, opts) {
  if (desc.unsent) return [desc.statusWord, ...unsentParts(desc, opts)].join(" · ");
  return [desc.generic ? "" : desc.word, desc.note, when].filter(Boolean).join(" · ");
}

function unsentParts(desc, { hidden = false, spoken = false } = {}) {
  const paid = desc.failed && desc.fee && !/^0\.0+$/.test(desc.fee);
  const fee = !paid ? "no fee" : !hidden ? `fee ${desc.fee} DUSK paid` : spoken ? "fee hidden" : `fee ${HIDDEN_BALANCE} DUSK paid`;
  return ["nothing sent", fee];
}

// The line under the name, its status word in the status colour.
function subEl(desc, when, hidden) {
  if (!desc.unsent) return h("div", { class: "row-sub tx-sub", "aria-hidden": "true", text: subText(desc, when) });
  return h("div", { class: "row-sub tx-sub", "aria-hidden": "true" }, [
    h("span", { class: `tx-status--${desc.tone}`, text: desc.statusWord }),
    ` · ${unsentParts(desc, { hidden }).join(" · ")}`,
  ]);
}

/**
 * A copy button for an address: an icon with its name, at least 24 by 24.
 * @param {string} address
 * @param {{ label?: string, showToast?: Function, className?: string }} [opts]
 */
export function copyButton(address, { label = "Copy address", showToast, className = "copy-ico" } = {}) {
  return h("button", {
    class: className,
    type: "button",
    title: label,
    "aria-label": label,
    html: iconSvg("copy"),
    onclick: async (e) => {
      e?.stopPropagation?.();
      const ok = await copyToClipboard(address);
      showToast?.(ok ? "Address copied" : "Couldn't copy the address");
    },
  });
}

/**
 * Saved contacts' names by address, loading the address book the first time.
 * @returns {(address: string) => string}
 */
export function contactNames(state, actions) {
  const byAddress = new Map();
  const ab = state?.addressBook;
  if (ab?.loaded && Array.isArray(ab.items)) {
    for (const entry of ab.items) {
      const addr = String(entry?.address ?? "").trim().toLowerCase();
      const name = String(entry?.name ?? "").trim();
      if (addr && name) byAddress.set(addr, name);
    }
  } else if (state && !ab?.loading) {
    state.addressBook = { ...(ab || {}), loading: true };
    listAddressBook()
      .then((items) => {
        state.addressBook = { ...(state.addressBook || {}), loaded: true, loading: false, error: null, items };
        actions?.render?.()?.catch?.(() => {});
      })
      .catch(() => {
        state.addressBook = { ...(state.addressBook || {}), loading: false };
      });
  }
  return (address) => byAddress.get(String(address ?? "").trim().toLowerCase()) ?? "";
}

function pulseClass(state, hash) {
  const p = state?.txPulse;
  if (!p || !hash || String(p.hash) !== hash || Date.now() - Number(p.at || 0) > 2500) return "";
  return p.kind === "bad" ? "is-pulse-bad" : "is-pulse-ok";
}

/**
 * One Activity row. Opening it shows the transaction's details.
 * @param {object} tx
 * @param {{
 *   state: object, actions: object, hidden: boolean, nodeUrl?: string,
 *   contactName: (address: string) => string,
 *   when: (tx: object) => string,
 * }} ctx
 */
export function txRowEl(tx, { state, actions, hidden, nodeUrl, contactName, when }) {
  const desc = describeTx(tx, { contactName, nodeUrl });
  const hash = String(tx?.hash ?? "");
  const sub = subText(desc, when(tx), { hidden, spoken: true });
  // What the row says, for the button that opens it.
  const spoken = !desc.amount ? "" : hidden && !desc.amount.text ? "amount hidden" : amountText(desc.amount, false);
  const label = [desc.alias ? `${desc.name} · ${desc.alias}` : desc.name, sub, spoken, desc.unsent ? "" : desc.statusWord].filter(Boolean).join(", ");

  const open = () => {
    if (!state || !hash) return;
    state.txDetailHash = hash;
    // Back from the details returns here: Activity, a contact's page, or Home.
    state.txDetailFrom = ["activity", "contacts"].includes(state.route) ? state.route : "home";
    state.route = "tx";
    actions?.render?.()?.catch?.(() => {});
  };

  const cls = [
    "tx-row",
    desc.tone === "pending" ? "is-pending" : "",
    desc.failed ? "is-failed" : "",
    state?.highlightTx && String(state.highlightTx).toLowerCase() === hash ? "is-highlight" : "",
    pulseClass(state, hash),
  ].filter(Boolean);

  return h("li", { class: cls.join(" ") }, [
    h("span", { class: "row-icon tx-icon", "aria-hidden": "true", html: txIconSvg(desc.icon) }),
    h("div", { class: "row-main" }, [
      h("div", { class: "tx-name-line" }, [
        h("button", { class: "tx-open", type: "button", "aria-label": label, onclick: open }, [
          h("span", { class: desc.isAddress ? "tx-name mono" : "tx-name", title: desc.isAddress || desc.evm ? desc.address : undefined }, [
            ...nameParts(desc),
            desc.alias ? h("span", { class: "tx-alias", text: ` · ${desc.alias}` }) : null,
          ]),
        ]),
        desc.isAddress || desc.evm
          ? copyButton(desc.address, {
              label: desc.evm ? "Copy DuskEVM address" : "Copy address",
              showToast: actions?.showToast,
              className: "copy-ico tx-copy",
            })
          : null,
      ].filter(Boolean)),
      // The button's name says these already.
      sub ? subEl(desc, when(tx), hidden) : null,
    ].filter(Boolean)),
    h("div", { class: "tx-right", "aria-hidden": "true" }, [
      amountEl(desc.amount, hidden),
      desc.statusWord && !desc.unsent ? h("div", { class: `tx-status tx-status--${desc.tone}`, text: desc.statusWord }) : null,
    ].filter(Boolean)),
  ]);
}
