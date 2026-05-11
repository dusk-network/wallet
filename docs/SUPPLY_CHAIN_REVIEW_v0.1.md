# Dusk Wallet v0.1 Supply Chain Review

Reviewed: 2026-05-11  
Base: `origin/main` at `1260f0b`  
Verdict: **GO WITH CAVEATS**

This review inspected the current lockfile and clean Chrome/Firefox extension builds without upgrading dependencies. No generated artifact showed an unexpected key-exfiltration path, remote script import, `eval`, `new Function`, XHR, `sendBeacon`, or `EventSource`. The main caveat is release-integrity risk from the current build chain and node-polyfill stack, especially the deferred Vite/Rollup and `vite-plugin-node-polyfills`/`crypto-browserify` audit path.

## Commands Run

- `npm ci`
- `npm run test:run`
- `npm run build:chrome`
- `npm run build:firefox`
- `npm audit --json`
- source-map package inventory across `dist/**/*.js.map` and `dist-firefox/**/*.js.map`
- artifact scans across `dist/**/*.js` and `dist-firefox/**/*.js` for `fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon`, `EventSource`, `mnemonic`, `privateKey`, `seed`, `password`, `vault`, `recovery`, `secret`, `eval`, `new Function`, `Function(`, `import(`, `http://`, `https://`, `script.src`, `getURL`, and `.wasm`

Result: installs, tests, Chrome build, and Firefox build passed.

## Dependency Surface

Runtime dependencies in `package.json`:

- `@dusk/w3sper` (`npm:@jsr/dusk__w3sper@1.6.0`)
- `@tauri-apps/api`, `@tauri-apps/plugin-fs`, `@tauri-apps/plugin-store`, `@tauri-apps/plugin-stronghold`
- `bip39`
- `jsqr`
- `qrcode-generator`

Dev/build/test dependencies:

- `vite`, `vite-plugin-node-polyfills`, `storybook`, `@storybook/html-vite`
- `vitest`, `@vitest/coverage-v8`, `fake-indexeddb`
- `@playwright/test`

Native/binary packages installed by the current platform:

- `@esbuild/linux-x64@0.21.5`
- `@rollup/rollup-linux-x64-gnu@4.53.5`
- `@rollup/rollup-linux-x64-musl@4.53.5`
- `playwright@1.58.2` and `playwright-core@1.58.2`

Package bins present include `vite`, `rollup`, `esbuild`, `vitest`, `storybook`, `playwright`, `sha.js`, `miller-rabin`, `nanoid`, `resolve`, `semver`, and parser/test helper CLIs. These are build/test-time executables, not extension runtime entrypoints.

Install-time lifecycle script of note:

- `esbuild@0.21.5`: `postinstall: node install.js`

Several packages include `prepare` or `prepack` metadata, including `rollup`, `@rollup/plugin-inject`, `acorn`, `recast`, `istanbul-reports`, `qs`, and Browserify crypto subpackages. Under `npm ci` from registry tarballs, the install-time risk is materially lower than a git dependency install; the `esbuild` postinstall remains the main lifecycle script to treat as install-time executable code.

## Bundled Packages By Artifact

Source-map inventory found third-party packages in the generated extension artifacts:

| Artifact | Bundled third-party packages |
| --- | --- |
| `dist/background.js`, `dist-firefox/background.js` | Wallet-owned code plus shared chunks; no direct `node_modules` source-map entries in the entry file |
| `dist/offscreen.js`, `dist-firefox/offscreen.js` | `@dusk/w3sper` |
| `dist/chunks/lux.js`, `dist-firefox/chunks/lux.js` | `@dusk/w3sper`, `@jsr/dusk__exu` |
| `dist/chunks/index4.js`, `dist-firefox/chunks/index4.js` | `bip39`, `@noble/hashes`, `vite-plugin-node-polyfills` |
| `dist/popup.js`, `dist-firefox/popup.js` | `jsqr`, `qrcode-generator` |
| `dist/chunks/core.js`, `index.js`, `index2.js`, `index3.js`, `path.js` and Firefox equivalents | `@tauri-apps/api`, `@tauri-apps/plugin-fs`, `@tauri-apps/plugin-store`, `@tauri-apps/plugin-stronghold` |
| `dist/contentScript.js`, `dist/inpage.js`, `dist-firefox/contentScript.js`, `dist-firefox/inpage.js` | No third-party `node_modules` source-map entries |

Code that can directly access decrypted mnemonic/private material:

- Wallet-owned vault/unlock paths in `background.js` decrypt the vault and send the mnemonic to the engine unlock path.
- Wallet-owned engine/offscreen code plus `@dusk/w3sper`, `@jsr/dusk__exu`, `bip39`, and `@noble/hashes` are the trusted cryptographic/runtime surface.
- The content script and inpage provider do not contain third-party runtime dependencies and do not contain network APIs in the built artifacts.

