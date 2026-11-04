import { describe, expect, it } from "vitest";
import { sanitizeIntegerInput } from "./inputGuards.js";

describe("inputGuards", () => {
  describe("sanitizeIntegerInput", () => {
    it("keeps only digits", () => {
      expect(sanitizeIntegerInput("12abc3e4.5")).toBe("12345");
    });
  });
});
