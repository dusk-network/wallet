import { bls12_381 } from "@noble/curves/bls12-381";
import { decodeBase58 } from "@dusk-network/networks/account";

/**
 * Whether a public account is a key at all. An account has no checksum, but a
 * mistyped one lands off the curve, so this catches it before it's sent. Base58
 * of the wrong length isn't an account either.
 * @param {string} account
 * @returns {boolean}
 */
export function isAccountKey(account) {
  try {
    const bytes = decodeBase58(String(account ?? ""));
    if (bytes?.length !== 96) return false;
    bls12_381.G2.ProjectivePoint.fromHex(bytes).assertValidity();
    return true;
  } catch {
    return false;
  }
}
