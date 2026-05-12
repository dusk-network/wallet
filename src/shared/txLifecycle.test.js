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

  it("classifies unavailable when GraphQL fails", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 503 });
    const { classifyTxPresence } = await import("./txLifecycle.js");

    await expect(classifyTxPresence("https://node.example", "abc")).resolves.toMatchObject({
      state: "unavailable",
    });
  });
});
