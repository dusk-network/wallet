import { defineConfig } from "vite";
import inject from "@rollup/plugin-inject";

// Frontend build for Tauri desktop/mobile.
//
// Key differences vs the extension build:
// - Only one entrypoint is required (the wallet UI)
// - No background/contentScript/inpage/offscreen bundles

export default defineConfig({
  plugins: [],
  define: {
    __DUSK_BACKEND__: JSON.stringify("local"),
  },
  build: {
    outDir: "dist-tauri",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      plugins: [
        // bip39@3.1.0 is CommonJS and references the Node Buffer global.
        // Keep this to Buffer only; do not pull the full node-stdlib-browser graph.
        inject({ Buffer: ["buffer", "Buffer"] }),
      ],
      input: {
        popup: "src/popup.js",
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
