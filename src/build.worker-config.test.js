import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { w3sperOwnedWorkerPlugin } from "../vite.extension-workers.js";

describe("extension worker build config", () => {
  it("configures extension-hosted workers for Chrome and Firefox builds", async () => {
    const plugin = await readFile(
      path.resolve(process.cwd(), "vite.extension-workers.js"),
      "utf8"
    );
    const chromeConfig = await readFile(path.resolve(process.cwd(), "vite.config.js"), "utf8");
    const firefoxConfig = await readFile(path.resolve(process.cwd(), "vite.firefox.config.js"), "utf8");
    const walletEngine = await readFile(
      path.resolve(process.cwd(), "src", "shared", "walletEngine.js"),
      "utf8"
    );
    const chromeManifest = JSON.parse(
      await readFile(path.resolve(process.cwd(), "public", "manifest.json"), "utf8")
    );
    const firefoxManifest = JSON.parse(
      await readFile(path.resolve(process.cwd(), "config", "manifest.firefox.json"), "utf8")
    );

    expect(plugin).toContain("@dusk/w3sper/src/network/syncer/address.js");
    expect(plugin).toContain("owned-note workers are disabled");
    expect(plugin).toContain("streamCanceled");
    expect(plugin).toContain("cancelSource(reason)");
    expect(plugin).toContain("dusk__exu/src/sandbox/mod.js");
    expect(plugin).toContain("exu-sandbox-worker.js");
    expect(chromeConfig).toContain("w3sperOwnedWorkerPlugin()");
    expect(chromeConfig).toContain("exuSandboxWorkerPlugin()");
    expect(firefoxConfig).toContain("w3sperOwnedWorkerPlugin()");
    expect(firefoxConfig).toContain("exuSandboxWorkerPlugin()");
    expect(walletEngine).toContain("ownershipWorkers: 1");
    expect(walletEngine).toContain("createAddressSyncer(state.network)");
    expect(chromeManifest.content_security_policy.extension_pages).toContain("worker-src 'self'");
    expect(firefoxManifest.content_security_policy.extension_pages).toContain("worker-src 'self'");
  });

  it("rewrites the installed W3sper address syncer stream for extension cancellation", async () => {
    const sourcePath = path.resolve(
      process.cwd(),
      "node_modules",
      "@dusk",
      "w3sper",
      "src",
      "network",
      "syncer",
      "address.js"
    );
    const source = await readFile(sourcePath, "utf8");
    const result = w3sperOwnedWorkerPlugin().transform(source, sourcePath);

    expect(result).toBeTruthy();
    expect(result.code).toContain("owned-note workers are disabled in extension builds");
    expect(result.code).not.toContain("./owned_worker.js?worker&url");
    expect(result.code).not.toContain('new URL("./owned_worker.js", import.meta.url)');
    expect(result.code).toContain("let streamCanceled = false");
    expect(result.code).toContain("const cancelSource = async (reason)");
    expect(result.code).toContain("await reader.cancel(reason)");
    expect(result.code).toContain("if (streamCanceled)");
    expect(result.code).toContain("return cancelSource(reason)");
    expect(result.code).not.toContain("closed readable stream");
  });
});
