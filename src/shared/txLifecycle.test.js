import { afterEach, describe, expect, it, vi } from "vitest";

describe("txLifecycle reconciliation", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  function mockFetchJson(...responses) {
    const fetchMock = vi.fn();
    for (const body of responses) {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => body,
      });
    }
    globalThis.fetch = fetchMock;
    return fetchMock;
  }

  it("classifies finalized success", async () => {
    mockFetchJson({ tx: { id: "abc", err: null } });
    const { classifyTxPresence } = await import("./txLifecycle.js");

    await expect(classifyTxPresence("https://node.example", "abc")).resolves.toMatchObject({
      state: "executed_success",
      tx: { id: "abc" },
    });
  });

  it("classifies finalized failure", async () => {
    mockFetchJson({ tx: { id: "abc", err: "OutOfGas" } });
    const { classifyTxPresence } = await import("./txLifecycle.js");

    await expect(classifyTxPresence("https://node.example", "abc")).resolves.toMatchObject({
      state: "executed_failed",
      error: "OutOfGas",
    });
  });

  it("classifies mempool presence after tx lookup misses", async () => {
    mockFetchJson({ tx: null }, { mempoolTxs: [{ id: "abc", txType: "Phoenix" }] });
    const { classifyTxPresence } = await import("./txLifecycle.js");

    await expect(classifyTxPresence("https://node.example", "abc")).resolves.toMatchObject({
      state: "mempool",
      tx: { id: "abc" },
    });
  });

  it("classifies not_found when chain and mempool miss", async () => {
    mockFetchJson({ tx: null }, { mempoolTxs: [{ id: "other" }] });
    const { classifyTxPresence } = await import("./txLifecycle.js");

    await expect(classifyTxPresence("https://node.example", "abc")).resolves.toMatchObject({
      state: "not_found",
    });
  });

  it("preserves large GraphQL integers and derives actual fee", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({
        tx: {
          id: "abc",
          err: null,
          gasSpent: "9007199254740993",
          blockHash: "block-1",
          blockHeight: "18446744073709551615",
          blockTimestamp: "1753000000",
          tx: { gasPrice: "2" },
        },
      }).replace('"9007199254740993"', "9007199254740993"),
    });
    const { classifyTxPresence, finalizedTxMetadata } = await import("./txLifecycle.js");

    const presence = await classifyTxPresence("https://node.example", "abc");
    expect(finalizedTxMetadata(presence.tx)).toMatchObject({
      gasSpent: "9007199254740993",
      gasPrice: "2",
      feePaid: "18014398509481986",
      blockHeight: "18446744073709551615",
      finalizedAt: 1_753_000_000_000,
    });
  });

  it("classifies unavailable when GraphQL fails", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 503 });
    const { classifyTxPresence } = await import("./txLifecycle.js");

    await expect(classifyTxPresence("https://node.example", "abc")).resolves.toMatchObject({
      state: "unavailable",
    });
  });
});
