/**
 * Raw BLS12-381 digest signing for Dusk Connect pay-auth / Moonlight-open flows.
 *
 * Key derivation matches wallet-core (`derive_bls_sk`, `rng_with_index`).
 * Signing uses Dusk V2 hash-to-curve DST (same as dusk-core `BlsVersion::V2`).
 */
import { sha256 } from "@noble/hashes/sha2";
import { bls12_381 } from "@noble/curves/bls12-381";
import { bytesToHex } from "./bytes.js";

export const BLS_SIGN_DST = "BLS_SIG_BLS12381G1_XMD:SHA-256_DUSK_V2";

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
 * DANGER: this is the raw-digest path (typed-data spec §12.1's whole reason for
 * existing). It MUST NOT be reachable from any dApp-facing RPC (e.g.
 * `dusk_signTypedData`) — a caller that can get an arbitrary 32-byte value signed
 * through this path can forge a typed-data signature, since both share the same
 * key and the same DST. Use `verifyTypedDataDigestSignature` for typed-data.
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

/**
 * Sign a BARE 32-byte digest.
 *
 * DANGER: this is the raw-digest path (typed-data spec §12.1's whole reason for
 * existing). It MUST NOT be reachable from any dApp-facing RPC (e.g.
 * `dusk_signTypedData`) — signing arbitrary caller-supplied 32-byte values under
 * this key/DST is precisely what would let a caller forge a typed-data signature.
 * It is used only internally (e.g. Moonlight pay-auth). Use
 * `signProfileTypedDataDigest` for typed-data.
 *
 * @param {import("@dusk/w3sper").Profile} profile
 * @param {Uint8Array} digestBytes
 */
export async function signProfileBlsDigest(profile, digestBytes) {
  if (!(digestBytes instanceof Uint8Array) || digestBytes.length !== 32) {
    throw new Error("digest must be exactly 32 bytes");
  }

  const seed = new Uint8Array(await profile.seed);
  const profileIndex = Number(profile);
  const skScalar = deriveBlsSecretKeyFromSeed(seed, profileIndex);
  const fundsPkBytes = profile.account.valueOf();
  const signatureBytes = signBlsMessageBytes(digestBytes, skScalar);

  return {
    fundsPkHex: `0x${bytesToHex(fundsPkBytes)}`,
    signatureHex: `0x${bytesToHex(signatureBytes)}`,
    digestHex: `0x${bytesToHex(digestBytes)}`,
  };
}

/**
 * Typed-data signature domain tag (spec §12.1).
 *
 *   SIG_TAG = utf8("DUSK_TYPED_DATA_SIG_V1\0")   // 23 bytes, includes the
 *                                                 // trailing NUL byte
 *
 * The signature is computed over `SIG_TAG || digest` (55 bytes), never over the
 * bare 32-byte digest. The digest alone is indistinguishable from any other
 * 32-byte value the same Moonlight BLS key might be asked to sign under the same
 * DST (e.g. pay-auth digests); the tag makes the typed-data signed-message space
 * structurally disjoint from every bare 32-byte message space, so a signature
 * from one path can never be replayed as valid on the other.
 */
export const TYPED_DATA_SIG_TAG = "DUSK_TYPED_DATA_SIG_V1\0";

const TYPED_DATA_SIG_TAG_BYTES = new TextEncoder().encode(TYPED_DATA_SIG_TAG);

function assertDigest32(digestBytes) {
  if (!(digestBytes instanceof Uint8Array) || digestBytes.length !== 32) {
    throw new Error("digest must be exactly 32 bytes");
  }
}

/**
 * Build the tagged message that is actually signed for typed-data (spec §12.1):
 *
 *   signedMessage = SIG_TAG || digest   // 23 + 32 = 55 bytes
 *
 * @param {Uint8Array} digestBytes 32-byte typed-data digest (spec §9)
 * @returns {Uint8Array} 55-byte tagged message
 */
export function buildTypedDataSignedMessage(digestBytes) {
  assertDigest32(digestBytes);
  const out = new Uint8Array(TYPED_DATA_SIG_TAG_BYTES.length + digestBytes.length);
  out.set(TYPED_DATA_SIG_TAG_BYTES, 0);
  out.set(digestBytes, TYPED_DATA_SIG_TAG_BYTES.length);
  return out;
}

/**
 * Sign a typed-data digest for a profile, over the tagged message (spec
 * §12.1-12.2). This is the only typed-data-facing signing path: it must never be
 * used to produce a signature over a bare digest, and the raw-digest path
 * (`signProfileBlsDigest`) must never be used for typed-data.
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
 * Verify a typed-data signature over the tagged message form (spec §12.3). A
 * verifier MUST use this — not `verifyBlsDigestSignature` — to check typed-data
 * signatures; verifying over the bare digest would accept signatures produced by
 * any raw-32-byte signing path.
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
