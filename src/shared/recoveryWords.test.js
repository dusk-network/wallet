import { describe, expect, it } from "vitest";
import { wordPlaces } from "./recoveryWords.js";

describe("Check your recovery words", () => {
  it("asks three places of the phrase, each once, in order, at random", () => {
    for (let i = 0; i < 200; i++) {
      const places = wordPlaces(24);
      expect(places).toHaveLength(3);
      expect(new Set(places).size).toBe(3);
      expect(places).toEqual([...places].sort((a, b) => a - b));
      expect(places.every((p) => Number.isInteger(p) && p >= 1 && p <= 24)).toBe(true);
    }
    // Each place can be asked.
    const seen = new Set();
    for (let i = 0; i < 400; i++) wordPlaces(12).forEach((p) => seen.add(p));
    expect(seen.size).toBe(12);
  });
});
