import { describe, expect, it } from "vitest";

import {
  transferRailLabel,
  txActivityStatusLabel,
  txRecoveryReasonLabel,
  txStatusLabel,
  txStatusTone,
} from "./txDisplay.js";

describe("tx display helpers", () => {
  it("labels shielded transfer activity as Phoenix", () => {
    expect(transferRailLabel({ kind: "transfer", privacy: "shielded" })).toBe("Shielded (Phoenix)");
    expect(transferRailLabel({ kind: "transfer", privacy: "public" })).toBe("Public (Moonlight)");
  });

  it("uses non-redundant unknown status labels", () => {
    expect(txStatusLabel("unknown")).toBe("Unknown");
    expect(txActivityStatusLabel("unknown")).toBe("Unknown");
    expect(txActivityStatusLabel("executed")).toBe("Finalized");
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
    expect(txRecoveryReasonLabel("node_url_missing")).toContain("node URL is missing");
    expect(txRecoveryReasonLabel("reconciliation_unavailable")).toContain("could not complete");
    expect(txRecoveryReasonLabel("Odd number of digits")).toBe(
      "The wallet could not complete the latest network status check."
    );
  });
});
