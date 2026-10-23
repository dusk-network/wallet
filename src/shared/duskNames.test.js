import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeBase58, encodeBase58 } from "@duskdomains/sdk";

import releases from "./dusk-domains-releases.json";
import { NETWORK_PRESETS } from "./networkPresets.js";

vi.mock("@duskdomains/sdk/lens-reader", async (importOriginal) => ({
  ...(await importOriginal()),
  createLensReader: vi.fn(),
}));
vi.mock("./verifiedNames.js", async (importOriginal) => ({
  ...(await importOriginal()),
  rememberVerifiedName: vi.fn(async () => {}),
}));

const nodeUrl = (id) => NETWORK_PRESETS.find((preset) => preset.id === id).nodeUrl;
const MAINNET = nodeUrl("mainnet");
const TESTNET = nodeUrl("testnet");

const ACCOUNT =
  "26FCH745YG5eTfL1CF7ExhifgcANFUvDTXtVPRz1MwNya7Lu23RnDZBYFLZUY6BRXnZhrhtb48Ax2Lsz3dQUX62mXaU4XRAoKm7qB9nFWpNNfhUDUVFo4teoosnwwJTck927";
const ADDRESS =
  "2Ana1pUpv2ZbMVkwF5FXapYeBEjdxDatLn7nvJkhgTSXbs59SyZSx866bXirPgj8QQVB57uxHJBG1YFvkRbFj4T";
// The same shapes with their last byte changed.
const otherOf = (value) => encodeBase58(decodeBase58(value).map((b, i, all) => (i === all.length - 1 ? b ^ 1 : b)));
const OTHER_ACCOUNT = otherOf(ACCOUNT);
const OTHER_ADDRESS = otherOf(ADDRESS);
const RECORD_KEYS = ["moonlight_address", "phoenix_payment_endpoint"];

let lens;
let names;
let kept;

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
  kept = await import("./verifiedNames.js");
  kept.rememberVerifiedName.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// Records as the reader returns them: a public account as its key's 96 bytes,
// a shielded address as UTF-8 text.
const record = (key, bytes) => ({ key, value: Array.from(bytes), ttl_seconds: 300n, updated_at: 1n });
const moonlight = (account) => record("moonlight_address", decodeBase58(account));
const utf8 = (text) => new TextEncoder().encode(text);
const phoenix = (value) => record("phoenix_payment_endpoint", typeof value === "string" ? utf8(value) : value);

// What `resolve` answers, with one record or null per key.
const answer = (status, records = [null, null]) => ({ status, height: 1n, records });
const active = (...records) => answer("Active", records);
// What `verifyPrimary` answers for a verified primary name.
const primary = (spelling) => ({ store: "", primary: { spelling }, record: moonlight(ACCOUNT), height: 1n });

