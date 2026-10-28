// "Did you mean alice.dusk?": for a typed .dusk name that isn't registered,
// the closest name this wallet already knows, from its contacts and the
// other side of past transfers. Nothing is looked up.

/**
 * Edits between two strings: letters added, removed, changed, or two
 * neighbours swapped.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function editDistance(a, b) {
  const rows = [];
  for (let i = 0; i <= a.length; i++) {
    rows.push([i]);
    for (let j = 1; j <= b.length; j++) {
      if (i === 0) {
        rows[i][j] = j;
        continue;
      }
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, rows[i - 2][j - 2] + 1);
      rows[i][j] = d;
    }
  }
  return rows[a.length][b.length];
}

const label = (name) =>
  String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.dusk$/, "");

/**
 * The known name closest to `typed`: one or two edits away (one for names of
 * four letters or fewer), the first of the closest in `known`'s order.
 * @param {string} typed - e.g. "alcie.dusk"
 * @param {Iterable<string>} known - .dusk names, most relevant first
 * @returns {string|null} e.g. "alice.dusk"
 */
export function closeDuskName(typed, known) {
  const want = label(typed);
  if (!want) return null;
  const most = want.length <= 4 ? 1 : 2;
  let best = null;
  let bestEdits = most + 1;
  for (const name of known) {
    const have = label(name);
    if (!have || have === want) continue;
    const edits = editDistance(want, have);
    if (edits < bestEdits) {
      best = have;
      bestEdits = edits;
    }
  }
  return best ? `${best}.dusk` : null;
}
