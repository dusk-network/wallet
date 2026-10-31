# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added more than one recovery phrase, all unlocked with one password: Add wallet creates or imports another, and refuses one that's already here.
- Grouped the profile switcher by wallet, as Wallet 1 and Wallet 2, and switched to another wallet's profile without the password.
- Added Wallets to Settings, to rename a wallet or remove it with the password.
- Added Change password to Settings.
- Added a Bridge filter to Activity, which now holds bridge transfers instead of Sent and Received.
- Said when a deposit to DuskEVM arrived, and added View in DuskEVM explorer to its details.
- Said Arrived on a deposit to DuskEVM once it's there, and linked its transaction on DuskEVM's explorer.
- Offered alice.dusk for a recipient typed as alice or alice.dusk.
- Linked Dusk's Terms of use and Privacy policy in Settings, under About.
- Said about what each way of staking pays a year, beside the choice: native staking across the network lately, and Sozu after its fee.
- Warned about a recipient listed as compromised or a scam, on Send and in a site's request, and sent it nothing.
- Added Activity to the full view's sidebar.
- Added Forgot your password? to the unlock screen: a restore from the recovery phrase that keeps the same wallet's contacts.
- Showed Sozu's fees on Liquid staking as its contract has them: its share of rewards, the deposit fee and no fee to unstake.
- Showed Sozu's deposit fee on each stake as it's typed and on Review, and took it off what the stake gets.
- Turned staking with Sozu off while Sozu has paused deposits or they can't be checked, and warned while its pool is synchronizing.
- Read Sozu's terms again before sending a stake, and showed them for another Confirm when they changed.
- Showed the 1 DUSK bridge fee and what arrives on BNB Smart Chain when paying the bridge's account, in its approval and on Send's Review.
- Said that the testnet bridge to Sepolia isn't running right now, in its approval and on Send's Review.
- Added Export to Activity: the rows listed as a CSV file with the web wallet's columns, your contact names only when asked.
- Showed a site's payment to the bridge's account as a bridge to BNB Smart Chain, or Ethereum (Sepolia) on Testnet, with the memo as the recipient there, and a warning when the memo isn't an address there.
- Said at the top of a test network, in the popup, the full view and site approvals, that test DUSK has no value.
- Read the DuskEVM bridge's deposit, prove and claim calls on Testnet in their approvals: amount and recipient, marked as a known bridge call.
- Accepted a gas limit without a price from sites, at the node's gas price.
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
- Saved contacts from `.dusk` names, keeping the name and checking it again before it's an hour old.
- Added a Disconnect for each connected site, and custom gas under Settings' Advanced.
- Showed a new wallet how to get its first DUSK, with Receive, instead of empty Tokens and NFTs.
- Added a spinner on the network pill while the wallet switches network.
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

