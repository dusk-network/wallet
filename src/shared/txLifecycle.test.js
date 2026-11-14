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
        text: async () => JSON.stringify(body),
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
          memo: "value: 9007199254740993, unchanged",
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
    expect(presence.tx.memo).toBe("value: 9007199254740993, unchanged");
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

  // Chen's: a payment handed over as the Wi-Fi died, which the node never had, was said to "may still have reached
  // the network". Where it stands is asked of the node: its chain, its mempool, and the account's nonce.
  describe("where a public transaction handed over without a clear answer stands", () => {
    const tx = { hash: "abc", account: "chen-account", nonce: "131" };
    const status = (nonce) => ({ balance: 481844605, nonce, next_nonce: nonce + 1 });

    it("is in the chain, or in the node's mempool: it went", async () => {
      mockFetchJson({ tx: { id: "abc", err: null } });
      const { handedOverState } = await import("./txLifecycle.js");
      await expect(handedOverState("https://node.example", tx)).resolves.toMatchObject({ state: "in" });
      mockFetchJson({ tx: null }, { mempoolTxs: [{ id: "abc" }] });
      await expect(handedOverState("https://node.example", tx)).resolves.toMatchObject({ state: "in" });
    });

    it("is absent where neither has it and the account's nonce hasn't reached it: the node never had it", async () => {
      const fetchMock = mockFetchJson({ tx: null }, { mempoolTxs: [] }, status(130));
      const { handedOverState } = await import("./txLifecycle.js");
      await expect(handedOverState("https://node.example", tx)).resolves.toEqual({ state: "absent" });
      expect(String(fetchMock.mock.calls[2][0])).toBe("https://node.example/on/account:chen-account/status");
    });

    it("is used where neither has it though the account's nonce went past it", async () => {
      mockFetchJson({ tx: null }, { mempoolTxs: [] }, status(131));
      const { handedOverState } = await import("./txLifecycle.js");
      await expect(handedOverState("https://node.example", tx)).resolves.toEqual({ state: "used" });
    });

    it("is unknown where the node can't be asked, or gives no nonce", async () => {
      const { handedOverState } = await import("./txLifecycle.js");
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
      await expect(handedOverState("https://node.example", tx)).resolves.toEqual({ state: "unknown" });
      mockFetchJson({ tx: null }, { mempoolTxs: [] }, { balance: 1 });
      await expect(handedOverState("https://node.example", tx)).resolves.toEqual({ state: "unknown" });
      // Nothing to tell by without a nonce: never absent.
      mockFetchJson({ tx: null }, { mempoolTxs: [] });
      await expect(handedOverState("https://node.example", { hash: "abc" })).resolves.toEqual({ state: "unknown" });
    });
  });
});
