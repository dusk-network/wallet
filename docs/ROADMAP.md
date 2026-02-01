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
- [ ] Consider Argon2id for browser vault (WebAssembly)

### 1.2 Content Security Policy
- [ ] Define strict CSP for Tauri (`"csp": null` currently)
- [ ] Ensure extension CSP blocks inline scripts

### 1.3 Security Testing
- [x] Unit tests for `crypto.js`
- [ ] Unit tests for `vault.js`
- [ ] Integration tests for `shieldedStore.js`
- [ ] Document threat model in `SECURITY.md`

---

## Phase 2: Test Coverage 🟠

**Priority: High**

Current: 93% on shared utilities, core engine untested.

### 2.1 Core Engine Tests
- [ ] `walletEngine.js` (1700+ lines) — Mock w3sper, test tx flows
- [ ] `shieldedStore.js` — IndexedDB operations
- [ ] `permissions.js` — Origin-based access control

### 2.2 Background Tests
- [ ] `rpc.js` — dApp RPC handler
- [ ] `pending.js` — Approval queue
- [ ] `dappEvents.js` — Event broadcasting

### 2.3 Integration Tests
- [ ] E2E: unlock → send tx → verify
- [ ] dApp connection flow

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

### 4.1 Multi-Account
- [ ] Account switching UI
- [ ] Per-account naming
- [ ] Account-specific history

### 4.2 Staking
- [ ] Stake/unstake flows
- [ ] Rewards display
- [ ] Validator selection

### 4.3 Transactions
- [ ] History with filtering
- [ ] Cancel/speed-up pending tx
- [ ] Better gas estimation UI
- [ ] Batch transactions

---

## Phase 5: Developer Experience 🟡

**Priority: Medium**

### 5.1 Documentation
- [x] `ARCHITECTURE.md` — System deep-dive
- [x] `SECURITY.md` — Threat model
- [x] `CONTRIBUTING.md` — Contribution guide
- [x] `AGENTS.md` — AI agent context

### 5.2 Tooling
- [ ] Mock Rusk node for testing
- [ ] Storybook for UI components
- [ ] E2E test harness (Playwright)

### 5.3 CI/CD
- [x] GitHub Actions (test, build)
- [x] Automated releases on tags
- [ ] Coverage badges in README

---

## Phase 6: Future 🟢

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
