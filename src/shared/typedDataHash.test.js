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
import {
  checkPolicyLimits,
  hashTypedData,
  hashTypedDataHex,
  validateTypedDataParams,
} from "./typedDataHash.js";

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

/** Assert `fn` throws with the given stable spec-10 error code. */
function expectCode(fn, code) {
  let caught;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught, `expected a throw with code ${code}`).toBeDefined();
  expect(caught.code).toBe(code);
}

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

describe("typedDataHash v1", () => {
  it.each(["sign_in_basic.json", "nested_struct.json", "bytes32_field.json"])(
    "matches golden digest for %s",
    (name) => {
      const fixture = loadFixture(name);
      expect(hashTypedDataHex(fixture.input)).toBe(fixture.digestHex);
    }
  );

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

  it("rejects missing primaryType with E_PRIMARY_MISSING", () => {
    const fixture = loadFixture("sign_in_basic.json");
    expectCode(
      () => validateTypedDataParams({ ...fixture.input, primaryType: undefined }),
      "E_PRIMARY_MISSING"
    );
  });

  it("rejects empty types with E_PRIMARY_MISSING (primaryType no longer a key of types)", () => {
    const fixture = loadFixture("sign_in_basic.json");
    expectCode(
      () => validateTypedDataParams({ ...fixture.input, types: {} }),
      "E_PRIMARY_MISSING"
    );
  });

  it("rejects a types map missing DuskTypedDataDomain with E_DOMAIN_TYPE", () => {
    const fixture = loadFixture("sign_in_basic.json");
    const types = { ...fixture.input.types };
    delete types.DuskTypedDataDomain;
    expectCode(
      () => validateTypedDataParams({ ...fixture.input, types }),
      "E_DOMAIN_TYPE"
    );
  });
});

describe("string/bytes encoding (spec 5.1)", () => {
  it("encodes an empty string field as sha256(\"\")", () => {
    // sha256("") is the well-known constant; string and bytes both encode to
    // it for empty input, which is fine because typeHash pins the field type.
    const digest = hashTypedDataHex({
      domain,
      types: { ...domainTypes, S: [{ name: "text", type: "string" }] },
      primaryType: "S",
      message: { text: "" },
      origin,
    });
    expect(digest.startsWith("0x")).toBe(true);
    expect(digest).toHaveLength(66);
  });

  it("does not apply any value-dependent size budget (spec 11 removes it from validity)", () => {
    const big = "x".repeat(2_000_000);
    expect(() =>
      hashTypedDataHex({
        domain,
        types: { ...domainTypes, Big: [{ name: "blob", type: "string" }] },
        primaryType: "Big",
        message: { blob: big },
        origin,
      })
    ).not.toThrow();
  });

  it("hashes two large string array elements independently (no shared budget to double-count)", () => {
    const chunk = "y".repeat(400_000);
    const digest = hashTypedDataHex({
      domain,
      types: { ...domainTypes, Arr: [{ name: "parts", type: "string[2]" }] },
      primaryType: "Arr",
      message: { parts: [chunk, chunk] },
      origin,
    });
    expect(digest.startsWith("0x")).toBe(true);
    expect(digest).toHaveLength(66);
  });
});

describe("uint64 JSON", () => {
  it("accepts max uint64 as decimal string", () => {
    const digest = hashTypedDataHex({
      domain,
      types: { ...domainTypes, U: [{ name: "n", type: "uint64" }] },
      primaryType: "U",
      message: { n: "18446744073709551615" },
      origin,
    });
    expect(digest.startsWith("0x")).toBe(true);
    expect(digest).toHaveLength(66);
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
    expect(digest).toHaveLength(66);
  });

  it("rejects unsafe JSON number for uint64 with E_UINT_RANGE", () => {
    expectCode(
      () =>
        hashTypedDataHex({
          domain,
          types: { ...domainTypes, U: [{ name: "n", type: "uint64" }] },
          primaryType: "U",
          message: { n: 9007199254740993 },
          origin,
        }),
      "E_UINT_RANGE"
    );
  });

  it("rejects decimal string overflow for uint64 with E_UINT_RANGE", () => {
    expectCode(
      () =>
        hashTypedDataHex({
          domain,
          types: { ...domainTypes, U: [{ name: "n", type: "uint64" }] },
          primaryType: "U",
          message: { n: "18446744073709551616" },
          origin,
        }),
      "E_UINT_RANGE"
    );
  });

  it("rejects leading-zero decimal string for uint64 with E_UINT_FORMAT", () => {
    expectCode(
      () =>
        hashTypedDataHex({
          domain,
          types: { ...domainTypes, U: [{ name: "n", type: "uint64" }] },
          primaryType: "U",
          message: { n: "007" },
          origin,
        }),
      "E_UINT_FORMAT"
    );
  });
});

