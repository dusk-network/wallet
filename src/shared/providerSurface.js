import { TX_KIND } from "./constants.js";

// Canonical dApp/provider surface area for the discovered Dusk provider.
//
// This file is intentionally small and dependency-free so we can:
// - keep docs and SDK in sync via tests
// - expose the same information at runtime via `dusk_getCapabilities`

export const DAPP_DISCOVERY_EVENTS = Object.freeze([
  "dusk:requestProvider",
  "dusk:announceProvider",
]);

export const DAPP_RPC_METHODS = Object.freeze([
  "dusk_getCapabilities",
  "dusk_requestAccounts",
  "dusk_accounts",
  "dusk_chainId",
  "dusk_switchNetwork",
  "dusk_getPublicBalance",
  "dusk_estimateGas",
  "dusk_sendTransaction",
  "dusk_watchAsset",
  "dusk_signMessage",
  "dusk_signAuth",
  "dusk_disconnect",
]);

export const DAPP_TX_KINDS = Object.freeze([TX_KIND.TRANSFER, TX_KIND.CONTRACT_CALL]);

export const DAPP_LIMITS = Object.freeze({
  // Protocol / node enforced.
  maxFnArgsBytes: 64 * 1024,
  // Wallet enforced (UX + predictable signing / display).
  maxFnNameChars: 64,
  // Protocol enforced for memo payloads (TransactionData::Memo).
  maxMemoBytes: 512,
});
