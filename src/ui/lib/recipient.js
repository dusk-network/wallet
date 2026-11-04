import { ProfileGenerator } from "@dusk/w3sper";

/**
 * A recipient as typed, joined up if spaces or line breaks, as a chat app can
 * put in a long address, are all that keep it from being one.
 * @param {string} text
 */
export function joinedAddress(text) {
  const joined = text.replace(/\s+/g, "");
  const type = ProfileGenerator.typeOf(joined);
  return type === "account" || type === "address" ? joined : text;
}

/**
 * Whether a contact's name would pass for a `.dusk` name it isn't saved from,
 * as a name that points elsewhere: its name shows where a `.dusk` name would.
 * @param {string} name
 * @param {string|null} [duskName] - what the contact is saved from
 */
export function passesForDuskName(name, duskName) {
  const typed = name.trim().toLowerCase().replace(/\.$/, "");
  return typed.endsWith(".dusk") && typed !== String(duskName ?? "").toLowerCase();
}
