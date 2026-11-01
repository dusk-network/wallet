import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeBase58 } from "@duskdomains/sdk";
import { PINNED_RELEASES as releases } from "@duskdomains/sdk/releases";

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
// Testnet's faucet, and another shielded address.
const OTHER_ACCOUNT =
  "26JfWKvhYdVY71bdSPVLNJ51Buy4GjimCT7zcsoxNQtydDbdoH2AwZaH8W7rjcAc9riAu39Vw9Lx1w7yrkBgotSjWmUdkSyQuaTKDZWVCKp9g1GxiEnnksv3W3onToB5NsNi";
const OTHER_ADDRESS = "3rTbMbu2ffd3kuUiq766HJBh3eYHpKbwZFZtXLFtadRMFw6dLqxAUr1n5PtAXfb3xnBhGssELCC64cxd4dSYyjEj";
const RECORD_KEYS = ["moonlight_address", "phoenix_payment_endpoint"];
// A contract read as the lens reader sends one.
const OCTETS = { "Content-Type": "application/octet-stream", Accept: "application/octet-stream" };

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
    ["a key's shape off the curve", record("moonlight_address", decodeBase58(ACCOUNT).map((b, i) => (i === 95 ? b ^ 1 : b)))],
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
    // Another node of Testnet's, and a custom node whose network isn't known, which reads no names.
    await names.resolveDuskName("alice.dusk", { nodeUrl: `${TESTNET}/rusk` });
    await expect(names.resolveDuskName("alice.dusk", { nodeUrl: "https://testnet.example.org" })).resolves.toMatchObject({
      reason: "unsupported_network",
    });
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

