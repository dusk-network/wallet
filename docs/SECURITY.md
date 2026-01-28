# Security

> Threat model and security considerations for Dusk Wallet.

## Overview

Dusk Wallet is a self-custody wallet — users control their own keys. This document outlines security measures, known limitations, and recommendations.

---

## Threat Model

### Assets to Protect

| Asset | Sensitivity | Storage |
|-------|-------------|---------|
| Mnemonic phrase | **Critical** | Encrypted in vault |
| Private keys | **Critical** | Derived in-memory from mnemonic |
| Shielded notes | High | IndexedDB (per-network) |
| dApp permissions | Medium | Platform storage |
| User settings | Low | Platform storage |

### Threat Actors

1. **Malicious websites** — XSS, phishing, fake dApps
2. **Browser extensions** — Malicious or compromised extensions
3. **Local attackers** — Physical access to device
4. **Network attackers** — MITM, malicious nodes
5. **Supply chain** — Compromised dependencies

---

## Security Measures

### 1. Mnemonic Protection

#### Encryption at Rest

| Platform | Algorithm | Parameters |
|----------|-----------|------------|
| Extension | PBKDF2 + AES-GCM-256 | 10,000 iterations (TODO: increase) |
| Tauri | Stronghold + Argon2 | OS-level encrypted storage |

```js
// Extension vault encryption
const key = await crypto.subtle.deriveKey(
  { name: "PBKDF2", salt, iterations: 10000, hash: "SHA-256" },
  passwordKey,
  { name: "AES-GCM", length: 256 },
  false,
  ["encrypt", "decrypt"]
);
```

#### Memory Lifecycle

- Mnemonic held in JavaScript heap after unlock
- Cleared on explicit lock or auto-lock timeout
- **Limitation**: Cannot guarantee memory zeroization in JavaScript

#### Recommendations

- [ ] Increase PBKDF2 iterations to 100,000+
- [ ] Consider WebAssembly Argon2 for browser
- [ ] Add rate limiting on unlock attempts

### 2. Auto-Lock

The wallet automatically locks after a configurable timeout:

| Setting | Options |
|---------|---------|
| Auto-lock timeout | 1, 5, 15, 30, 60 minutes |
| Default | 5 minutes |

Implementation uses `chrome.alarms` API for reliable timing even when service worker sleeps.

### 3. dApp Permissions

#### Origin-Based Access Control

- Each origin must explicitly request connection
- User approves via popup before granting access
- Permissions stored per-origin with connected accounts

```js
// Permission record
{
  "https://dapp.example.com": {
    accounts: ["2Z8m..."],
    connectedAt: 1706400000000,
  }
}
```

#### RPC Method Security

| Method | Requires Connection | Requires Unlock |
|--------|--------------------|-----------------| 
| `dusk_requestAccounts` | No (grants it) | No |
| `dusk_accounts` | No | No |
| `dusk_chainId` | No | No |
| `dusk_getPublicBalance` | Yes | Yes |
| `dusk_sendTransaction` | Yes | Yes |
| `dusk_estimateGas` | Yes | No |

#### User Approval for Transactions

All `dusk_sendTransaction` calls require explicit user approval via a popup window. Users can:
- Review transaction details
- Adjust gas settings
- Approve or reject

### 4. Content Security Policy

#### Extension

Manifest V3 enforces strict CSP by default:
- No inline scripts
- No `eval()`
- No remote code execution

#### Tauri

**Current state**: `"csp": null` (disabled)

**TODO**: Define strict CSP:
```json
{
  "csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'"
}
```

### 5. Network Security

#### Node Communication

- All node communication over HTTPS
- Users can configure custom node URLs
- No hardcoded API keys or secrets

#### Prover Communication

- Prover receives transaction circuits (no private keys)
- Timeouts prevent hanging connections
- Fallback to node URL if prover fails

### 6. Extension Isolation

#### Content Script Isolation

- Content scripts run in isolated world
- Cannot access page JavaScript context
- Provider injected via script tag with controlled interface

#### Service Worker

- No DOM access (by design)
- Wallet engine runs in offscreen document
- Message passing with validation

---

## Known Limitations

### 1. JavaScript Memory

JavaScript does not provide memory zeroization guarantees. Private keys and mnemonic remain in heap memory until garbage collected.

**Mitigation**: Lock wallet when not in use; rely on OS-level protections.

### 2. Browser Extension Trust

Users must trust:
- The extension itself (install from official source)
- Other installed extensions (could attempt to steal data)

**Mitigation**: Minimal permissions requested; no `<all_urls>` in manifest.

### 3. IndexedDB Encryption

Shielded notes are stored in IndexedDB without encryption.

**Risk**: Local attacker with file system access could read notes.

**Mitigation**: Consider encrypting IndexedDB contents; rely on OS-level encryption.

### 4. PBKDF2 Iteration Count

Current iteration count (10,000) is below modern recommendations.

**Risk**: Faster brute-force attacks on weak passwords.

**TODO**: Increase to 100,000+ iterations; consider Argon2.

### 5. No Hardware Wallet Support

Dusk uses BLS12-381 signatures, which Ledger/Trezor do not support.

**Status**: Not possible with current hardware wallet firmware.

---

## Security Checklist

### For Users

- [ ] Use a strong, unique password for the wallet
- [ ] Write down mnemonic phrase and store securely offline
- [ ] Enable auto-lock with short timeout
- [ ] Verify transaction details before approving
- [ ] Only connect to trusted dApps
- [ ] Keep browser and extensions updated

### For Developers

- [ ] Never log sensitive data (mnemonic, private keys)
- [ ] Validate all message inputs
- [ ] Use strict CSP in Tauri builds
- [ ] Keep dependencies updated
- [ ] Run security-focused code review for crypto code

---

## Incident Response

### If Mnemonic is Compromised

1. Immediately transfer funds to a new wallet
2. Create new wallet with fresh mnemonic
3. Revoke all dApp permissions on compromised wallet

### If Extension is Compromised

1. Uninstall extension immediately
2. Assume mnemonic is compromised
3. Follow mnemonic compromise steps above

---

## Security Audits

**Status**: No external audit completed yet.

**Recommendation**: Before production release, conduct:
1. Cryptographic implementation review
2. Smart contract interaction audit
3. Browser extension security audit

---

## Reporting Vulnerabilities

If you discover a security vulnerability, please:

1. **Do not** open a public GitHub issue
2. Email security concerns to [maintainer email]
3. Include detailed reproduction steps
4. Allow reasonable time for fix before disclosure

---

## References

- [Chrome Extension Security](https://developer.chrome.com/docs/extensions/mv3/security/)
- [Tauri Security](https://tauri.app/v1/references/architecture/security/)
- [OWASP Cryptographic Storage](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html)
- [BIP39 Mnemonic Standard](https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki)
