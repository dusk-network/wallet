// Activity as a CSV file, as the web wallet's History exports it: the same
// columns, by the same names, and the user's own contact names only when
// asked for, in a column of their own. Amounts are exact, with a minus for
// what left the account; a transaction that failed moved nothing, so its
// amount is 0 and its fee stands on its own. A row whose time or outcome
// isn't looked up yet says so in its status. Pure functions of the rows.

import { formatLuxToDusk } from "../../shared/amount.js";
import { dateText } from "../lib/time.js";
import { contractIdText } from "../lib/strings.js";
import { describeTx, subText } from "./views/txRow.js";

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
  pending: "Pending",
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

/** "Wed 28 Oct 2026, 06:51 CET": a time in full, as the wallet writes it everywhere (time.js). */
export const fullDateTime = (ms) => dateText(ms);

// One row as a line. Its words never use the user's contact names: those go
// in their own column, when asked for.
function csvLine(tx, { nodeUrl, contactName }, withContacts) {
  const desc = describeTx(tx, { nodeUrl });
  const lux = desc.unsent ? 0n : tx.value;
  const signed = tx.direction === "out" && lux > 0n ? `-${formatLuxToDusk(lux)}` : formatLuxToDusk(lux);
  // A token's amount, which no DUSK column holds, goes with what it did.
  const token = desc.amount && desc.amount.unit !== "DUSK" ? `${desc.amount.value} ${desc.amount.unit}` : "";
  const line = [subText(desc, ""), token].filter(Boolean).join(" · ");
  const what = desc.isAddress ? line : line ? `${desc.name} (${line})` : desc.name;
  // A contract by its ID as every Dusk app writes one, without 0x; a transfer
  // through a bridge's account, that account.
  const counterparty = contractIdText((desc.via?.address ?? (desc.evm ? desc.address : desc.address ?? tx.counterparty ?? tx.contractId)) ?? "");
  return [
    csvField(tx.time ? new Date(tx.time).toISOString() : ""),
    csvField(tx.time ? fullDateTime(tx.time) : ""),
    csvField(tx.blockHeight ?? ""),
    csvField(tx.hash),
    csvField(tx.direction),
    csvField(tx.privacy === "shielded" ? "Shielded" : "Public"),
    csvText(what),
    csvText(tx.counterpartyName ?? tx.toName ?? ""),
    csvField(counterparty),
    csvField(signed),
    csvField(tx.fee !== null ? formatLuxToDusk(tx.fee) : ""),
    csvText(tx.memo ?? ""),
    csvField(tx.incomplete ? "Not looked up yet" : STATUS_WORDS[tx.status]),
    ...(withContacts ? [csvText(((desc.via || !desc.evm) && counterparty && contactName?.(counterparty)) || "")] : []),
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
