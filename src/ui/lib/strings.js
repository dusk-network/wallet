export function truncateMiddle(str, head = 8, tail = 8) {
  if (!str || str.length <= head + tail + 3) return str;
  return `${str.slice(0, head)}…${str.slice(str.length - tail)}`;
}

export function normalizeMnemonic(m) {
  return String(m ?? "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .join(" ");
}
