# Architecture

> Technical deep-dive into the Dusk Wallet architecture.

## Overview

Dusk Wallet is a multi-platform self-custody wallet supporting:

- **Browser Extension** (Chrome, Firefox planned)
- **Desktop** (Windows, macOS, Linux via Tauri)
- **Mobile** (Android, iOS via Tauri)

The architecture prioritizes:
1. **Security** — Mnemonic never leaves device, encrypted at rest
2. **Code reuse** — Shared core logic across all platforms
3. **dApp compatibility** — MetaMask-style provider API

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         User Interface                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────┐ │
│  │  Popup   │  │   Full   │  │ Notifi-  │  │   Options/       │ │
│  │  (420px) │  │  Window  │  │ cation   │  │   Settings       │ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────────┬─────────┘ │
└───────┼─────────────┼─────────────┼─────────────────┼───────────┘
        │             │             │                 │
        └─────────────┴──────┬──────┴─────────────────┘
                             │
┌────────────────────────────┼────────────────────────────────────┐
│                    Message Bus                                   │
│  ┌─────────────────────────┴─────────────────────────────────┐  │
│  │  Extension: chrome.runtime / Tauri: localBus (in-process) │  │
│  └─────────────────────────┬─────────────────────────────────┘  │
└────────────────────────────┼────────────────────────────────────┘
                             │
┌────────────────────────────┼────────────────────────────────────┐
│                    Background / Service                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────┐ │
│  │  RPC     │  │ Pending  │  │  dApp    │  │   Auto-lock      │ │
│  │ Handler  │  │ Approvals│  │  Events  │  │   Timer          │ │
│  └────┬─────┘  └──────────┘  └──────────┘  └──────────────────┘ │
└───────┼─────────────────────────────────────────────────────────┘
        │
┌───────┼─────────────────────────────────────────────────────────┐
│       │              Offscreen Document (Extension only)         │
│       │    ┌─────────────────────────────────────────────────┐  │
│       └───►│              Wallet Engine                      │  │
│            │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌────────┐ │  │
│            │  │ w3sper  │ │  Vault  │ │Shielded │ │ Tx     │ │  │
│            │  │ Network │ │  Crypto │ │ Store   │ │ Build  │ │  │
│            │  └─────────┘ └─────────┘ └─────────┘ └────────┘ │  │
│            └─────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                      External Services                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │  Rusk Node   │  │   Prover     │  │   Archiver           │   │
│  │  (HTTP/RUES) │  │   Service    │  │   (History)          │   │
│  └──────────────┘  └──────────────┘  └──────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Directory Structure

```
src/
├── background/           # Extension service worker
│   ├── index.js          # Entry point, message routing
│   ├── rpc.js            # dApp RPC handler
│   ├── offscreen.js      # Engine bridge (extension)
│   ├── pending.js        # Approval queue
│   ├── dappEvents.js     # Event broadcasting
│   └── txNotify.js       # Notifications
│
├── ui/
│   ├── popup/            # Main wallet interface
│   │   ├── app.js        # App shell, routing
│   │   ├── state.js      # Reactive state
│   │   ├── header.js     # Header component
│   │   └── views/        # Page views
│   │       ├── home.js
│   │       ├── send.js
│   │       ├── receive.js
│   │       ├── convert.js
│   │       ├── addressbook.js
│   │       ├── options.js
│   │       ├── txDetails.js
│   │       ├── locked.js
│   │       └── onboarding.js
│   ├── components/       # Reusable components
│   ├── notification/     # Approval popup
│   └── lib/              # UI utilities
│
├── shared/               # Platform-agnostic core
│   ├── walletEngine.js   # Main engine (1700+ lines)
│   ├── vault.js          # Secret storage
│   ├── crypto.js         # PBKDF2 + AES-GCM
│   ├── shieldedStore.js  # Phoenix note cache
│   ├── settings.js       # User preferences
│   ├── permissions.js    # dApp permissions
│   ├── txDefaults.js     # Gas defaults
│   ├── constants.js      # Enums, magic values
│   ├── chain.js          # Chain ID utilities
│   ├── network.js        # Network helpers
│   ├── errors.js         # Error codes
│   └── ...
│
├── platform/             # Platform abstraction
│   ├── runtime.js        # Platform detection
│   ├── storage.js        # Storage abstraction
│   └── assets.js         # Asset URLs
│
└── wallet/               # Message bus
    ├── bus.js            # Extension bus
    └── localBus.js       # Tauri in-process bus
```

