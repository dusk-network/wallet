# Dusk Wallet Roadmap

> Production readiness plan for the multi-platform Dusk wallet.

## Current Status

| Platform | Status | Notes |
|----------|--------|-------|
| Chrome Extension | ✅ Ready | MV3, full feature set |
| Firefox Extension | 🟡 In Progress | Engine page + static worker landed; QA pending |
| Desktop (Tauri) | 🟡 Tested | Works, needs final polish |
| Android (Tauri) | 🟡 Tested | Works, needs final polish |
| iOS (Tauri) | 🟡 Scaffold | Needs device testing |

---

## Phase 1: Security Hardening 🔴

**Priority: Critical**

### 1.1 Cryptographic Improvements
- [x] Increase PBKDF2 iterations from 10,000 → 900,000
- [x] Add rate limiting on vault unlock (exponential backoff)
- [x] Audit mnemonic memory lifecycle
- [x] Remove legacy vault format support

### 1.2 Content Security Policy
- [x] Define strict CSP for Tauri (`"csp": null` currently)
- [x] Ensure extension CSP blocks inline scripts

### 1.3 Security Testing
- [x] Unit tests for `crypto.js`
- [x] Unit tests for `vault.js`
- [x] Integration tests for `shieldedStore.js`
- [x] Document threat model in `SECURITY.md`

---

## Phase 2: Test Coverage 🟠

**Priority: High**

Current: 93% on shared utilities, core engine untested.

### 2.1 Core Engine Tests
- [x] `walletEngine.js` (1700+ lines) — Mock w3sper, test tx flows
- [x] `shieldedStore.js` — IndexedDB operations
- [x] `permissions.js` — Origin-based access control

### 2.2 Background Tests
- [x] `rpc.js` — dApp RPC handler
- [x] `pending.js` — Approval queue
- [x] `dappEvents.js` — Event broadcasting

### 2.3 Integration Tests
- [x] E2E: unlock → send tx → verify
- [x] dApp connection flow

---

## Phase 3: Platform Completion 🟠

**Priority: High**

### 3.1 Firefox Extension
- [x] MV3 compatibility pass (background scripts, API adapter)
- [x] Offscreen alternative via `engine.html` page host
- [x] Static EXU sandbox worker (avoid blob worker CSP)
- [ ] QA unlock/import/tx flows on Firefox stable
- [ ] Submit to Firefox Add-ons

### 3.2 Desktop (Tauri)
- [ ] Final testing on Windows, macOS, Linux
- [ ] Auto-update mechanism
- [ ] Installers (`.msi`, `.dmg`, `.deb`)
- [ ] Deep link handling (`dusk:` URI)

### 3.3 Mobile (Tauri)
- [ ] Final testing on Android/iOS physical devices
- [ ] Biometric unlock (fingerprint/Face ID)
- [ ] Push notifications for tx confirmation
- [ ] App store submission

---

## Phase 4: Feature Enhancements 🟡

**Priority: Medium**

### 4.1 Staking
- [ ] Stake/unstake flows
- [ ] Rewards display
- [ ] Validator selection (TBD: if this is actually meaningful in Dusk; today it is mostly "your stake keys" rather than delegation)

### 4.2 Transactions (Core UX)
- [ ] Better gas estimation UI (quick win, see Phase 5; use Rusk gas price stats endpoint)

### 4.3 Assets (DRC20 / DRC721)

Goal: users should be able to manage common on-chain assets (tokens + NFTs) in-wallet, similar to the "Tokens" / "NFTs" tabs in Ethereum wallets.

- [ ] **DRC20 (tokens):** add a wallet UI to "watch/import" a token by `contractId` (per-network), fetch `{ name, symbol, decimals }`, and display balance (public only).
- [ ] **DRC20 (send):** add a send flow that builds `contract_call` transactions for `transfer(TransferCall)` using a canonical DRC20 data-driver for encoding.
- [ ] **DRC20 (approvals):** add an approval flow for `approve(ApproveCall)` with safer defaults (exact amount), plus an explicit one-click "MAX" option with strong warnings (spender, amount, token).
- [ ] **DRC721 (NFTs):** add an "Import NFT" flow by `{ contractId, token_id }` (MetaMask-style), verify ownership via `owner_of`, and display metadata using `token_uri`.
- [ ] **Auto-discovery (lightweight):** after the user successfully submits a DRC20/DRC721 tx (transfer/approve/etc), offer to add that token/NFT to their watched assets list.
- [ ] **NFT privacy controls:** default to fetching metadata/images, but offer a setting to disable remote metadata/image fetches (token URI may be HTTP/IPFS and can leak usage patterns).
- [ ] **Activity UX:** label locally-submitted DRC20/DRC721 actions in the activity feed (even without full inbound history/indexing).