function useReader({ resolve = async () => answer("Absent"), verifyPrimary = async () => null } = {}) {
  const reader = { resolve: vi.fn(resolve), verifyPrimary: vi.fn(verifyPrimary) };
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
    const reader = useReader({ resolve: async () => active(moonlight(ACCOUNT), null) });

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
    // Both addresses come from one lens query.
    expect(reader.resolve).toHaveBeenCalledTimes(1);
    expect(reader.resolve).toHaveBeenCalledWith("tdi.dusk", RECORD_KEYS);
  });

  it("resolves the shielded address in a name's phoenix_payment_endpoint record", async () => {
    const reader = useReader({ resolve: async () => active(null, phoenix(ADDRESS)) });
    await expect(names.resolveDuskName("alice.dusk", { nodeUrl: TESTNET })).resolves.toEqual({
      ok: true,
      name: "alice.dusk",
      address: ADDRESS,
    });

    reader.resolve.mockResolvedValueOnce(active(moonlight(ACCOUNT), phoenix(ADDRESS)));
    await expect(names.resolveDuskName("alice.dusk", { nodeUrl: TESTNET })).resolves.toEqual({
      ok: true,
      name: "alice.dusk",
      account: ACCOUNT,
      address: ADDRESS,
    });
    expect(reader.resolve).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a public account", ACCOUNT],
    ["text that is no Base58", "0OIl"],
    ["a shortened address", ADDRESS.slice(0, -4)],
    ["an address with a space before it", ` ${ADDRESS}`],
    ["an address with a line break after it", `${ADDRESS}\n`],
    ["an address after a byte order mark", `\uFEFF${ADDRESS}`],
    ["an address and a byte that is no UTF-8", [...utf8(ADDRESS), 0xff]],
    ["the address's 64 bytes rather than its text", decodeBase58(ADDRESS)],
  ])("counts a phoenix_payment_endpoint record holding %s as absent", async (_label, value) => {
    const reader = useReader({ resolve: async () => active(moonlight(ACCOUNT), phoenix(value)) });
    await expect(names.resolveDuskName("alice.dusk", { nodeUrl: TESTNET })).resolves.toEqual({
      ok: true,
      name: "alice.dusk",
      account: ACCOUNT,
    });

    reader.resolve.mockResolvedValueOnce(active(null, phoenix(value)));
    await expect(names.resolveDuskName("alice.dusk", { nodeUrl: TESTNET })).resolves.toEqual({
      ok: false,
      name: "alice.dusk",
      reason: "no_account",
    });
  });

  it("uses the mainnet release with the wallet's mainnet node", async () => {
    useReader({ resolve: async () => active(moonlight(ACCOUNT), null) });

    await expect(names.resolveDuskName("alice.dusk", { nodeUrl: MAINNET })).resolves.toMatchObject({ ok: true });
    expect(lens.createLensReader).toHaveBeenCalledWith(
      releases.mainnet,
      expect.objectContaining({ nodeUrl: MAINNET, artifactBaseUrl: "https://dusk.domains/" })
    );
  });

  it("loads bundled drivers from the extension and sends nothing but node reads", async () => {
    useReader({ resolve: async () => active(moonlight(ACCOUNT), null) });
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
    useReader({ resolve: async () => answer(status) });

    await expect(names.resolveDuskName("alice.dusk", { nodeUrl: TESTNET })).resolves.toEqual({
      ok: false,
      name: "alice.dusk",
      reason,
    });
  });

  it.each([
    ["no record", null],
    ["a shielded address's 64 bytes", record("moonlight_address", decodeBase58(ADDRESS))],
    ["96 bytes without a compressed key's flags", record("moonlight_address", new Uint8Array(96))],
    ["a coordinate outside the field", record("moonlight_address", [0x9f, ...new Array(95).fill(0xff)])],
    ["no bytes", record("moonlight_address", [])],
  ])("checks the public account as the reader and any address are checked (%s)", async (_label, account) => {
    useReader({ resolve: async () => active(account, null) });

    await expect(names.resolveDuskName("alice.dusk", { nodeUrl: TESTNET })).resolves.toEqual({
      ok: false,
      name: "alice.dusk",
      reason: "no_account",
    });
  });

  it("fails every reader error and unexpected answer", async () => {
    const reader = useReader({ resolve: async () => null });
    const failures = ["deployment", "refused", "decode", "evidence", "read", "timeout"].map(
      (reason) => () => Promise.reject(new lens.LensReaderError(reason, `lens ${reason}`))
    );
    failures.push(
      () => Promise.reject(new Error("Invalid label")),
      async () => answer("Unknown", [moonlight(ACCOUNT), null]),
      async () => ({ status: "Active", height: 1n }),
      async () => null
    );
    for (const failure of failures) {
      reader.resolve.mockImplementationOnce(failure);
      await expect(names.resolveDuskName("alice.dusk", { nodeUrl: TESTNET })).resolves.toEqual({
        ok: false,
        name: "alice.dusk",
        reason: "lookup_failed",
      });
    }
    expect(reader.resolve).toHaveBeenCalledTimes(failures.length);
  });

  it("reuses one reader per network and node", async () => {
    useReader({ resolve: async () => active(moonlight(ACCOUNT), null) });

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

    useReader({ resolve: async () => active(moonlight(ACCOUNT), null) });
    await expect(names.resolveDuskName("alice.dusk", { nodeUrl: TESTNET })).resolves.toMatchObject({ ok: true });
    expect(lens.createLensReader).toHaveBeenCalledTimes(2);
  });

  it("keeps a working reader when a read fails", async () => {
    const reader = useReader({
      resolve: async () => {
        throw new lens.LensReaderError("read", "Lens resolve query failed: HTTP 500");
      },
    });
    await expect(names.resolveDuskName("alice.dusk", { nodeUrl: TESTNET })).resolves.toMatchObject({
      reason: "lookup_failed",
    });

    reader.resolve.mockResolvedValueOnce(active(moonlight(ACCOUNT), null));
    await expect(names.resolveDuskName("alice.dusk", { nodeUrl: TESTNET })).resolves.toMatchObject({ ok: true });
    expect(lens.createLensReader).toHaveBeenCalledTimes(1);
  });
});

