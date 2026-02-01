import { describe, it, expect } from "vitest";
import { encryptMnemonic, decryptMnemonic, serializeEncryptInfo, deserializeEncryptInfo } from "./crypto.js";

const hasWebCrypto = typeof globalThis.crypto?.subtle !== "undefined";

(hasWebCrypto ? describe : describe.skip)("crypto helpers", () => {
  it("round-trips mnemonic with iterations metadata", async () => {
    const mnemonic = "test seed phrase";
    const pwd = "password123";

    const enc = await encryptMnemonic(mnemonic, pwd);
    expect(typeof enc.iterations).toBe("number");
    expect(enc.iterations).toBeGreaterThanOrEqual(900_000);

    const serial = serializeEncryptInfo(enc);
    const deserial = deserializeEncryptInfo(serial);

    const dec = await decryptMnemonic(deserial, pwd);
    expect(dec).toBe(mnemonic);
  });

});
