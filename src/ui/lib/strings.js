export function truncateMiddle(str, head = 8, tail = 8) {
  if (!str || str.length <= head + tail + 3) return str;
  return `${str.slice(0, head)}…${str.slice(str.length - tail)}`;
}

/**
 * An account or address as the .dusk name views shorten it: its first and
 * last six characters around "…". Short input comes back as it is.
 * @param {string} address
 * @returns {string}
 */
export function shortAddress(address) {
  return truncateMiddle(String(address ?? ""), 6, 6);
}

/**
 * Convenience helper for displaying transaction hashes in compact form.
 * Returns first 10 chars + ellipsis + last 8 chars.
 * @param {string} hash
 * @returns {string}
 */
export function shortHash(hash) {
  const h = String(hash ?? "");
  if (!h) return "";
  if (h.length <= 18) return h;
  return `${h.slice(0, 10)}…${h.slice(-8)}`;
}

export function normalizeMnemonic(m) {
  return String(m ?? "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .join(" ");
}

/**
 * A site as the wallet names it, in approvals and the popup alike: its host
 * with any port, or for a local http:// site its whole origin, so the scheme
 * shows too.
 * @param {string} origin
 * @returns {string}
 */
export function siteName(origin) {
  try {
    const url = new URL(String(origin ?? ""));
    return url.protocol === "https:" ? url.host : url.origin;
  } catch {
    return String(origin ?? "");
  }
}
