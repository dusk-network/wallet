import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mnemonicToSeedSync } from "bip39";
import { bls12_381 } from "@noble/curves/bls12-381";

import { hexToBytes } from "./bytes.js";
import {
  deriveBlsSecretKeyFromSeed,
  signBlsMessageBytes,
  verifyBlsDigestSignature,
} from "./blsDigest.js";
import { hashTypedDataHex, validateTypedDataParams } from "./typedDataHash.js";

const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "typed-data-v1"
);

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

function loadFixture(name) {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, name), "utf8"));
}

function derivedFundsPkBytes(seed, profileIndex) {
  const skScalar = deriveBlsSecretKeyFromSeed(seed, profileIndex);
  return bls12_381.G2.ProjectivePoint.BASE.multiply(skScalar).toRawBytes(true);
}

describe("typedDataHash v1", () => {
  it.each([
    "sign_in_basic.json",
    "nested_struct.json",
    "bytes32_field.json",
  ])("matches golden digest for %s", (name) => {
    const fixture = loadFixture(name);
    expect(hashTypedDataHex(fixture.input)).toBe(fixture.digestHex);
  });

  it("BLS V2 signature over SignIn golden digest verifies with derived funds pk", () => {
    const fixture = loadFixture("sign_in_basic.json");
    const digestHex = hashTypedDataHex(fixture.input);
    expect(digestHex).toBe(fixture.digestHex);

    const digest = hexToBytes(digestHex);
    const seed = mnemonicToSeedSync(MNEMONIC);
    const skScalar = deriveBlsSecretKeyFromSeed(seed, 0);
    const fundsPkBytes = derivedFundsPkBytes(seed, 0);
    const signature = signBlsMessageBytes(digest, skScalar);

    expect(signature).toHaveLength(48);
    expect(verifyBlsDigestSignature(fundsPkBytes, digest, signature)).toBe(true);
  });

  it("rejects missing primaryType", () => {
    const fixture = loadFixture("sign_in_basic.json");
    expect(() =>
      validateTypedDataParams({
        ...fixture.input,
        primaryType: undefined,
      })
    ).toThrow(/primaryType/);
  });

  it("rejects unknown / empty types", () => {
    const fixture = loadFixture("sign_in_basic.json");
    expect(() =>
      validateTypedDataParams({
        ...fixture.input,
        types: {},
      })
    ).toThrow();
  });
});

const domain = { name: "Example", version: "1", chainId: "dusk:1" };
const domainTypes = {
  DuskTypedDataDomain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "string" },
    { name: "verifyingContract", type: "bytes32" },
  ],
};

const origin = "https://app.example";

describe("encoded size DoS", () => {
  it("rejects when shared budget exceeds 1 MiB", () => {
    // Domain name + primary string each stay under 1 MiB; together they must not.
    const name = "n".repeat(600_000);
    const blob = "x".repeat(500_000);
    expect(() =>
      hashTypedDataHex({
        domain: { ...domain, name },
        types: { ...domainTypes, Big: [{ name: "blob", type: "string" }] },
        primaryType: "Big",
        message: { blob },
        origin,
      })
    ).toThrow(/1 MiB/);
  });

  it("does not double-count T[n] concatenated bytes", () => {
    // Two ~400 KiB strings: unique encoded size < 1 MiB; naive concat account would exceed.
    const chunk = "y".repeat(400_000);
    const digest = hashTypedDataHex({
      domain,
      types: { ...domainTypes, Arr: [{ name: "parts", type: "string[2]" }] },
      primaryType: "Arr",
      message: { parts: [chunk, chunk] },
      origin,
    });
    expect(digest.startsWith("0x")).toBe(true);
    expect(digest.length).toBe(66);
  });
});

describe("uint64 JSON", () => {
  it("accepts max uint64 as decimal string", () => {
    const digest = hashTypedDataHex({
      domain,
      types: {
        ...domainTypes,
        U: [{ name: "n", type: "uint64" }],
      },
      primaryType: "U",
      message: { n: "18446744073709551615" },
      origin,
    });
    expect(digest.startsWith("0x")).toBe(true);
    expect(digest.length).toBe(66);
  });

  it("accepts safe JSON number for uint64", () => {
    const digest = hashTypedDataHex({
      domain,
      types: { ...domainTypes, U: [{ name: "n", type: "uint64" }] },
      primaryType: "U",
      message: { n: 9007199254740991 },
      origin,
    });
    expect(digest.startsWith("0x")).toBe(true);
    expect(digest.length).toBe(66);
  });

  it("rejects unsafe JSON number for uint64", () => {
    expect(() =>
      hashTypedDataHex({
        domain,
        types: { ...domainTypes, U: [{ name: "n", type: "uint64" }] },
        primaryType: "U",
        message: { n: 9007199254740993 },
        origin,
      })
    ).toThrow(/safe integer/);
  });

  it("rejects decimal string overflow for uint64", () => {
    expect(() =>
      hashTypedDataHex({
        domain,
        types: { ...domainTypes, U: [{ name: "n", type: "uint64" }] },
        primaryType: "U",
        message: { n: "18446744073709551616" },
        origin,
      })
    ).toThrow(/uint64 overflow/);
  });
});
