import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import releases from "./dusk-domains-releases.json";
import { NETWORK_PRESETS } from "./networkPresets.js";

vi.mock("@duskdomains/sdk/lens-reader", async (importOriginal) => ({
  ...(await importOriginal()),
  createLensReader: vi.fn(),
}));

const nodeUrl = (id) => NETWORK_PRESETS.find((preset) => preset.id === id).nodeUrl;
const MAINNET = nodeUrl("mainnet");
const TESTNET = nodeUrl("testnet");

const ACCOUNT =
  "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927";
const ADDRESS =
  "2Ana1pUpv2ZbMVkwF5FXapYeBEjdxDatLn7nvJkhgTSXbs59SyZSx866bXirPgj8QQVB57uxHJBG1YFvkRbFj4T";

let lens;
let names;

beforeEach(async () => {
  // An extension runtime, so bundled assets resolve to extension URLs.
  vi.stubGlobal("chrome", {
    runtime: { id: "wallet", sendMessage() {}, getURL: (p) => `chrome-extension://wallet/${p}` },
  });
  // Fresh module state (reader and lookup caches) per test; the mocked SDK is shared.
  vi.resetModules();
  lens = await import("@duskdomains/sdk/lens-reader");
  lens.createLensReader.mockReset();
  names = await import("./duskNames.js");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// What `resolveMoonlightAccount` answers.
const answer = (status, account) => ({ status, height: 1n, ...(account === undefined ? {} : { account }) });

function useReader(resolveMoonlightAccount) {
  const reader = { resolveMoonlightAccount: vi.fn(resolveMoonlightAccount) };
  lens.createLensReader.mockResolvedValue(reader);
  return reader;
}

describe("isDuskName", () => {
  it("detects input ending in .dusk", () => {
    expect(names.isDuskName("alice.dusk")).toBe(true);
    expect(names.isDuskName("  Alice.DUSK ")).toBe(true);
    expect(names.isDuskName("pay.alice.dusk")).toBe(true);
  });

  it("leaves raw recipients and other text alone", () => {
    for (const value of [ACCOUNT, ADDRESS, "", null, undefined, "alice", "alice.dus", "alice.dusk.network"]) {
      expect(names.isDuskName(value)).toBe(false);
    }
    expect(names.isDuskName(`dusk:public-${ACCOUNT}`)).toBe(false);
    expect(names.isDuskName("dusk:alice.dusk")).toBe(false);
  });
});

describe("duskNamesNetwork", () => {
  it("turns names on for mainnet and testnet only", () => {
    expect(names.duskNamesNetwork(MAINNET)).toBe("mainnet");
    expect(names.duskNamesNetwork(TESTNET)).toBe("testnet");
    for (const url of [nodeUrl("devnet"), nodeUrl("local"), "https://rusk.example.com", "", "not a url", undefined]) {
      expect(names.duskNamesNetwork(url)).toBeNull();
    }
  });
});

describe("resolveDuskName", () => {
  it("resolves an active name to its public account through the pinned release", async () => {
    const reader = useReader(async () => answer("Active", ACCOUNT));

    await expect(names.resolveDuskName(" TDI.dusk ", { nodeUrl: TESTNET })).resolves.toEqual({
      ok: true,
      name: "tdi.dusk",
      account: ACCOUNT,
    });

    expect(lens.createLensReader).toHaveBeenCalledTimes(1);
    expect(lens.createLensReader).toHaveBeenCalledWith(releases.testnet, {
      nodeUrl: TESTNET,
      artifactBaseUrl: "https://testnet.dusk.domains/",
      fetch: expect.any(Function),
    });
    expect(reader.resolveMoonlightAccount).toHaveBeenCalledWith("tdi.dusk");
  });

  it("uses the mainnet release with the wallet's mainnet node", async () => {
    useReader(async () => answer("Active", ACCOUNT));

    await expect(names.resolveDuskName("alice.dusk", { nodeUrl: MAINNET })).resolves.toMatchObject({ ok: true });
    expect(lens.createLensReader).toHaveBeenCalledWith(
      releases.mainnet,
      expect.objectContaining({ nodeUrl: MAINNET, artifactBaseUrl: "https://dusk.domains/" })
    );
  });

  it("loads bundled drivers from the extension and sends nothing but node reads", async () => {
    useReader(async () => answer("Active", ACCOUNT));
    await names.resolveDuskName("tdi.dusk", { nodeUrl: TESTNET });
    const { fetch: sdkFetch } = lens.createLensReader.mock.calls[0][1];
    const network = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", network);
    const { signal } = new AbortController();

    const bundled = names.bundledDrivers(releases.testnet);
    for (const { url, file } of bundled) {
      await sdkFetch(new URL(url), { signal });
      expect(network).toHaveBeenLastCalledWith(`chrome-extension://wallet/drivers/dusk-domains/${file}`, { signal });
    }

    const query = `${TESTNET}/on/contracts:${releases.testnet.lens.contractId}/resolve`;
    const read = { method: "POST", body: new Uint8Array([1]), signal };
    await sdkFetch(query, read);
    expect(network).toHaveBeenLastCalledWith(query, read);

    const unbundled = [...releases.testnet.contracts, releases.testnet.lens]
      .filter(({ role }) => !names.BUNDLED_DRIVER_ROLES.includes(role))
      .map(({ dataDriver }) => new URL(dataDriver.path, releases.testnet.artifactBaseUrl).href);
    for (const url of [
      ...unbundled,
      "https://testnet.dusk.domains/api/names/tdi.dusk",
      `https://dusk.domains/${releases.testnet.lens.dataDriver.path}`,
      `${TESTNET}.example.org/on/graphql/query`,
      "https://example.org/",
    ]) {
      await expect(sdkFetch(url)).rejects.toThrow("Refused request");
    }
    expect(network).toHaveBeenCalledTimes(bundled.length + 1);
  });

  it("refuses names off mainnet and testnet without building a reader", async () => {
    for (const url of [nodeUrl("devnet"), nodeUrl("local"), "https://rusk.example.com", undefined]) {
      await expect(names.resolveDuskName("alice.dusk", { nodeUrl: url })).resolves.toEqual({
        ok: false,
        name: "alice.dusk",
        reason: "unsupported_network",
      });
    }
    expect(lens.createLensReader).not.toHaveBeenCalled();
  });

  it("rejects invalid names with the SDK's validation", async () => {
    for (const input of ["bad name.dusk", ".dusk", "a..dusk"]) {
      await expect(names.resolveDuskName(input, { nodeUrl: TESTNET })).resolves.toMatchObject({
        ok: false,
        reason: "invalid_name",
      });
    }
    expect(lens.createLensReader).not.toHaveBeenCalled();
  });

  it.each([
    ["Absent", "not_registered"],
    ["Released", "not_registered"],
    ["Grace", "expired"],
    ["Expired", "expired"],
  ])("maps a %s name to %s", async (status, reason) => {
    useReader(async () => answer(status));

    await expect(names.resolveDuskName("alice.dusk", { nodeUrl: TESTNET })).resolves.toEqual({
      ok: false,
      name: "alice.dusk",
      reason,
    });
  });

  it.each([
    ["no account", undefined],
    ["a shielded address", ADDRESS],
    ["text that is no Base58", "0OIl"],
    ["an empty string", ""],
  ])("checks the account as any address (%s)", async (_label, account) => {
    useReader(async () => answer("Active", account));

    await expect(names.resolveDuskName("alice.dusk", { nodeUrl: TESTNET })).resolves.toEqual({
      ok: false,
      name: "alice.dusk",
      reason: "no_account",
    });
  });

  it("fails every reader error and unexpected answer", async () => {
    const reader = useReader(async () => null);
    const failures = ["deployment", "refused", "decode", "evidence", "read", "timeout"].map(
      (reason) => () => Promise.reject(new lens.LensReaderError(reason, `lens ${reason}`))
    );
    failures.push(
      () => Promise.reject(new Error("Invalid label")),
      async () => answer("Unknown", ACCOUNT),
      async () => null
    );
    for (const failure of failures) {
      reader.resolveMoonlightAccount.mockImplementationOnce(failure);
      await expect(names.resolveDuskName("alice.dusk", { nodeUrl: TESTNET })).resolves.toEqual({
        ok: false,
        name: "alice.dusk",
        reason: "lookup_failed",
      });
    }
    expect(reader.resolveMoonlightAccount).toHaveBeenCalledTimes(failures.length);
  });

  it("reuses one reader per network and node", async () => {
    useReader(async () => answer("Active", ACCOUNT));

    await names.resolveDuskName("alice.dusk", { nodeUrl: TESTNET });
    await names.resolveDuskName("bob.dusk", { nodeUrl: TESTNET });
    expect(lens.createLensReader).toHaveBeenCalledTimes(1);

    await names.resolveDuskName("alice.dusk", { nodeUrl: MAINNET });
    await names.resolveDuskName("alice.dusk", { nodeUrl: "https://testnet.example.org" });
    expect(lens.createLensReader).toHaveBeenCalledTimes(3);
  });

  it("drops a reader that failed to build so the next lookup retries", async () => {
    lens.createLensReader.mockRejectedValueOnce(new lens.LensReaderError("deployment", "The lens driver did not load"));
    await expect(names.resolveDuskName("alice.dusk", { nodeUrl: TESTNET })).resolves.toMatchObject({
      reason: "lookup_failed",
    });

    useReader(async () => answer("Active", ACCOUNT));
    await expect(names.resolveDuskName("alice.dusk", { nodeUrl: TESTNET })).resolves.toMatchObject({ ok: true });
    expect(lens.createLensReader).toHaveBeenCalledTimes(2);
  });

  it("keeps a working reader when a read fails", async () => {
    const reader = useReader(async () => {
      throw new lens.LensReaderError("read", "Lens resolve query failed: HTTP 500");
    });
    await expect(names.resolveDuskName("alice.dusk", { nodeUrl: TESTNET })).resolves.toMatchObject({
      reason: "lookup_failed",
    });

    reader.resolveMoonlightAccount.mockResolvedValueOnce(answer("Active", ACCOUNT));
    await expect(names.resolveDuskName("alice.dusk", { nodeUrl: TESTNET })).resolves.toMatchObject({ ok: true });
    expect(lens.createLensReader).toHaveBeenCalledTimes(1);
  });
});

describe("lookupDuskName", () => {
  it("shares a running lookup and reuses its answer for a minute", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const reader = useReader(async () => answer("Active", ACCOUNT));

    const first = names.lookupDuskName("alice.dusk", { nodeUrl: TESTNET });
    expect(names.lookupDuskName("alice.dusk", { nodeUrl: TESTNET })).toBe(first);
    await expect(first.promise).resolves.toMatchObject({ ok: true, account: ACCOUNT });
    expect(first.result).toMatchObject({ ok: true });

    vi.advanceTimersByTime(59_000);
    expect(names.lookupDuskName("alice.dusk", { nodeUrl: TESTNET })).toBe(first);
    expect(reader.resolveMoonlightAccount).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2_000);
    const again = names.lookupDuskName("alice.dusk", { nodeUrl: TESTNET });
    expect(again).not.toBe(first);
    await again.promise;
    expect(reader.resolveMoonlightAccount).toHaveBeenCalledTimes(2);
  });

  it("looks up again after a failure or for other input", async () => {
    const reader = useReader(async () => {
      throw new lens.LensReaderError("read", "offline");
    });

    const failed = names.lookupDuskName("alice.dusk", { nodeUrl: TESTNET });
    await expect(failed.promise).resolves.toMatchObject({ reason: "lookup_failed" });

    reader.resolveMoonlightAccount.mockResolvedValue(answer("Active", ACCOUNT));
    const retried = names.lookupDuskName("alice.dusk", { nodeUrl: TESTNET });
    expect(retried).not.toBe(failed);
    await expect(retried.promise).resolves.toMatchObject({ ok: true });

    expect(names.lookupDuskName("bob.dusk", { nodeUrl: TESTNET })).not.toBe(retried);
    expect(names.lookupDuskName("alice.dusk", { nodeUrl: MAINNET })).not.toBe(retried);
  });
});