---

## Phase 5: Developer Experience 🟡

**Priority: Medium**

### 5.0 dApp Provider + Dusk Connect Parity

Goal: make the injected provider (`window.dusk`) + the SDK (`@dusk-network/connect`, "Dusk Connect") feel as predictable for dApp developers as `window.ethereum` + common Ethereum SDKs.

#### 5.0.1 Decide Canonical dApp API Surface
- [x] Decision: dApps can read **public** state only (accounts via `dusk_requestAccounts`/`dusk_accounts`, chain, public balance) and submit transactions via `dusk_sendTransaction`.
- [x] Decision: the provider must not expose shielded addresses/balances/sync state to dApps. `dusk_getAddresses` is not part of the dApp/provider surface (shielded stays internal to the wallet UI).
- [x] Implementation: remove/disable `dusk_getAddresses` in the dApp RPC handler (return `4200`) and remove it from docs/SDK.

#### 5.0.2 Fix Current Mismatches (Docs/SDK/Engine)
- [x] **Calldata limit:** align `fnArgs` max across docs + dApp RPC + engine (currently docs/rpc allow 128 KiB, engine enforces 64 KiB).
- [x] **Transfer recipient type:** document/encode that `transfer.to` can be a public account or a shielded address; fix approval UI label to not imply "account only".
- [x] **dApp tx kinds:** either support `shield`/`unshield` in dApp approvals, or explicitly reject them from dApps (`4200`) and document it.
- [x] **Contract calls privacy selection:** add `privacy: "public" | "shielded"` for `contract_call` so dApps can request Phoenix vs Moonlight without needing a `to` field.
- [x] Ensure the Dusk Connect SDK types match the canonical provider surface (including the transfer recipient type).

#### 5.0.3 Capability Discovery / Versioning
- [x] Add a provider capability RPC (e.g. `dusk_getCapabilities` or `dusk_providerInfo`) returning supported RPC methods + transaction kinds.
- [x] Include limits in capabilities (e.g. `maxFnArgsBytes`).
- [x] Include feature flags in capabilities (shielded read/sync availability, signing availability).
- [x] Include provider + wallet version identifiers in capabilities.
- [x] Update Dusk Connect to use capabilities for feature detection (avoid hard-coding method lists).
- [x] Add conformance tests in the wallet repo that assert: docs == implementation == SDK expectations.

#### 5.0.4 Signing (Ethereum Parity Gap)
- [x] Design + implement a Dusk-native signing API for dApps:
  - `dusk_signMessage` (generic, arbitrary bytes; always domain-separated)
  - `dusk_signAuth` (canonical login/auth envelope including origin + chainId + nonce/timestamps)
- [x] Add an approval UI for signing requests (separate from tx approvals).
- [x] Add SDK helpers for signing and common dApp auth flows.

#### 5.0.5 Multi-Account & Permissions (Provider-Level)
- [x] UI: account switching + per-origin account selection (align with provider behavior: which account is exposed to a site).
- [x] Provider semantics: single-account-per-origin (array length 0 or 1), MetaMask-like account picker on connect.
- [x] Add provider events semantics for account switching (consistent `accountsChanged` behavior).

### 5.1 Documentation
- [x] `ARCHITECTURE.md` — System deep-dive
- [x] `SECURITY.md` — Threat model
- [x] `CONTRIBUTING.md` — Contribution guide
- [x] `AGENTS.md` — AI agent context
- [x] `provider-api.md` — Keep in lockstep with `src/background/rpc.js` + Dusk Connect SDK

### 5.2 Tooling
- [x] Integration test node via Docker image (`dusknode/rusk`) instead of mocking
- [x] Storybook for UI components
- [x] E2E test harness (Playwright)

### 5.3 CI/CD
- [x] GitHub Actions (test, build)
- [x] Automated releases on tags
- [x] Coverage badges in README

