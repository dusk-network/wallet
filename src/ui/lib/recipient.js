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