describe("lookupDuskName", () => {
  it("shares a running lookup and reuses its answer for a minute", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const reader = useReader({ resolve: async () => active(moonlight(ACCOUNT), null) });

    const first = names.lookupDuskName("alice.dusk", { nodeUrl: TESTNET });
    expect(names.lookupDuskName("alice.dusk", { nodeUrl: TESTNET })).toBe(first);
    await expect(first.promise).resolves.toMatchObject({ ok: true, account: ACCOUNT });
    expect(first.result).toMatchObject({ ok: true });

    vi.advanceTimersByTime(59_000);
    expect(names.lookupDuskName("alice.dusk", { nodeUrl: TESTNET })).toBe(first);
    expect(reader.resolve).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2_000);
    const again = names.lookupDuskName("alice.dusk", { nodeUrl: TESTNET });
    expect(again).not.toBe(first);
    await again.promise;
    expect(reader.resolve).toHaveBeenCalledTimes(2);
  });

  it("looks up again after a failure or for other input", async () => {
    const reader = useReader({
      resolve: async () => {
        throw new lens.LensReaderError("read", "offline");
      },
    });

    const failed = names.lookupDuskName("alice.dusk", { nodeUrl: TESTNET });
    await expect(failed.promise).resolves.toMatchObject({ reason: "lookup_failed" });

    reader.resolve.mockResolvedValue(active(moonlight(ACCOUNT), null));
    const retried = names.lookupDuskName("alice.dusk", { nodeUrl: TESTNET });
    expect(retried).not.toBe(failed);
    await expect(retried.promise).resolves.toMatchObject({ ok: true });

    expect(names.lookupDuskName("bob.dusk", { nodeUrl: TESTNET })).not.toBe(retried);
    expect(names.lookupDuskName("alice.dusk", { nodeUrl: MAINNET })).not.toBe(retried);
  });
});

describe("duskNameRecipient", () => {
  it("sends to the public account, the shielded address only when it is all there is or is picked", () => {
    const both = { account: ACCOUNT, address: ADDRESS };
    expect(names.duskNameRecipient(both)).toBe(ACCOUNT);
    expect(names.duskNameRecipient(both, { shielded: true })).toBe(ADDRESS);
    expect(names.duskNameRecipient(both, { shielded: false })).toBe(ACCOUNT);
    expect(names.duskNameRecipient({ address: ADDRESS })).toBe(ADDRESS);
    expect(names.duskNameRecipient({ account: ACCOUNT }, { shielded: true })).toBe(ACCOUNT);
  });
});

