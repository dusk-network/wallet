// Activity's Export: the rows listed as a CSV file (activityCsv.js), with
// the user's contact names only when they ask for them.
//
// A page that stays open saves the file itself: the full view, and a tab
// like it. The popup closes when a save dialog takes the focus, and the file
// with it, so it hands the file to a new full view tab, through the
// extension's session storage, and that tab saves it as it opens.

import { runtimeGetURL, storageSessionGet, storageSessionRemove, storageSessionSet, tabsCreate } from "../../platform/extensionApi.js";
import { h } from "../lib/dom.js";
import { activityCsv, activityCsvFilename, isRowIncomplete } from "./activityCsv.js";

/** Where the popup leaves a file for the full view to save: `{ id, filename, csv, at }`. */
export const HANDED_EXPORT_KEY = "dusk_activity_export_v1";

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

// The popup's file, for the full view tab it opens to save it.
async function handOver(csv, filename) {
  const id = globalThis.crypto.randomUUID();
  await storageSessionSet({ [HANDED_EXPORT_KEY]: { id, filename, csv, at: Date.now() } });
  try {
    await tabsCreate({ url: runtimeGetURL(`full.html?route=activity&save=${encodeURIComponent(id)}`) });
  } catch (error) {
    await storageSessionRemove(HANDED_EXPORT_KEY).catch(() => {});
    throw error;
  }
}

/**
 * In a full view tab the popup opened to save its export: save the file,
 * once, and take the request off the address, so a reload asks nothing.
 * @returns {Promise<string|null>} the file's name, or null when the tab wasn't opened for one
 * @throws when the file isn't there any more
 */
export async function saveHandedExport() {
  const params = new URLSearchParams(location.search);
  const id = params.get("save");
  if (!id) return null;
  params.delete("save");
  const query = params.toString();
  history.replaceState(history.state, "", `${location.pathname}${query ? `?${query}` : ""}`);
  const handed = (await storageSessionGet(HANDED_EXPORT_KEY))?.[HANDED_EXPORT_KEY];
  await storageSessionRemove(HANDED_EXPORT_KEY);
  if (!handed || handed.id !== id || typeof handed.csv !== "string") throw new Error("The export isn't here any more. Export it again.");
  saveTextFile(handed.csv, String(handed.filename || "dusk-activity.csv"));
  return handed.filename;
}

/**
 * The Export panel, under Activity's head: whether to add the user's
 * contact names, what the file holds, and Save CSV.
 * @param {object} ov - the overview
 * @param {object[]} rows - the rows listed
 * @param {{ state: object, actions: object, nodeUrl: string, contactName: (address: string) => string }} ctx
 * @returns {HTMLElement}
 */
export function activityExportPanel(ov, rows, { state, actions, nodeUrl, contactName }) {
  const ex = state.activityExport;
  const contacts = h("input", {
    type: "checkbox",
    id: "activity-export-contacts",
    checked: Boolean(ex.withContacts),
    onchange: (e) => {
      ex.withContacts = Boolean(e?.target?.checked);
    },
  });
  const incomplete = rows.filter(isRowIncomplete).length;
  const save = h("button", {
    class: "btn-primary btn-full",
    type: "button",
    text: "Save CSV",
    disabled: !rows.length,
    onclick: async () => {
      const filename = activityCsvFilename({ networkName: ov?.networkName, profileIndex: ov?.selectedAccountIndex });
      const csv = activityCsv(rows, { nodeUrl, contactName, withContacts: Boolean(ex.withContacts) });
      try {
        if (inPopup()) {
          await handOver(csv, filename);
          globalThis.close?.();
          return;
        }
        saveTextFile(csv, filename);
        ex.open = false;
        actions?.showToast?.("CSV saved");
        actions?.render?.()?.catch?.(() => {});
      } catch (e) {
        actions?.showToast?.(e?.message ?? "Couldn't export. Try again.", 2500);
      }
    },
  });
  return h("section", { class: "group activity-export", id: "activity-export", "aria-label": "Export CSV" }, [
    h("label", { class: "checkline activity-export-contacts", for: "activity-export-contacts" }, [
      contacts,
      h("span", { text: "Include my contact names in the export, in their own column" }),
    ]),
    h("p", {
      class: "activity-export-note",
      text: "An export holds the rows listed, with memos and .dusk names, and dates in UTC and local time.",
    }),
    incomplete
      ? h("p", {
          class: "activity-export-note",
          text:
            incomplete === 1
              ? 'A row has no date or fee yet. The export marks it "Not looked up yet".'
              : `${incomplete} rows have no date or fee yet. The export marks them "Not looked up yet".`,
        })
      : null,
    inPopup() ? h("p", { class: "activity-export-note", text: "The file is saved from a new tab." }) : null,
    save,
  ].filter(Boolean));
}
