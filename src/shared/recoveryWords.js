// "Check your recovery words": three of a phrase's words, by their places,
// chosen at random, and whether the words typed are its words there. The
// words are compared on this device only; nothing typed is kept, logged or
// sent anywhere.

const wordOf = (text) => String(text ?? "").normalize("NFKD").trim().toLowerCase();

/**
 * Three places (from 1) of a phrase of `count` words, at random, in order.
 * @param {number} count
 * @param {(n: number) => number} [pick] - a whole number from 0 below n
 * @returns {number[]}
 */
export function wordPlaces(count, pick = (n) => globalThis.crypto.getRandomValues(new Uint32Array(1))[0] % n) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  const places = new Set();
  while (places.size < Math.min(3, n)) places.add(pick(n) + 1);
  return [...places].sort((a, b) => a - b);
}

/**
 * Whether each word typed, by its place, is the phrase's word there.
 * @param {string} phrase
 * @param {[number, string][]} typed
 */
export function wordsMatch(phrase, typed) {
  const words = wordOf(phrase).split(/\s+/);
  return (
    Array.isArray(typed) &&
    typed.length > 0 &&
    typed.every(([place, word]) => Number.isInteger(place) && place >= 1 && place <= words.length && wordOf(word) !== "" && words[place - 1] === wordOf(word))
  );
}
