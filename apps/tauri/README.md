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

The Android project under `src-tauri/gen/` is generated, not kept in git: make
it once with `cargo tauri android init --ci` (with `ANDROID_HOME` and
`NDK_HOME` set). What the wallet needs of Android itself (no screenshots of
its screens, the share sheet, saving to Downloads, Back on its first screen)
is in `src-tauri/src/android.rs`, so a new `android init` keeps it; fingerprint
unlock is Kotlin beside it, `src-tauri/android/KeystorePlugin.kt`: the password
kept only encrypted under an Android Keystore key that a fresh fingerprint
opens (Android 11 and later). As the app is built, `src-tauri/build.rs` adds
the permissions to hear the network come and go and to ask for a fingerprint
to the project's manifest, puts that Kotlin in its sources, and Dusk's icon in
its resources from `src-tauri/icons/android`. That icon is made from `icons/app-icon.json`:
`cargo tauri icon icons/app-icon.json -o <folder>`, then its `android` folder
in place of `icons/android`.

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

For the emulator, a debug APK:
```bash
cargo tauri android build --debug --apk true --target x86_64
```