Packaged WASM artifacts are local and hash-identical between `public`, `dist`, and `dist-firefox`:

| Artifact | SHA-256 |
| --- | --- |
| `wallet_core-1.6.0.wasm` | `a20b7e34b5fe5b3fa4c9ed25a4881e7eba5eed0ba8b6befb48b4aaf4a4cf0680` |
| `drivers/drc20_data_driver.wasm` | `d28ff096116b142425605ebc5efd05c9386e35c67edb5f52ebb5a751e5db08be` |
| `drivers/drc721_data_driver.wasm` | `9c51c5f473a2c0ccb792f1171739c46ed651a27909c7fbe06a31a700aa733c90` |

## Artifact Inspection

Chrome and Firefox builds each produced 56 files, about 3.7 MB per build directory.

Focused entrypoint scan:

| Entry | Network APIs | Dynamic code | Notes |
| --- | --- | --- | --- |
| `dist/background.js`, `dist-firefox/background.js` | `fetch`: 1 | none | Expected node/prover/archive health checks from wallet-owned code. |
| `dist/offscreen.js`, `dist-firefox/offscreen.js` | `fetch`: 8, `WebSocket`: 1 | none | Expected wallet engine/node/prover/archive traffic through `@dusk/w3sper` and wallet-owned sync/driver code. |
| `dist/contentScript.js`, `dist-firefox/contentScript.js` | none | none | Extension bridge only; uses extension messaging and local `window.postMessage`. |
| `dist/inpage.js`, `dist-firefox/inpage.js` | none | none | Provider surface only; no network path or third-party bundle. |

Other scan results:

- `XMLHttpRequest`, `sendBeacon`, and `EventSource`: no hits in Chrome or Firefox artifacts.
- `eval` and `new Function`: no hits in Chrome or Firefox artifacts.
- `import(` appears in Vite-generated local chunk loading and in `exu-sandbox-worker.js`, where it imports a local `importsUrl`.
- Remote URL strings are expected presets (`https://nodes.dusk.network`, `https://testnet.nodes.dusk.network`, prover URLs, explorer URLs, and local node URLs), data URI provider icon content, and `runtime.getURL`/`browser.runtime.getURL` local extension asset paths.
- The manifest CSP allows `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`; Firefox also includes `worker-src 'self'`. This is expected for local WASM execution and does not permit remote script execution.
- `host_permissions` cover `http`, `https`, `ws`, and `wss` broadly. This is needed for custom Dusk node/prover/archive endpoints, but it increases blast radius if the background/offscreen dependency stack is compromised.
- Secret-term hits are expected in wallet-owned UI/vault/engine code and the bundled BIP39 wordlist. No suspicious exfil API was colocated in `contentScript.js` or `inpage.js`.

## Audit Findings

`npm audit --json` reported 9 findings: 6 low, 1 moderate, 2 high, 0 critical.

| Package | Severity | Direct | Reason | Recommendation |
| --- | --- | --- | --- | --- |
| `vite` | high | yes | Vite/esbuild advisory chain; audit suggests Vite `8.0.12`, a major build-chain change | Keep deferred to dedicated Vite/esbuild PR with extension artifact diffs and Chrome/Firefox smoke tests. |
| `rollup` | high | no | Rollup advisory; fix is available | Apply in dedicated Rollup PR with generated artifact review because Rollup directly changes extension bundle output. |
| `esbuild` | moderate | no | Pulled by Vite; install-time binary/postinstall component | Handle with the Vite PR; do not silently change bundler output in this review. |
| `vite-plugin-node-polyfills` | low | yes | Pulls `node-stdlib-browser` and Browserify crypto shims | Audit separately and try to reduce/remove polyfills used by extension bundles. |
| `node-stdlib-browser` | low | no | Pulls broad Node/browser shims including `crypto-browserify` | Same as polyfill audit path. |
| `crypto-browserify` | low | no | Pulls Browserify crypto stack | Same as polyfill audit path. |
| `browserify-sign` | low | no | Via `elliptic` | Same as polyfill audit path. |
| `create-ecdh` | low | no | Via `elliptic` | Same as polyfill audit path. |
| `elliptic` | low | no | Transitive crypto advisory path | Same as polyfill audit path. |

## Risk Table

