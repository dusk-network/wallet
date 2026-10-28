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

/**
 * What the desktop app's wallet (wallet/localBus.js) tells the page it runs
 * in, as the extension's background tells its pages with runtime messages:
 * an event of this type on the page, the message its detail.
 */
export const WALLET_MESSAGE_EVENT = "dusk-wallet-message";