describe("resolvePrimaryName", () => {
  it("verifies the account's primary name, passing its 96-byte key as plain numbers", async () => {
    const reader = useReader({ verifyPrimary: async () => primary("domains.dusk") });

    await expect(names.resolvePrimaryName(ACCOUNT, { nodeUrl: TESTNET })).resolves.toEqual({
      ok: true,
      name: "domains.dusk",
    });
    expect(lens.createLensReader).toHaveBeenCalledWith(
      releases.testnet,
      expect.objectContaining({ nodeUrl: TESTNET, artifactBaseUrl: "https://testnet.dusk.domains/" })
    );
    const [endpoint] = reader.verifyPrimary.mock.calls[0];
    expect(Array.isArray(endpoint)).toBe(true);
    expect(endpoint).toEqual(Array.from(decodeBase58(ACCOUNT)));
    expect(reader.resolve).not.toHaveBeenCalled();
  });

  it("answers no name for an account without a verified primary", async () => {
    useReader({ verifyPrimary: async () => null });
    await expect(names.resolvePrimaryName(ACCOUNT, { nodeUrl: MAINNET })).resolves.toEqual({ ok: true, name: null });
    expect(lens.createLensReader).toHaveBeenCalledWith(releases.mainnet, expect.objectContaining({ nodeUrl: MAINNET }));
  });

  it("looks up nothing off Mainnet and Testnet, or for what isn't a public account", async () => {
    for (const url of [nodeUrl("devnet"), nodeUrl("local"), "https://rusk.example.com", undefined]) {
      await expect(names.resolvePrimaryName(ACCOUNT, { nodeUrl: url })).resolves.toEqual({
        ok: false,
        reason: "unsupported_network",
      });
    }
    for (const account of [ADDRESS, "alice.dusk", "", undefined]) {
      await expect(names.resolvePrimaryName(account, { nodeUrl: TESTNET })).resolves.toEqual({ ok: true, name: null });
    }
    expect(lens.createLensReader).not.toHaveBeenCalled();
  });

  it("fails every reader error and unexpected answer", async () => {
    const reader = useReader();
    const failures = [
      () => Promise.reject(new lens.LensReaderError("read", "offline")),
      () => Promise.reject(new lens.LensReaderError("evidence", "Lens primary does not match its endpoint")),
      async () => undefined,
      async () => ({}),
      async () => ({ primary: { spelling: 7 } }),
    ];
    for (const failure of failures) {
      reader.verifyPrimary.mockImplementationOnce(failure);
      await expect(names.resolvePrimaryName(ACCOUNT, { nodeUrl: TESTNET })).resolves.toEqual({
        ok: false,
        reason: "lookup_failed",
      });
    }
    expect(reader.verifyPrimary).toHaveBeenCalledTimes(failures.length);
  });
});