---

## Platform Abstraction

### Runtime Detection

```js
// src/platform/runtime.js
export function isExtension() {
  return typeof chrome !== "undefined" && chrome.runtime?.id;
}

export function isTauri() {
  return "__TAURI__" in window;
}
```

### Storage

| Platform | Implementation |
|----------|----------------|
| Extension | `chrome.storage.local` |
| Tauri | `@tauri-apps/plugin-store` |
| Web (dev) | `localStorage` |

### Secret Storage

| Platform | Implementation |
|----------|----------------|
| Extension | PBKDF2 + AES-GCM-256 → chrome.storage |
| Tauri | Stronghold plugin with Argon2 |

---

## Extension Architecture

### Service Worker Limitations

Chrome MV3 service workers cannot:
- Access DOM APIs
- Use WebCrypto for certain operations
- Maintain long-running connections reliably

**Solution**: Offscreen document.

### Offscreen Document

The wallet engine runs in `offscreen.html`, a hidden DOM context:

```js
// background/offscreen.js
async function engineCall(method, params) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({
    type: "DUSK_ENGINE_CALL",
    method,
    params,
  });
}
```

The offscreen document (`src/offscreen.js`) receives these messages and calls the wallet engine directly.

### Firefox Engine Page (MV3)

Firefox does not support the offscreen document API. The Firefox build hosts the engine in
`engine.html` (a hidden extension page) and reuses the same `DUSK_ENGINE_CALL` message protocol.

### Message Flow

```
Content Script              Service Worker              Offscreen
     │                           │                          │
     │ DUSK_RPC_REQUEST          │                          │
     ├──────────────────────────►│                          │
     │                           │ DUSK_ENGINE_CALL         │
     │                           ├─────────────────────────►│
     │                           │                          │
     │                           │◄─────────────────────────┤
     │◄──────────────────────────┤                          │
     │                           │                          │
```

---

## Tauri Architecture

### Simplified Flow

Tauri doesn't need an offscreen document — everything runs in the same renderer process:

```js
// wallet/localBus.js
export async function localSend(message) {
  // Direct call to wallet engine
  if (message?.type === "DUSK_UI_SEND_TX") {
    const result = await sendTransaction(message.params);
    return { ok: true, result };
  }
}
```

### Native Plugins

| Plugin | Purpose |
|--------|---------|
| `plugin-store` | Persistent key-value storage |
| `plugin-stronghold` | Encrypted secret vault |
| `plugin-fs` | File system (for Argon2 salt) |

---

## Wallet Engine

The core logic lives in `src/shared/walletEngine.js` (~1700 lines).

### State Management

```js
const state = {
  unlocked: false,
  profiles: [],           // HD-derived key pairs
  currentIndex: 0,        // Active account index
  network: null,          // w3sper Network instance
  bookkeeper: null,       // w3sper Bookkeeper
  treasury: null,         // Balance queries
  shielded: {             // Phoenix state
    status: {},
    syncer: null,
  },
};
```

### Key Functions

| Function | Purpose |
|----------|---------|
| `unlockWithMnemonic()` | Derive keys, initialize engine |
| `lock()` | Clear sensitive state |
| `getPublicBalance()` | Query public account balance |
| `getShieldedBalance()` | Query Phoenix balance |
| `sendTransaction()` | Build and submit transactions |
| `getCachedGasPrice()` | Fetch gas prices (30s cache) |

