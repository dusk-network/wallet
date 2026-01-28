// Shared constants for the Dusk Wallet.
//
// Centralizing magic strings and configuration values here improves
// type safety and makes refactoring easier.

/**
 * Transaction kind identifiers.
 * Used throughout the wallet for gas defaults, UI rendering, and RPC handling.
 */
export const TX_KIND = Object.freeze({
  TRANSFER: "transfer",
  SHIELD: "shield",
  UNSHIELD: "unshield",
  CONTRACT_CALL: "contract_call",
  // Staking (not yet exposed in UI, but used in engine/defaults).
  STAKE: "stake",
  UNSTAKE: "unstake",
});
