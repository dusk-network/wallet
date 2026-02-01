# AI Agent Context

> Guidelines for AI coding agents (GitHub Copilot, Claude, Cursor, etc.) working on this codebase.

## Project Overview

**Dusk Wallet** is a self-custody cryptocurrency wallet for the Dusk blockchain. It runs as:

- **Chrome/Firefox Extension** (MV3) — Primary platform
- **Desktop app** (Tauri) — Windows, macOS, Linux
- **Mobile app** (Tauri) — Android, iOS

Key characteristics:
- Mnemonic never leaves device, encrypted at rest
- Supports public (Moonlight) and shielded (Phoenix) accounts
- dApp connectivity via MetaMask-style provider API
- Zero analytics, no remote calls except blockchain nodes

---

## Architecture Overview

```
src/
├── background/           # Extension service worker
│   ├── index.js          # Entry point, message routing, auto-lock
│   ├── rpc.js            # dApp RPC handler (dusk_* methods)
│   ├── offscreen.js      # Bridge to offscreen document
│   ├── pending.js        # Approval queue for dApp requests
│   ├── dappEvents.js     # accountsChanged, chainChanged events
│   └── txNotify.js       # Transaction notifications
│
├── ui/
│   ├── popup/            # Main wallet UI
│   │   ├── app.js        # Preact app, routing, global state
│   │   ├── views/        # Page components (home, send, receive...)
│   │   └── state.js      # Reactive state management
│   ├── components/       # Reusable UI components
│   ├── notification/     # Transaction approval popup
│   └── lib/              # UI utilities (clipboard, strings)
│
├── shared/               # Platform-agnostic core logic
│   ├── walletEngine.js   # w3sper integration, tx building (1700+ lines)
│   ├── vault.js          # Mnemonic encryption/decryption
│   ├── shieldedStore.js  # IndexedDB for Phoenix notes
│   ├── txDefaults.js     # Gas defaults, tx param helpers
│   ├── constants.js      # TX_KIND enum, magic values
│   ├── permissions.js    # Origin-based dApp permissions
│   ├── settings.js       # User settings persistence
│   └── ...               # Network, chain, crypto, errors
│
├── platform/             # Platform abstraction layer
│   ├── runtime.js        # Detect extension vs Tauri vs web
│   ├── storage.js        # chrome.storage / tauri-store / localStorage
│   └── assets.js         # Asset URL resolution
│
└── wallet/
    ├── bus.js            # Extension message bus
    └── localBus.js       # In-process bus for Tauri
```

---

## Message Flow

### Extension (Chrome/Firefox)

```
dApp page
    ↓ window.dusk.request()
contentScript.js
    ↓ chrome.runtime.sendMessage
background/rpc.js
    ↓ engineCall()
background/offscreen.js
    ↓ chrome.runtime.sendMessage
offscreen.html (offscreen document)
    ↓ direct call
shared/walletEngine.js
```

For user approvals:
```
background/rpc.js
    ↓ requestUserApproval()
background/pending.js
    ↓ chrome.windows.create
notification.html
    ↓ user clicks approve/reject
background/pending.js → resolves promise
```

### Tauri (Desktop/Mobile)

```
UI (popup/app.js)
    ↓ send()
wallet/localBus.js
    ↓ direct call
shared/walletEngine.js
```

No offscreen document needed — engine runs in the same process.

---

## Key Patterns

### Gas Handling

```js
// 1. Static defaults per transaction kind
const DEFAULT_GAS_BY_KIND = {
  transfer: { limit: "10000000", price: "1" },
  shield: { limit: "50000000", price: "1" },
  // ...
};

// 2. Dynamic gas price (30s cache)
const livePrice = await getCachedGasPrice();

// 3. Merge: user params > dynamic price > static default
const finalParams = applyTxDefaults(params, { dynamicPrice: livePrice.median });
```

### Vault / Secret Storage

| Platform | Method |
|----------|--------|
| Extension | PBKDF2 (900k iter) + AES-GCM-256 → chrome.storage.local |
| Tauri | Stronghold plugin with Argon2 salt file |

### Error Handling

```js
import { ERROR_CODES, rpcError } from "../shared/errors.js";

// For dApp-facing errors:
throw rpcError(ERROR_CODES.UNAUTHORIZED, "Wallet locked");

// For internal errors, serialize before message passing:
sendResponse({ error: serializeError(err) });
```

---

## Conventions

