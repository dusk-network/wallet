# Dusk Wallet (Tauri)

This folder contains the Tauri wrapper for the same wallet UI used by the Chrome extension.

The frontend is built from the repo root into `dist-tauri/` and then served by Tauri.

## Desktop

### Running

From the repo root:

```bash
npm install
npm run tauri:dev
```

### Building

```bash
npm install
npm run build:tauri
npm run tauri:build
```

## Mobile

### Running

Make sure you have an emulator or device with debugging enabled

```bash
cargo tauri android dev --host <DEVICE_IP>
```

### Build

For Google Play builds:
```bash
cargo tauri android build --aab
```

For portable APK builds:
```bash
cargo tauri android build --apk
```
