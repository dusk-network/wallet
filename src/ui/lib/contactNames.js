import { nameClash } from "@dusk-network/app-core/names";

import { profileLabelOf } from "../components/ProfileName.js";

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
