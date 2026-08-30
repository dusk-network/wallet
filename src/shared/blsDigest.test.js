import { describe, expect, it } from "vitest";
import { mnemonicToSeedSync } from "bip39";
import { bls12_381 } from "@noble/curves/bls12-381";

import { hexToBytes } from "./bytes.js";
import {
  TYPED_DATA_SIG_TAG,
  buildTypedDataSignedMessage,
  deriveBlsSecretKeyFromSeed,
  signBlsMessageBytes,
  signProfileBlsDigest,
  signProfileTypedDataDigest,
  verifyBlsDigestSignature,
  verifyTypedDataDigestSignature,
} from "./blsDigest.js";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

/** rusk `test_derive_bls_sk`: seed `[0;64]`, index `42`. */
const RUSK_DERIVE_BLS_SK_GOLDEN = Uint8Array.from([
  95, 35, 167, 191, 106, 171, 71, 158, 159, 39, 84, 1, 132, 238, 152, 235, 154, 5, 250, 158, 255,
  195, 79, 95, 193, 58, 36, 189, 0, 99, 230, 86,
]);

function skScalarToBytes(skScalar) {
  return bls12_381.fields.Fr.toBytes(skScalar);
}

function derivedFundsPkBytes(seed, profileIndex) {
  const skScalar = deriveBlsSecretKeyFromSeed(seed, profileIndex);
  return bls12_381.G2.ProjectivePoint.BASE.multiply(skScalar).toRawBytes(true);
}

function mockProfile(seed, profileIndex, accountBytes) {
  const account = {
    valueOf() {
      return accountBytes.slice();
    },
    toString() {
      return "mock-account";
    },
  };

  return {
    seed,
    account,
    [Symbol.toPrimitive](hint) {
      if (hint === "number") return profileIndex;
      return null;
    },
  };
}

describe("blsDigest", () => {
  it("deriveBlsSecretKeyFromSeed matches wallet-core rusk golden vector", () => {
    const seed = new Uint8Array(64);
    const skScalar = deriveBlsSecretKeyFromSeed(seed, 42);
    expect(skScalarToBytes(skScalar)).toEqual(RUSK_DERIVE_BLS_SK_GOLDEN);
  });

  it("signProfileBlsDigest verifies and derived G2 pk matches profile account", async () => {
    const seed = mnemonicToSeedSync(MNEMONIC);
    const profileIndex = 0;
    const accountBytes = derivedFundsPkBytes(seed, profileIndex);
    const profile = mockProfile(seed, profileIndex, accountBytes);

    const digest = new Uint8Array(32);
    digest[0] = 0xde;
    digest[31] = 0xad;

    const signed = await signProfileBlsDigest(profile, digest);
    const signatureBytes = hexToBytes(signed.signatureHex);
    const fundsPkFromProfile = profile.account.valueOf();

    expect(signatureBytes).toHaveLength(48);
    expect(verifyBlsDigestSignature(fundsPkFromProfile, digest, signatureBytes)).toBe(true);
    expect(derivedFundsPkBytes(seed, profileIndex)).toEqual(fundsPkFromProfile);
    expect(hexToBytes(signed.fundsPkHex)).toEqual(fundsPkFromProfile);
  });

  it("signs a 32-byte digest and verifies with derived funds pk", () => {
    const seed = mnemonicToSeedSync(MNEMONIC);
    const profileIndex = 0;
    const skScalar = deriveBlsSecretKeyFromSeed(seed, profileIndex);
    const fundsPkBytes = derivedFundsPkBytes(seed, profileIndex);

    const digest = new Uint8Array(32);
    digest[0] = 0xde;
    digest[31] = 0xad;

    const signature = signBlsMessageBytes(digest, skScalar);
    expect(signature).toHaveLength(48);
    expect(verifyBlsDigestSignature(fundsPkBytes, digest, signature)).toBe(true);
  });

  it("rejects verification when digest bytes differ", () => {
    const seed = mnemonicToSeedSync(MNEMONIC);
    const skScalar = deriveBlsSecretKeyFromSeed(seed, 1);
    const fundsPkBytes = derivedFundsPkBytes(seed, 1);

    const digest = new Uint8Array(32).fill(0x11);
    const other = new Uint8Array(32).fill(0x22);
    const signature = signBlsMessageBytes(digest, skScalar);

    expect(verifyBlsDigestSignature(fundsPkBytes, other, signature)).toBe(false);
  });
});