describe("validation error codes (spec section 10)", () => {
  it("E_PARAMS_SHAPE: params is not an object", () => {
    expectCode(() => hashTypedData("nope"), "E_PARAMS_SHAPE");
  });

  it("E_PRIMARY_INVALID: primaryType is DuskTypedDataDomain", () => {
    expectCode(
      () =>
        hashTypedData({
          domain,
          types: { ...domainTypes, S: [{ name: "text", type: "string" }] },
          primaryType: "DuskTypedDataDomain",
          message: domain,
          origin,
        }),
      "E_PRIMARY_INVALID"
    );
  });

  it("E_PRIMARY_INVALID: primaryType is an atomic type", () => {
    expectCode(
      () =>
        hashTypedData({
          domain,
          types: { ...domainTypes, S: [{ name: "text", type: "string" }] },
          primaryType: "string",
          message: {},
          origin,
        }),
      "E_PRIMARY_INVALID"
    );
  });

  it("E_DOMAIN_VALUE: domain.name is not a string", () => {
    expectCode(
      () =>
        hashTypedData({
          domain: { ...domain, name: 123 },
          types: { ...domainTypes, S: [{ name: "text", type: "string" }] },
          primaryType: "S",
          message: { text: "hi" },
          origin,
        }),
      "E_DOMAIN_VALUE"
    );
  });

  it("E_TYPE_UNKNOWN: field references an undeclared struct type", () => {
    expectCode(
      () =>
        hashTypedData({
          domain,
          types: { ...domainTypes, S: [{ name: "inner", type: "Undeclared" }] },
          primaryType: "S",
          message: { inner: {} },
          origin,
        }),
      "E_TYPE_UNKNOWN"
    );
  });

  it("E_TYPE_INVALID: array size has a leading zero (T[01])", () => {
    expectCode(
      () =>
        hashTypedData({
          domain,
          types: { ...domainTypes, S: [{ name: "items", type: "uint8[01]" }] },
          primaryType: "S",
          message: { items: [1] },
          origin,
        }),
      "E_TYPE_INVALID"
    );
  });

  it("E_TYPE_INVALID: zero-length array (T[0])", () => {
    expectCode(
      () =>
        hashTypedData({
          domain,
          types: { ...domainTypes, S: [{ name: "items", type: "uint8[0]" }] },
          primaryType: "S",
          message: { items: [] },
          origin,
        }),
      "E_TYPE_INVALID"
    );
  });

  it("E_TYPE_INVALID: dynamic array T[]", () => {
    expectCode(
      () =>
        hashTypedData({
          domain,
          types: { ...domainTypes, S: [{ name: "items", type: "uint8[]" }] },
          primaryType: "S",
          message: { items: [1] },
          origin,
        }),
      "E_TYPE_INVALID"
    );
  });

  it("E_TYPE_CYCLE: mutually recursive struct types", () => {
    expectCode(
      () =>
        hashTypedData({
          domain,
          types: {
            ...domainTypes,
            A: [{ name: "b", type: "B" }],
            B: [{ name: "a", type: "A" }],
          },
          primaryType: "A",
          message: { b: { a: {} } },
          origin,
        }),
      "E_TYPE_CYCLE"
    );
  });

  it("E_TYPE_CYCLE: self-referencing struct type", () => {
    expectCode(
      () =>
        hashTypedData({
          domain,
          types: { ...domainTypes, A: [{ name: "next", type: "A" }] },
          primaryType: "A",
          message: { next: {} },
          origin,
        }),
      "E_TYPE_CYCLE"
    );
  });

  it("E_FIELD_DUP: duplicate field name in one struct", () => {
    expectCode(
      () =>
        hashTypedData({
          domain,
          types: {
            ...domainTypes,
            S: [
              { name: "text", type: "string" },
              { name: "text", type: "string" },
            ],
          },
          primaryType: "S",
          message: { text: "hi" },
          origin,
        }),
      "E_FIELD_DUP"
    );
  });

  it("E_FIELD_RESERVED: field declared __proto__", () => {
    expectCode(
      () =>
        hashTypedData({
          domain,
          types: { ...domainTypes, S: [{ name: "__proto__", type: "string" }] },
          primaryType: "S",
          message: { ["__proto__"]: "hi" },
          origin,
        }),
      "E_FIELD_RESERVED"
    );
  });

  it("E_FIELD_DEF: field definition missing a type", () => {
    expectCode(
      () =>
        hashTypedData({
          domain,
          types: { ...domainTypes, S: [{ name: "text" }] },
          primaryType: "S",
          message: { text: "hi" },
          origin,
        }),
      "E_FIELD_DEF"
    );
  });

  it("E_FIELD_MISSING: field is present only via the prototype chain, not as an own property", () => {
    const fixture = loadFixture("sign_in_basic.json");
    const message = Object.assign(Object.create({ address: "via-prototype" }), {
      statement: "Sign in to Example",
    });
    expectCode(
      () => hashTypedData({ ...fixture.input, message }),
      "E_FIELD_MISSING"
    );
  });

  it("E_FIELD_EXTRA: value has an own property not declared by its struct type", () => {
    expectCode(
      () =>
        hashTypedData({
          domain,
          types: { ...domainTypes, S: [{ name: "text", type: "string" }] },
          primaryType: "S",
          message: { text: "hi", bogus: "nope" },
          origin,
        }),
      "E_FIELD_EXTRA"
    );
  });

  it("E_VALUE_TYPE: bool field given a string value", () => {
    expectCode(
      () =>
        hashTypedData({
          domain,
          types: { ...domainTypes, S: [{ name: "flag", type: "bool" }] },
          primaryType: "S",
          message: { flag: "true" },
          origin,
        }),
      "E_VALUE_TYPE"
    );
  });

  it("E_ARRAY_LENGTH: fixed array value has the wrong length", () => {
    expectCode(
      () =>
        hashTypedData({
          domain,
          types: { ...domainTypes, S: [{ name: "items", type: "uint8[3]" }] },
          primaryType: "S",
          message: { items: [1, 2] },
          origin,
        }),
      "E_ARRAY_LENGTH"
    );
  });

  it("E_HEX_FORMAT: bytes value has odd hex length", () => {
    expectCode(
      () =>
        hashTypedData({
          domain,
          types: { ...domainTypes, S: [{ name: "b", type: "bytes" }] },
          primaryType: "S",
          message: { b: "0xabc" },
          origin,
        }),
      "E_HEX_FORMAT"
    );
  });

  it("E_BYTES32_LENGTH: bytes32 value does not decode to exactly 32 bytes", () => {
    expectCode(
      () =>
        hashTypedData({
          domain,
          types: { ...domainTypes, S: [{ name: "b", type: "bytes32" }] },
          primaryType: "S",
          message: { b: "0xaabb" },
          origin,
        }),
      "E_BYTES32_LENGTH"
    );
  });

  it("E_ORIGIN_TYPE: origin is not a string", () => {
    expectCode(
      () =>
        hashTypedData({
          domain,
          types: { ...domainTypes, S: [{ name: "text", type: "string" }] },
          primaryType: "S",
          message: { text: "hi" },
          origin: 12345,
        }),
      "E_ORIGIN_TYPE"
    );
  });
});

