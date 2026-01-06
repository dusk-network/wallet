# Mochavi Wallet

This is a minimal shared wallet design that can be used as a Chromium extension, desktop app and mobile app.

The Chromium extension injects a `window.dusk` provider into any webpage, so dApps can talk to the wallet without users importing a private key/mnemonic into the dApp.

The provider is EIP-1193-like (request + events) and mirrors the UX patterns
developers expect from MetaMask (without pretending Dusk is EVM).

### Supported RPC methods

- `dusk_requestAccounts`
- `dusk_accounts`
- `dusk_chainId`
- `dusk_switchNetwork`
- `dusk_getPublicBalance`
- `dusk_sendTransaction` (send API: transfer + contract call)
- `dusk_disconnect`
- `dusk_getAddresses`

### Provider events (push)

The extension pushes MetaMask-style events to connected sites:

- `accountsChanged: string[]`
- `chainChanged: string` (hex string like `0x1`)
- `connect: { chainId: string }`
- `disconnect: { code: number, message: string }`

And one Dusk-specific helper event:

- `duskNodeChanged: { chainId: string, nodeUrl: string, networkName: string }`

Notes:

- `accountsChanged([])` is emitted when the wallet locks or the site's permission is revoked.
- `chainChanged` uses a Dusk chain identifier, not an Ethereum chain id.
  Known presets map to fixed ids; for custom nodes we derive a stable-ish id from the
  node URL origin (scheme+host+port) using a small FNV-1a hash.

> Shielded transactions are not implemented yet.

## Build

```bash
npm install
npm run build
```

This produces a `dist/` folder.

### Multi-platform (Extension + Tauri) builds

This codebase is structured so the same wallet UI can run:

- as a Chrome extension (MV3)
- as a Tauri desktop app
- as a Tauri mobile app

The browser dApp injection/connection pieces remain extension-only.

Build commands:

```bash
npm run build:extension   # -> dist/
npm run build:tauri       # -> dist-tauri/
```

To run the Tauri desktop app wrapper (added under `apps/tauri/`):

```bash
npm run dev:tauri
npm run tauri:dev
```

See `apps/tauri/README.md` for more info.

The Tauri build generates a simple web bundle (with `public/index.html`) that you can
point a Tauri project at. The wallet core wasm is still served from `public/` and loaded
via a platform-safe `assetUrl()` helper.

## Load in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the `dist/` folder.

## Test in a dApp

In any webpage console:

```js
// Optional: subscribe to provider events
window.dusk.on("connect", (info) => console.log("connect", info));
window.dusk.on("disconnect", (err) => console.log("disconnect", err));
window.dusk.on("accountsChanged", (a) => console.log("accountsChanged", a));
window.dusk.on("chainChanged", (c) => console.log("chainChanged", c));
window.dusk.on("duskNodeChanged", (n) => console.log("duskNodeChanged", n));

await window.dusk.request({ method: "dusk_requestAccounts" })
// => ["<base58-account>"]

await window.dusk.request({ method: "dusk_getPublicBalance" })

// Transfer request
await window.dusk.request({
  method: "dusk_sendTransaction",
  params: {
    kind: "transfer",
    to: "ugiaM55iFtPRSMhRRSkq5EuNZRzREx9TxfGaxZV4W4XFjayTmTMEtQrFc95qTURnFHB7rrbW4XqKQCcPG4HUU5sQ36YFmmms1y8ovjFtjWTuW645Asn8v25adkaDQoh8bzE",
    amount: "1", // u64 string (Lux)
    memo: "hello",
    // gas is optional; the wallet applies defaults (limit=10,000,000, price=1)
    // gas: { limit: "10000000", price: "1" }
  }
})

// Contract call (opaque args bytes)
await window.dusk.request({
  method: "dusk_sendTransaction",
  params: {
    kind: "contract_call",
    contractId: "0x0200000000000000000000000000000000000000000000000000000000000000", // 32 bytes
    fnName: "get_version",
    fnArgs: "0x", // rkyv-encoded bytes, hex/base64/number[] supported

    // optional value movement
    amount: "0",  // transfer_value in Lux
    deposit: "0", // deposit in Lux
    // optional; default is your own selected account
    // to: "<base58-account>",

    // gas is optional; the wallet applies defaults (contract_call: limit=500,000,000, price=1)
    // gas: { limit: "500000000", price: "1" },
    display: { contractName: "Example", methodSig: "get_version()" }
  }
})

// Request to switch network
await window.dusk.request({ method: "dusk_switchNetwork", params: [{ chainId: "0x1" }] });
```

### Provider surface

`window.dusk` implements a minimal EIP-1193-like interface:

```js
await window.dusk.request({ method: "dusk_accounts" });

window.dusk.on("accountsChanged", (accounts) => {});
window.dusk.once("disconnect", (err) => {});
window.dusk.off("chainChanged", handler);

window.dusk.chainId;          // "0x..."
window.dusk.selectedAddress;  // first account or null
window.dusk.isAuthorized;     // whether the origin is connected

// Legacy convenience (calls dusk_requestAccounts)
await window.dusk.enable();
```
