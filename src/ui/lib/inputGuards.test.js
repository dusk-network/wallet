import { describe, expect, it } from "vitest";
import { sanitizeDecimalInput, sanitizeIntegerInput } from "./inputGuards.js";

describe("inputGuards", () => {
  describe("sanitizeIntegerInput", () => {
    it("keeps only digits", () => {
      expect(sanitizeIntegerInput("12abc3e4.5")).toBe("12345");
    });
  });

  describe("sanitizeDecimalInput", () => {
    it("keeps digits and a single decimal separator", () => {
      expect(sanitizeDecimalInput("a1.2.3e4 DUSK")).toBe("1.234");
    });

    it("allows incomplete decimal input while typing", () => {
      expect(sanitizeDecimalInput(".")).toBe(".");
      expect(sanitizeDecimalInput("1.")).toBe("1.");
    });
  });
});
