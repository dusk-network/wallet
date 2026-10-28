// Times as the wallet writes them: "14:32" within a day, and in full as
// @dusk-network/networks writes them for every Dusk app, in English with the
// time zone they show in: "Mon 26 Oct 2026, 14:32 CET". The time of day is
// on the browser's language's clock and digits, with English words, as the
// web wallet writes it: "14:32" in Dutch or British English, "2:32 PM" in
// American English.

import { formatTime } from "@dusk-network/networks/format";

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// A language's clock: its hour cycle and digits, and whether its words are English.
function clockOf(language) {
  const resolved = new Intl.DateTimeFormat(language, { hour: "numeric" }).resolvedOptions();
  return {
    english: /^en(-|$)/i.test(resolved.locale),
    hourCycle: resolved.hourCycle ?? (resolved.hour12 ? "h12" : "h23"),
    numberingSystem: resolved.numberingSystem,
  };
}

const clockIn = (language, ms) => {
  const { english, hourCycle, numberingSystem } = clockOf(language);
  return new Intl.DateTimeFormat(english ? language : "en-US", {
    hour: hourCycle === "h23" || hourCycle === "h24" ? "2-digit" : "numeric",
    hourCycle,
    minute: "2-digit",
    numberingSystem,
  }).format(new Date(ms));
};

/** "14:32" or "2:32 PM", in the page's time zone and on the browser's language's clock. */
export function clockText(ms) {
  try {
    return clockIn(globalThis.navigator?.language || undefined, ms);
  } catch {
    // A language Intl doesn't know: its default's clock.
    return clockIn(undefined, ms);
  }
}

/**
 * The time zone a time shows in, by its short name: "CET", "EDT", "UTC", or
 * "GMT+5:30" where the zone has no other.
 * @param {number} ms
 * @returns {string}
 */
export function zoneText(ms) {
  const date = new Date(ms);
  const short = (locale) => {
    try {
      return new Intl.DateTimeFormat(locale, { timeZoneName: "short" }).formatToParts(date).find((p) => p.type === "timeZoneName")?.value ?? "";
    } catch {
      return "";
    }
  };
  // The reader's own, then the English names a zone may have: CET is en-GB's, EDT en-US's.
  const names = [undefined, "en-US", "en-GB"].map(short).filter(Boolean);
  return names.find((n) => !/^(GMT|UTC)[+\-−]/.test(n)) ?? names[0] ?? "";
}

/** "14:32 CET": a time of day with its zone. */
export function zonedClockText(ms) {
  return `${clockText(ms)} ${zoneText(ms)}`.trim();
}

/** "Mon 26 Oct 2026, 14:32 CET": a time in full, in the page's time zone now. */
export function dateText(ms) {
  const language = globalThis.navigator?.language || undefined;
  const { timeZone } = new Intl.DateTimeFormat().resolvedOptions();
  try {
    return formatTime(ms, { date: "full", locale: language, timeZone });
  } catch {
    // A language Intl doesn't know: its default's clock.
    return formatTime(ms, { date: "full", timeZone });
  }
}
