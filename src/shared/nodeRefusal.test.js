import { describe, expect, it } from "vitest";


describe("what's said of an error sending a transaction out", () => {
  it("is a refusal only on the node's own word", async () => {
    const { ALREADY_THERE, NO_CLEAR_ANSWER, propagationError } = await import("./nodeRefusal.js");
    const { sendRefused } = await import("../ui/popup/views/sent.js");

    // A gateway's answer, JSON or not, and Rusk's own when it says nothing of the transaction (its 500s).
    for (const unsure of ["Gateway Timeout", '{"error":"Gateway Timeout"}', "<html>502 Bad Gateway</html>", '{"error":"Internal server error"}', "Invalid nonce", '{"error":"Invalid input: Data: InvalidData"}', ""]) {
      expect(propagationError(unsure)).toBe(NO_CLEAR_ANSWER);
      expect(sendRefused(propagationError(unsure))).toBe(false);
    }
    // Rusk's refusal of the transaction (1.7.3's map_check_tx_error), and the plain text of a node before it.
    const id = "4f".repeat(32);
    expect(sendRefused(propagationError(`{"error":"Invalid input: Tx ${id} not accepted: this transaction is invalid Value spent larger than account holds"}`))).toBe(true);
    expect(propagationError(`Tx ${id} not accepted: gas price lower than minimum 1`)).toBe("The node refused it: the network fee is too low. Raise it under Custom fee.");
    expect(propagationError(`{"error":"Invalid input: Tx ${id} not accepted: this transaction exists in the mempool"}`)).toBe(ALREADY_THERE);
    expect(sendRefused(ALREADY_THERE)).toBe(false);
  });
});
