import { describe, it, expect } from "vitest";
import { TX_KIND } from "./constants.js";

describe("TX_KIND", () => {
  it("has expected transaction types", () => {
    expect(TX_KIND.TRANSFER).toBe("transfer");
    expect(TX_KIND.SHIELD).toBe("shield");
    expect(TX_KIND.UNSHIELD).toBe("unshield");
    expect(TX_KIND.CONTRACT_CALL).toBe("contract_call");
    expect(TX_KIND.STAKE).toBe("stake");
    expect(TX_KIND.UNSTAKE).toBe("unstake");
  });

  it("is frozen (immutable)", () => {
    expect(Object.isFrozen(TX_KIND)).toBe(true);
  });

  it("has all 6 transaction types", () => {
    expect(Object.keys(TX_KIND).length).toBe(6);
  });
});
