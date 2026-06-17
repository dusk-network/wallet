# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added a repository privacy policy document for wallet extension store submissions. ([#29])
- Added Sozu liquid staking support, native staking owner flows, and updated staking transaction review UX. ([#32], [#33])

### Changed

- Changed the default wallet network from Testnet to Mainnet.

## [0.1.0] - 2026-05-28

### Added

- Added Chrome and Firefox extension builds for Dusk Wallet v0.1.0.
- Added wallet onboarding, mnemonic import, vault creation, unlock, lock, and auto-lock flows.
- Added profile-based account management aligned with Dusk Connect and the injected provider profile API.
- Added public account balance display and Phoenix/shielded balance display with shielded sync status.
- Added public transfer, shielded transfer, shielding, and unshielding flows.
- Added transaction activity and detail views with explorer links, fee details, execution state, and local wallet metadata.
- Added Dusk provider support for dApp profile connections, `dusk_requestProfiles`, `dusk_profiles`, `profilesChanged`, and `dusk_disconnect`.
- Added explicit shielded receive-address approvals through `dusk_requestShieldedAddress`.
- Added dApp approval flows for transactions, message signing, auth signing, contract calls, and watched assets.
- Added DRC20 and DRC721 watch-asset support.
- Added DRC20 transfer/approve UI and DRC721 import/detail support.
- Added data-driver backed decoding for known DRC20 and DRC721 contract-call approvals.
- Added sign-message approval previews for readable messages, with hash/length-only treatment for opaque byte payloads.
- Added gas editor controls and cached gas-price suggestions for transaction review flows.
- Added Phoenix-aware transfer gas defaults.
- Added expanded transaction lifecycle states for submitted, mempool, executed, failed, removed, and unknown transactions.
- Added mempool/chain reconciliation for submitted transactions when watcher state is incomplete.
- Added conservative Phoenix pending-nullifier reservation tracking for shielded transactions.
- Added a Phoenix spend mutex to prevent concurrent shielded sends from building against the same spendable note set.
- Added safe recheck support for old local transaction reservations.
- Added wallet e2e mnemonic import fixes so the Playwright flow can act as a release signal.
- Added Chrome Web Store and Firefox Add-ons release metadata and packaged build support.

### Changed

- Aligned public wallet docs with the profile provider API and v0.1 release/security guidance.
- Updated transaction copy so watcher timeouts and unknown Phoenix states do not read as execution failure.
- Updated activity and transaction-detail tone for unknown/removed states so they no longer visually imply failure.
- Updated provider responses so internal Phoenix pending-nullifier metadata stays wallet-local.
- Updated dApp transaction defaults and validation so transfer gas defaults are privacy-aware.
- Hardened dApp origin isolation and permission scoping.
- Hardened sensitive provider method validation for transactions, message signing, auth signing, and watched assets.
- Hardened vault and lock lifecycle behavior, including locked-wallet provider responses.
- Updated extension packaging, metadata, and store assets for the v0.1.0 release.
- Reduced browser extension polyfill, remote-code, and bundled dependency surface for v0.1.

### Fixed

- Prevented watcher timeout/unknown Phoenix transactions from being shown as execution failures.
- Prevented Phoenix pending-nullifier reservations from being automatically released on timeout, unknown status, removed status, or a single missing mempool poll.
- Prevented provider responses from leaking local pending nullifiers.

[Unreleased]: https://github.com/dusk-network/wallet/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/dusk-network/wallet/releases/tag/v0.1.0
