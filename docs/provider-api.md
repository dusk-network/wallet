# Dusk Provider API

The Dusk Wallet extension announces a provider into web pages through **Dusk discovery events**. The provider itself is modeled after EIP-1193 (MetaMask's interface), but Dusk isn't EVM, so all methods use `dusk_*` prefixes.

The canonical discovery protocol is documented in [`@dusk-network/connect`](https://github.com/dusk-network/connect/blob/main/docs/wallet-discovery.md).

## Quick Start

```js
const providers = [];

window.addEventListener("dusk:announceProvider", (event) => {
  providers.push(event.detail);
});

window.dispatchEvent(new Event("dusk:requestProvider"));

const dusk = providers[0]?.provider;
if (!dusk) throw new Error("Dusk wallet not installed");

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

## Discovery

Wallet discovery is event-based so multiple Dusk wallets can coexist on the page.

Canonical discovery events:

- `dusk:requestProvider`
- `dusk:announceProvider`

```js
window.addEventListener("dusk:announceProvider", (event) => {
  const { info, provider } = event.detail;
  console.log(info.uuid, info.name, info.rdns);
});

window.dispatchEvent(new Event("dusk:requestProvider"));
```

Announced provider metadata:

- `uuid`
- `name`
- `icon`
- `rdns`

```js
{
  info: {
    uuid: string,
    name: string,
    icon: string,
    rdns: string
  },
  provider: DuskProvider
}
```

Wallets may also expose a wallet-specific namespace for debugging or internal use, but dApps should treat the discovery events as the canonical integration surface.

## Provider Surface

```js
provider = {
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
| `ChainId` | CAIP-2 `dusk:<id>` | `"dusk:1"` (mainnet) |

**Chain IDs:** `dusk:1` mainnet, `dusk:2` testnet, `dusk:3` devnet, `dusk:0` local. Custom nodes get `dusk:` + FNV-1a32 hash of origin (decimal).

**Gas:** `{ limit: LuxString, price: LuxString }` or omit for wallet defaults.

---

## Methods

### `dusk_getCapabilities`

Get a machine-readable description of the provider surface (supported methods, tx kinds, limits).

This method does **not** require connection permission.

```js
const caps = await dusk.request({ method: "dusk_getCapabilities" });
// → { methods: [...], txKinds: [...], limits: { maxFnArgsBytes: 65536, ... }, ... }
```

### `dusk_requestAccounts`

Connect the site to the wallet. Opens approval prompt.

```js
const accounts = await dusk.request({ method: "dusk_requestAccounts" });
// → ["2Z8m..."]
```

The wallet exposes a **single** public account to each origin (array length 0 or 1). The connect prompt lets the user choose which account to expose.

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

Get current chain ID (CAIP-2, `dusk:<id>`).

```js
const chainId = await dusk.request({ method: "dusk_chainId" });
// → "dusk:2" (testnet)
```

---

### `dusk_switchNetwork`

Ask user to switch networks. Requires prior connection.

```js
// By preset (CAIP-2)
await dusk.request({
  method: "dusk_switchNetwork",
  params: { chainId: "dusk:1" }
});

// By URL
await dusk.request({
  method: "dusk_switchNetwork",
  params: { nodeUrl: "https://my-node.example.com" }
});
```

Returns `null`. Emits `chainChanged` and `duskNodeChanged` on success.

> Note: `chainId` must be CAIP-2 (`dusk:<id>`).

---

### `dusk_getPublicBalance`

Get public balance. Requires connection + unlocked wallet.

```js
const bal = await dusk.request({ method: "dusk_getPublicBalance" });
// → { nonce: "42", value: "123000000000" }
```

---

### `dusk_estimateGas`

Get current gas price statistics from the node's mempool. Requires connection.

```js
const gas = await dusk.request({
  method: "dusk_estimateGas",
  params: { maxTransactions: 100 }  // optional, defaults to 100
});
// → { average: "1", max: "1", median: "1", min: "1" }
```

Returns gas prices in Lux (1 Lux = 10⁻⁹ DUSK). Values default to `"1"` when the mempool is empty.

---

### `dusk_sendTransaction`

Send a transaction. The wallet shows an approval prompt where users can adjust gas.

#### Transfer

```js
const tx = await dusk.request({
  method: "dusk_sendTransaction",
  params: {
    kind: "transfer",
    to: "2Z8m...",           // AccountId (public) OR Address (shielded)
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
    privacy: "public",        // "public" | "shielded"
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

`fnArgs` max: 64 KiB. Memo not allowed for contract calls.

---

### `dusk_watchAsset`

Prompt the user to add a **DRC20** token or **DRC721** NFT to the wallet's Assets UI (approval required).

Requires prior connection (`dusk_requestAccounts`) and an unlocked wallet.

Assets are stored per **(network + selected account/profile)**.

```js
// Watch/import a DRC20 token by contractId
await dusk.request({
  method: "dusk_watchAsset",
  params: {
    type: "DRC20",
    options: {
      contractId: "0x02000..." // 32 bytes
      // image: "https://..."  // optional hint (may be ignored by the wallet)
    }
  }
});

// Watch/import a DRC721 NFT by contractId + tokenId (u64 decimal string)
await dusk.request({
  method: "dusk_watchAsset",
  params: {
    type: "DRC721",
    options: {
      contractId: "0x02000...", // 32 bytes
      tokenId: "1"
      // image: "https://..."  // optional hint (may be ignored by the wallet)
    }
  }
});
```

The wallet verifies on-chain metadata before persisting the asset.

For `type: "DRC721"`, the wallet also verifies the connected account currently owns `tokenId`.

Returns `true` on success. Throws `4001` if rejected, `4100` if not connected.

---

### `dusk_signMessage`

Sign an arbitrary **message** for off-chain use (auth, session binding, etc).

Requires connection + unlocked wallet.

> Note: The wallet signs a **domain-separated SHA-256 hash** of your message (origin + chainId are included in the signed envelope). The approval UI shows the hash and message length.

```js
const sig = await dusk.request({
  method: "dusk_signMessage",
  params: { message: "0x..." } // bytes (hex/base64/Uint8Array/ArrayBuffer/number[])
});
// → { account, origin, chainId, messageHash, messageLen, signature, payload }
```

---

### `dusk_signAuth`

Sign a canonical login envelope (origin + chainId + nonce + timestamps).

Requires connection + unlocked wallet.

```js
const auth = await dusk.request({
  method: "dusk_signAuth",
  params: { nonce: "server-provided-nonce", statement: "optional" }
});
// → { account, origin, chainId, nonce, issuedAt, expiresAt, message, signature, payload }
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
| `accountsChanged` | `AccountId[]` | Lock/unlock, connect/disconnect, or user changes the connected account for the site |
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
const providers = [];

window.addEventListener("dusk:announceProvider", (event) => {
  providers.push(event.detail);
});

window.dispatchEvent(new Event("dusk:requestProvider"));

const dusk = providers[0]?.provider;
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
