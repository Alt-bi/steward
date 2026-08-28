/**
 * Name comparison for scam detection.
 *
 * The classic trade scam is a name that reads identically to a valuable item but
 * is not it: a Cyrillic "а" inside a Latin word, a zero-width space, doubled
 * spacing, or a one-character difference. All of that has to be measurable, not
 * eyeballed, so it lives here and is tested directly.
 */

/** Characters that render like Latin letters but are not. */
const HOMOGLYPHS: Record<string, string> = {
  а: "a", в: "b", е: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t",
  у: "y", х: "x", А: "A", В: "B", Е: "E", К: "K", М: "M", Н: "H", О: "O", Р: "P",
  С: "C", Т: "T", У: "Y", Х: "X", і: "i", ј: "j", ѕ: "s", ԁ: "d", ɡ: "g",
  α: "a", β: "b", ε: "e", ι: "i", κ: "k", ο: "o", ρ: "p", τ: "t", υ: "u", χ: "x",
  Α: "A", Β: "B", Ε: "E", Η: "H", Ι: "I", Κ: "K", Μ: "M", Ν: "N", Ο: "O", Ρ: "P",
  Τ: "T", Υ: "Y", Χ: "X",
};

/**
 * Zero-width and other invisible characters that hide inside a name.
 * Written as escapes on purpose: the literal characters are unreadable in source
 * and get mangled by editors that trim them.
 */
const INVISIBLE_SOURCE =
  "[" +
  "\u200B-\u200F" + // zero-width space through right-to-left mark
  "\u202A-\u202E" + // bidi overrides
  "\u2060-\u2064" + // word joiner, invisible operators
  "\uFEFF" + //         byte order mark
  "\u00AD" + //         soft hyphen
  "\u180E" + //         Mongolian vowel separator
  "]";

function invisibleRe(): RegExp {
  return new RegExp(INVISIBLE_SOURCE, "gu");
}

export function hasInvisibleCharacters(text: string): boolean {
  return invisibleRe().test(String(text ?? ""));
}

/** True when a name mixes Latin letters with lookalikes from another script. */
export function hasMixedScripts(text: string): boolean {
  const latin = /[A-Za-z]/.test(text);
  const confusable = /[Ѐ-ӿͰ-Ͽ]/.test(text);
  return latin && confusable;
}

/** Non-Latin lookalike characters actually present, for the warning text. */
export function confusableCharacters(text: string): string[] {
  const found = new Set<string>();
  for (const ch of text) {
    if (HOMOGLYPHS[ch]) found.add(ch);
  }
  return [...found];
}

/**
 * Folds a name to what a human sees: lookalikes mapped to Latin, invisibles gone,
 * punctuation dropped, spacing collapsed, case ignored.
 */
export function foldName(text: string): string {
  const withoutInvisible = String(text ?? "").replace(invisibleRe(), "");
  let out = "";
  for (const ch of withoutInvisible) out += HOMOGLYPHS[ch] ?? ch;
  return out
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Levenshtein distance, abandoned once it passes `max`.
 * Bounded because we only care whether two names are *nearly* the same.
 */
export function editDistance(a: string, b: string, max = 4): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;

  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;

  let previous = Array.from({ length: short.length + 1 }, (_, i) => i);
  let current = new Array<number>(short.length + 1);

  for (let i = 1; i <= long.length; i++) {
    current[0] = i;
    let rowMin = i;
    for (let j = 1; j <= short.length; j++) {
      const cost = long[i - 1] === short[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + cost
      );
      if (current[j]! < rowMin) rowMin = current[j]!;
    }
    /** Whole row already worse than the bound: it can only get worse. */
    if (rowMin > max) return max + 1;
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[short.length]!;
}

/** How close two names look to a person, 0 apart to 1 identical. */
export function nameSimilarity(a: string, b: string): number {
  const left = foldName(a);
  const right = foldName(b);
  if (!left && !right) return 1;
  if (!left || !right) return 0;
  if (left === right) return 1;

  const longest = Math.max(left.length, right.length);
  const bound = Math.min(6, Math.max(2, Math.floor(longest * 0.25)));
  const distance = editDistance(left, right, bound);
  if (distance > bound) return 0;
  return 1 - distance / longest;
}
