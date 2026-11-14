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

    // Marek's: the browser died before a payment left it, and the account's next send took its nonce: it said "on
    // its way" for good. Not sent only once the account's transaction at its nonce is seen, and is another.
    const OTHER = "e7".repeat(32);
    const OWN = "ab".repeat(32);
    const made = Date.now() - 60_000;
    const head = { pair: { json: { last_block: [4860000, "aa"], last_finalized_block: [4859998, "bb"] } } };
    const sent = (...ids) => ({ h: { json: ids.map((origin, i) => ({ block_height: 4859990 + i, origin, events: [] })) } });
    const nonces = (...list) => Object.fromEntries(list.map((n, i) => [`t${i}`, { tx: { json: JSON.stringify({ type: "moonlight", sender: "chen-account", receiver: "someone", value: 1, nonce: n }) } }]));

    it("is replaced where neither has it, the account's nonce went past it, and its transaction at that nonce is another", async () => {
      const fetchMock = mockFetchJson({ tx: null }, { mempoolTxs: [] }, status(132), head, sent("c1".repeat(32), OTHER), nonces(130, 131));
      const { handedOverState } = await import("./txLifecycle.js");
      await expect(handedOverState("https://node.example", { ...tx, at: made })).resolves.toEqual({ state: "replaced", by: OTHER });
      // The account's own sends, from before the payment was made on.
      const history = String(fetchMock.mock.calls[4][1].body);
      expect(history).toContain('moonlightHistory(sender: "chen-account", fromBlock: ');
      expect(Number(history.match(/fromBlock: (\d+)/)[1])).toBeLessThan(4860000 - 6);
    });

    it("is used, which says nothing yet, where the account's nonce went past it with no transaction seen at its nonce", async () => {
      const { handedOverState } = await import("./txLifecycle.js");
      // The chain's list is behind: what it has of the account isn't at that nonce.
      mockFetchJson({ tx: null }, { mempoolTxs: [] }, status(131), head, sent("c1".repeat(32)), nonces(130));
      await expect(handedOverState("https://node.example", { ...tx, at: made })).resolves.toEqual({ state: "used" });
      // Nothing listed of it at all.
      mockFetchJson({ tx: null }, { mempoolTxs: [] }, status(131), head, { h: null });
      await expect(handedOverState("https://node.example", { ...tx, at: made })).resolves.toEqual({ state: "used" });
      // A node without the archive: it can't be told.
      mockFetchJson({ tx: null }, { mempoolTxs: [] }, status(131), head, { errors: [{ message: 'Unknown field "moonlightHistory" on type "Query".' }] });
      await expect(handedOverState("https://node.example", { ...tx, at: made })).resolves.toEqual({ state: "unknown" });
      // Its own, listed at that nonce before the lookup by its ID has it: it went.
      mockFetchJson({ tx: null }, { mempoolTxs: [] }, status(131), head, sent(OWN), nonces(131));
      await expect(handedOverState("https://node.example", { ...tx, hash: OWN, at: made })).resolves.toEqual({ state: "in" });
      // Not asked to prove it, as before the next send: used, nothing more looked for.
      const fetchMock = mockFetchJson({ tx: null }, { mempoolTxs: [] }, status(131));
      await expect(handedOverState("https://node.example", tx, { prove: false })).resolves.toEqual({ state: "used" });
      expect(fetchMock).toHaveBeenCalledTimes(3);
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
