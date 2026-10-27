import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clockText, dateText, zonedClockText } from "./time.js";

// The web wallet writes a time of day with Intl's 2-digit hour and minute in
// the browser's language, and no hour cycle forced: the extension writes it
// the same way, so one person sees one clock in both.
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
    expect(clockText(AT)).toBe("08:10 AM");
    expect(clockText(EVENING)).toBe("08:10 PM");
    expect(zonedClockText(AT)).toBe("08:10 AM UTC");
    expect(dateText(AT)).toBe("27 Oct 2026, 08:10 AM UTC");
  });

  it("has 24 hours in Dutch and British English", () => {
    inLanguage("nl-NL");
    expect(clockText(AT)).toBe("08:10");
    expect(clockText(EVENING)).toBe("20:10");
    expect(dateText(EVENING)).toBe("27 Oct 2026, 20:10 UTC");
    inLanguage("en-GB");
    expect(clockText(EVENING)).toBe("20:10");
  });

  it("is the web wallet's own format, Intl's with the same options", () => {
    for (const language of ["en-US", "nl-NL", "de-DE", "ja-JP"]) {
      inLanguage(language);
      expect(clockText(EVENING), language).toBe(
        new Intl.DateTimeFormat(language, { hour: "2-digit", minute: "2-digit" }).format(EVENING)
      );
    }
  });

  it("falls back to the default language's clock for one Intl doesn't know", () => {
    inLanguage("not a language");
    expect(clockText(AT)).toBe(new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(AT));
  });
});