describe("duskNameErrorText", () => {
  it("explains each failure", () => {
    const text = (reason) => names.duskNameErrorText({ name: "alice.dusk", reason });
    expect(text("invalid_name")).toBe("This isn't a valid .dusk name.");
    expect(text("unsupported_network")).toBe("Sending to .dusk names works on Mainnet and Testnet only.");
    expect(text("not_registered")).toBe("alice.dusk isn't registered.");
    expect(text("expired")).toBe("alice.dusk has expired.");
    expect(text("no_account")).toBe("alice.dusk has no public account to send to.");
    expect(text("lookup_failed")).toBe("Couldn't look up alice.dusk.");
  });
});

describe("bundled data drivers", () => {
  it("ships exactly the bundled drivers, each matching its pinned sha256", async () => {
    const pinned = new Map();
    for (const release of Object.values(releases)) {
      for (const { file, sha256 } of names.bundledDrivers(release)) {
        expect(pinned.get(file) ?? sha256).toBe(sha256);
        pinned.set(file, sha256);
      }
    }
    expect(pinned.size).toBeGreaterThan(0);

    const dir = path.resolve(process.cwd(), "public", "drivers", "dusk-domains");
    expect((await readdir(dir)).sort()).toEqual([...pinned.keys()].sort());
    for (const [file, sha256] of pinned) {
      const digest = createHash("sha256").update(await readFile(path.join(dir, file))).digest("hex");
      expect(digest, file).toBe(sha256);
    }
  });
});

describe("bundle boundary", () => {
  it("loads the SDK and release descriptors only on lookup", async () => {
    const read = (...parts) => readFile(path.resolve(process.cwd(), "src", ...parts), "utf8");
    const module = await read("shared", "duskNames.js");
    const shim = await read("shared", "duskNamesSdk.js");
    const sendView = await read("ui", "popup", "views", "send.js");

    expect(module).not.toContain("@duskdomains/sdk");
    expect(module).not.toMatch(/^import[^;]*(duskNamesSdk|dusk-domains-releases)/m);
    expect(module).toContain('import("./duskNamesSdk.js")');
    expect(module).toContain('import("./dusk-domains-releases.json"');
    expect(shim).toContain('export { validateName } from "@duskdomains/sdk";');
    expect(shim).toContain('export { createLensReader } from "@duskdomains/sdk/lens-reader";');
    expect(sendView).not.toMatch(/@duskdomains\/sdk|duskNamesSdk/);
  });
});