describe("the lens's binding and interface", () => {
  const LENS = releases.testnet.lens.contractId;
  // Session storage, as the popups and the background share it.
  let session;
  beforeEach(async () => {
    session = new Map();
    const pick = (keys) => Object.fromEntries([keys].flat().filter((k) => session.has(k)).map((k) => [k, session.get(k)]));
    vi.stubGlobal("chrome", {
      runtime: { id: "wallet", sendMessage() {}, getURL: (p) => `chrome-extension://wallet/${p}` },
      storage: {
        session: {
          get: (keys, done) => done(pick(keys)),
          set: (items, done) => done(Object.entries(items).forEach(([k, v]) => session.set(k, v))),
          remove: (keys, done) => done([keys].flat().forEach((k) => session.delete(k))),
        },
      },
    });
    // A popup that has session storage; the mocked SDK is shared.
    vi.resetModules();
    names = await import("./duskNames.js");
  });

  // The node: what it's asked, by method, and its replies, by method (two
  // bytes each unless given).
  function node(replies = {}) {
    const asked = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const fn = String(url).split("/").pop();
        asked.push(fn);
        return replies[fn]?.() ?? new Response(new Uint8Array([7, 7]), { status: 200 });
      })
    );
    return asked;
  }

  // A reader as the SDK builds one: its first lookup asks for the lens's
  // binding and interface through the fetch it was given, checks them
  // (`check` reads what came back), and only then answers, or throws.
  function sdkReader(answer, { check = (res) => res.arrayBuffer() } = {}) {
    lens.createLensReader.mockImplementation(async (_release, { fetch, nodeUrl: url }) => {
      let checked = null;
      const deployment = () =>
        (checked ??= (async () => {
          for (const fn of ["binding", "lens_interface"]) {
            await check(await fetch(`${url}/on/contracts:${LENS}/${fn}`, { method: "POST", headers: OCTETS, body: new Uint8Array([1]) }));
          }
        })());
      const read = async () => {
        await deployment();
        if (answer instanceof Error) throw answer;
        return answer;
      };
      return { resolve: vi.fn(read), verifyPrimary: vi.fn(read) };
    });
  }

  // Another popup: its own modules, the same session.
  async function anotherPopup() {
    vi.resetModules();
    names = await import("./duskNames.js");
  }

  it("are asked once a session: a later reader, a popup's or the background's, checks the replies kept", async () => {
    sdkReader(active(moonlight(ACCOUNT), null));
    const first = node();
    await expect(names.resolveDuskName("alice.dusk", { nodeUrl: TESTNET })).resolves.toMatchObject({ ok: true });
    expect(first).toEqual(["binding", "lens_interface"]);

    await anotherPopup();
    const later = node();
    await expect(names.resolveDuskName("bob.dusk", { nodeUrl: TESTNET })).resolves.toMatchObject({ ok: true });
    expect(later).toEqual([]);
  });

  it("keeps no reply the reader didn't take: one that didn't decode is asked for again", async () => {
    sdkReader(new lens.LensReaderError("decode", "Lens binding reply didn't decode"));
    node();
    await expect(names.resolveDuskName("alice.dusk", { nodeUrl: TESTNET })).resolves.toMatchObject({ reason: "lookup_failed" });

    await anotherPopup();
    sdkReader(active(moonlight(ACCOUNT), null));
    const asked = node();
    await expect(names.resolveDuskName("alice.dusk", { nodeUrl: TESTNET })).resolves.toMatchObject({ ok: true });
    expect(asked).toEqual(["binding", "lens_interface"]);
  });

  it("are asked again after a reader refused the lens's deployment", async () => {
    sdkReader(active(moonlight(ACCOUNT), null));
    node();
    await names.resolveDuskName("alice.dusk", { nodeUrl: TESTNET });

    // Kept, then refused: a later reader's check of them fails.
    await anotherPopup();
    sdkReader(new lens.LensReaderError("deployment", "The deployed lens's binding isn't the release's"));
    expect(node()).toEqual([]);
    await expect(names.resolveDuskName("alice.dusk", { nodeUrl: TESTNET })).resolves.toMatchObject({ reason: "lookup_failed" });

    await anotherPopup();
    sdkReader(active(moonlight(ACCOUNT), null));
    const asked = node();
    await names.resolveDuskName("alice.dusk", { nodeUrl: TESTNET });
    expect(asked).toEqual(["binding", "lens_interface"]);
  });

  it("never keeps a reader's rejected replies over those another reader kept since", async () => {
    // Readers that take the lens's replies only as the healthy node gives
    // them; a check that failed is made again by the next lookup, as the
    // SDK's is once its hold-off passes.
    lens.createLensReader.mockImplementation(async (_release, { fetch, nodeUrl: url }) => {
      let checking = null;
      const deployment = () =>
        (checking ??= (async () => {
          for (const fn of ["binding", "lens_interface"]) {
            const res = await fetch(`${url}/on/contracts:${LENS}/${fn}`, { method: "POST", headers: OCTETS, body: new Uint8Array([1]) });
            const bytes = [...new Uint8Array(await res.arrayBuffer())];
            if (bytes.join() !== "7,7") throw new lens.LensReaderError("deployment", `The deployed lens's ${fn} isn't the release's`);
          }
        })().catch((error) => {
          checking = null;
          throw error;
        }));
      const read = async () => {
        await deployment();
        return active(moonlight(ACCOUNT), null);
      };
      return { resolve: vi.fn(read), verifyPrimary: vi.fn(read) };
    });
    const rejected = () => new Response(new Uint8Array([6, 6]), { status: 200 });

    // Popup A's reader is given replies its check rejects.
    const popupA = names;
    node({ binding: rejected, lens_interface: rejected });
    await expect(popupA.resolveDuskName("alice.dusk", { nodeUrl: TESTNET })).resolves.toMatchObject({ reason: "lookup_failed" });
    // Popup B's reader is given the healthy node's, and keeps them.
    await anotherPopup();
    node();
    await expect(names.resolveDuskName("alice.dusk", { nodeUrl: TESTNET })).resolves.toMatchObject({ ok: true });
    // Popup A's reader tries again with the replies kept, and takes them.
    expect(node()).toEqual([]);
    await expect(popupA.resolveDuskName("bob.dusk", { nodeUrl: TESTNET })).resolves.toMatchObject({ ok: true });

    // A later popup checks the healthy replies kept, not popup A's rejected ones.
    await anotherPopup();
    expect(node()).toEqual([]);
    await expect(names.resolveDuskName("carol.dusk", { nodeUrl: TESTNET })).resolves.toMatchObject({ ok: true });
  });

  it("reads a reply no further than the SDK's 32,768 bytes, and keeps none over it", async () => {
    // A megabyte, in 8 KiB chunks, as the node streams it.
    let pulled = 0;
    const huge = () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            pulled += 1;
            if (pulled > 128) controller.close();
            else controller.enqueue(new Uint8Array(8_192));
          },
        }),
        { status: 200 }
      );
    // The SDK refuses a reply past its limit unread.
    sdkReader(active(moonlight(ACCOUNT), null), {
      check: async () => {
        throw new lens.LensReaderError("read", "Contract reply exceeds wire envelope");
      },
    });
    node({ binding: huge });
    await expect(names.resolveDuskName("alice.dusk", { nodeUrl: TESTNET })).resolves.toMatchObject({ reason: "lookup_failed" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Five chunks read, and the stream a chunk or two ahead: not the 128.
    expect(pulled).toBeLessThanOrEqual(8);

    await anotherPopup();
    sdkReader(active(moonlight(ACCOUNT), null));
    const asked = node();
    await names.resolveDuskName("alice.dusk", { nodeUrl: TESTNET });
    expect(asked).toEqual(["binding", "lens_interface"]);
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

  it("reads through Multicall for Dusk, and alone a lookup the lens refused for want of gas in it", async () => {
    const refused = new lens.LensReaderError("refused", "Lens reverse refused: GasBudget", {
      refusal: { code: "GasBudget", contract: null, cause: null, height: 1n },
    });
    const batched = { resolve: vi.fn(), verifyPrimary: vi.fn(async () => Promise.reject(refused)) };
    const direct = { resolve: vi.fn(), verifyPrimary: vi.fn(async () => primary("domains.dusk")) };
    lens.createLensReader.mockResolvedValueOnce(batched).mockResolvedValueOnce(direct);

    await expect(lookup()).resolves.toBe("domains.dusk");
    expect(batched.verifyPrimary).toHaveBeenCalledTimes(1);
    expect(direct.verifyPrimary).toHaveBeenCalledTimes(1);

    // The first reader's reads of one task go out as one query.
    const { fetch, nodeUrl: node } = lens.createLensReader.mock.calls[0][1];
    const sent = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        sent.push(String(url));
        return new Response("", { status: 500 });
      })
    );
    const LENS = releases.testnet.lens.contractId;
    await Promise.all(
      ["lens_interface", "binding", "reverse"].map((fn) =>
        fetch(`${node}/on/contracts:${LENS}/${fn}`, { method: "POST", headers: OCTETS, body: new Uint8Array([1]) })
      )
    );
    expect(sent[0]).toBe(`${node}/on/contracts:93de287b7d349d678a0038fe7772e8960e1a84a1b5da2d0b1f62f532616ce1d4/aggregate`);
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

describe("lookupRecipientName", () => {
  const lookup = (recipient = ACCOUNT, url = TESTNET) => names.lookupRecipientName(recipient, { nodeUrl: url });

  it("gives the recipient's verified primary name, read as a profile's is, and keeps nothing", async () => {
    const reader = useReader({ verifyPrimary: async () => primary("carol.dusk") });
    await expect(lookup(` ${ACCOUNT} `)).resolves.toBe("carol.dusk");
    expect(reader.verifyPrimary).toHaveBeenCalledWith(Array.from(decodeBase58(ACCOUNT)));
    expect(kept.rememberVerifiedName).not.toHaveBeenCalled();
  });

  it("gives no name without a verified primary, when the lookup fails, or for what can't have one", async () => {
    const reader = useReader({ verifyPrimary: async () => null });
    await expect(lookup()).resolves.toBeNull();
    // A primary whose record doesn't point back to the account fails the reader's check.
    reader.verifyPrimary.mockRejectedValue(new lens.LensReaderError("evidence", "Lens primary does not match its endpoint"));
    await expect(lookup()).resolves.toBeNull();

    lens.createLensReader.mockClear();
    for (const recipient of [ADDRESS, `0x${"11".repeat(32)}`, "carol.dusk", ""]) {
      await expect(lookup(recipient)).resolves.toBeNull();
    }
    await expect(lookup(ACCOUNT, nodeUrl("devnet"))).resolves.toBeNull();
    expect(lens.createLensReader).not.toHaveBeenCalled();
  });

  it.each([
    ["isn't canonical", "Carol.dusk"],
    ["is longer than 24 characters", "abcdefghijklmnopqrst.dusk"],
    ["has a label like a contract ID", "0xdeadbeef.dusk"],
    ["has a subname label like one", "0x11.carol.dusk"],
    ["has a label like the start of an account or address", "26fch745yg5etfl1.dusk"],
  ])("gives no name that %s", async (_label, spelling) => {
    useReader({ verifyPrimary: async () => primary(spelling) });
    await expect(lookup()).resolves.toBeNull();
  });

  it.each(["abcdefghijklmnopqrs.dusk", "pay.carol.dusk", "carol-2024-payroll.dusk", "web3wallet2024.dusk", "0xford.dusk"])(
    "gives %s, which keeps to those rules",
    async (spelling) => {
      useReader({ verifyPrimary: async () => primary(spelling) });
      await expect(lookup()).resolves.toBe(spelling);
    }
  );
});

describe("lookupRecipientNames", () => {
  const lookup = (accounts, url = TESTNET) => names.lookupRecipientNames(accounts, { nodeUrl: url });
  const LENS = releases.testnet.lens.contractId;

  it("looks up many accounts at once, each as lookupRecipientName gives one, and keeps nothing", async () => {
    const reader = useReader({ verifyPrimary: async (key) => (key[95] === decodeBase58(ACCOUNT)[95] ? primary("carol.dusk") : null) });
    const result = await lookup([ACCOUNT, OTHER_ACCOUNT, ` ${ACCOUNT} `, ADDRESS, "carol.dusk"]);
    expect(result).toEqual(new Map([[ACCOUNT, "carol.dusk"], [OTHER_ACCOUNT, null]]));
    // Once per account, and only for public accounts.
    expect(reader.verifyPrimary).toHaveBeenCalledTimes(2);
    expect(kept.rememberVerifiedName).not.toHaveBeenCalled();
  });

  it("reads through Multicall for Dusk: the lookups of one task go out as one query", async () => {
    useReader();
    await lookup([ACCOUNT]);
    const { fetch, nodeUrl: node } = lens.createLensReader.mock.calls[0][1];
    const sent = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        sent.push([String(url), new Uint8Array(init.body)]);
        // Two results of one byte each, as the multicall archives them: the
        // bytes, a 16-byte slot each from 4, and the root at 40.
        const reply = new Uint8Array(56);
        const view = new DataView(reply.buffer);
        reply.set([7, 8], 0);
        view.setInt32(4 + 4, 0 - (4 + 4), true);
        view.setUint32(4 + 8, 1, true);
        view.setInt32(20 + 4, 1 - (20 + 4), true);
        view.setUint32(20 + 8, 1, true);
        view.setBigUint64(40, 5n, true);
        view.setInt32(48, 4 - 48, true);
        view.setUint32(52, 2, true);
        return new Response(reply);
      })
    );
    const read = (body) => fetch(`${node}/on/contracts:${LENS}/reverse`, { method: "POST", headers: OCTETS, body: new Uint8Array(body) });
    const answers = await Promise.all([read([1]), read([2])]);
    expect(sent.map(([url]) => url)).toEqual([`${node}/on/contracts:93de287b7d349d678a0038fe7772e8960e1a84a1b5da2d0b1f62f532616ce1d4/aggregate`]);
    // Each reverse read capped at the SDK client's 842M gas: 203 reads at 4M, and 30M.
    const envelope = sent[0][1];
    const gas = new DataView(envelope.buffer).getBigUint64(envelope.length - 8 - 56 * 2 + 48, true);
    expect(gas).toBe(842_000_000n);
    expect(answers.map((r) => r.status)).toEqual([200, 200]);
    expect(await Promise.all(answers.map(async (r) => Array.from(new Uint8Array(await r.arrayBuffer()))))).toEqual([[7], [8]]);
  });

  it("reads a lookup the lens refused for want of gas again on its own", async () => {
    const refused = new lens.LensReaderError("refused", "Lens reverse refused: GasBudget", {
      refusal: { code: "GasBudget", contract: null, cause: null, height: 1n },
    });
    const batched = { resolve: vi.fn(), verifyPrimary: vi.fn(async () => Promise.reject(refused)) };
    const direct = { resolve: vi.fn(), verifyPrimary: vi.fn(async () => primary("carol.dusk")) };
    lens.createLensReader.mockResolvedValueOnce(batched).mockResolvedValueOnce(direct);
    await expect(lookup([ACCOUNT])).resolves.toEqual(new Map([[ACCOUNT, "carol.dusk"]]));
    expect(direct.verifyPrimary).toHaveBeenCalledTimes(1);
  });

  it("leaves out an account whose lookup failed, and names the reader's checks refused", async () => {
    useReader({
      verifyPrimary: async (key) => {
        if (key[95] === decodeBase58(ACCOUNT)[95]) throw new lens.LensReaderError("evidence", "Lens primary does not match its endpoint");
        return primary("Carol.dusk");
      },
    });
    await expect(lookup([ACCOUNT, OTHER_ACCOUNT])).resolves.toEqual(new Map([[OTHER_ACCOUNT, null]]));
  });

  it("looks up nothing off Mainnet and Testnet, or without accounts", async () => {
    useReader();
    await expect(lookup([ACCOUNT], nodeUrl("devnet"))).resolves.toEqual(new Map());
    await expect(lookup([ADDRESS, ""])).resolves.toEqual(new Map());
    expect(lens.createLensReader).not.toHaveBeenCalled();
  });
});

