import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

const engineDebug = process.env.DUSK_ENGINE_DEBUG === "1";

export default defineConfig({
  plugins: [
    // bip39 pulls in node shims, the web-wallet already uses this plugin.
    nodePolyfills(),
  ],
  define: {
    // Build-time constant used by src/wallet/bus.js to avoid bundling the
    // local (Tauri/web) backend into the extension bundle.
    __DUSK_BACKEND__: JSON.stringify("extension"),
    __DUSK_TARGET__: JSON.stringify("chrome"),
    __DUSK_ENGINE_HOST__: JSON.stringify("offscreen"),
    ...(engineDebug ? { "globalThis.__DUSK_ENGINE_DEBUG__": "true" } : {}),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    // We use multiple JS entrypoints so the output file names are stable.
    rollupOptions: {
      input: {
        background: "src/background.js",
        contentScript: "src/contentScript.js",
        inpage: "src/inpage.js",
        offscreen: "src/offscreen.js",
        engine: "src/engine.js",
        popup: "src/popup.js",
        notification: "src/notification.js",
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