### 5.4 Wallet UX Quick Wins
- [x] Multi-account: account switching UI in the main wallet UI (not only in Settings/Options)
- [x] Multi-account: enforce Dusk standard max of 2 profiles (note scanning cost scales with profiles)
- [x] Multi-account: per-account naming (persisted per `walletId`)
- [x] Activity view: polish the existing activity feed (local submitted/executed statuses, explorer links)
- [x] Transactions: better gas estimation UI (use Rusk gas price stats, show recommended + range)

### 5.5 Token Standards (DRC20 / DRC721) via Data-Drivers

Goal: for token/NFT contracts that follow the DRC standards, dApp developers should get ERC20/ERC721-like ergonomics in the SDK, and users should see verified, human-readable approvals in the wallet (not just opaque bytes).

- [ ] **Provider:** implement an EIP-747-like "watch asset" request so dApps can prompt users to add a token/NFT to the wallet UI (approval required).
  - Proposed RPC: `dusk_watchAsset` with `type: "DRC20" | "DRC721"` and options like `{ contractId, symbol?, decimals?, image?, tokenId? }`.
  - Wallet must verify on-chain metadata (via contract views) before persisting.
- [ ] **Wallet approvals (verified decode):** for DRC20/DRC721 calls (`transfer`, `approve`, `transfer_from`, `set_approval_for_all`), decode args using a canonical data-driver and show a specialized approval screen (amount formatted with decimals, token symbol, spender/to/from, high-risk warnings).
- [ ] **SDK wrappers:** add `drc20` / `drc721` helper modules built on `createDuskContract()`:
  - typed `read` (`name/symbol/decimals/balance_of/allowance/...`)
  - typed `write` (`transfer/approve/transfer_from/...`)
  - standardized `display` builders so approvals stay consistent across dApps.
- [ ] **SDK examples:** add `examples/drc20-demo` and `examples/drc721-demo` consuming the canonical `data_driver.wasm` artifacts.
- [ ] **Conformance tests:** add tests that assert the canonical drivers can:
  - encode inputs that the chain accepts, and
  - decode outputs/events for the standard methods.

---

## Phase 6: Large / Risky Projects 🟢

**Priority: Low**

### 6.1 Key Derivation Upgrade (EIP-2334)
- [ ] Adopt EIP-2334 derivation for Moonlight (BLS) accounts (requires backward compatibility)
- [ ] Add a migration UX (legacy → EIP) for existing wallets
- [ ] Support dual-scheme restore/import (scan legacy + EIP and let the user choose)

### 6.2 Provisioner/Staking Key Export (Extension)
- [ ] Export node-compatible provisioner keys (`.keys` + `.cpk`) from the wallet UI
- [ ] Requires protocol driver / `wallet-core` changes to allow deriving/exporting the BLS secret key bytes safely (JS can handle encryption + file format)

### 6.3 Advanced Transactions (Protocol Dependent)
- [ ] Cancel/speed-up pending tx (only if Dusk supports replace-by-nonce semantics)
- [ ] Batch transactions (only if Dusk supports an atomic batch mechanism)

### 6.4 History (Archive Node)
- [ ] Full transaction history via archive node (GraphQL) with filtering/pagination
- [ ] Token/NFT indexing on top of archive history (inbound/outbound transfers, NFT galleries, allowance/approval discovery)

---

## Phase 7: Future 🟢

**Priority: Low**

- [ ] WalletConnect v2 integration
- [ ] Dusk naming service (if available)

> **Note:** Hardware wallet support (Ledger/Trezor) is not currently feasible because Dusk uses BLS signatures, which existing hardware wallets do not support.

---

## Technical Debt

| Location | Issue | Effort |
|----------|-------|--------|
| `Identicon.js` | TODO: Consider library | Low |
| `shieldedStore.js` | Abstract for Tauri SQLite | High |

---

## Success Metrics

Before declaring "production ready":

1. **Security audit** — External review of crypto + vault
2. **Test coverage** — 80%+ on critical paths
3. **Platform verification** — All targets tested on real devices
4. **Performance** — Unlock < 1s, tx submit < 2s
5. **Accessibility** — Keyboard navigation, screen reader support

---

## Priority Legend

- 🔴 **Critical** — Security, blocking issues
- 🟠 **High** — Core functionality, test coverage
- 🟡 **Medium** — Features, DX improvements
- 🟢 **Low** — Nice-to-have, future work
