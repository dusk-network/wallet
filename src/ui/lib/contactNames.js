import { nameClash, nameStarts } from "@dusk-network/app-core/names";

import { safeText } from "../../shared/safeText.js";
import { profileLabelOf } from "../components/ProfileName.js";

/**
 * A contact's name as the wallet shows it: what can't be seen in it shows as
 * its codes, as a memo's does (safeText.js), so a right-to-left override can't
 * make "\u202eecilA" read as "Alice". Such names are refused now; this is for
 * one saved before.
 * @param {unknown} name
 */
export const contactNameText = (name) => safeText(String(name ?? "").trim()).text;

/** What a contact saved with hidden characters in its name says of itself, in a list and on its page. */
export const HIDDEN_NAME_ROW = "Its name has hidden characters";
export const HIDDEN_NAME_NOTE = "This name has hidden characters, shown here as codes. Edit the contact to type it again, or delete it.";

/**
 * This wallet's profiles, by their names on this device, with their account
 * and address: a contact can't take one's name for another address.
 * @param {object} ov - the overview
 */
export function profilesOf(ov) {
  const accounts = Array.isArray(ov?.accounts) ? ov.accounts : [];
  return accounts.map((account, i) => ({ account: String(account ?? ""), address: String(ov?.addresses?.[i] ?? ""), name: profileLabelOf(ov, i) }));
}

/**
 * Whose name a contact's takes, or looks like, by Unicode's confusables
 * (app-core's nameClash): a profile of this wallet's first, then another
 * contact. A profile whose own address it is takes nothing from it.
 * @param {object} ov
 * @param {unknown} name
 * @param {{ contacts?: any[], except?: unknown, address?: string }} [among]
 */
export function contactNameClash(ov, name, { address = "", contacts = [], except } = {}) {
  const clash = nameClash(name, { contacts, except, profiles: profilesOf(ov) });
  if (clash?.kind === "profile" && address && (clash.entry.account === address || clash.entry.address === address)) return null;
  return clash;
}

/**
 * The question for a contact's name that a profile's name starts, or that
 * starts it, word for word, by the look-alike rules (app-core's nameStarts):
 * "Lucas (petit-fils)" beside a profile "Lucas" reads as it on Send. It can be
 * saved. "" for none, and for the profile whose own address it is.
 * @param {object} ov
 * @param {unknown} name
 * @param {{ address?: string }} [contact]
 */
export function contactNameStartsText(ov, name, { address = "" } = {}) {
  const starts = nameStarts(name, { profiles: profilesOf(ov) });
  if (!starts || (address && (starts.entry.account === address || starts.entry.address === address))) return "";
  return `One of your profiles is called ${starts.name}. Is this someone else?`;
}

/**
 * What a list says of a contact whose name looks like another's: "" for none.
 * @param {ReturnType<typeof contactNameClash>} clash
 */
export const lookAlikeText = (clash) => (!clash ? "" : clash.kind === "profile" ? "Looks like your profile's name" : "Looks like another contact");

/**
 * What a contact in a list or a picker says of itself: "" for one whose name
 * looks like no one else's.
 * @param {object} ov
 * @param {{ id?: unknown, name?: unknown, address?: unknown }} contact
 * @param {any[]} contacts - all of them
 */
export const contactAlikeText = (ov, contact, contacts) =>
  lookAlikeText(contactNameClash(ov, contact?.name, { address: String(contact?.address ?? ""), contacts: contacts.filter((each) => each !== contact), except: contact?.id }));

/**
 * What each contact whose name looks like another's says of itself, by its
 * address: "" for an address no such contact has. For every place a contact's
 * name shows: Send, Review and Activity.
 * @param {object} ov
 * @param {any[]} contacts - all of them
 * @returns {(address: unknown) => string}
 */
export function contactAlikeOf(ov, contacts) {
  const list = Array.isArray(contacts) ? contacts : [];
  const said = new Map();
  return (address) => {
    const key = String(address ?? "").trim().toLowerCase();
    if (!key) return "";
    if (!said.has(key)) {
      const contact = list.find((each) => String(each?.address ?? "").trim().toLowerCase() === key);
      said.set(key, contact ? contactAlikeText(ov, contact, list) : "");
    }
    return said.get(key);
  };
}