| Package/name | Direct/transitive | Runtime/build/test | Bundled into extension? | Lifecycle scripts? | Network/file/process capability? | Risk | Recommendation |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `@jsr/dusk__w3sper@1.6.0` (`@dusk/w3sper`) | Direct runtime | Runtime | Yes: offscreen and `chunks/lux.js` | None found | Uses Dusk node/prover/archive network paths and wallet engine APIs | High inherent trust | Keep pinned for v0.1; require provenance/source review for future bumps. |
| `@jsr/dusk__exu@0.1.2` | Transitive runtime | Runtime | Yes: `chunks/lux.js` | None found | WASM/sandbox support; local worker/import path | Medium-high | Keep pinned; review alongside `@dusk/w3sper` updates. |
| `bip39@3.1.0` | Direct runtime | Runtime | Yes: `chunks/index4.js` | None found | Handles mnemonic/seed derivation; no network | High inherent trust | Keep pinned; audit before replacing or upgrading. |
| `@noble/hashes@1.8.0` | Transitive runtime | Runtime | Yes: `chunks/index4.js` | None found | Crypto primitives; no network | Medium | Accept for v0.1; update only with crypto review. |
| `wallet_core-1.6.0.wasm` | First-party/packaged artifact | Runtime | Yes | N/A | Executes local wallet cryptographic engine | High inherent trust | Record checksum in release notes; only ship from reviewed source/provenance. |
| `drc20_data_driver.wasm`, `drc721_data_driver.wasm` | First-party/packaged artifact | Runtime | Yes | N/A | Local contract data-driver WASM | Medium-high | Record checksums and review on every driver change. |
| `vite-plugin-node-polyfills@0.23.0` | Direct build/runtime polyfill | Build and bundled shims | Yes: `chunks/index4.js` | None found | Pulls Node polyfill graph including crypto shims | Medium-high | Dedicated audit/removal path before or immediately after v0.1; do not mix with unrelated work. |
| `node-stdlib-browser@1.3.1` | Transitive | Bundled shims | Indirectly via polyfills | None found | Broad Node shims: `crypto`, streams, buffers, process/url/http shims | Medium-high | Identify exact used shims and remove unused polyfills. |
| `crypto-browserify@3.12.1` plus `browserify-sign`, `create-ecdh`, `elliptic` | Transitive | Bundled shims | Indirectly via polyfills | `prepack` metadata only | Crypto primitives; no artifact network API by itself | Medium | Keep out of signing/key paths where possible; reduce polyfill dependency. |
| `@tauri-apps/api` and Tauri plugins | Direct runtime | Runtime for Tauri mode | Yes in shared chunks | None found | File/stronghold/store capability in Tauri context | Medium | Accept for v0.1 extension build; review separately for Tauri distribution. |
| `jsqr@1.4.0` | Direct runtime | UI runtime | Yes: popup | None found | QR parsing; no network | Low | Accept. |
| `qrcode-generator@2.0.4` | Direct runtime | UI runtime | Yes: popup | None found | QR generation; no network | Low | Accept. |
| `vite@5.4.21` | Direct dev/build | Build | Not runtime, controls output | Bin; no package install script | Reads/writes build graph; can poison artifacts if compromised | High release-integrity | Dedicated Vite/esbuild PR with artifact diffs. |
| `rollup@4.53.5` and `@rollup/rollup-linux-x64-*` | Transitive build | Build | Not runtime, controls output | Native binary packages; `prepare` metadata | Native bundler controls generated JS | High release-integrity | Dedicated Rollup PR with artifact diffs. |
| `esbuild@0.21.5`, `@esbuild/linux-x64@0.21.5` | Transitive build | Build | Not runtime, controls output | `postinstall: node install.js`; native binary package | Native build transform path | Medium-high release-integrity | Handle with Vite/esbuild PR; prefer clean CI build and artifact comparison. |
| `storybook`, `@storybook/html-vite`, `vitest`, `@vitest/coverage-v8`, `fake-indexeddb`, `@playwright/test` | Direct dev/test | Test/dev | No extension runtime entrypoints | Some package metadata scripts; Playwright binaries | Test/dev process and browser automation | Low for shipped extension, medium for CI | Keep lockfile pinned; do not expose release secrets to untrusted PR jobs. |

## Release Recommendations

- **Vite upgrade PR:** keep separate. It should run `npm ci`, tests, Chrome/Firefox builds, inspect `dist`/`dist-firefox` diffs, and smoke-test install/unlock/connect/send paths. This is a build-output-changing PR and should not be hidden inside docs or small dependency hygiene work.
- **Rollup upgrade PR:** keep separate. Rollup has native platform packages and controls bundle shape; require generated artifact diff review and extension smoke tests.
- **`vite-plugin-node-polyfills` / `crypto-browserify` audit path:** prioritize reducing the polyfill surface. The current artifact scan did not find exfil APIs in provider bridge files, but Browserify crypto shims and `node-stdlib-browser` are broader than ideal for a wallet. Inventory exact imports, remove unused Node shims, and document any required shims that remain.
- **Current v0.1 posture:** v0.1 can ship with the current dependency set only with caveats: pin the lockfile, build from clean CI, record WASM checksums, review Chrome/Firefox artifacts before release, and keep the Vite/Rollup/polyfill audit work explicitly tracked. No critical issue in this pass required an immediate dependency upgrade.
