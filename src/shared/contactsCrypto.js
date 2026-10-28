// The wallet's contacts at rest: AES-GCM-256 under a key that only the
// unlocked wallet can make, from its seed, and a place of their own per
// wallet. WebCrypto does all of it.
//
// The key: HKDF-SHA-256 over the seed, with CONTACTS_INFO as its info and no
// salt (the seed is uniformly random already). It can't be exported, and it
// goes when the wallet locks (walletEngine.js).
//
// The place: a hash of the wallet's first public account, so another wallet
// in this browser never finds them, let alone opens them.
//
// A record: `{ v: 1, iv, data }`, base64. Each write takes a fresh random
// 12-byte IV, and the place is its additional data: a record moved to
// another wallet's place doesn't open.

import { base64ToBytes, bytesToBase64, bytesToUtf8, utf8ToBytes } from "./crypto.js";

/** HKDF's info for the contacts key; it also labels their place and their records. */
export const CONTACTS_INFO = "dusk-wallet/contacts/v1";

const RECORD_VERSION = 1;
const IV_BYTES = 12;

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const additionalData = (namespace) => utf8ToBytes(`${CONTACTS_INFO}\n${namespace}`);

/**
 * The key that encrypts a wallet's contacts, from its seed.
 * @param {Uint8Array} seed
 * @returns {Promise<CryptoKey>} AES-GCM-256, not extractable
 */
export async function deriveContactsKey(seed) {
  if (!(seed instanceof Uint8Array) || seed.length < 32) throw new Error("A wallet seed is required");
  const material = await crypto.subtle.importKey("raw", seed, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8ToBytes(CONTACTS_INFO) },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * Where a wallet's contacts are kept: SHA-256 over CONTACTS_INFO and its
 * first profile's public account, in hex.
 * @param {string} walletId
 * @returns {Promise<string>}
 */
export async function contactsNamespace(walletId) {
  const id = String(walletId ?? "").trim();
  if (!id) throw new Error("A wallet ID is required");
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8ToBytes(`${CONTACTS_INFO}\n${id}`))));
}

/**
 * Encrypt the contacts' text for their place.
 * @param {CryptoKey} key
 * @param {string} namespace
 * @param {string} text
 * @returns {Promise<{ v: number, iv: string, data: string }>}
 */
export async function sealContacts(key, namespace, text) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: additionalData(namespace) },
    key,
    utf8ToBytes(String(text))
  );
  return { v: RECORD_VERSION, iv: bytesToBase64(iv), data: bytesToBase64(new Uint8Array(data)) };
}

/**
 * Decrypt a record kept at `namespace`. Throws when anything doesn't match:
 * another key, another place, or data changed since it was written.
 * @param {CryptoKey} key
 * @param {string} namespace
 * @param {{ v: number, iv: string, data: string }} record
 * @returns {Promise<string>}
 */
export async function openContacts(key, namespace, record) {
  if (record?.v !== RECORD_VERSION || typeof record.iv !== "string" || typeof record.data !== "string") {
    throw new Error("Unknown contacts format");
  }
  const iv = base64ToBytes(record.iv);
  if (iv.length !== IV_BYTES) throw new Error("Unknown contacts format");
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: additionalData(namespace) },
      key,
      base64ToBytes(record.data)
    );
    return bytesToUtf8(new Uint8Array(plain));
  } catch {
    throw new Error("Your contacts couldn't be read with this wallet's key");
  }
}
