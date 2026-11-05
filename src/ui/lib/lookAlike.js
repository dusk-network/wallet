// A name as it looks rather than as it's written, to warn of one that looks
// like another: the Cyrillic and Greek letters that look like Latin ones, and
// the Latin ones that look like each other, read as the letter they look like.
// A small part of Unicode's confusables (UTS #39), for the common letters only.
// It never tells names apart: two that differ here may still look alike.

// Each letter by the one it looks like, upper and lower case apart: Cyrillic
// Н looks like H, but its н doesn't look like h. A capital I looks like l.
const LOOKS_LIKE = new Map(
  Object.entries({
    // Cyrillic
    А: "A", В: "B", С: "C", Е: "E", Н: "H", І: "l", Ј: "J", К: "K", М: "M", О: "O", Р: "P", Ѕ: "S", Т: "T", У: "Y", Х: "X",
    Ү: "Y", Һ: "H", Ӏ: "l", Ԛ: "Q", Ԝ: "W",
    а: "a", с: "c", е: "e", і: "i", ј: "j", о: "o", р: "p", ѕ: "s", у: "y", х: "x", һ: "h", ӏ: "l", ԁ: "d", ԛ: "q", ԝ: "w",
    // Greek
    Α: "A", Β: "B", Ε: "E", Ζ: "Z", Η: "H", Ι: "l", Κ: "K", Μ: "M", Ν: "N", Ο: "O", Ρ: "P", Τ: "T", Υ: "Y", Χ: "X", Ϲ: "C", Ϳ: "J",
    α: "a", γ: "y", η: "n", ι: "i", κ: "k", ν: "v", ο: "o", ρ: "p", υ: "u", χ: "x", ω: "w", ϲ: "c", ϳ: "j",
    // Latin and digits
    ı: "i", ȷ: "j", ɑ: "a", ɡ: "g", ɩ: "i", I: "l", 1: "l", "|": "l", 0: "o",
  })
);
// Pairs that read as one letter.
const PAIRS = [
  [/rn/g, "m"],
  [/vv/g, "w"],
];

// A name by the letters it looks like, without accents, case, what renders
// as nothing, or extra spaces.
function shape(name) {
  const plain = String(name ?? "")
    .normalize("NFKD")
    .replace(/[\p{M}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "");
  const latin = Array.from(plain, (char) => LOOKS_LIKE.get(char) ?? char).join("");
  return PAIRS.reduce((text, [pair, letter]) => text.replace(pair, letter), latin)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Whether two names look alike: as they're written, and in lower case, where
 * a capital that looks like another letter is the small one.
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function looksAlike(a, b) {
  const [x, y] = [String(a ?? ""), String(b ?? "")];
  if (!shape(x) || !shape(y)) return false;
  return shape(x) === shape(y) || shape(x.toLowerCase()) === shape(y.toLowerCase());
}