describe("typed-data signed message (spec §12.1)", () => {
  /**
   * `SIG_TAG = utf8("DUSK_TYPED_DATA_SIG_V1\0")`, pinned byte-for-byte so the
   * tag cannot silently drift. Independent of the source's own TextEncoder call.
   */
  const EXPECTED_SIG_TAG_BYTES = Uint8Array.from([
    68, 85, 83, 75, 95, 84, 89, 80, 69, 68, 95, 68, 65, 84, 65, 95, 83, 73, 71, 95, 86, 49, 0,
  ]);

  it("pins the exact tag string and byte length", () => {
    expect(TYPED_DATA_SIG_TAG).toBe("DUSK_TYPED_DATA_SIG_V1\0");
    expect(TYPED_DATA_SIG_TAG).toHaveLength(23);
    expect(new TextEncoder().encode(TYPED_DATA_SIG_TAG)).toEqual(EXPECTED_SIG_TAG_BYTES);
  });

  it("builds a 55-byte signed message as SIG_TAG || digest", () => {
    const digest = new Uint8Array(32);
    digest[0] = 0xaa;
    digest[31] = 0xbb;

    const signedMessage = buildTypedDataSignedMessage(digest);
    expect(signedMessage).toHaveLength(55);
    expect(signedMessage.slice(0, 23)).toEqual(EXPECTED_SIG_TAG_BYTES);
    expect(signedMessage.slice(23)).toEqual(digest);
  });

  it("throws on a non-32-byte digest", () => {
    expect(() => buildTypedDataSignedMessage(new Uint8Array(31))).toThrow();
    expect(() => buildTypedDataSignedMessage(new Uint8Array(33))).toThrow();
    expect(() => buildTypedDataSignedMessage(new Uint8Array(0))).toThrow();
  });

  it("signProfileTypedDataDigest validates digest length", async () => {
    const seed = mnemonicToSeedSync(MNEMONIC);
    const accountBytes = derivedFundsPkBytes(seed, 0);
    const profile = mockProfile(seed, 0, accountBytes);

    await expect(signProfileTypedDataDigest(profile, new Uint8Array(31))).rejects.toThrow();
  });

  it("a tagged signature verifies under the tagged verifier, and matches the derived pk", async () => {
    const seed = mnemonicToSeedSync(MNEMONIC);
    const profileIndex = 2;
    const accountBytes = derivedFundsPkBytes(seed, profileIndex);
    const profile = mockProfile(seed, profileIndex, accountBytes);

    const digest = new Uint8Array(32);
    digest[0] = 0x01;
    digest[15] = 0x42;
    digest[31] = 0xff;

    const signed = await signProfileTypedDataDigest(profile, digest);
    const signatureBytes = hexToBytes(signed.signatureHex);
    const publicKeyBytes = hexToBytes(signed.publicKeyHex);

    expect(signatureBytes).toHaveLength(48);
    expect(publicKeyBytes).toEqual(accountBytes);
    expect(verifyTypedDataDigestSignature(publicKeyBytes, digest, signatureBytes)).toBe(true);
  });

  // This pair is the entire point of the phase: a raw-digest oracle must not be
  // able to forge a typed-data signature, and a typed-data signature must not be
  // replayable as a raw digest.
  it("a tagged signature is REJECTED by the bare-digest verifier", async () => {
    const seed = mnemonicToSeedSync(MNEMONIC);
    const profileIndex = 3;
    const accountBytes = derivedFundsPkBytes(seed, profileIndex);
    const profile = mockProfile(seed, profileIndex, accountBytes);

    const digest = new Uint8Array(32).fill(0x33);

    const signed = await signProfileTypedDataDigest(profile, digest);
    const signatureBytes = hexToBytes(signed.signatureHex);
    const publicKeyBytes = hexToBytes(signed.publicKeyHex);

    expect(verifyBlsDigestSignature(publicKeyBytes, digest, signatureBytes)).toBe(false);
  });

  it("a signature over the BARE digest is REJECTED by the tagged verifier", () => {
    const seed = mnemonicToSeedSync(MNEMONIC);
    const profileIndex = 4;
    const skScalar = deriveBlsSecretKeyFromSeed(seed, profileIndex);
    const publicKeyBytes = derivedFundsPkBytes(seed, profileIndex);

    const digest = new Uint8Array(32).fill(0x44);
    const bareSignature = signBlsMessageBytes(digest, skScalar);

    expect(verifyBlsDigestSignature(publicKeyBytes, digest, bareSignature)).toBe(true);
    expect(verifyTypedDataDigestSignature(publicKeyBytes, digest, bareSignature)).toBe(false);
  });
});
