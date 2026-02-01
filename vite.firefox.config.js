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

// Plugin to replace blob worker URLs with static worker file for Firefox.
// Firefox MV3 blocks blob: URL workers, so we need to use static files.
function firefoxWorkerPlugin() {
  return {
    name: "dusk-firefox-worker",
    apply: "build",
    transform(code, id) {
      // Only transform the exu sandbox module
      const normalizedId = String(id || "").replace(/\\/g, "/");
      if (!normalizedId.includes("dusk__exu/src/sandbox/mod.js")) {
        return null;
      }

      const blobPattern =
        /const\s+workerUrl\s*=\s*URL\.createObjectURL\([\s\S]*?\);/m;

      if (blobPattern.test(code)) {
        const replacement = `
// Firefox MV3 compatible: use static worker file instead of blob URL
function getWorkerUrl() {
  if (typeof browser !== "undefined" && browser.runtime && browser.runtime.getURL) {
    return browser.runtime.getURL("exu-sandbox-worker.js");
  }
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL) {
    return chrome.runtime.getURL("exu-sandbox-worker.js");
  }
  return "exu-sandbox-worker.js";
}
const workerUrl = getWorkerUrl();`;

        const newCode = code.replace(blobPattern, replacement);

        // Also remove the worker import since we don't need it anymore
        const importPattern =
          /import\s+worker\s+from\s+["']\.\/worker\.js["']\s*;?/;
        const finalCode = newCode.replace(importPattern, "");

        return {
          code: finalCode,
          map: null,
        };
      }

      return null;
    },
  };
}

export default defineConfig({
  plugins: [nodePolyfills(), firefoxWorkerPlugin(), manifestPlugin()],
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
