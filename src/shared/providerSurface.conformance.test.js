import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  DAPP_DISCOVERY_EVENTS,
  DAPP_DISCOVERY_INFO_FIELDS,
  DAPP_RPC_METHODS,
} from "./providerSurface.js";

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

function extractSectionBacktickedBullets(markdown, sectionTitle) {
  const lines = String(markdown).split(/\r?\n/);
  const out = [];
  let inSection = false;

  for (const line of lines) {
    if (line === `## ${sectionTitle}`) {
      inSection = true;
      continue;
    }

    if (inSection && /^##\s+/.test(line)) break;
    if (!inSection) continue;

    const m = line.match(/^\s*-\s+`([^`]+)`\s*$/);
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

function extractStringConstantAssignments(jsSource) {
  const out = [];
  const re = /\bconst\s+[A-Z0-9_]+\s*=\s*"([^"]+)"/g;
  const s = String(jsSource);
  for (;;) {
    const m = re.exec(s);
    if (!m) break;
    out.push(m[1]);
  }
  return out;
}

function extractQuotedObjectKeys(jsSource, objectName) {
  const out = [];
  const block = String(jsSource).match(new RegExp(`${objectName}\\s*=\\s*Object\\.freeze\\s*\\(\\s*\\{([\\s\\S]*?)\\}\\s*\\)`));
  if (!block) return out;
  const re = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:/gm;
  for (;;) {
    const m = re.exec(block[1]);
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

  it("docs/provider-api.md discovery section matches canonical discovery events and metadata fields", async () => {
    const docPath = path.resolve(process.cwd(), "docs", "provider-api.md");
    const md = await readFile(docPath, "utf8");

    expect(uniqSorted(extractSectionBacktickedBullets(md, "Discovery").filter((v) => v.startsWith("dusk:")))).toEqual(
      uniqSorted(DAPP_DISCOVERY_EVENTS)
    );
    expect(
      uniqSorted(
        extractSectionBacktickedBullets(md, "Discovery").filter((v) => !v.startsWith("dusk:"))
      )
    ).toEqual(uniqSorted(DAPP_DISCOVERY_INFO_FIELDS));
  });

  it("src/background/rpc.js implements all canonical dApp RPC methods", async () => {
    const rpcPath = path.resolve(process.cwd(), "src", "background", "rpc.js");
    const js = await readFile(rpcPath, "utf8");
    const impl = new Set(extractRpcSwitchCases(js));
    for (const m of DAPP_RPC_METHODS) {
      expect(impl.has(m)).toBe(true);
    }
  });

  it("src/inpage.js implements the canonical discovery events and provider metadata fields", async () => {
    const inpagePath = path.resolve(process.cwd(), "src", "inpage.js");
    const js = await readFile(inpagePath, "utf8");

    const assignedConstants = new Set(extractStringConstantAssignments(js));
    for (const eventName of DAPP_DISCOVERY_EVENTS) {
      expect(assignedConstants.has(eventName)).toBe(true);
    }

    const metadataFields = uniqSorted(extractQuotedObjectKeys(js, "walletInfo"));
    expect(metadataFields).toEqual(uniqSorted(DAPP_DISCOVERY_INFO_FIELDS));
  });

  it("SDK discovery spec matches the canonical discovery events and metadata fields (when available)", async () => {
    const specPath = path.resolve(process.cwd(), "..", "dusk-wallet-sdk", "docs", "wallet-discovery.md");
    let md;
    try {
      md = await readFile(specPath, "utf8");
    } catch {
      return;
    }

    expect(uniqSorted(extractSectionBacktickedBullets(md, "Events"))).toEqual(
      uniqSorted(DAPP_DISCOVERY_EVENTS)
    );
    expect(uniqSorted(extractSectionBacktickedBullets(md, "Wallet Metadata"))).toEqual(
      uniqSorted(DAPP_DISCOVERY_INFO_FIELDS)
    );
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
