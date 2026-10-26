// Times as the wallet writes them: "14:32" within a day, and in full with
// the time zone they show in, "26 Oct 2026, 14:32 CET".

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const two = (n) => String(n).padStart(2, "0");

/** "14:32", in the page's time zone. */
export function clockText(ms) {
  const d = new Date(ms);
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
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
