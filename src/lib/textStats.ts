/**
 * Text statistics for the StatusBar — pure, dependency-free.
 *
 * "Word" counting is script-agnostic by construction: a CJK ideograph/kana
 * counts as one word each (the convention in 中文 word processors — 字数),
 * while any RUN of other letters/digits — Latin, Cyrillic, Greek, Arabic,
 * Devanagari, … — counts as one word per run. Punctuation (ASCII or CJK) and
 * symbols never count, so `= Introduction 引言` is 3 words and a pure English
 * sentence gets its natural count.
 */

// CJK ideographs + kana + hangul: each character is its own "word".
// \p{Script=...} needs the u flag; Han covers 中文, kana covers かな/カナ,
// Hangul covers Korean (included for completeness, not advertised).
const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

// A single letter or digit in ANY script (×/÷ etc. are symbols, not letters,
// so "3×4" stays two words). No /g flag → .test is stateless and reusable.
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** Count words: each CJK char = 1, each other letter/digit run = 1. */
export function countWords(text: string): number {
  let words = 0;
  let inRun = false;
  for (const ch of text) {
    if (CJK_CHAR.test(ch)) {
      words += 1;
      inRun = false;
    } else if (LETTER_OR_DIGIT.test(ch)) {
      if (!inRun) {
        words += 1;
        inRun = true;
      }
    } else {
      inRun = false;
    }
  }
  return words;
}

/** Count characters as Unicode code points (astral chars = 1 each). */
export function countChars(text: string): number {
  let chars = 0;
  for (const _ of text) chars += 1;
  return chars;
}