describe("names looked up together", () => {
  const LENS = releases.testnet.lens.contractId;
  const THIRD_ACCOUNT =
    "26brdzqNXEG1jTzCubJAPhks18bSSDY4n21ZW6VLYkCv6bBUdBAZZAbn1Coz1LPBYc4uEekBbzFnZvhL9untGCqRamhZS2cBV51fdZog3qkP3NbMEaqgNMcKEahAFV8t2Cke";
  const spelled = new Map([[ACCOUNT, "alice.dusk"], [OTHER_ACCOUNT, "bob.dusk"]]);
  // The queries the node is asked, each as the functions it carries, and
  // the browser's session storage.
  let asked;
  let session;

  // Each read's function in a query, as encodeAggregate lays them out: a
  // name of up to 7 bytes in its call's slot, a longer one before the slots.
  function functionsOf(body) {
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const root = body.length - 8;
    const slots = root + view.getInt32(root, true);
    return Array.from({ length: view.getUint32(root + 4, true) }, (_, i) => {
      const slot = slots + 56 * i;
      const [at, length] =
        body[slot + 39] < 0x80 ? [slot + 32, body[slot + 39]] : [slot + 32 + view.getInt32(slot + 36, true), view.getUint32(slot + 32, true)];
      return new TextDecoder().decode(body.subarray(at, at + length));
    });
  }

  // The multicall's reply of one byte for each read: the bytes, then their
  // 16-byte slots from a 4-aligned offset, then the root, 8-aligned.
  function reply(count) {
    const slots = Math.ceil(count / 4) * 4;
    const root = Math.ceil((slots + 16 * count) / 8) * 8;
    const bytes = new Uint8Array(root + 16).fill(7, 0, count);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < count; i++) {
      view.setInt32(slots + 16 * i + 4, i - (slots + 16 * i + 4), true);
      view.setUint32(slots + 16 * i + 8, 1, true);
    }
    view.setBigUint64(root, 5n, true);
    view.setInt32(root + 8, slots - (root + 8), true);
    view.setUint32(root + 12, count, true);
    return bytes;
  }

  beforeEach(async () => {
    // Session storage as Chrome's, which answers a few milliseconds later.
    session = new Map();
    const later = (done, value) => setTimeout(() => done(value), 5);
    vi.stubGlobal("chrome", {
      runtime: { id: "wallet", sendMessage() {}, getURL: (p) => `chrome-extension://wallet/${p}` },
      storage: {
        session: {
          get: (keys, done) => later(done, Object.fromEntries([keys].flat().filter((k) => session.has(k)).map((k) => [k, session.get(k)]))),
          set: (items, done) => later(done, Object.entries(items).forEach(([k, v]) => session.set(k, v))),
          remove: (keys, done) => later(done, [keys].flat().forEach((k) => session.delete(k))),
        },
      },
    });
    vi.resetModules();
    names = await import("./duskNames.js");
    asked = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        const fns = String(url).endsWith("/aggregate") ? functionsOf(new Uint8Array(init.body)) : [String(url).split("/").pop()];
        asked.push(fns.sort());
        return new Response(fns.length > 1 ? reply(fns.length) : new Uint8Array([7]), { status: 200 });
      })
    );
    // A reader that reads as the SDK's: each lookup sends its lens query at
    // once, and its first also starts the check of the lens's binding and
    // interface, in the same task; each answers once the check read them.
    lens.createLensReader.mockImplementation(async (_release, { fetch, nodeUrl: url }) => {
      const read = (fn, body = new Uint8Array()) =>
        fetch(`${url}/on/contracts:${LENS}/${fn}`, { method: "POST", headers: OCTETS, body }).then((res) => res.arrayBuffer());
      let checking = null;
      const verifyPrimary = async (key) => {
        const reverse = read("reverse", new Uint8Array(key));
        await (checking ??= Promise.all([read("binding"), read("lens_interface")]));
        await reverse;
        const account = [...spelled.keys()].find((a) => decodeBase58(a).every((b, i) => b === key[i]));
        return account ? primary(spelled.get(account)) : null;
      };
      return { resolve: vi.fn(), verifyPrimary: vi.fn(verifyPrimary) };
    });
  });

  it("go out as one Multicall for Dusk query, the lens's check with the first", async () => {
    // A popup's first lookups of a session: the header's, its menu's or Settings'.
    const accounts = [ACCOUNT, OTHER_ACCOUNT, THIRD_ACCOUNT];
    await expect(Promise.all(accounts.map((a) => names.lookupPrimaryName(a, { nodeUrl: TESTNET })))).resolves.toEqual(["alice.dusk", "bob.dusk", null]);
    expect(asked).toEqual([["binding", "lens_interface", "reverse", "reverse", "reverse"]]);

    // Another popup's, as Activity names its counterparties: the check's replies were kept.
    await vi.waitFor(() => expect(session.size).toBe(2));
    vi.resetModules();
    names = await import("./duskNames.js");
    asked.length = 0;
    await expect(names.lookupRecipientNames(accounts, { nodeUrl: TESTNET })).resolves.toEqual(
      new Map([[ACCOUNT, "alice.dusk"], [OTHER_ACCOUNT, "bob.dusk"], [THIRD_ACCOUNT, null]])
    );
    expect(asked).toEqual([["reverse", "reverse", "reverse"]]);
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
  const read = (...parts) => readFile(path.resolve(process.cwd(), "src", ...parts), "utf8");
  // The SDK's root, its reader and its account check, which carries the curve's
  // code; its name rules, call facts and releases are light.
  const heavySdk = /(?:from\s*|import\(\s*)["'](?:@duskdomains\/sdk(?:\/lens-reader|\/accounts)?|[^"']*duskNamesSdk\.js)["']/;
  const namesCode = /(?:from\s*|import\(\s*)["'][^"']*\/duskNames\.js["']/;

  it("loads the SDK's reader and account check only on lookup", async () => {
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

    expect(module).toContain('import("./duskNamesSdk.js")');
    expect(module.replace('import("./duskNamesSdk.js")', "")).not.toMatch(heavySdk);
    expect(shim).toContain('export { createLensReader, decodeBase58 } from "@duskdomains/sdk/lens-reader";');
    expect(shim).toContain('export { resolveAccounts } from "@duskdomains/sdk/accounts";');
    for (const parts of users) {
      expect(await read(...parts), parts.join("/")).not.toMatch(heavySdk);
    }
    expect('import { nameToShow } from "@duskdomains/sdk/names";').not.toMatch(heavySdk);
    expect('import("@duskdomains/sdk/accounts")').toMatch(heavySdk);
  });

  it("keeps the names code out of the service worker and the approval window", async () => {
    const readers = [
      ["shared", "verifiedNames.js"],
      ["shared", "knownCalls.js"],
      ["shared", "permissions.js"],
      ["background", "siteNames.js"],
      ["background", "rpc.js"],
      ["background", "dappEvents.js"],
      ["background", "index.js"],
      ["ui", "notification", "app.js"],
    ];
    for (const parts of readers) {
      const text = await read(...parts);
      expect(text, parts.join("/")).not.toMatch(heavySdk);
      expect(text, parts.join("/")).not.toMatch(namesCode);
    }
    expect('import { x } from "../shared/duskNames.js";').toMatch(namesCode);
    // The engine checks the names sites get.
    expect(await read("engine", "runtime.js")).toMatch(/import \{[^}]*\blookupPrimaryName\b[^}]*\} from "\.\.\/shared\/duskNames\.js";/);
  });
});
