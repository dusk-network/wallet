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
- [ ] Integration test node via Docker image (`dusknode/rusk`) instead of mocking
- [ ] Storybook for UI components
- [ ] E2E test harness (Playwright)

### 5.3 CI/CD
- [x] GitHub Actions (test, build)
- [x] Automated releases on tags
- [ ] Coverage badges in README

### 5.4 Wallet UX Quick Wins
- [ ] Multi-account: account switching UI in the main wallet UI (not only in Settings/Options)
- [x] Multi-account: enforce Dusk standard max of 2 profiles (note scanning cost scales with profiles)
- [ ] Multi-account: per-account naming (persisted per `walletId`)
- [ ] Activity view: polish the existing activity feed (local submitted/executed statuses, explorer links)
- [ ] Transactions: better gas estimation UI (use Rusk gas price stats, show recommended + range)

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
