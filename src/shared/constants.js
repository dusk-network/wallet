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

/**
 * Maximum number of wallet profiles supported by the UI/engine.
 *
 * Note: Shielded note scanning cost scales with the number of profiles. The
 * upstream CLI wallet defaults to a low number of profiles as well.
 */
export const MAX_ACCOUNT_COUNT = 5;
