// Times as the wallet writes them: "14:32" within a day, and in full with
// the time zone they show in, "26 Oct 2026, 14:32 CET". The time of day
// follows the browser's language, as the web wallet's does: "14:32" in
// Dutch or British English, "02:32 PM" in American English.

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// The web wallet's options for a time of day, with no hour cycle forced.
const CLOCK = { hour: "2-digit", minute: "2-digit" };

/** "14:32" or "02:32 PM", in the page's time zone and the browser's language. */
export function clockText(ms) {
  const language = globalThis.navigator?.language || undefined;
  try {
    return new Intl.DateTimeFormat(language, CLOCK).format(new Date(ms));
  } catch {
    // A language Intl doesn't know: its default's clock.
    return new Intl.DateTimeFormat(undefined, CLOCK).format(new Date(ms));
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

/** "26 Oct 2026, 14:32 CET": a time in full. */
export function dateText(ms) {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${zonedClockText(ms)}`;
}