- Kept site connections, sends and DuskEVM arrivals per wallet: a site connected to one wallet sees nothing of another.
- Said on Forgot your password? and Reset wallet that they remove every recovery phrase here.
- Named a send's recipient in Activity by its verified `.dusk` name before the name typed when sending.
- Showed a failed shield's details as a shield's, from the public balance to the shielded one.
- Dropped Submitted and Shielded reservation from a send's Technical details once the chain's history has all of it.
- Named DUSK bridged to and from BNB Smart Chain and Ethereum in Activity by their routes, To BNB Smart Chain and From Ethereum, under Bridge, with the bridge's account it went through.
- Named a `.dusk` name's reservation in Activity by the name its registration reveals, else Name reservation (step 1 of 2).
- Said on Send that a pasted 0x address is an EVM address, not a Dusk account, and kept Review off.
- Called a failed shield Shield attempt (failed) in Activity, and one that went through Shield, not Call convert.
- Named Dusk Domains' contracts in Technical details, and every named contract in approvals, as the explorer does.
- Said under Reset what it removes, and that your funds stay on Dusk.
- Hid Sozu's deposit fee in DUSK while balances are hidden, on the stake form and its Review.
- Worked out Sozu's yearly estimate from native staking's figure as shown, as the web wallet does, and added Not promised.
- Moved Sozu's contract from the stake form to its Review, under Custom fee.
- Dropped the note that a failed call is charged its whole gas limit.
- Said what's visible to everyone only on sends, not on staking Reviews or the bridge, allowance and other contract approvals.
- Shortened EVM addresses and transactions to 0x and four characters at each end, addresses with their checksum, and Dusk IDs to six at each end in approvals and notifications too.
- Renamed Exact fee to Fee paid under Technical details, and Function to Method in approvals.
- Showed stDUSK estimates to 4 decimals.
- Said only that native staking needs your own Dusk node, with Run a node to Dusk's docs on running one.
- Wrote dates and times as every Dusk app does: in English, on the language's clock, as "Mon 26 Oct 2026, 2:32 PM CET", in the export too.
- Wrote Dusk contract IDs without 0x, and an ellipsis as one character.
- Wrote fees under 0.01 DUSK to 2 significant digits, a maximum still rounded up.
- Said "no fee" on a failed row that paid none, not "fee 0 DUSK paid".
- Found the network by the chain ID its node gives, not its address: a custom node gets its network's names, Sozu, bridge, explorer and history, and one that hasn't said is Custom, not Mainnet.
- Named the contracts and accounts the network's file names, in Activity and Technical details.
- Named the bridge's chains as the network's routes do: BNB Smart Chain, and Sepolia on Testnet.
- Led a withdrawal's prove and claim approvals with what they cost, then the withdrawal.
- Named the connected site in the popup as its approval did: with its port, and http:// for a local one.
- Marked the popup's top row as its header and its page as main, for screen readers.
- Showed a profile's `.dusk` name beside its short account in the profile switcher.
- Said that native staking's Max keeps both fees: this stake's and the one to unstake later.
- Named a `.dusk` name's registration in Activity by the name it registered.
- Moved a contract call's contract from under its title to Technical details, with Copy.
- Hid a failed row's fee in Activity while balances are hidden.
- Said that unstaking from Sozu returns the DUSK in the same transaction, with no fee and no waiting.
- Gave stakes with Sozu a 5M gas limit and unstakes 10M, at the network's price, never under 2.5M and 4M.
- Showed a deposit to DuskEVM as To its DuskEVM address in Activity and its details, with Copy.
- Put the test network strip across the top of the full view, and kept it and the sidebar in place as the page scrolls.
- Asked to unlock before showing Contacts.
- Set section heads and balance labels in small capitals, the heads between grey brackets.
- Showed links and a transaction's ID in blue.
- Set addresses, IDs and block heights in Söhne Mono.
- Wrote times of day in the browser's own format, as the web wallet does.
- Shortened Staking's section head to Stake.
- Warned on a contact's page when its saved `.dusk` name has expired, isn't registered or has no address any more.
- Named whom a token approval lets spend in Activity, showed an allowance of 0 as a revoke, and listed approvals in the spender's contact Activity.
- Named the eye button Show balances while balances are hidden.
- Moved what a site's payment makes visible to everyone up, under the amount, in its approval window.
- Set every extension page's language to English.
- Showed the time zone with full dates and times in a transaction's details, the Sent screen and approvals.
- Moved Delete all contacts to Settings' Advanced, asking first, and showed each contact by its first letter.
- Kept Confirm and Approve off while a custom gas limit is under the minimum or the gas price is 0, with the reason under the field.
- Showed under Custom fee what the gas limit and price come to in DUSK.
- Showed a transaction's exact fee under Technical details.
- Said plainly that staking needs some public DUSK for the network fee, without an error before anything is typed.
- Kept Max on Staking to 4 decimals, and left the fee to unstake later.
- Named the profile on both staking Reviews by its `.dusk` name, and repeated before Confirm that it needs your own Dusk node.
- Showed on Sozu's Review what the stDUSK is worth now, and said why a contract call's fee cap is higher.
- Led Activity and a transaction's details with a saved contact's own name, its `.dusk` name beside it.
- Named Dusk Domains calls in Activity by what they did, such as "Registered a .dusk name", and Sozu's as "Staked with Sozu".
- Kept a deposit to DuskEVM's recipient with the transaction and showed it in its details.
- Stopped offering Add token and Import NFT on a contract call's details.
- Gave the site approval windows the calm look, with Reject and the approve button always in view, and the chain, node, function, call data and the site's own details under Details.
- Led a site's payment approval with the amount, the recipient's name and the fee.
- Said in the connect approval what a site sees and that it can't move funds without your approval, with its own wording for a request for the shielded address.
- Showed a saved contact's label beside the recipient's verified `.dusk` name in approvals, instead of in its place.
- Said on a public transfer's approval what becomes visible to everyone, and under which name.
- Showed what a site asks while the wallet is locked, with Reject beside Unlock.
- Showed the exact amount a site asks to send, every decimal.
- Refused `dusk_signMessage` strings that aren't hex or `base64:`-prefixed, instead of reading plain text as base64.
- Gave the popup a calmer look: lists on one surface, pill buttons, round home actions and plain section titles, in each system's own fonts.
- Reworked Staking into an overview with native and liquid staking as two equal choices, an amount screen that checks the 1,000 DUSK minimum as you type, and the owner and stake account under Advanced.
- Named Sozu as a third party wherever liquid staking shows, and said how much stDUSK a stake gets and what it's worth now.
- Showed toasts at the bottom of the popup, outside the page that scrolls, long enough to reach their action, and announced to screen readers.
- Showed errors under their field instead of only in a toast.
- Hid amounts in toasts and on the Sent screen while balances are hidden.
- Showed every amount and fee in one format: at most 4 decimals, no trailing zeros, thousands grouped, with DUSK; a fee's maximum rounds up, a fee paid to the nearest.
- Set fees at the network's gas price, with one Custom fee for your own limit and price, and a warning under the minimum gas limit as you type.
- Restyled Send, Shield and Unshield: one large amount field, what's available after fees with Max, and errors under the field.
- Stopped offering Save to Contacts for your own account or address.
- Restyled Receive, Contacts and Settings, and showed what a `.dusk` name reaches under it on Receive.
- Restyled the token and NFT screens, onboarding and Unlock, and kept the full view's pages to one readable column.
- Shortened every Dusk address, contract ID and transaction ID the same way, to its first and last six characters.
- Named a profile without a `.dusk` name by its label in the header, with its account in the tooltip and the profile switcher.
- Named profiles by their verified `.dusk` names in Settings and its profile pickers.
- Offered auto-lock after 5 or 15 minutes, 15 by default, or Off; an open popup nobody uses locks too.
- Asked before disconnecting all sites, and moved Reset wallet to the end of Settings.
- Showed Activity's rows with a direction icon and the other side's name first; a failed one says nothing was sent and the fee paid.
- Showed a synced transaction's time from its block, or Syncing… until its outcome comes.
- Reworked a transaction's details into a summary of who, how much and its status, then its date, memo, fee, profile and ID, with block and gas under Technical details.
- Hid Activity's amounts and a transaction's amount while balances are hidden; fees stay visible.
- Said known chain errors in plain words, with the chain's own under Technical details.
- Moved the account's explorer link from Home's History ↗ to the end of Activity, on the Dusk explorer instead of DuskScan.
- Cleared the wallet's transactions, shielded notes and history on reset.
- Removed Review's Cancel. ([#126])
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