describe("lookupPrimaryName", () => {
  const lookup = (account = ACCOUNT, url = TESTNET) => names.lookupPrimaryName(account, { nodeUrl: url });

  it("starts a lookup after the render that asked for it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    useReader({ verifyPrimary: async () => primary("domains.dusk") });

    const pending = lookup();
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(1);
    expect(lens.createLensReader).not.toHaveBeenCalled();

    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    await expect(pending).resolves.toBe("domains.dusk");
  });

  it("shares a lookup, reuses its answer for a minute, and then gives the answer of a new one", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const reader = useReader({ verifyPrimary: async () => primary("domains.dusk") });

    const first = lookup();
    expect(lookup()).toBe(first);
    await expect(first).resolves.toBe("domains.dusk");

    vi.advanceTimersByTime(59_000);
    await expect(lookup()).resolves.toBe("domains.dusk");
    expect(reader.verifyPrimary).toHaveBeenCalledTimes(1);

    // A minute on, the name was cleared: callers get that, not the old answer.
    vi.advanceTimersByTime(2_000);
    reader.verifyPrimary.mockResolvedValue(null);
    const again = lookup();
    expect(lookup()).toBe(again);
    await expect(again).resolves.toBeNull();
    expect(reader.verifyPrimary).toHaveBeenCalledTimes(2);
  });

  it("gives no name when the lookup a minute on fails, while the account chip keeps the last one", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const reader = useReader({ verifyPrimary: async () => primary("domains.dusk") });
    const chip = () => names.lookupPrimaryName(ACCOUNT, { nodeUrl: TESTNET, stale: true });
    await expect(lookup()).resolves.toBe("domains.dusk");

    vi.advanceTimersByTime(61_000);
    reader.verifyPrimary.mockRejectedValue(new lens.LensReaderError("read", "offline"));
    // The chip gets the last answer at once, and the same new lookup runs for both.
    await expect(chip()).resolves.toBe("domains.dusk");
    await expect(lookup()).resolves.toBeNull();
    expect(reader.verifyPrimary).toHaveBeenCalledTimes(2);

    // The next answer replaces it for everyone.
    reader.verifyPrimary.mockResolvedValue(primary("other.dusk"));
    await expect(lookup()).resolves.toBe("other.dusk");
    await expect(chip()).resolves.toBe("other.dusk");
    expect(reader.verifyPrimary).toHaveBeenCalledTimes(3);
  });

  it("keeps each answer for sites and approvals, and nothing for a failed lookup", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const reader = useReader({ verifyPrimary: async () => primary("domains.dusk") });
    await expect(lookup()).resolves.toBe("domains.dusk");
    expect(kept.rememberVerifiedName).toHaveBeenCalledWith(TESTNET, ACCOUNT, "domains.dusk");

    // A reused answer is kept once.
    await expect(lookup()).resolves.toBe("domains.dusk");
    expect(kept.rememberVerifiedName).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(61_000);
    reader.verifyPrimary.mockResolvedValue(null);
    await expect(lookup()).resolves.toBeNull();
    expect(kept.rememberVerifiedName).toHaveBeenLastCalledWith(TESTNET, ACCOUNT, null);

    vi.advanceTimersByTime(61_000);
    reader.verifyPrimary.mockRejectedValue(new lens.LensReaderError("read", "offline"));
    await expect(lookup()).resolves.toBeNull();
    expect(kept.rememberVerifiedName).toHaveBeenCalledTimes(2);
  });

  it("keeps lookups apart by node and account, so a switch looks the new one up", async () => {
    const key = Array.from(decodeBase58(ACCOUNT)).join();
    const reader = useReader({
      verifyPrimary: async (endpoint) => (endpoint.join() === key ? primary("domains.dusk") : null),
    });

    await expect(lookup(ACCOUNT)).resolves.toBe("domains.dusk");
    await expect(lookup(OTHER_ACCOUNT)).resolves.toBeNull();
    await expect(lookup(ACCOUNT, MAINNET)).resolves.toBe("domains.dusk");
    expect(reader.verifyPrimary).toHaveBeenCalledTimes(3);

    // Back on the first account, its answer is reused.
    await expect(lookup(ACCOUNT)).resolves.toBe("domains.dusk");
    expect(reader.verifyPrimary).toHaveBeenCalledTimes(3);
  });

  it("shows nothing for a failed lookup and looks up again on the next call", async () => {
    const reader = useReader({
      verifyPrimary: async () => {
        throw new lens.LensReaderError("read", "offline");
      },
    });
    await expect(lookup()).resolves.toBeNull();

    reader.verifyPrimary.mockResolvedValue(primary("domains.dusk"));
    await expect(lookup()).resolves.toBe("domains.dusk");
    expect(reader.verifyPrimary).toHaveBeenCalledTimes(2);
  });

  it("shows nothing off Mainnet and Testnet, or for what isn't a public account, without a lookup", async () => {
    for (const url of [nodeUrl("devnet"), nodeUrl("local"), "https://rusk.example.com", undefined]) {
      await expect(names.lookupPrimaryName(ACCOUNT, { nodeUrl: url })).resolves.toBeNull();
    }
    for (const account of [ADDRESS, "alice.dusk", "", undefined]) {
      await expect(names.lookupPrimaryName(account, { nodeUrl: TESTNET })).resolves.toBeNull();
    }
    expect(lens.createLensReader).not.toHaveBeenCalled();
  });
});

