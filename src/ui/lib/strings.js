export function truncateMiddle(str, head = 8, tail = 8) {
  if (!str || str.length <= head + tail + 3) return str;
  return `${str.slice(0, head)}…${str.slice(str.length - tail)}`;
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
