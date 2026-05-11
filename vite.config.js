import { defineConfig } from "vite";
import inject from "@rollup/plugin-inject";

const engineDebug = process.env.DUSK_ENGINE_DEBUG === "1";

export default defineConfig({
  plugins: [],
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
      plugins: [
        // bip39@3.1.0 is CommonJS and references the Node Buffer global.
        // Keep this to Buffer only; do not pull the full node-stdlib-browser graph.
        inject({ Buffer: ["buffer", "Buffer"] }),
      ],
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
