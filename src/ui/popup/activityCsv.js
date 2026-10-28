// Activity as a CSV file, as the web wallet's History exports it: the same
// columns, by the same names, and the user's own contact names only when
// asked for, in a column of their own. Amounts are exact, with a minus for
// what left the account; a transaction that failed moved nothing, so its
// amount is 0 and its fee stands on its own. A row whose time or outcome
// isn't looked up yet says so in its status. Pure functions of the rows.

import { formatLuxToDusk, safeBigInt } from "../../shared/amount.js";
import { TX_KIND } from "../../shared/constants.js";
import { SOZU_FN } from "../../shared/sozuAdapter.js";
import { describeTx, subText, txTime } from "./views/txRow.js";

/** The columns of an export. */
export const CSV_COLUMNS = Object.freeze([
  "Date (UTC)",
  "Date (local)",
  "Block",
  "Transaction ID",
  "Direction",
  "Type",
  "What",
  "Counterparty name",
  "Counterparty",
  "Amount (DUSK)",
  "Fee paid (DUSK)",
  "Memo",
  "Status",
]);

/** The column an export adds with the user's own contact names. */
export const CSV_CONTACT_COLUMN = "Your contact name";

const STATUS_WORDS = Object.freeze({
  executed: "Completed",
  failed: "Failed",
  mempool: "Pending",
  removed: "Unknown",
  submitted: "Pending",
  unknown: "Unknown",
});

// A field, quoted when it holds a separator, a quote or a line break.
function csvField(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

// Text someone else chose, as a memo or a name: never read as a formula.
const csvText = (value) => {
  const text = String(value ?? "");
  return csvField(/^[=+\-@\t\r]/.test(text) ? `'${text}` : text);
};

/** "Wed, 28 Oct 2026, 06:51 CET": a time in full, in the browser's language. */
export function fullDateTime(ms) {
  const options = { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" };
  try {
    return new Intl.DateTimeFormat(globalThis.navigator?.language || undefined, options).format(new Date(ms));
  } catch {
    return new Intl.DateTimeFormat(undefined, options).format(new Date(ms));
  }
}

/** Whether a row's time, fee and outcome are still to be looked up. */
export const isRowIncomplete = (tx) =>
  !txTime(tx) || ((tx?.source === "archive" || tx?.source === "both") && typeof tx?.success !== "boolean");

// Which way it went, as the chain's history says, else as the wallet sent it.
function directionOf(tx) {
  if (["in", "out", "self"].includes(tx?.direction)) return tx.direction;
  const kind = String(tx?.kind ?? "").toLowerCase();
  const back = [TX_KIND.UNSHIELD, TX_KIND.UNSTAKE, TX_KIND.WITHDRAW_REWARD].includes(kind) || tx?.fnName === SOZU_FN.UNSTAKE;
  return back ? "in" : "out";
}

// The DUSK it moved: a call's deposit, else its amount.
function movedLux(tx) {
  const deposit = safeBigInt(tx?.deposit, 0n);
  return deposit > 0n ? deposit : safeBigInt(tx?.amount, 0n);
}

// One row as a line. Its words never use the user's contact names: those go
// in their own column, when asked for.
function csvLine(tx, { nodeUrl, contactName }, withContacts) {
  const desc = describeTx(tx, { nodeUrl });
  const time = txTime(tx);
  const direction = directionOf(tx);
  const lux = desc.unsent ? 0n : movedLux(tx);
  const signed = direction === "out" && lux > 0n ? `-${formatLuxToDusk(lux)}` : formatLuxToDusk(lux);
  // A token's amount, which no DUSK column holds, goes with what it did.
  const token = desc.amount && desc.amount.unit !== "DUSK" ? `${desc.amount.value} ${desc.amount.unit}` : "";
  const line = [subText(desc, ""), token].filter(Boolean).join(" · ");
  const what = desc.isAddress ? line : line ? `${desc.name} (${line})` : desc.name;
  const counterparty = (desc.evm ? desc.address : desc.address ?? tx?.to ?? tx?.from ?? tx?.counterparty ?? tx?.contractId) ?? "";
  const status = isRowIncomplete(tx) ? "Not looked up yet" : STATUS_WORDS[String(tx?.status ?? "")] ?? "";
  return [
    csvField(time ? new Date(time).toISOString() : ""),
    csvField(time ? fullDateTime(time) : ""),
    csvField(tx?.blockHeight ?? ""),
    csvField(tx?.hash ?? ""),
    csvField(direction),
    csvField(String(tx?.privacy ?? "").toLowerCase() === "shielded" ? "Shielded" : "Public"),
    csvText(what),
    csvText(tx?.counterpartyName ?? tx?.toName ?? ""),
    csvField(counterparty),
    csvField(signed),
    csvField(tx?.feePaid != null && tx.feePaid !== "" ? formatLuxToDusk(tx.feePaid) : ""),
    csvText(tx?.memo ?? ""),
    csvField(status),
    ...(withContacts ? [csvText((!desc.evm && counterparty && contactName?.(counterparty)) || "")] : []),
  ].join(",");
}

/**
 * The rows as CSV: the columns of CSV_COLUMNS, and the user's contact names
 * in CSV_CONTACT_COLUMN only `withContacts`.
 * @param {object[]} rows - Activity's rows (activity.js activityRows)
 * @param {{ nodeUrl?: string, contactName?: (address: string) => string, withContacts?: boolean }} [opts]
 * @returns {string}
 */
export function activityCsv(rows, { nodeUrl, contactName, withContacts = false } = {}) {
  const columns = withContacts ? [...CSV_COLUMNS, CSV_CONTACT_COLUMN] : CSV_COLUMNS;
  const lines = (rows ?? []).map((tx) => csvLine(tx, { nodeUrl, contactName }, withContacts));
  return [columns.map(csvField).join(","), ...lines].join("\r\n");
}

const slug = (text) =>
  String(text ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * The file's name: the network, the profile and the day, as
 * "dusk-activity-testnet-profile-1-2026-10-28.csv".
 * @param {{ networkName?: string, profileIndex?: number }} what
 * @param {Date} [now]
 */
export function activityCsvFilename({ networkName, profileIndex = 0 } = {}, now = new Date()) {
  const day = [now.getFullYear(), now.getMonth() + 1, now.getDate()].map((n) => String(n).padStart(2, "0")).join("-");
  const profile = `profile-${Math.max(0, Math.floor(Number(profileIndex) || 0)) + 1}`;
  return ["dusk-activity", slug(networkName) || "wallet", profile, day].join("-") + ".csv";
}
