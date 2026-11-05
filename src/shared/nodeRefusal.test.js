import { describe, expect, it } from "vitest";


describe("what's said of an error sending a transaction out", () => {
  it("is a refusal only on the node's own word", async () => {
    const { ALREADY_THERE, NO_CLEAR_ANSWER, propagationError } = await import("./nodeRefusal.js");
    const { sendRefused } = await import("../ui/popup/views/sent.js");

    for (const unsure of ["Gateway Timeout", "<html>502 Bad Gateway</html>", "Internal Server Error", ""]) {
      expect(propagationError(unsure)).toBe(NO_CLEAR_ANSWER);
      expect(sendRefused(propagationError(unsure))).toBe(false);
    }
    expect(sendRefused(propagationError('{"error":"Invalid input: Tx abc not accepted: this transaction is invalid"}'))).toBe(true);
    expect(sendRefused(propagationError("Invalid nonce"))).toBe(true);
    expect(propagationError("Tx exists in the mempool")).toBe(ALREADY_THERE);
    expect(sendRefused(ALREADY_THERE)).toBe(false);
  });
});
