// Activity's Export: one profile's activity as the file an accountant or a tax
// tool reads (@dusk-network/app-core/export), for a quarter or any dates, read
// whole first: Koinly's universal CSV, the format others follow.
//
// A page that stays open makes and saves the file itself: the full view. The
// popup closes when a save dialog takes the focus, or as soon as it loses it, and
// the file with it, so it hands what was asked to a new full view tab, through the
// extension's session storage, and that tab does it as it opens. Each export has
// a key of its own there, so two at once don't meet.

import { accountingCsv, datesPeriod, quarterPeriod } from "@dusk-network/app-core/export";

import { listAddressBook } from "../../shared/addressBook.js";
import { walletLabel } from "../../shared/wallets.js";
import { runtimeGetURL, storageSessionGet, storageSessionRemove, storageSessionSet, tabsCreate } from "../../platform/extensionApi.js";
import { fieldLabel } from "../components/FormControls.js";
import { profileLabelOf } from "../components/ProfileName.js";
import { duskNamesNetwork, lookupPrimaryName } from "../../shared/duskNames.js";
import { h } from "../lib/dom.js";
import { saveToDownloads } from "../../platform/native.js";
import { stamped } from "../lib/fileNames.js";
import { ActivityChangedError, activityRows, assertActivityOpen, selected, sozuFactsOf, wholeActivity } from "./activity.js";
import { duskPrices } from "./duskPrice.js";
import { migrationFactsOf } from "./migrationFacts.js";
import { defaultCurrency } from "@dusk-network/app-core/amounts";

/**
 * A currency by its name, as a value is said in it: "euros", "US dollars",
 * "Singapore dollars"; "euro" and the like with `count` 1.
 * @param {string} code
 * @param {number} [count]
 */
export function currencyName(code, count = 2) {
  try {
    const parts = new Intl.NumberFormat("en", { style: "currency", currency: code, currencyDisplay: "name", minimumFractionDigits: 0, maximumFractionDigits: 0 }).formatToParts(count);
    return parts.find((part) => part.type === "currency")?.value ?? code;
  } catch {
    return code;
  }
}

// The profile's name as the header shows it: its verified .dusk name, else its
// label on this device, else "Profile N".
async function profileNameOf(ov, profileIndex) {
  const account = String(ov?.accounts?.[profileIndex] ?? "");
  const name = account && duskNamesNetwork(ov?.nodeUrl) ? await lookupPrimaryName(account, { nodeUrl: ov?.nodeUrl, stale: true }).catch(() => null) : null;
  return name || profileLabelOf(ov, profileIndex);
}

/** Where the popup leaves what one export asks for the full view to do: `{ id, choices, at }`. */
export const handedExportKey = (id) => `dusk_activity_export_v1:${id}`;

const EXPORT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The popup, as env.js tells it, asked when it matters.
const inPopup = () =>
  Boolean(globalThis.document?.body?.classList?.contains("page--popup")) &&
  String(globalThis.location?.pathname ?? "").endsWith("popup.html");

/**
 * Save text as a file, as a download.
 * @param {string} text
 * @param {string} filename
 */
