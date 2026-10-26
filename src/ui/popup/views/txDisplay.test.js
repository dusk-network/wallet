import { describe, expect, it } from "vitest";

import { txErrorText, txRecoveryReasonLabel, txStatusTone, txStatusWord } from "./txDisplay.js";

describe("tx display helpers", () => {
  it("says each status in one plain word", () => {
    expect(txStatusWord("submitted")).toBe("Pending");
    expect(txStatusWord("mempool")).toBe("Pending");
    expect(txStatusWord("executed")).toBe("Completed");
    expect(txStatusWord("failed")).toBe("Failed");
    expect(txStatusWord("removed")).toBe("Dropped");
    expect(txStatusWord("unknown")).toBe("Not confirmed");
    expect(txStatusWord(undefined)).toBe("Pending");
  });

  it("puts known chain errors in plain words, and leaves others alone", () => {
    expect(txErrorText("Panic: phoenix is not enabled in the VM")).toBe("Shielded transactions are paused on the network.");
    expect(txErrorText("OutOfGas")).toBe("It ran out of gas. A higher gas limit lets it finish.");
    expect(txErrorText("Out of gas")).toBe("It ran out of gas. A higher gas limit lets it finish.");
    expect(txErrorText("Contract does not exist")).toBe("The contract it called isn't on this network.");
    expect(txErrorText("Panic: DRC20Phoenix: paused")).toBe("");
    expect(txErrorText(undefined)).toBe("");
  });

  it("does not visually tone unknown or removed as failed", () => {
    expect(txStatusTone("failed")).toBe("bad");
    expect(txStatusTone("unknown")).toBe("pending");
    expect(txStatusTone("removed")).toBe("pending");
    expect(txStatusTone("mempool")).toBe("pending");
  });

  it("maps technical recovery reasons to user-safe copy", () => {
    expect(txRecoveryReasonLabel("watcher_timeout")).toContain("timed out");
    expect(txRecoveryReasonLabel("not_found")).toContain("not found");
    expect(txRecoveryReasonLabel("removed")).toContain("removed");
    expect(txRecoveryReasonLabel("removed_unconfirmed")).toContain("not confirmed");
    expect(txRecoveryReasonLabel("node_url_missing")).toContain("node URL is missing");
    expect(txRecoveryReasonLabel("reconciliation_unavailable")).toContain("could not complete");
    expect(txRecoveryReasonLabel("Odd number of digits")).toBe(
      "The wallet could not complete the latest network status check."
    );
  });
});