describe("lookupShieldedName", () => {
  it.each([
    ["its phoenix_payment_endpoint is this address", phoenix(ADDRESS), "domains.dusk"],
    ["its phoenix_payment_endpoint is another address", phoenix(OTHER_ADDRESS), null],
    ["it has no phoenix_payment_endpoint", null, null],
    ["its phoenix_payment_endpoint is no valid address", phoenix(`${ADDRESS}\n`), null],
  ])("names the shielded address only when the name pays to it: %s", async (_label, shielded, expected) => {
    const reader = useReader({
      verifyPrimary: async () => primary("domains.dusk"),
      resolve: async () => active(moonlight(ACCOUNT), shielded),
    });

    await expect(names.lookupShieldedName(ACCOUNT, ADDRESS, { nodeUrl: TESTNET })).resolves.toBe(expected);
    expect(reader.resolve).toHaveBeenCalledWith("domains.dusk", RECORD_KEYS);
  });

  it("reads no records for an account without a primary name", async () => {
    const reader = useReader({ verifyPrimary: async () => null });
    await expect(names.lookupShieldedName(ACCOUNT, ADDRESS, { nodeUrl: TESTNET })).resolves.toBeNull();
    expect(reader.resolve).not.toHaveBeenCalled();
  });

  it("shows nothing when the name's records can't be read", async () => {
    useReader({
      verifyPrimary: async () => primary("domains.dusk"),
      resolve: async () => {
        throw new lens.LensReaderError("read", "offline");
      },
    });
    await expect(names.lookupShieldedName(ACCOUNT, ADDRESS, { nodeUrl: TESTNET })).resolves.toBeNull();
  });
});

describe("duskNameErrorText", () => {
  it("explains each failure", () => {
    const text = (reason) => names.duskNameErrorText({ name: "alice.dusk", reason });
    expect(text("invalid_name")).toBe("This isn't a valid .dusk name.");
    expect(text("unsupported_network")).toBe("Sending to .dusk names works on Mainnet and Testnet only.");
    expect(text("not_registered")).toBe("alice.dusk isn't registered.");
    expect(text("expired")).toBe("alice.dusk has expired.");
    expect(text("no_account")).toBe("alice.dusk has no address to send to.");
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
    const users = [
      ["ui", "popup", "views", "send.js"],
      ["ui", "popup", "views", "receive.js"],
      ["ui", "popup", "header.js"],
      ["ui", "components", "AccountChip.js"],
      ["ui", "components", "AccountMenu.js"],
      ["ui", "components", "DuskName.js"],
    ];

    expect(module).not.toContain("@duskdomains/sdk");
    expect(module).not.toMatch(/^import[^;]*(duskNamesSdk|dusk-domains-releases)/m);
    expect(module).toContain('import("./duskNamesSdk.js")');
    expect(module).toContain('import("./dusk-domains-releases.json"');
    expect(shim).toContain(
      'export { decodeBase58, encodeBase58, hasClaimableReferrerShape, validateName } from "@duskdomains/sdk";'
    );
    expect(shim).toContain('export { createLensReader } from "@duskdomains/sdk/lens-reader";');
    for (const parts of users) {
      expect(await read(...parts), parts.join("/")).not.toMatch(/@duskdomains\/sdk|duskNamesSdk/);
    }
  });

  it("keeps the names code out of the service worker and the approval window", async () => {
    const read = (...parts) => readFile(path.resolve(process.cwd(), "src", ...parts), "utf8");
    const readers = [
      ["shared", "verifiedNames.js"],
      ["shared", "permissions.js"],
      ["background", "siteNames.js"],
      ["background", "rpc.js"],
      ["background", "dappEvents.js"],
      ["background", "index.js"],
      ["ui", "notification", "app.js"],
    ];
    const importsNames = /(?:from\s*|import\(\s*)["'][^"']*(?:@duskdomains\/sdk|duskNamesSdk|\/duskNames\.js)["']/;
    for (const parts of readers) {
      expect(await read(...parts), parts.join("/")).not.toMatch(importsNames);
    }
    expect('import { x } from "../shared/duskNames.js";').toMatch(importsNames);
    // The engine checks the names sites get.
    expect(await read("engine", "runtime.js")).toContain('import { lookupPrimaryName } from "../shared/duskNames.js";');
  });
});
