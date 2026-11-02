import { defineConfig } from "vite";
import { localW3sperAlias, w3sperStreamCompat } from "./vite.local-w3sper.js";

// Frontend build for Tauri desktop/mobile.
//
// Key differences vs the extension build:
// - Only one entrypoint is required (the wallet UI)
// - No background/contentScript/inpage/offscreen bundles

export default defineConfig({
  plugins: [w3sperStreamCompat()],
  resolve: {
    alias: localW3sperAlias(),
  },
  define: {
    __DUSK_BACKEND__: JSON.stringify("local"),
  },
  build: {
    outDir: "dist-tauri",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
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
