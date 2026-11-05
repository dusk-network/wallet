import { readFile } from "node:fs/promises";
import path from "node:path";
import { networks } from "@dusk-network/networks";
import { describe, expect, it } from "vitest";
import { w3sperOwnedWorkerPlugin } from "../vite.extension-workers.js";

describe("the offer on the web wallet", () => {
  it("runs on each network's web wallet, in both builds, and nowhere else", async () => {
    const send = Object.values(networks).flatMap((n) => (n.apps.wallet ? [`${n.apps.wallet}/*`] : []));
    expect(send.length).toBeGreaterThan(0);
    for (const file of [["public", "manifest.json"], ["config", "manifest.firefox.json"]]) {
      const { content_scripts: scripts } = JSON.parse(await readFile(path.resolve(process.cwd(), ...file), "utf8"));
      expect(scripts.find((s) => s.js.includes("requestLinkOffer.js")).matches.sort()).toEqual([...send].sort());
    }
    for (const config of ["vite.config.js", "vite.firefox.config.js"]) {
      expect(await readFile(path.resolve(process.cwd(), config), "utf8")).toContain('requestLinkOffer: "src/requestLinkOffer.js"');
    }
    // A classic script: no static imports in what's bundled, and nothing declared
    // at its top, which the extension's other content script shares.
    const script = await readFile(path.resolve(process.cwd(), "src", "requestLinkOffer.js"), "utf8");
    expect(script).not.toMatch(/^\s*import\s/m);
    expect(script).not.toMatch(/^(const|let|var|class|function)\s/m);
  });
});

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
    expect(walletEngine).toContain("createAddressSyncer(network)");
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
