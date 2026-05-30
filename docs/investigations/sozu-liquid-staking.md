# Sozu Liquid Staking Integration Notes

This is a local investigation note for the wallet branch stacked on PR #32.

## v1 Contract Config

Source: `/home/hein_/projects/sozu-integration-analysis/sozu-wallet/config/default.config.toml`.

Configured networks:

- `testnet`
  - hub: `bae85f8c24730a5a19fbe3d3bd58248ac8c302b62fe414a8c640d8c0ed286b9e`
  - pool: `72883945ac1aa032a88543aacc9e358d1dfef07717094c05296ce675f23078f2`
  - relayer: `51ced4fad52fc590def2736969c9e3e30013275a996c53714b81d8a08774aa37`
  - substrate: `0077ecbf88aa20d6d0a6afa20bd26300a2b562fdbac368bf1e3c1325e8555941`
- `mainnet`
  - hub: `b32c917e76abc6fcf2edbee0fa70231d8e19c405b18421794a11badfc66d2f26`
  - pool: `6fdfdc713a18fc6ca2ad20eb2b4a3305a935ef47d6a872d9a4df8bc9fd9d169e`
  - relayer: `1cc415d05b1cfbf2583bf2e8a0e39b2c768d263ef92d6a21a4787f76c6afa924`
  - substrate: `bc6f50f7404d098cdd1117b15dddab6f6f3dad01c5ce3c5ce9b68a8b60bc4c1d`

`devnet` and `local` do not have bundled contract IDs in the Sozu wallet config. The wallet must show a disabled state there unless the user/config layer provides IDs later.

## Contract Calls

The Sozu CLI sends Moonlight contract calls to the pool contract:

- deposit/liquid stake: `sozu_stake(amount)` with transaction `deposit = amount`
- withdraw/liquid unstake: `sozu_unstake(amount)` with transaction `deposit = 0`

Both arguments are encoded as a little-endian `u64`. The Sozu pool data-driver fixture confirms `1000000000000` encodes as `0010a5d4e8000000`.

The CLI also has `sozu_airdrop`, but that is not a normal wallet user action. I did not find a user-facing claim action equivalent to native stake reward withdrawal, so v1 should not show a Sozu claim button.

## Reads

Useful pool reads from `sozu-wallet/src/rues/pool.rs` and `sozu-contracts-dd/pool/src/lib.rs`:

- `balance_of(account)` returns the user's pool/share balance.
- `exchange_rate()` returns `{ numerator, denominator }`, representing total active stake over token total supply.

Hub discovery exists through the hub contract `contract(name)`, but v1 intentionally uses the Sozu wallet's hardcoded config. Hub/DD discovery should be a follow-up.

## Data Drivers

The Sozu pool data-driver supports:

- input encoding/decoding for `sozu_stake`, `sozu_unstake`, `balance_of`, `exchange_rate`
- output decoding for `balance_of` and `exchange_rate`
- events including `deposit`, `unstake`, and `reward`

For this local v1 wallet pass, no Sozu data-driver WASM is committed. The adapter builds `sozu_stake`/`sozu_unstake` args directly because they are plain `u64` values. Live pool reads should use the Sozu pool data-driver in a later wiring pass.

## UX Separation

Sozu is liquid staking, not native/provisioner staking. The wallet should keep it in a separate "Liquid staking with Sozu" section and should not reuse owner-aware native staking concepts like stake owner, provisioner, or owner-funded gas.

Initial safe copy:

- `Liquid staking with Sozu`
- `Stake without running a node`
- `This uses Sozu contracts, not native provisioner staking.`

## Open Questions

- Whether Sozu wants wallet v1 to use hardcoded IDs only, or a hosted/hub lookup fallback.
- Whether share balances should be displayed as `sDUSK`, another token symbol, or generic Sozu shares.
- Whether Phoenix-funded Sozu contract calls should be exposed. Current wallet contract-call infrastructure can build shielded contract calls, but this needs a dedicated end-to-end safety pass before UI exposure.
- Whether a local Sozu contract fixture can be run for browser-driven live validation.
