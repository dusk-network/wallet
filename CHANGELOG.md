# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added a Sent screen after Confirm that follows the transaction: Sending, Sent to the network, then Completed or Failed with the reason and the fee charged, with its ID, Copy and the Dusk explorer link.
- Showed the profile's full public history in Activity, including received transfers.
- Showed the profile's shielded history in Activity.
- Named Activity's counterparties by their verified `.dusk` names.
- Added day groups and All, Sent, Received and Staking filters to Activity's full list.
- Labelled DuskEVM bridge transfers in Activity.
- Suggested a close `.dusk` name from contacts and past transfers when a typed one isn't registered.
- Showed a pasted public account's verified `.dusk` name on Send.
- Named the profile that pays on Send's Review, and a contact by both its label and its verified name.
- Said on a public send's Review what everyone can see: the amount, the memo and your name.
- Added an eye button beside the total balance that hides every balance behind ••••; the choice is remembered. ([#130])
- Gave connected sites the profile's verified `.dusk` name, as `name`. ([#127])
- Showed the profile's verified `.dusk` name in the approval pop-ups. ([#127])
- Named the recipient of a site's transfer under its address: your profile, a saved contact, or its verified `.dusk` name. ([#127])
- Added sending to `.dusk` names on Mainnet and Testnet, to their public account or shielded address. ([#125])
- Showed each profile's verified `.dusk` name in the header, the profile switcher and Receive. ([#125])
- Added a warning when sending to your own account or address. ([#125])
- Showed on Review whether the transfer is visible on chain. ([#125])
- Added a full escaped typed-data request view alongside the bounded approval preview. ([#113])
- Displayed the installed extension version in Settings. ([#80])
- Added `dusk_signTypedData`, letting dApps request a signature over structured data the wallet renders — domain, primary type, and bounded, potentially truncated message previews with declared field types — instead of an opaque digest. The wallet injects the requesting origin into the digest and echoes it in the result. ([#22])

### Changed

- Gave the popup a calmer look: lists on one surface, pill buttons, round home actions and plain section titles, in each system's own fonts.
- Reworked Staking into an overview with native and liquid staking as two equal choices, an amount screen that checks the 1,000 DUSK minimum as you type, and the owner and stake account under Advanced.
- Named Sozu as a third party wherever liquid staking shows, and said how much stDUSK a stake gets and what it's worth now.
- Showed toasts at the bottom of the popup, outside the page that scrolls, long enough to reach their action, and announced to screen readers.
- Showed errors under their field instead of only in a toast.
- Hid amounts in toasts and on the Sent screen while balances are hidden.
- Showed every amount and fee in one format: at most 4 decimals, no trailing zeros, thousands grouped, with DUSK.
- Set fees at the network's gas price, with one Custom fee for your own limit and price, and a warning under the minimum gas limit as you type.
- Restyled Send, Shield and Unshield: one large amount field, what's available after fees with Max, and errors under the field.
- Stopped offering Save to Contacts for your own account or address.
- Showed Activity's rows with a direction icon and the other side's name first; a failed one says nothing was sent and the fee paid.
- Reworked a transaction's details into a summary of who, how much and its status, then its date, memo, fee, profile and ID, with block and gas under Technical details.
- Hid Activity's amounts and a transaction's amount while balances are hidden; fees stay visible.
- Said known chain errors in plain words, with the chain's own under Technical details.
- Moved the account's explorer link from Home's History ↗ to the end of Activity, on the Dusk explorer instead of DuskScan.
- Cleared the wallet's transactions, shielded notes and history on reset.
- Moved Review's gas price line and presets behind the fee's Edit, and removed Review's Cancel. ([#126])
- Cut repeated text across the popup, labelled its fields for screen readers and drew its icon buttons as SVG icons. ([#126])
- Opened Receive on the public account, as the web wallet does. ([web-wallet#970])
- Picked the profile to connect from option cards instead of a dropdown. ([#127])
- Opened the profile switcher from the header's account chip, with a copy button per account. ([#125])
- Moved Refresh from the header to the balance. ([#125])
- Showed Receive's name and short address in one-line fields with copy buttons. ([#125])
- Pinned the shared typed-data RC through JSR's npm compatibility registry for reproducible installs. ([#22])
- Used `@dusk/typed-data` for typed-data validation, hashing and signed-message construction. ([#22])
- Gated dApp RPC requests on the canonical method list before any permission lookup or approval prompt, so methods absent from the advertised surface are unreachable rather than merely undocumented. Deliberately refused methods still report why instead of "Unknown method".
- Defaulted public transfers to 2.5M gas, set gas minimums for shield (30M) and public staking (35M), and lowered the unshield minimum to 30M, matching the web wallet. ([web-wallet#969](https://github.com/dusk-network/web-wallet/issues/969))

### Security

- Rejected non-integer and out-of-u8-range profile indices before BLS key derivation. ([#117])
- Pinned direct Noble dependencies to exact reviewed versions. ([#22])
- Typed-data signatures cover a domain-separated message rather than the bare 32-byte digest, so they cannot be produced by, or replayed as, a signature over a caller-supplied digest.

### Fixed

- Fixed the popup moving Receive's QR and Review's recipient below the rest of the page. ([#125])
- Raised the shielded (Phoenix) transfer default gas limit to 50M and its minimum to 30M so shielded sends clear the node's spend-gas admission floor.
- Preserved the active unlock form, including entered text and in-flight submission state, across passive rerenders. ([#110](https://github.com/dusk-network/wallet/issues/110))
- Cleared unanchored spent-note caches before resync to prevent orphaned notes from reappearing. ([#106](https://github.com/dusk-network/wallet/issues/106))
- Committed prefetched shielded chunks before stopping at the scan target, including under slow RPC responses.
- Discarded abandoned unlock metadata errors and notifications after session or sync changes.
- Kept concurrent metadata initialization from overwriting committed shielded cursors and anchors.
- Backported the upstream W3sper stream reader so interrupted reads surface errors and can be retried; retained the published SDK pin without adding dependencies.
- Validated shielded cache anchors and rebuilt invalidated notes/cursors together after a reorg, preserving pending reservations. Cursors now represent the next note position. ([#106](https://github.com/dusk-network/wallet/issues/106))
- Surfaced failed spent-note reconciliation instead of reporting a healthy sync. ([#107](https://github.com/dusk-network/wallet/issues/107))
- Cancelled stale shielded sync work after lock, profile or network changes, including preflight and cache writes. ([#108](https://github.com/dusk-network/wallet/issues/108))
- Disabled typed-data approval when complete disclosure cannot match the pending digest within display limits. ([#113])
- Flagged typed-data formatting controls, line separators and non-NFC text without normalizing signed values. ([#113])
- Displayed empty typed-data structs with their paths and types, including array elements and row-limit disclosure. ([#22])
- Replaced Arabic Letter Mark in typed-data domain and message previews with a visible placeholder and warning. ([#22])
- Counted completed typed-data signing requests as auto-lock activity. ([#22])
- Matched typed-data byte previews to every accepted hex spelling. ([#22])
- Applied message-preview safeguards to typed-data domain strings. ([#22])
- Required an exact typed-data chain match before approval. ([#22])
- Rejected undeclared non-enumerable and symbol-keyed fields in typed-data structs. ([#22])
- Returned `INVALID_PARAMS` with the typed-data error code for hash-time value validation failures. ([#22])
- Visibly disclosed truncated strings in typed-data approval previews. ([#22])
- Required identifier field names in typed-data schemas. ([#22])
- Rejected unpaired UTF-16 surrogates in typed-data strings. ([#22])
- Updated the dApp quick start to use conflict-aware provider selection. ([dusk-network/connect#42](https://github.com/dusk-network/connect/issues/42))
- Serialized DRC20 and DRC721 encoded call arguments before browser extension messaging. ([#79])
- Generated fresh discovery UUIDv4 values per page/provider, separate from the stable bridge routing identifier. ([dusk-network/connect#42](https://github.com/dusk-network/connect/issues/42))

[#22]: https://github.com/dusk-network/wallet/issues/22
[#113]: https://github.com/dusk-network/wallet/issues/113
[#117]: https://github.com/dusk-network/wallet/issues/117
[#125]: https://github.com/dusk-network/wallet/issues/125
[#126]: https://github.com/dusk-network/wallet/issues/126
[#127]: https://github.com/dusk-network/wallet/issues/127
[#130]: https://github.com/dusk-network/wallet/issues/130
[web-wallet#970]: https://github.com/dusk-network/web-wallet/issues/970

## [0.3.0] - 2026-06-23

### Added

- Added contact detail views with full saved addresses, Edit and Send actions, filtered local activity, and public explorer History links. ([#61])
- Added full receive-address display and QR PNG export from the receive view. ([#60])
- Added saved-contact badges to recent activity when the outgoing recipient matches an address book contact. ([#61])

### Changed

- Replaced the History tab with inline recent activity and explorer History access. ([#59])
- Componentized popup subnav headings and transfer recipient badges for more consistent wallet UI. ([#58], [#62])
- Improved public, shielded, and contact recipient badges across send, shield, and unshield flows. ([#62])
- Tightened wallet form behavior so value fields reject text input and Enter continues supported flows. ([#57])

### Fixed

- Fixed extension worker loading under browser extension content security policies. ([#62])
- Fixed auto-lock activity tracking across background worker restarts and preserved connected dApp locked-state profile events. ([#70])
- Kept account-type detection pills compact when adding or editing contacts. ([#61])

## [0.2.0] - 2026-06-18

### Added

- Added a repository privacy policy document for wallet extension store submissions. ([#29])
- Added owner-aware native staking position flows. ([#32])
- Added Sozu liquid staking support with hub discovery and live pool reads. ([#33])
- Added a Shield action to the full wallet view navigation. ([#43])

### Changed

- Changed the default wallet network from Testnet to Mainnet.
- Updated wallet-core to 1.7.1. ([#47])
- Updated dashboard action icons and extension icon contrast. ([#42], [#46])
- Clarified the transfer amount control and connected-site status UI. ([#44], [#45])
- Polished wallet copy across staking and other user-facing flows. ([#52])
- Updated the audited development toolchain so `npm audit` is clean. ([#55])

### Fixed

- Allowed users to retry approval unlocks after entering a wrong password. ([#41])
- Refreshed full-view lock state when the wallet auto-locks in the background. ([#51])
- Scoped provider bridge messages to Dusk Wallet so another installed Dusk provider does not receive the same dApp request. ([#53])

### Security

- Restricted dApp RPC and custom node switching to HTTPS origins/endpoints or local HTTP development endpoints. ([#54])

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

[Unreleased]: https://github.com/dusk-network/wallet/compare/v0.3.0...HEAD
[#79]: https://github.com/dusk-network/wallet/issues/79
[#80]: https://github.com/dusk-network/wallet/issues/80
[0.3.0]: https://github.com/dusk-network/wallet/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/dusk-network/wallet/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/dusk-network/wallet/releases/tag/v0.1.0
