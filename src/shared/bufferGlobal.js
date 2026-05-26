import { Buffer } from "buffer";

// bip39@3.1.0 expects a Node-style Buffer global at call time. Production
// extension builds inject Buffer through Rollup; Vite dev/e2e needs the same
// narrow shim without restoring the broader Node polyfill surface.
if (typeof globalThis.Buffer === "undefined") {
  Object.defineProperty(globalThis, "Buffer", {
    configurable: true,
    writable: true,
    value: Buffer,
  });
}