### w3sper Integration

The wallet uses `@dusk/w3sper` for blockchain operations:

```js
import { Network, Bookkeeper, ProfileGenerator } from "@dusk/w3sper";

// Network connection
state.network = new Network(new URL(nodeUrl));
await state.network.connect();

// Balance queries
state.bookkeeper = new Bookkeeper(treasury);
const balance = await state.bookkeeper.balance(profile.account);

// Transaction building
const tx = state.bookkeeper.as(profile).transfer(amount).to(recipient);
const result = await state.network.execute(tx);
```

---

## dApp Provider

### Injection

The provider is injected into web pages via content script:

```js
// contentScript.js → injects inpage.js
window.dusk = {
  request({ method, params }) { ... },
  on(event, handler) { ... },
  // ...
};
```

### RPC Methods

| Method | Description |
|--------|-------------|
| `dusk_requestAccounts` | Request connection |
| `dusk_accounts` | Get connected accounts |
| `dusk_chainId` | Get current chain ID |
| `dusk_switchNetwork` | Switch networks |
| `dusk_getPublicBalance` | Get balance |
| `dusk_estimateGas` | Get gas prices |
| `dusk_sendTransaction` | Send transaction |
| `dusk_getAddresses` | Get shielded addresses |
| `dusk_disconnect` | Revoke permission |

See [provider-api.md](provider-api.md) for full documentation.

---

## Data Storage

### Settings

```js
// Stored in platform storage
{
  nodeUrl: "https://nodes.dusk.network",
  proverUrl: "",
  archiverUrl: "",
  autoLockMinutes: 5,
  // ...
}
```

### Vault (Encrypted Mnemonic)

```js
// Extension: chrome.storage.local
{
  dusk_vault: {
    ciphertext: "...",   // AES-GCM encrypted
    iv: "...",
    salt: "...",
  }
}
```

### Shielded Notes (IndexedDB)

```js
// Database: dusk_shielded_<network>_<walletId>
// Object stores per account index
{
  notes: [...],          // Phoenix notes
  nullifiers: [...],     // Spent note markers
  checkpoint: 12345,     // Sync height
}
```

### Permissions

```js
// Per-origin permission records
{
  "https://dapp.example.com": {
    accounts: ["2Z8m..."],
    connectedAt: 1706400000000,
  }
}
```

---

## Transaction Flow

### 1. User Initiates

```
UI (send.js) → DUSK_UI_SEND_TX → background/index.js
```

### 2. Apply Defaults

```js
const gasData = await getCachedGasPrice();
const params = applyTxDefaults(rawParams, { dynamicPrice: gasData.median });
```

### 3. Build Transaction

```js
// walletEngine.js
const tx = state.bookkeeper
  .as(profile)
  .transfer(amount)
  .to(recipient)
  .memo(memo)
  .gas(gas);
```

### 4. Execute

```js
const result = await state.network.execute(tx);
// { hash: "abc...", nonce: 42 }
```

### 5. Track Execution

```js
// Fire-and-forget: watch for EXECUTED event
watchTxExecuted(result.hash);
```

---

## Security Considerations

See [SECURITY.md](SECURITY.md) for the full threat model.

Key points:
- Mnemonic encrypted with PBKDF2 + AES-GCM
- Auto-lock after configurable timeout
- Origin-based dApp permissions
- No analytics or tracking

---

## Testing

```bash
npm run test           # Run tests
npm run test:coverage  # With coverage report
```

Tests use Vitest and live alongside source files (`*.test.js`).

---

## Build System

### Extension

```bash
npm run build          # Production build → dist/
npm run dev            # Development with watch
```

### Tauri

```bash
cd apps/tauri
npm run tauri build    # Desktop build
npm run tauri android  # Android build
npm run tauri ios      # iOS build
```

Uses Vite for bundling with separate configs:
- `vite.config.js` — Extension
- `vite.tauri.config.js` — Tauri