- Encrypted contacts with a key only the unlocked wallet has, kept apart for each wallet, and moved plain ones in on the first unlock.
- Deleted contacts on Reset wallet, and started a new or imported wallet with none.
- Rejected non-integer and out-of-u8-range profile indices before BLS key derivation. ([#117])
- Pinned direct Noble dependencies to exact reviewed versions. ([#22])
- Typed-data signatures cover a domain-separated message rather than the bare 32-byte digest, so they cannot be produced by, or replayed as, a signature over a caller-supplied digest.

### Fixed

- Kept looking for a bridge transfer's payment after a search missed it, rather than waiting for it for good.
- Said Arrived on an earlier deposit to DuskEVM also after a later one was sent, and waited for a deposit the archive doesn't list yet rather than taking another's payment.
- Showed amounts under 0.01 DUSK to two significant digits, as the other Dusk apps do.
- Sent nothing to a .dusk name whose public account isn't a valid key.
- Named a call that replaces a .dusk name's records in Activity, as one that changes them.
- Named only calls to Sozu's own pool as Sozu stakes and unstakes in Activity.
- Kept a contract's "·" with its short ID and Copy when its row wraps.
- Refused a stake with Sozu too small to get any stDUSK, and said the minimum.
- Kept Confirm off on Send's Review when the bridge's 1 DUSK fee takes the whole amount.
- Underlined links in a row's text, such as Run a node.
- Fixed links sitting higher than the section head beside them.
- Hid controls that showed while hidden: Review's Use the network's price, Max on an empty Send, and Settings' custom gas fields when off.
- Kept a profile label being typed when Settings redraws, and saved it when the field is left.
- Made the profile and network menus work from the keyboard.
- Gave every popup screen a heading for screen readers.
- Accepted a `Uint8Array` message in `dusk_signMessage` in Chrome, whose extension messaging turns it into an object.
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
- Waited for the archive to have every block a shielded history needs, rather than keep it incomplete.
- Marked an unshield as Shielded in the export.
- Marked a deposit to DuskEVM Arrived only on the bridge's payment of a deposit from the same account.

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
