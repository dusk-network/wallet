# Dusk Wallet

A non-custodial wallet for [Dusk](https://dusk.network). Browser extension, desktop, and mobile—one codebase.

**Your keys. Your DUSK. No middleman.**

<p align="center">
  <a href="https://github.com/HDauven/dusk-wallet/actions/workflows/ci.yml">
    <img src="https://github.com/HDauven/dusk-wallet/actions/workflows/ci.yml/badge.svg" alt="CI">
  </a>
  &nbsp;
  <a href="https://github.com/HDauven/dusk-wallet/actions/workflows/release.yml">
    <img src="https://github.com/HDauven/dusk-wallet/actions/workflows/release.yml/badge.svg" alt="Release">
  </a>
  &nbsp;
  <a href="https://codecov.io/gh/HDauven/dusk-wallet">
    <img src="https://codecov.io/gh/HDauven/dusk-wallet/branch/main/graph/badge.svg" alt="Coverage">
  </a>
  &nbsp;
  <a href="https://github.com/HDauven/dusk-wallet/stargazers">
    <img alt="GitHub Repo stars" src="https://img.shields.io/github/stars/HDauven/dusk-wallet?style=social">
  </a>
  &nbsp;
  <a href="https://discord.gg/dusk-official">
    <img src="https://img.shields.io/discord/847466263064346624?label=discord&style=flat-square&color=5a66f6" alt="Join Discord">
  </a>
  &nbsp;
  <a href="https://x.com/DuskFoundation/">
    <img alt="X (formerly Twitter) Follow" src="https://img.shields.io/twitter/follow/DuskFoundation">
  </a>
  &nbsp;
  <a href="https://docs.dusk.network">
    <img alt="Read the docs" src="https://img.shields.io/badge/read%20the%20docs-E2DFE9?style=flat-square">
  </a>
</p>

## Features

🔐 **Self-custody** — Your mnemonic never leaves your device. Encrypted at rest.

⚡ **Public & Shielded** — Send from your public account or shield funds for privacy.

🌐 **dApp Ready** — Connect to any Dusk dApp. MetaMask-style `window.dusk` provider.

🔄 **Multi-network** — Switch between mainnet, testnet, devnet, or custom nodes.

📱 **Cross-platform** — Chrome extension today. Desktop and mobile via Tauri.

## Install

### Chrome Extension

```bash
npm install
npm run build:extension
```

Then load `dist/` as an unpacked extension in `chrome://extensions` (Developer mode).

### Firefox Extension

```bash
npm run build:firefox
```

Then load `dist-firefox/` as a temporary add-on in `about:debugging`.

### Desktop / Mobile (Tauri)

```bash
npm run build:tauri
npm run tauri:dev
```

See [apps/tauri/README.md](apps/tauri/README.md) for platform-specific setup.

## For dApp Developers

The extension injects `window.dusk`—an EIP-1193-style provider. Dusk isn't EVM, but the patterns are familiar.

```js
// Connect
const [account] = await dusk.request({ method: "dusk_requestAccounts" });

// Send DUSK
await dusk.request({
  method: "dusk_sendTransaction",
  params: {
    kind: "transfer",
    to: account,
    amount: "1000000000"  // 1 DUSK
  }
});

// Listen for changes
dusk.on("accountsChanged", console.log);
dusk.on("chainChanged", console.log);
```

Full API reference: [docs/provider-api.md](docs/provider-api.md)

## Architecture

```
src/
├── background/      # Extension service worker
├── ui/              # Popup, full view, notifications
├── shared/          # Wallet logic (works everywhere)
├── platform/        # Platform abstraction (extension vs tauri)
└── wallet/          # Engine interface
```

The wallet engine runs in an offscreen document (extension) or directly in-process (Tauri). Same cryptographic core either way.

## Development

```bash
npm run build:extension   # Build extension → dist/
npm run build:firefox     # Build Firefox extension → dist-firefox/
npm run build:tauri       # Build Tauri bundle → dist-tauri/
npm run dev:tauri         # Run Tauri dev server

# Local Rusk node (Docker)
npm run rusk:up
npm run rusk:wait

# UI component workbench
npm run storybook

# E2E (Playwright + Docker Rusk)
npm run e2e:rusk
```

## Security

- Mnemonic encrypted with user password (PBKDF2 + AES-GCM)
- Tauri uses OS keychain via Stronghold
- No analytics, no tracking, no remote calls except to your chosen node

## License

MIT
