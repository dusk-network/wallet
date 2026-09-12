import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { mnemonicToSeedSync } from "bip39";
import { bls12_381 } from "@noble/curves/bls12-381";
import { hashTypedDataHex } from "@dusk/typed-data";
import { verifyTypedDataSignature, verifyBlsDigest } from "@dusk/typed-data/bls";

import { hexToBytes } from "./bytes.js";
import {
  deriveBlsSecretKeyFromSeed,
  signProfileTypedDataDigest,
} from "./blsDigest.js";

// Consumer checks use packaged frozen expectations, not a second encoder.
// Core validation/policy tests and the full corpus live in @dusk/typed-data.
const require = createRequire(import.meta.url);
function loadFixture(name) {
  return JSON.parse(readFileSync(require.resolve(`@dusk/typed-data/vectors/${name}`), "utf8"));
}

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

function derivedFundsPkBytes(seed, profileIndex) {
  const skScalar = deriveBlsSecretKeyFromSeed(seed, profileIndex);
  return bls12_381.G2.ProjectivePoint.BASE.multiply(skScalar).toRawBytes(true);
}

describe("shared typed-data package integration", () => {
  it.each(["sign_in_basic.json", "nested_struct.json", "bytes32_field.json"])(
    "matches golden digest for %s",
    (name) => {
      const fixture = loadFixture(name);
      expect(hashTypedDataHex(fixture.input)).toBe(fixture.digestHex);
    }
  );

  it("verifies the Wallet profile signature with the shared policy-aware verifier", async () => {
    const fixture = loadFixture("sign_in_basic.json");
    const digestHex = hashTypedDataHex(fixture.input);
    expect(digestHex).toBe(fixture.digestHex);

    const digest = hexToBytes(digestHex);
    const seed = mnemonicToSeedSync(MNEMONIC);
    const fundsPkBytes = derivedFundsPkBytes(seed, 0);
    const profile = { seed, account: { valueOf: () => fundsPkBytes }, [Symbol.toPrimitive]: () => 0 };
    const { signatureHex, publicKeyHex } = await signProfileTypedDataDigest(profile, digest);
    const policy = { chainId: fixture.input.domain.chainId, origin: fixture.input.origin };

    expect(verifyTypedDataSignature(fixture.input, signatureHex, publicKeyHex, policy)).toEqual({
      ...policy, digestHex: fixture.digestHex, ok: true, code: "OK",
    });
    expect(verifyTypedDataSignature(fixture.input, signatureHex, publicKeyHex, {
      ...policy, origin: "https://other.example",
    }).code).toBe("E_ORIGIN_MISMATCH");
    expect(verifyTypedDataSignature({ ...fixture.input, origin: "https://other.example" }, signatureHex, publicKeyHex, policy).code).toBe("E_SIG_INVALID");
    expect(verifyBlsDigest(digestHex, signatureHex, publicKeyHex)).toBe(false);
  });
});
