import { describe, expect, it } from "vitest";

import { base64ToBytes, bytesToBase64, bytesToUtf8, utf8ToBytes } from "./crypto.js";
import { CONTACTS_INFO, contactsNamespace, deriveContactsKey, openContacts, sealContacts } from "./contactsCrypto.js";

const seed = (byte) => new Uint8Array(64).fill(byte);
const ACCOUNT = "qxwSidLBa1rJ74ngfP4GUCaNsAYjMboDPHzbmiVEMmNNK26hVkYe8QccH6ipYdVRsUDnx9QS1KBeu8ZoMDFpXJJE6YCcHy2AykvJ7eEAGc7PGDgCZFV5YJBxzukADkQ2Bgr";
const BOOK = JSON.stringify({ 1: { id: "1", name: "Alice (landlord, private)", address: ACCOUNT } });

describe("the contacts key", () => {
  it("is HKDF-SHA-256 over the seed with info dusk-wallet/contacts/v1, and can't be exported", async () => {
    expect(CONTACTS_INFO).toBe("dusk-wallet/contacts/v1");
    const key = await deriveContactsKey(seed(7));
    expect([key.algorithm, key.extractable, key.usages.sort()]).toEqual([{ name: "AES-GCM", length: 256 }, false, ["decrypt", "encrypt"]]);
    await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow();

    // The same key made by hand opens what it seals.
    const material = await crypto.subtle.importKey("raw", seed(7), "HKDF", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8ToBytes("dusk-wallet/contacts/v1") },
      material,
      256
    );
    const byHand = await crypto.subtle.importKey("raw", bits, "AES-GCM", false, ["decrypt"]);
    const namespace = await contactsNamespace(ACCOUNT);
    const record = await sealContacts(key, namespace, BOOK);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(record.iv), additionalData: utf8ToBytes(`dusk-wallet/contacts/v1\n${namespace}`) },
      byHand,
      base64ToBytes(record.data)
    );
    expect(bytesToUtf8(new Uint8Array(plain))).toBe(BOOK);
  });

  it("needs a seed", async () => {
    await expect(deriveContactsKey(new Uint8Array(0))).rejects.toThrow("A wallet seed is required");
    await expect(deriveContactsKey("seed")).rejects.toThrow("A wallet seed is required");
  });
});

describe("a wallet's contacts' place", () => {
  it("is a hash of its first public account: the same for the same wallet, another for another, and not the account", async () => {
    const place = await contactsNamespace(ACCOUNT);
    expect(place).toMatch(/^[0-9a-f]{64}$/);
    expect(await contactsNamespace(` ${ACCOUNT} `)).toBe(place);
    expect(await contactsNamespace(`${ACCOUNT.slice(0, -1)}x`)).not.toBe(place);
    expect(place).not.toContain(ACCOUNT.slice(0, 8).toLowerCase());
    await expect(contactsNamespace("")).rejects.toThrow("A wallet ID is required");
  });
});

describe("a contacts record", () => {
  it("opens with its own key at its own place, and holds no plaintext", async () => {
    const key = await deriveContactsKey(seed(1));
    const place = await contactsNamespace(ACCOUNT);
    const record = await sealContacts(key, place, BOOK);
    expect(Object.keys(record).sort()).toEqual(["data", "iv", "v"]);
    expect(base64ToBytes(record.iv)).toHaveLength(12);
    const stored = JSON.stringify(record);
    for (const secret of ["landlord", "Alice", ACCOUNT.slice(0, 12)]) expect(stored).not.toContain(secret);
    expect(await openContacts(key, place, record)).toBe(BOOK);
  });

  it("takes a fresh IV every time it's written", async () => {
    const key = await deriveContactsKey(seed(1));
    const place = await contactsNamespace(ACCOUNT);
    const [a, b] = [await sealContacts(key, place, BOOK), await sealContacts(key, place, BOOK)];
    expect(a.iv).not.toBe(b.iv);
    expect(a.data).not.toBe(b.data);
  });

  it("fails closed: another key, another place, changed data or another format don't open", async () => {
    const key = await deriveContactsKey(seed(1));
    const place = await contactsNamespace(ACCOUNT);
    const record = await sealContacts(key, place, BOOK);
    const other = await deriveContactsKey(seed(2));
    await expect(openContacts(other, place, record)).rejects.toThrow("couldn't be read with this wallet's key");
    await expect(openContacts(key, await contactsNamespace("another account"), record)).rejects.toThrow("couldn't be read");
    const bytes = base64ToBytes(record.data);
    bytes[0] ^= 1;
    await expect(openContacts(key, place, { ...record, data: bytesToBase64(bytes) })).rejects.toThrow("couldn't be read");
    await expect(openContacts(key, place, { ...record, v: 2 })).rejects.toThrow("Unknown contacts format");
    await expect(openContacts(key, place, { ...record, iv: bytesToBase64(new Uint8Array(8)) })).rejects.toThrow("Unknown contacts format");
    await expect(openContacts(key, place, null)).rejects.toThrow("Unknown contacts format");
  });
});
