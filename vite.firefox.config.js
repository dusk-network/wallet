import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

const MANIFEST_PATH = path.resolve("config/manifest.firefox.json");

function manifestPlugin() {
  let outDir = "dist-firefox";
  return {
    name: "dusk-firefox-manifest",
    apply: "build",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      fs.copyFileSync(MANIFEST_PATH, path.join(outDir, "manifest.json"));
    },
  };
}

export default defineConfig({
  plugins: [nodePolyfills(), manifestPlugin()],
  define: {
    __DUSK_BACKEND__: JSON.stringify("extension"),
    __DUSK_TARGET__: JSON.stringify("firefox"),
    __DUSK_ENGINE_HOST__: JSON.stringify("enginePage"),
  },
  build: {
    outDir: "dist-firefox",
    emptyOutDir: true,
    sourcemap: true,
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
