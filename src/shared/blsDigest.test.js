import { describe, expect, it } from "vitest";
import { mnemonicToSeedSync } from "bip39";
import { bls12_381 } from "@noble/curves/bls12-381";

import { hexToBytes } from "./bytes.js";
import {
  deriveBlsSecretKeyFromSeed,
  signBlsMessageBytes,
  signProfileBlsDigest,
  verifyBlsDigestSignature,
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