export function saveTextFile(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const link = h("a", { href: url, download: filename, hidden: true });
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// What the popup asks, for the full view tab it opens to do it.
async function handOver(choices) {
  const id = globalThis.crypto.randomUUID();
  const key = handedExportKey(id);
  await storageSessionSet({ [key]: { id, choices, at: Date.now() } });
  try {
    await tabsCreate({ url: runtimeGetURL(`full.html?route=activity&save=${encodeURIComponent(id)}`) });
  } catch (error) {
    await storageSessionRemove(key).catch(() => {});
    throw error;
  }
}

// The user's contact names for an export, read in full first: a list still
// loading would leave them out. Throws when they can't be read. The contact names
// of the wallet the rows are (`walletId`), and of no other.
async function exportContactNames(state, walletId) {
  const ab = state?.addressBook;
  const own = ab?.loaded && Array.isArray(ab.items) && (!state?.contactsWallet || state.contactsWallet === walletId);
  const items = own ? ab.items : await listAddressBook({ walletId });
  const byAddress = new Map();
  for (const entry of items ?? []) {
    const address = String(entry?.address ?? "").trim().toLowerCase();
    const name = String(entry?.name ?? "").trim();
    if (address && name) byAddress.set(address, name);
  }
  return (address) => byAddress.get(String(address ?? "").trim().toLowerCase()) ?? "";
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * The EVM addresses this profile bridged DUSK to, as its own rows say them:
 * the address a transfer to BNB Smart Chain or Ethereum pays (its memo, as
 * text), and the one a deposit to DuskEVM pays, of any that didn't fail. The
 * extension connects no EVM wallet: these are the ones it knows as the
 * person's, as the web wallet knows those it connected or migrated from.
 * @param {object[]} rows - the profile's activity rows
 * @returns {string[]}
 */
function bridgedToOf(rows) {
  const out = new Set();
  for (const row of rows ?? []) {
    if (row?.dropped || row?.status === "failed") continue;
    const to =
      row?.route?.kind === "service" && row.direction === "out" && row.entry?.memoBinary !== true
        ? String(row.memo ?? "").trim()
        : row?.bridge?.step === "deposit"
          ? String(row.bridge.to ?? "")
          : "";
    if (EVM_ADDRESS.test(to)) out.add(to.toLowerCase());
  }
  return [...out];
}

// The person's other profiles, this wallet's and any other wallet's here: what
// moves between them is a transfer, not income.
function otherProfiles(ov, profileIndex) {
  const own = (ov?.accounts ?? []).flatMap((account, i) =>
    i === profileIndex ? [] : [{ name: profileLabelOf(ov, i), account, address: ov?.addresses?.[i] }]
  );
  const others = (Array.isArray(ov?.wallets) ? ov.wallets : []).flatMap((wallet) =>
    wallet?.active || !Array.isArray(wallet?.accounts)
      ? []
      : wallet.accounts.map((account, i) => ({
          name: `${walletLabel(wallet)} · ${String(wallet.accountNames?.[String(i)] ?? "").trim() || `Profile ${i + 1}`}`,
          account,
        }))
  );
  return [...own, ...others];
}

// A quarter asked for, "2026-4", all of it (no period), or the days typed.
function periodOf({ period, from, to } = {}) {
  if (!period || period === "all") return undefined;
  if (period === "dates") {
    if (!from || !to) throw new RangeError("Choose both days.");
    return datesPeriod(from, to);
  }
  const [year, quarter] = String(period).split("-").map(Number);
  return quarterPeriod(year, quarter);
}

/**
 * The file asked for, from the account's whole history. Throws what to say when
 * it can't be read: nothing half read goes out as if it were all of it.
 * @param {object} ov - the overview
 * @param {{ period?: string, from?: string, to?: string, withContacts?: boolean, fiat?: boolean, excel?: boolean }} choices
 * @param {{ state: object }} ctx
 * @returns {Promise<import("@dusk-network/app-core/export").ExportResult & { shieldedWaiting: boolean }>}
 */
export async function makeExport(ov, choices, { state }) {
  const period = periodOf(choices);
  // The region's own currency where CoinGecko has DUSK's price in it, US dollars elsewhere.
  const currency = defaultCurrency();
  if (!ov?.isUnlocked) throw new Error("Unlock the wallet, then export again.");
  let contactName;
  if (choices.withContacts) {
    try {
      contactName = await exportContactNames(state, String(ov?.accounts?.[0] ?? ""));
    } catch {
      throw new Error("Couldn't read your contacts, so nothing was saved. Try again.");
    }
  }
  const whole = await wholeActivity(ov, { state }).catch(async (error) => {
    // One that stopped because the wallet changed says that, not that the node failed.
    await assertActivityOpen(ov, { state });
    throw error instanceof ActivityChangedError ? error : new Error("Couldn't read your whole history from this node, so nothing was saved. Try again.");
  });
  const rows = activityRows(ov, state, whole);
  const { account, profileIndex } = selected(ov);
  // A stake whose stDUSK can't be read yet says so in its line.
  const facts = await sozuFactsOf(ov, rows);
  // What each migration whose payout is here paid on its own chain, its
  // approval too, to the wei, as the payout's details say: each on a line of
  // its own, in the period of its own time. A payout after the period can have
  // fees in it, one before it can't. Booked only where it came from an EVM
  // address this profile bridged to: anyone can migrate to an account, and
  // another's gas is no cost of the person's.
  const bridgedTo = bridgedToOf(rows);
  const evm = bridgedTo.length ? await migrationFactsOf(ov, period ? rows.filter((row) => row.time >= period.from) : rows) : new Map();
  const made = await accountingCsv({
    rows,
    profile: { name: await profileNameOf(ov, profileIndex), account, address: ov?.addresses?.[profileIndex] },
    profiles: otherProfiles(ov, profileIndex),
    period,
    price: choices.fiat ? duskPrices({ currency }) : undefined,
    currency,
    facts,
    evm,
    evmAddresses: bridgedTo,
    contactName,
    network: ov?.networkName,
    bom: Boolean(choices.excel),
  });
  // The file is of what was open as it began: with anything else open now, there's none.
  await assertActivityOpen(ov, { state });
  // A migration whose side there couldn't be read has no fee there in the file, and the toast says so:
  // read, it may be from one of those addresses.
  const evmUnread = [...evm.values()].filter((fact) => fact.state === "pending" || fact.state === "error");
  const evmChains = [...new Set(evmUnread.map((fact) => rows.find((row) => row.route?.id === fact.route)?.route.chain?.name ?? "its chain"))];
  return { ...made, currency, evmUnread: { count: evmUnread.length, chain: evmChains.length === 1 ? evmChains[0] : "their chains" }, shieldedWaiting: whole.shieldedWaiting };
}

// What the file holds, and what it doesn't, once it's saved; where, when the
// phone's Downloads has it, by the name Android gave it there.
function savedText({ count, currency, evmUnread, left, unpriced, shieldedWaiting }, { savedAs = "" } = {}) {
  const out = [left.pending ? `${left.pending} on its way` : "", left.notRead ? `${left.notRead} not read yet` : ""].filter(Boolean);
  const lines = count === 1 ? "1 line" : `${count} lines`;
  return [
    savedAs ? `CSV saved to Downloads as ${savedAs}: ${lines}.` : `CSV saved: ${lines}.`,
    out.length ? `Left out: ${out.join(", ")}.` : "",
    unpriced ? `${unpriced === 1 ? "1 line has" : `${unpriced} lines have`} no ${currencyName(currency, 1)} value.` : "",
    evmUnread?.count ? `${evmUnread.count === 1 ? "1 migration's fee" : `${evmUnread.count} migrations' fees`} on ${evmUnread.chain} couldn't be read: export again to add ${evmUnread.count === 1 ? "it" : "them"}.` : "",
    shieldedWaiting ? "Your shielded activity is still syncing: export again once it's done." : "",
  ]
    .filter(Boolean)
    .join(" ");
}

// Makes the file and saves it, or says what stopped it: what was asked stays.
async function exportNow(ov, choices, { state, showToast }) {
  const made = await makeExport(ov, choices, { state });
  if (!made.count) return "There's nothing in that period, so nothing was saved.";
  // The app saves it in the phone's Downloads; a page, as a download. Named
  // with when it was made, so one export never takes another's name.
  const fileName = stamped(made.fileName);
  const savedAs = await saveToDownloads(fileName, "text/csv", made.csv);
  if (!savedAs) saveTextFile(made.csv, fileName);
  showToast?.(savedText(made, { savedAs }), 6000);
  return "";
}

/**
 * In a full view tab the popup opened to export: makes the file and saves it,
 * once, its panel saying so meanwhile and what stopped it after, and takes the
 * request off the address, so a reload asks nothing.
 * @param {{ state: object, render?: () => Promise<void>, showToast?: Function }} ctx
 * @returns {Promise<boolean>} whether the tab was opened for one
 * @throws when what it was opened for isn't there any more
 */
export async function saveHandedExport({ state, render, showToast }) {
  const params = new URLSearchParams(location.search);
  const id = params.get("save");
  if (!id) return false;
  params.delete("save");
  const query = params.toString();
  history.replaceState(history.state, "", `${location.pathname}${query ? `?${query}` : ""}`);
  const gone = new Error("The export isn't here any more. Export it again.");
  if (!EXPORT_ID.test(id)) throw gone;
  // This export's alone: another one handed over meanwhile stays.
  const key = handedExportKey(id);
  const handed = (await storageSessionGet(key))?.[key];
  await storageSessionRemove(key);
  if (!handed || handed.id !== id || !handed.choices) throw gone;
  const ex = (state.activityExport = { ...handed.choices, open: true, busy: true, error: "" });
  render?.()?.catch?.(() => {});
  const stopped = await exportNow(state.overview, handed.choices, { state, showToast }).catch((e) => e?.message ?? "Couldn't export. Try again.");
  Object.assign(ex, { busy: false, error: stopped, open: Boolean(stopped) });
  render?.()?.catch?.(() => {});
  return true;
}

// The current quarter and the seven before it, newest first.
function quarterChoices(now = new Date()) {
  let year = now.getFullYear();
  let quarter = Math.floor(now.getMonth() / 3) + 1;
  const out = [];
  for (let i = 0; i < 8; i += 1) {
    out.push({ value: `${year}-${quarter}`, text: `Q${quarter} ${year}` });
    quarter -= 1;
    if (!quarter) {
      quarter = 4;
      year -= 1;
    }
  }
  return out;
}

const checkbox = (id, text, on, onChange) =>
  h("label", { class: "checkline activity-export-check", for: id }, [
    h("input", { type: "checkbox", id, checked: Boolean(on), onchange: (e) => onChange(Boolean(e?.target?.checked)) }),
    h("span", { text }),
  ]);

/**
 * The Export panel, under Activity's head: which period, what to add, and Save CSV.
 * @param {object} ov - the overview
 * @param {{ state: object, actions: object }} ctx
 * @returns {HTMLElement}
 */
export function activityExportPanel(ov, { state, actions }) {
  const ex = state.activityExport;
  const period = ex.period ?? "all";
  const periodSelect = h(
    "select",
    {
      id: "activity-export-period",
      onchange: (e) => {
        ex.period = String(e?.target?.value ?? "all");
        ex.error = "";
        actions?.render?.()?.catch?.(() => {});
      },
    },
    [{ value: "all", text: "All activity" }, ...quarterChoices(), { value: "dates", text: "Choose dates" }].map(({ value, text }) => h("option", { value, text }))
  );
  periodSelect.value = period;
  const dateField = (id, label, key) => {
    const input = h("input", {
      type: "date",
      id,
      value: ex[key] ?? "",
      oninput: (e) => {
        ex[key] = String(e?.target?.value ?? "");
      },
    });
    return h("div", { class: "activity-export-date" }, [fieldLabel(input, label), input]);
  };
  const error = h("div", { class: "field-error", role: "alert", hidden: !ex.error, text: ex.error ?? "" });
  const choicesOf = () => ({ period: ex.period ?? "all", from: ex.from, to: ex.to, withContacts: Boolean(ex.withContacts), fiat: Boolean(ex.fiat), excel: Boolean(ex.excel) });
  const save = h("button", {
    class: "btn-primary btn-full",
    type: "button",
    text: ex.busy ? "Reading your history…" : "Save CSV",
    disabled: Boolean(ex.busy),
    onclick: async () => {
      if (ex.busy) return;
      const choices = choicesOf();
      const said = (text) => {
        ex.error = text;
        actions?.render?.()?.catch?.(() => {});
      };
      try {
        periodOf(choices);
      } catch (e) {
        said(e?.message ?? String(e));
        return;
      }
      ex.error = "";
      if (inPopup()) {
        try {
          await handOver(choices);
          globalThis.close?.();
        } catch (e) {
          said(e?.message ?? "Couldn't export. Try again.");
        }
        return;
      }
      ex.busy = true;
      actions?.render?.()?.catch?.(() => {});
      try {
        const stopped = await exportNow(ov, choices, { state, showToast: actions?.showToast });
        ex.busy = false;
        if (stopped) said(stopped);
        else {
          ex.open = false;
          actions?.render?.()?.catch?.(() => {});
        }
      } catch (e) {
        ex.busy = false;
        said(e?.message ?? "Couldn't export. Try again.");
      }
    },
  });
  return h("section", { class: "group activity-export", id: "activity-export", "aria-label": "Export CSV" }, [
    h("div", { class: "activity-export-field" }, [fieldLabel(periodSelect, "Period"), h("div", { class: "select-wrap" }, [periodSelect])]),
    period === "dates" ? h("div", { class: "activity-export-dates" }, [dateField("activity-export-from", "From", "from"), dateField("activity-export-to", "To", "to")]) : null,
    checkbox("activity-export-contacts", "Add my contact names", ex.withContacts, (on) => {
      ex.withContacts = on;
    }),
    checkbox("activity-export-value", `Add each payment's value in ${currencyName(defaultCurrency())}, from CoinGecko's prices`, ex.fiat, (on) => {
      ex.fiat = on;
    }),
    checkbox("activity-export-excel", "For Excel: keep accents as it opens", ex.excel, (on) => {
      ex.excel = on;
    }),
    h("p", {
      class: "activity-export-note",
      text: "One profile's file for tax tools such as Koinly: exact amounts, times in UTC, transfers between your profiles marked.",
    }),
    inPopup() ? h("p", { class: "activity-export-note", text: "The file is saved from a new tab." }) : null,
    error,
    save,
  ].filter(Boolean));
}
