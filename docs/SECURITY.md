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
| Extension | PBKDF2 + AES-GCM-256 | 900,000 iterations |
| Tauri | Stronghold + Argon2 | OS-level encrypted storage |

```js
// Extension vault encryption
const key = await crypto.subtle.deriveKey(
  { name: "PBKDF2", salt, iterations: 900000, hash: "SHA-256" },
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

- Keep PBKDF2 iterations aligned with industry guidance (currently 900,000)
- Keep rate limiting on unlock attempts (exponential backoff)

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
- Permissions stored per-origin with the selected profile/account index and grants

```js
// Permission record
{
  "https://dapp.example.com": {
    profileId: "account:0:...",
    accountIndex: 0,
    grants: {
      publicAccount: true,
      shieldedReceiveAddress: false
    },
    connectedAt: 1706400000000,
  }
}
```

#### RPC Method Security

| Method | Permission Required | Unlock Required |
|--------|---------------------|-----------------|
| `dusk_getCapabilities` | No | No |
| `dusk_requestProfiles` | No (grants it) | Yes (prompt) |
| `dusk_profiles` | Yes (returns `[]` otherwise) | Yes (returns `[]` otherwise) |
| `dusk_requestShieldedAddress` | No (grants or upgrades it) | Yes (prompt) |
| `dusk_chainId` | No | No |
| `dusk_switchNetwork` | Yes | No |
| `dusk_getPublicBalance` | Yes | Yes |
| `dusk_estimateGas` | Yes | No |
| `dusk_sendTransaction` | Yes | Yes |
| `dusk_watchAsset` | Yes | Yes |
| `dusk_signMessage` | Yes | Yes |
| `dusk_signAuth` | Yes | Yes |
| `dusk_disconnect` | No | No |

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

The public repository does not currently include a native Tauri wrapper, so there is no checked-in `tauri.conf.json` to audit here.

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

**Mitigation**: Keep requested permissions minimal and review `host_permissions` regularly (broad host access increases blast radius).

### 3. IndexedDB Encryption

Shielded notes are stored in IndexedDB without encryption.

**Risk**: Local attacker with file system access could read notes.

**Mitigation**: Consider encrypting IndexedDB contents; rely on OS-level encryption.

### 4. PBKDF2 Iteration Count

Current iteration count is 900,000.

**Risk**: Brute-force resistance still depends on password strength.

**Mitigation**: Maintain a high iteration count and monitor guidance for updates.

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
- [ ] Use strict CSP in any native wrapper builds
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
2. Report it privately through GitHub Security Advisories:
   https://github.com/dusk-network/wallet/security/advisories/new
3. Include detailed reproduction steps
4. Allow reasonable time for fix before disclosure

---

## References

- [Chrome Extension Security](https://developer.chrome.com/docs/extensions/mv3/security/)
- [Tauri Security](https://tauri.app/v1/references/architecture/security/)
- [OWASP Cryptographic Storage](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html)
- [BIP39 Mnemonic Standard](https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki)