describe("checkPolicyLimits (spec section 11)", () => {
  const smallInput = {
    domain,
    types: { ...domainTypes, S: [{ name: "text", type: "string" }] },
    primaryType: "S",
    message: { text: "hi" },
    origin,
  };

  it("accepts a payload within the floor", () => {
    expect(() => checkPolicyLimits(smallInput)).not.toThrow();
  });

  it("hashTypedData does not enforce policy limits - only checkPolicyLimits does", () => {
    // 65 fields exceeds the spec-11 floor of 64 fields/struct, but is still
    // structurally valid, so hashTypedData (the digest path) must accept it.
    const fields = Array.from({ length: 65 }, (_, i) => ({
      name: `f${i}`,
      type: "uint8",
    }));
    const message = Object.fromEntries(fields.map((f) => [f.name, 1]));
    const bigInput = {
      domain,
      types: { ...domainTypes, Big: fields },
      primaryType: "Big",
      message,
      origin,
    };

    expect(() => hashTypedDataHex(bigInput)).not.toThrow();
    expectCode(() => checkPolicyLimits(bigInput), "E_POLICY_LIMIT");
  });

  it("rejects more than 32 distinct struct types with E_POLICY_LIMIT", () => {
    const types = { ...domainTypes };
    let prev = "string";
    for (let i = 0; i < 33; i++) {
      const name = `S${i}`;
      types[name] = [{ name: "next", type: i === 0 ? "string" : `S${i - 1}` }];
      prev = name;
    }
    let message = "leaf";
    for (let i = 0; i < 33; i++) {
      message = i === 0 ? { next: "leaf" } : { next: message };
    }
    const input = { domain, types, primaryType: prev, message, origin };
    expectCode(() => checkPolicyLimits(input), "E_POLICY_LIMIT");
  });

  it("rejects more than 256 elements in a fixed array with E_POLICY_LIMIT", () => {
    const input = {
      domain,
      types: { ...domainTypes, Arr: [{ name: "items", type: "uint8[257]" }] },
      primaryType: "Arr",
      message: { items: Array.from({ length: 257 }, () => 1) },
      origin,
    };
    expectCode(() => checkPolicyLimits(input), "E_POLICY_LIMIT");
  });
});
