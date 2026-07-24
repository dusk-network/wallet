import { describe, expect, it } from "vitest";

import { executionEventError, executionEventOk } from "./txExecution.js";

describe("transaction execution events", () => {
  it("detects the error field in the current RUES payload shape", () => {
    const event = {
      payload: {
        err: "OutOfGas",
        gas_spent: 50_000_000,
      },
    };

    expect(executionEventOk(event)).toBe(false);
    expect(executionEventError(event)).toBe("OutOfGas");
  });

  it("treats a boolean payload error as a failure with a useful message", () => {
    const event = { payload: { err: true } };

    expect(executionEventOk(event)).toBe(false);
    expect(executionEventError(event)).toBe("Transaction execution failed");
  });

  it("accepts a successful RUES payload", () => {
    const event = { payload: { err: null, gas_spent: 12_345 } };

    expect(executionEventOk(event)).toBe(true);
    expect(executionEventError(event)).toBe("");
  });

  it.each([
    [{ success: false }, "Transaction execution failed"],
    [{ error: "reverted" }, "reverted"],
    [{ result: { err: { message: "contract panic" } } }, "contract panic"],
    [{ payload: { result: { error: "nested failure" } } }, "nested failure"],
    [
      { payload: { err: false, error: "contract reverted" } },
      "contract reverted",
    ],
    [{ payload: { err: "", error: "out of gas" } }, "out of gas"],
  ])("keeps compatibility with alternate event shape %#", (event, message) => {
    expect(executionEventOk(event)).toBe(false);
    expect(executionEventError(event)).toBe(message);
  });

  it("does not turn an absent or malformed event into a false failure", () => {
    expect(executionEventOk(null)).toBe(true);
    expect(executionEventOk("not an event")).toBe(true);
    expect(executionEventError(null)).toBe("");
  });
});
