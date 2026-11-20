import { describe, expect, it } from "vitest";

import { txStatusTone, txStatusWord } from "./txDisplay.js";

describe("tx display helpers", () => {
  it("tells apart a payment still out, one that went through, failed, isn't confirmed or wasn't sent", () => {
    // Submitted, in the mempool or not known yet: all still out.
    expect(txStatusWord("mempool")).toBe(txStatusWord("submitted"));
    expect(txStatusWord(undefined)).toBe(txStatusWord("submitted"));
    // Each outcome reads as its own, never as one still out: an unknown one final on chain apart from one not confirmed.
    const words = ["submitted", "executed", "failed", "unknown", "unsent", "not_sent"].map((status) => txStatusWord(status));
    words.push(txStatusWord("unknown", { final: true }));
    expect(new Set(words).size).toBe(words.length);
  });

  it("does not visually tone one not confirmed as failed", () => {
    expect(txStatusTone("failed")).toBe("bad");
    expect(txStatusTone("unknown")).toBe("pending");
    expect(txStatusTone("mempool")).toBe("pending");
  });
});
