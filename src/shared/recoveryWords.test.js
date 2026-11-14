import { describe, expect, it } from "vitest";
import { wordPlaces, wordsMatch } from "./recoveryWords.js";

const PHRASE = "legal winner thank year wave sausage worth useful legal winner thank yellow";

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

  it("matches the words at their places, whatever their case or spaces, and nothing else", () => {
    expect(wordsMatch(PHRASE, [[1, "legal"], [6, " Sausage "], [12, "YELLOW"]])).toBe(true);
    expect(wordsMatch(PHRASE, [[1, "legal"], [6, "sausage"], [12, "winner"]])).toBe(false);
    expect(wordsMatch(PHRASE, [[13, "legal"]])).toBe(false);
    expect(wordsMatch(PHRASE, [[1, ""]])).toBe(false);
    expect(wordsMatch(PHRASE, [])).toBe(false);
  });
});
