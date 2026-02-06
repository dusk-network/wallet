import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { DAPP_RPC_METHODS } from "./providerSurface.js";

function uniqSorted(arr) {
  return [...new Set(arr)].sort();
}

function extractDocMethods(markdown) {
  const out = [];
  for (const line of String(markdown).split(/\r?\n/)) {
    const m = line.match(/^###\s+`(dusk_[^`]+)`\s*$/);
    if (m) out.push(m[1]);
  }
  return out;
}

function extractSdkReadmeMethods(markdown) {
  const out = [];
  for (const line of String(markdown).split(/\r?\n/)) {
    const m = line.match(/^\s*-\s+`(dusk_[^`]+)`\s*$/);
    if (m) out.push(m[1]);
  }
  return out;
}

function extractRpcSwitchCases(jsSource) {
  const out = [];
  const re = /\bcase\s+"([^"]+)"\s*:/g;
  const s = String(jsSource);
  for (;;) {
    const m = re.exec(s);
    if (!m) break;
    out.push(m[1]);
  }
  return out;
}

describe("Provider Surface Conformance", () => {
  it("docs/provider-api.md matches src/shared/providerSurface.js", async () => {
    const docPath = path.resolve(process.cwd(), "docs", "provider-api.md");
    const md = await readFile(docPath, "utf8");
    const docMethods = uniqSorted(extractDocMethods(md));
    const canonical = uniqSorted(DAPP_RPC_METHODS);
    expect(docMethods).toEqual(canonical);
  });

  it("src/background/rpc.js implements all canonical dApp RPC methods", async () => {
    const rpcPath = path.resolve(process.cwd(), "src", "background", "rpc.js");
    const js = await readFile(rpcPath, "utf8");
    const impl = new Set(extractRpcSwitchCases(js));
    for (const m of DAPP_RPC_METHODS) {
      expect(impl.has(m)).toBe(true);
    }
  });

  it("SDK README method list matches canonical provider surface (when available)", async () => {
    const sdkReadmePath = path.resolve(process.cwd(), "..", "dusk-wallet-sdk", "README.md");
    let md;
    try {
      md = await readFile(sdkReadmePath, "utf8");
    } catch {
      // Allow running tests without the SDK repo checked out.
      return;
    }
    const sdkMethods = uniqSorted(extractSdkReadmeMethods(md));
    const canonical = uniqSorted(DAPP_RPC_METHODS);
    expect(sdkMethods).toEqual(canonical);
  });
});

