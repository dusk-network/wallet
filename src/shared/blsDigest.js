/**
 * Wallet-owned BLS12-381 key derivation and typed-data signing.
 *
 * Key derivation matches wallet-core (`derive_bls_sk`, `rng_with_index`).
 * Signing uses Dusk V2 hash-to-curve DST (same as dusk-core `BlsVersion::V2`).
 */
import { sha256 } from "@noble/hashes/sha2";
import { bls12_381 } from "@noble/curves/bls12-381";
import { bytesToHex } from "./bytes.js";

import { BLS_SIGN_DST, buildTypedDataSignedMessage } from "@dusk/typed-data/bls";
export { BLS_SIGN_DST, TYPED_DATA_SIG_TAG, buildTypedDataSignedMessage } from "@dusk/typed-data/bls";

const Fr_ORDER = bls12_381.fields.Fr.ORDER;

function chacha12Block(key32) {
  const C = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574];
  const init = new Uint32Array(16);
  const kv = new DataView(key32.buffer, key32.byteOffset, 32);

  init[0] = C[0];
  init[1] = C[1];
  init[2] = C[2];
  init[3] = C[3];
  for (let i = 0; i < 8; i++) init[4 + i] = kv.getUint32(i * 4, true);

  const w = new Uint32Array(init);
  const rotl32 = (n, b) => (n << b | n >>> (32 - b)) >>> 0;

  function qr(a, b, c, d) {
    w[a] = (w[a] + w[b]) >>> 0;
    w[d] = rotl32(w[d] ^ w[a], 16);
    w[c] = (w[c] + w[d]) >>> 0;
    w[b] = rotl32(w[b] ^ w[c], 12);
    w[a] = (w[a] + w[b]) >>> 0;
    w[d] = rotl32(w[d] ^ w[a], 8);
    w[c] = (w[c] + w[d]) >>> 0;
    w[b] = rotl32(w[b] ^ w[c], 7);
  }

  for (let i = 0; i < 6; i++) {
    qr(0, 4, 8, 12);
    qr(1, 5, 9, 13);
    qr(2, 6, 10, 14);
    qr(3, 7, 11, 15);
    qr(0, 5, 10, 15);
    qr(1, 6, 11, 12);
    qr(2, 7, 8, 13);
    qr(3, 4, 9, 14);
  }

  for (let i = 0; i < 16; i++) w[i] = (w[i] + init[i]) >>> 0;

  const out = new Uint8Array(64);
  const outV = new DataView(out.buffer);
  for (let i = 0; i < 16; i++) outV.setUint32(i * 4, w[i], true);
  return out;
}

function fromBytesWide(bytes64) {
  const view = new DataView(bytes64.buffer, bytes64.byteOffset, 64);
  let result = 0n;
  for (let i = 0; i < 8; i++) {
    result += view.getBigUint64(i * 8, true) << BigInt(i * 64);
  }
  return result % Fr_ORDER;
}

/**
 * @param {Uint8Array} seed 64-byte BIP39 seed
 * @param {number} profileIndex
 */
export function deriveBlsSecretKeyFromSeed(seed, profileIndex) {
  const indexBytes = new Uint8Array(8);
  new DataView(indexBytes.buffer).setBigUint64(0, BigInt(profileIndex), true);
  const termination = new Uint8Array([0x53, 0x4b]);

  const hashInput = new Uint8Array(seed.length + 8 + 2);
  hashInput.set(seed, 0);
  hashInput.set(indexBytes, seed.length);
  hashInput.set(termination, seed.length + 8);

  const seed32 = sha256(hashInput);
  const keystream = chacha12Block(seed32);
  return fromBytesWide(keystream);
}

/**
 * @param {Uint8Array} message
 * @param {bigint} skScalar
 */
export function signBlsMessageBytes(message, skScalar) {
  const h2cPoint = bls12_381.G1.hashToCurve(message, { DST: BLS_SIGN_DST });
  return h2cPoint.multiply(skScalar).toRawBytes(true);
}

/**
 * Verify a signature over a BARE 32-byte digest.
 *
 * Test helper, not a typed-data verifier: a bare-digest signature does not cover
 * the typed-data tag. Application verifiers must use the shared library's
 * `verifyTypedDataSignature` with their trusted policy.
 *
 * @param {Uint8Array} fundsPkBytes 96-byte G2 compressed public key
 * @param {Uint8Array} digestBytes 32-byte digest
 * @param {Uint8Array} signatureBytes 48-byte G1 compressed signature
 */
export function verifyBlsDigestSignature(fundsPkBytes, digestBytes, signatureBytes) {
  return bls12_381.verifyShortSignature(signatureBytes, digestBytes, fundsPkBytes, {
    DST: BLS_SIGN_DST,
  });
}

// There is deliberately no profile-level signer for BARE 32-byte digests here.
// Signing caller-supplied digests under this key and DST is the subject of a
// separate, undecided design question (issue #90), so this module offers no
// ready-made capability for it. `signBlsMessageBytes` remains as the low-level
// primitive, used by the typed-data path and by tests that need to construct a
// bare-digest signature in order to assert it is rejected.

function assertDigest32(digestBytes) {
  if (!(digestBytes instanceof Uint8Array) || digestBytes.length !== 32) {
    throw new Error("digest must be exactly 32 bytes");
  }
}

/**
 * Sign a typed-data digest for a profile, over the tagged message (spec
 * §12.1-12.2). This is the only profile-level signing path in this module, and
 * it always signs SIG_TAG || digest — never a bare digest.
 *
 * @param {import("@dusk/w3sper").Profile} profile
 * @param {Uint8Array} digestBytes 32-byte typed-data digest (spec §9)
 * @returns {Promise<{publicKeyHex:string, signatureHex:string, digestHex:string}>}
 */
export async function signProfileTypedDataDigest(profile, digestBytes) {
  assertDigest32(digestBytes);

  const seed = new Uint8Array(await profile.seed);
  const profileIndex = Number(profile);
  const skScalar = deriveBlsSecretKeyFromSeed(seed, profileIndex);
  const publicKeyBytes = profile.account.valueOf();
  const signedMessage = buildTypedDataSignedMessage(digestBytes);
  const signatureBytes = signBlsMessageBytes(signedMessage, skScalar);

  return {
    publicKeyHex: `0x${bytesToHex(publicKeyBytes)}`,
    signatureHex: `0x${bytesToHex(signatureBytes)}`,
    digestHex: `0x${bytesToHex(digestBytes)}`,
  };
}

/**
 * Low-level test helper for the tagged message form. This does not check the
 * chain/origin policy; application verifiers use `verifyTypedDataSignature`
 * from `@dusk/typed-data/bls`.
 *
 * @param {Uint8Array} publicKeyBytes 96-byte G2 compressed public key
 * @param {Uint8Array} digestBytes 32-byte typed-data digest (spec §9)
 * @param {Uint8Array} signatureBytes 48-byte G1 compressed signature
 */
export function verifyTypedDataDigestSignature(publicKeyBytes, digestBytes, signatureBytes) {
  const signedMessage = buildTypedDataSignedMessage(digestBytes);
  return bls12_381.verifyShortSignature(signatureBytes, signedMessage, publicKeyBytes, {
    DST: BLS_SIGN_DST,
  });
}
