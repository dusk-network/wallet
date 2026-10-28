import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clockText, dateText, zonedClockText } from "./time.js";

// A time of day as the web wallet writes it, and as @dusk-network/networks
// writes the clock of a full date: the browser's language's clock and digits,
// with English words, so one person sees one clock in both.
describe("a time of day, as the browser's language writes it", () => {
  const AT = Date.parse("2026-10-27T08:10:00Z");
  const EVENING = Date.parse("2026-10-27T20:10:00Z");
  let zone;

  beforeEach(() => {
    zone = process.env.TZ;
    process.env.TZ = "UTC";
  });

  afterEach(() => {
    process.env.TZ = zone;
    vi.unstubAllGlobals();
  });

  const inLanguage = (language) => vi.stubGlobal("navigator", { language });

  it("has AM and PM in American English", () => {
    inLanguage("en-US");
    expect(clockText(AT)).toBe("8:10 AM");
    expect(clockText(EVENING)).toBe("8:10 PM");
    expect(zonedClockText(AT)).toBe("8:10 AM UTC");
    expect(dateText(AT)).toBe("Tue 27 Oct 2026, 8:10 AM UTC");
  });

  it("has 24 hours in Dutch and British English, and English words in full dates", () => {
    inLanguage("nl-NL");
    expect(clockText(AT)).toBe("08:10");
    expect(clockText(EVENING)).toBe("20:10");
    expect(dateText(EVENING)).toBe("Tue 27 Oct 2026, 20:10 UTC");
    inLanguage("en-GB");
    expect(clockText(EVENING)).toBe("20:10");
  });

  it("writes the clock a full date has, in every language: English words on the language's own clock and digits", () => {
    for (const language of ["en-US", "en-GB", "nl-NL", "de-DE", "ja-JP", "ar-EG"]) {
      inLanguage(language);
      expect(dateText(EVENING).endsWith(`, ${clockText(EVENING)} UTC`), language).toBe(true);
    }
    inLanguage("ar-EG");
    expect(clockText(EVENING)).toBe(new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", numberingSystem: "arab" }).format(EVENING));
  });

  it("falls back to the default language's clock for one Intl doesn't know", () => {
    const fallback = clockText(AT);
    inLanguage("not a language");
    expect(clockText(AT)).toBe(fallback);
    expect(dateText(AT)).toMatch(/^Tue 27 Oct 2026, /);
  });
});