| Convention | Format | Example |
|------------|--------|---------|
| Transaction kinds | lowercase string | `transfer`, `shield`, `unshield`, `contract_call` |
| Chain IDs | CAIP-2 `dusk:<id>` | `"dusk:1"` (mainnet), `"dusk:2"` (testnet) |
| Amounts | LUX string (u64) | `"1000000000"` = 1 DUSK |
| Addresses | Base58 | Account: `"2Z8m..."`, Shielded: `"4Kp9..."` |
| Gas | object or null | `{ limit: "10000000", price: "1" }` or `null` (auto) |

### File Naming

- Source: `camelCase.js`
- Tests: `camelCase.test.js` (alongside source)
- Components: `PascalCase.js`

---

## Common Tasks

### Add a new RPC method

1. **Handler**: Add case in `src/background/rpc.js` (`handleRpc` switch)
2. **Engine**: If needs wallet logic, add handler in `src/offscreen.js`
3. **Logic**: Add function in `src/shared/walletEngine.js`
4. **Docs**: Update `docs/provider-api.md`
5. **Test**: Add test case

### Add a new transaction type

1. **Constant**: Add to `TX_KIND` in `src/shared/constants.js`
2. **Defaults**: Add gas defaults in `src/shared/txDefaults.js`
3. **Handler**: Add case in `walletEngine.sendTransaction()`
4. **Tests**: Update `txDefaults.test.js` and `constants.test.js`

### Add a new UI view

1. Create `src/ui/popup/views/myview.js`
2. Export render function: `export function MyView(props) { ... }`
3. Add route in `src/ui/popup/app.js` (in the view switch)
4. Add navigation link if needed

### Add a new setting

1. Add default in `src/shared/settings.js` (`DEFAULT_SETTINGS`)
2. Add UI in `src/ui/popup/views/options.js`
3. Use via `getSettings()` / `setSettings()`

---

## External Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@dusk/w3sper` | ^1.4.0 | Dusk SDK (Network, Bookkeeper, ProfileGenerator) |
| `bip39` | 3.1.0 | Mnemonic generation/validation |
| `preact` | (via HTM) | UI framework |
| `qrcode-generator` | ^2.0.4 | QR code generation |
| `jsqr` | ^1.4.0 | QR code scanning |

### Tauri Plugins

| Plugin | Purpose |
|--------|---------|
| `@tauri-apps/plugin-store` | Persistent storage |
| `@tauri-apps/plugin-stronghold` | Encrypted secret storage |
| `@tauri-apps/plugin-fs` | File system access |

---

## Important Gotchas

1. **Offscreen document**: The wallet engine runs in `offscreen.html`, not the service worker, because w3sper needs DOM APIs.

2. **BigInt serialization**: Always convert BigInt to string before message passing:
   ```js
   // ❌ Breaks
   sendResponse({ value: 123n });
   // ✅ Works
   sendResponse({ value: "123" });
   ```

3. **Shielded sync required**: Phoenix (shielded) notes must be synced before spending. Check `getShieldedStatus()` before shielded transactions.

4. **Gas completeness**: Gas must have both `limit` AND `price`, or neither (null = auto). Partial gas objects are invalid.

5. **BLS signatures**: Dusk uses BLS12-381 signatures. Hardware wallets (Ledger/Trezor) don't support this, so HW wallet integration isn't possible.

6. **Firefox offscreen**: Firefox MV3 doesn't support offscreen documents. The Firefox build hosts the engine in `engine.html` (hidden extension page) instead.

---

## Testing

```bash
# Run all tests
npm run test

# Run with coverage
npm run test:coverage

# Watch mode
npm run test -- --watch
```

Tests live alongside source files (`*.test.js`). Use Vitest.

---

## Useful Links

| Resource | URL |
|----------|-----|
| Provider API | [docs/provider-api.md](provider-api.md) |
| Roadmap | [docs/ROADMAP.md](ROADMAP.md) |
| Architecture | [docs/ARCHITECTURE.md](ARCHITECTURE.md) |
| Security | [docs/SECURITY.md](SECURITY.md) |
| Dusk Docs | https://docs.dusk.network |
| w3sper SDK | https://github.com/dusk-network/w3sper |

---

## Quick Reference

```js
// Get current settings
import { getSettings, setSettings } from "./shared/settings.js";
const settings = await getSettings();

// Check wallet state
import { isUnlocked, getAccounts } from "./shared/walletEngine.js";
if (isUnlocked()) {
  const accounts = getAccounts();
}

// Send transaction
import { sendTransaction } from "./shared/walletEngine.js";
const result = await sendTransaction({
  kind: "transfer",
  to: "2Z8m...",
  amount: "1000000000",
  gas: { limit: "10000000", price: "1" }
});

// Get gas price
import { getCachedGasPrice } from "./shared/walletEngine.js";
const { average, median, min, max } = await getCachedGasPrice();
```
