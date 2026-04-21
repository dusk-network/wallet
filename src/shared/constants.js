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
  WITHDRAW_REWARD: "withdraw_reward",
});

/**
 * Maximum number of wallet profiles supported by the UI/engine.
 *
 * Note: Shielded note scanning cost scales with the number of profiles. Match
 * the CLI wallet's two-profile default/limit until there is a product reason
 * to support broader account discovery.
 */
export const MAX_ACCOUNT_COUNT = 2;
