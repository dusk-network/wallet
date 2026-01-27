# Dusk Provider API

The Dusk Wallet extension injects `window.dusk` into web pages. It's modeled after EIP-1193 (MetaMask's interface), but Dusk isn't EVM—so all methods use `dusk_*` prefixes.

## Quick Start

```js
// Connect to wallet (prompts user)
const [account] = await dusk.request({ method: "dusk_requestAccounts" });

// Check balance
const { value } = await dusk.request({ method: "dusk_getPublicBalance" });
console.log(`Balance: ${value} LUX`);

// Send 1 DUSK
const { hash } = await dusk.request({
  method: "dusk_sendTransaction",
  params: {
    kind: "transfer",
    to: account,
    amount: "1000000000"  // 1 DUSK = 1e9 LUX
  }
});
```

## Provider Surface

```js
window.dusk = {
  // Core
  request({ method, params }) → Promise<any>,
  
  // Events
  on(event, handler),
  once(event, handler),
  off(event, handler),
  removeListener(event, handler),
  removeAllListeners(event?),
  
  // Legacy
  enable() → dusk_requestAccounts,
  isConnected() → true,
  
  // Properties (read-only)
  chainId: string | null,
  selectedAddress: string | null,
  isAuthorized: boolean,
  isDusk: true
}
```

The provider starts emitting events after the first `request()` call or `on()` subscription.

---

## Types

| Type | Format | Example |
|------|--------|---------|
| `AccountId` | Base58 public account | `"2Z8m..."` |
| `Address` | Base58 shielded address | `"4Kp9..."` |
| `LuxString` | Decimal string (u64) | `"1000000000"` (= 1 DUSK) |
| `ChainId` | Hex with `0x` prefix | `"0x1"` (mainnet) |

**Chain IDs:** `0x1` mainnet, `0x2` testnet, `0x3` devnet, `0x0` local. Custom nodes get `0x` + FNV-1a32 hash of origin.

**Gas:** `{ limit: LuxString, price: LuxString }` or omit for wallet defaults.

---

## Methods

### `dusk_requestAccounts`

Connect the site to the wallet. Opens approval prompt.

```js
const accounts = await dusk.request({ method: "dusk_requestAccounts" });
// → ["2Z8m..."]
```

Returns `AccountId[]`. Throws `4001` if rejected, `4100` if wallet not set up.

---

### `dusk_accounts`

Get connected accounts without prompting.

```js
const accounts = await dusk.request({ method: "dusk_accounts" });
// → [] if not connected/locked, ["2Z8m..."] otherwise
```

---

### `dusk_chainId`

Get current chain ID.

```js
const chainId = await dusk.request({ method: "dusk_chainId" });
// → "0x2" (testnet)
```

---

### `dusk_switchNetwork`

Ask user to switch networks. Requires prior connection.

```js
// By preset
await dusk.request({
  method: "dusk_switchNetwork",
  params: { chainId: "0x1" }
});

// By URL
await dusk.request({
  method: "dusk_switchNetwork",
  params: { nodeUrl: "https://my-node.example.com" }
});
```

Returns `null`. Emits `chainChanged` and `duskNodeChanged` on success.

---

### `dusk_getPublicBalance`

Get public balance. Requires connection + unlocked wallet.

```js
const bal = await dusk.request({ method: "dusk_getPublicBalance" });
// → { nonce: "42", value: "123000000000" }
```

---

### `dusk_sendTransaction`

Send a transaction. The wallet shows an approval prompt where users can adjust gas.

#### Transfer

```js
const tx = await dusk.request({
  method: "dusk_sendTransaction",
  params: {
    kind: "transfer",
    to: "2Z8m...",           // AccountId
    amount: "1000000000",    // 1 DUSK in LUX
    memo: "optional",
    gas: { limit: "10000000", price: "1" }  // optional
  }
});
// → { hash: "abc...", nonce: "5" }
```

#### Contract Call

```js
const tx = await dusk.request({
  method: "dusk_sendTransaction",
  params: {
    kind: "contract_call",
    contractId: "0x02000...",  // 32 bytes
    fnName: "stake",
    fnArgs: "0x...",           // bytes (hex, array, or Uint8Array)
    amount: "0",               // transfer value
    deposit: "1000000000",     // deposit amount
    gas: { limit: "500000000", price: "1" },
    display: { /* shown in approval UI */ }
  }
});
```

`fnArgs` max: 128 KiB. Memo not allowed for contract calls.

---

### `dusk_getAddresses`

Get shielded addresses. Requires connection + unlocked wallet.

```js
const addrs = await dusk.request({ method: "dusk_getAddresses" });
// → ["4Kp9..."]
```

---

### `dusk_disconnect`

Revoke site permission.

```js
await dusk.request({ method: "dusk_disconnect" });
// → true
```

Emits `disconnect` and `accountsChanged([])`.

---

## Events

```js
dusk.on("connect", ({ chainId }) => { });
dusk.on("disconnect", ({ code, message }) => { });
dusk.on("accountsChanged", (accounts) => { });
dusk.on("chainChanged", (chainId) => { });
dusk.on("duskNodeChanged", ({ chainId, nodeUrl, networkName }) => { });
```

| Event | Payload | When |
|-------|---------|------|
| `connect` | `{ chainId }` | Permission granted |
| `disconnect` | `{ code: 4900, message }` | Permission revoked |
| `accountsChanged` | `AccountId[]` | Lock/unlock, connect/disconnect |
| `chainChanged` | `ChainId` | Network changed (different chain ID) |
| `duskNodeChanged` | `{ chainId, nodeUrl, networkName }` | Node URL changed (even same chain) |

---

## Errors

| Code | Name | Meaning |
|------|------|---------|
| `4001` | USER_REJECTED | User closed or rejected prompt |
| `4100` | UNAUTHORIZED | Not connected, locked, or no wallet |
| `4200` | UNSUPPORTED | Feature not available |
| `4900` | DISCONNECTED | Extension unavailable |
| `-32601` | METHOD_NOT_FOUND | Unknown method |
| `-32602` | INVALID_PARAMS | Bad parameters |
| `-32603` | INTERNAL | Something broke |

Errors are thrown as `Error` objects with `.code`, `.message`, and optional `.data`.

---

## Full Example

```js
const dusk = window.dusk;
if (!dusk) throw new Error("Dusk wallet not installed");

// Subscribe to state changes
dusk.on("accountsChanged", accts => console.log("Accounts:", accts));
dusk.on("chainChanged", id => console.log("Chain:", id));

// Connect
const [account] = await dusk.request({ method: "dusk_requestAccounts" });
console.log("Connected:", account);

// Read balance
const { value } = await dusk.request({ method: "dusk_getPublicBalance" });
console.log("Balance:", value, "LUX");

// Transfer
const { hash } = await dusk.request({
  method: "dusk_sendTransaction",
  params: {
    kind: "transfer",
    to: "2Z8mRecipient...",
    amount: "500000000"  // 0.5 DUSK
  }
});
console.log("TX:", hash);
```
