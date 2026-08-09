/**
 * Offline Kannada → Roman letters.
 *
 * WHY THIS EXISTS.
 *
 * Kannada had no offline transliterator, so Sarvam was the only engine that
 * could romanise it. When one Sarvam batch came back mis-delimited there was
 * nothing to fall back to and the render died — the production failure this
 * module removes.
 *
 * WHY IT IS NOT THE DEVANAGARI ENGINE.
 *
 * Kannada is not written in Devanagari and does not behave like Hindi. The
 * single biggest difference is the inherent vowel: Hindi deletes it
 * ("पुस्तक" → "pustak"), Kannada keeps it ("ಪುಸ್ತಕ" → "pustaka"). Running Kannada
 * through Hindi rules would not throw — the Devanagari engine simply does not
 * recognise Kannada code points and returns the input unchanged, which looks
 * downstream exactly like "the model left it in native script". A silent wrong
 * answer, in other words. Hence: separate tables, separate engine, and a test
 * that fails if Kannada is ever handed to the Devanagari one.
 *
 * That absence of schwa deletion is also what makes this tractable offline.
 * The Devanagari engine needs real phonological heuristics to decide which
 * inherent vowels to drop; Kannada needs none, so the mapping is close to
 * mechanical and is reproducible with no network and no key.
 *
 * SCOPE, STATED HONESTLY.
 *
 *   - This is PRACTICAL romanisation, the same register as the Hinglish engine:
 *     "idu ondu pustaka", not ISO-15919 "idu ondu pustaka" with diacritics.
 *     Readability for a caption viewer beats scholarly precision.
 *   - It is therefore LOSSY in two documented places (see the tables):
 *     retroflex and dental consonants both romanise to t/d/n, and the long/short
 *     e and o pairs both romanise to e/o. Kannada readers reconstruct these from
 *     context; a caption reader gets a word they can pronounce. ISO diacritics
 *     would be more faithful and much harder to read.
 *   - Like every rule-based engine here, it CANNOT recover English spelling from
 *     English written in Kannada script ("ಮೀಟಿಂಗ್" → "meeting" needs a glossary
 *     entry, not phonetics).
 *   - It has not been reviewed by a native speaker. It is a fallback that keeps
 *     a render alive and readable, not a replacement for the model backend.
 */

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/**
 * Consonants, WITHOUT the inherent vowel — that is added by the parser, because
 * whether it survives depends on what follows.
 *
 * Retroflex (ಟ ಠ ಡ ಢ ಣ) and dental (ತ ಥ ದ ಧ ನ) collapse to the same Roman
 * letters. Deliberate: "ta" and "ṭa" are one sound to a reader who does not
 * already know Kannada, and diacritics in burned-in captions are noise.
 */
const CONSONANTS: Record<string, string> = {
  'ಕ': 'k', 'ಖ': 'kh', 'ಗ': 'g', 'ಘ': 'gh', 'ಙ': 'ng',
  'ಚ': 'ch', 'ಛ': 'chh', 'ಜ': 'j', 'ಝ': 'jh', 'ಞ': 'ny',
  'ಟ': 't', 'ಠ': 'th', 'ಡ': 'd', 'ಢ': 'dh', 'ಣ': 'n',
  'ತ': 't', 'ಥ': 'th', 'ದ': 'd', 'ಧ': 'dh', 'ನ': 'n',
  'ಪ': 'p', 'ಫ': 'ph', 'ಬ': 'b', 'ಭ': 'bh', 'ಮ': 'm',
  'ಯ': 'y', 'ರ': 'r', 'ಱ': 'r', 'ಲ': 'l', 'ಳ': 'l', 'ೞ': 'zh',
  'ವ': 'v', 'ಶ': 'sh', 'ಷ': 'sh', 'ಸ': 's', 'ಹ': 'h',
};

/** Independent vowels — the form used at the start of a word. */
const VOWELS: Record<string, string> = {
  'ಅ': 'a', 'ಆ': 'aa', 'ಇ': 'i', 'ಈ': 'ee', 'ಉ': 'u', 'ಊ': 'oo',
  'ಋ': 'ru', 'ೠ': 'ru', 'ಌ': 'lu', 'ೡ': 'lu',
  'ಎ': 'e', 'ಏ': 'e', 'ಐ': 'ai',
  'ಒ': 'o', 'ಓ': 'o', 'ಔ': 'au',
};

/**
 * Vowel signs (matras) — the same vowels attached to a consonant.
 *
 * Long/short e and o both give "e"/"o". ಈ gives "ee" and ಏ also gives "e",
 * which is the one place the practical scheme is least faithful; writing ಈ as
 * "ii" would be more precise and less readable.
 */
const MATRAS: Record<string, string> = {
  'ಾ': 'aa', 'ಿ': 'i', 'ೀ': 'ee', 'ು': 'u', 'ೂ': 'oo',
  'ೃ': 'ru', 'ೄ': 'ru',
  'ೆ': 'e', 'ೇ': 'e', 'ೈ': 'ai',
  'ೊ': 'o', 'ೋ': 'o', 'ೌ': 'au',
};

const DIGITS: Record<string, string> = {
  '೦': '0', '೧': '1', '೨': '2', '೩': '3', '೪': '4',
  '೫': '5', '೬': '6', '೭': '7', '೮': '8', '೯': '9',
};

const VIRAMA = '್';      // U+0CCD — suppresses the inherent vowel
const ANUSVARA = 'ಂ';    // U+0C82 — nasal, place assimilated to what follows
const VISARGA = 'ಃ';     // U+0C83
const NUKTA = '಼';        // U+0CBC
const AVAGRAHA = 'ಽ';    // U+0CBD
const LENGTH_MARK = 'ೕ'; // U+0CD5 — legacy long-vowel composition
const AI_LENGTH = 'ೖ';   // U+0CD6
const ZWJ = '‍';
const ZWNJ = '‌';

/** Kannada block, including the historic characters. */
const KANNADA_RE = /[ಀ-೿]/;

export function hasKannada(s: string): boolean {
  return KANNADA_RE.test(s);
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * Anusvara takes the place of articulation of the consonant after it: labial
 * before p/b/m, otherwise dental/alveolar. "ಒಂದು" is ondu, "ಸಂಭ್ರಮ" is sambhrama.
 * Getting this wrong is the most audible error a Kannada romaniser can make,
 * which is why it is a rule rather than a fixed letter.
 */
function nasalFor(next: string | undefined): string {
  if (!next) return 'n';
  const roman = CONSONANTS[next];
  if (!roman) return 'n';
  return /^[pbm]/.test(roman) ? 'm' : 'n';
}

/** Skip joiners, which carry no phonetic value. */
function skipJoiners(chars: string[], i: number): number {
  let k = i;
  while (k < chars.length && (chars[k] === ZWJ || chars[k] === ZWNJ || chars[k] === NUKTA)) k++;
  return k;
}

/** Anusvara / visarga that may trail a syllable. */
function consumeCoda(chars: string[], i: number): { text: string; next: number } {
  let k = skipJoiners(chars, i);
  let text = '';
  for (;;) {
    const ch = chars[k];
    if (ch === ANUSVARA) {
      text += nasalFor(chars[skipJoiners(chars, k + 1)]);
      k = skipJoiners(chars, k + 1);
      continue;
    }
    if (ch === VISARGA) {
      text += 'h';
      k = skipJoiners(chars, k + 1);
      continue;
    }
    break;
  }
  return { text, next: k };
}

/** Read the vowel attached to a consonant: a sign, a virama, or the inherent 'a'. */
function readVowel(chars: string[], i: number): { vowel: string; next: number } {
  let k = skipJoiners(chars, i);
  const ch = chars[k];

  if (ch !== undefined && MATRAS[ch] !== undefined) {
    let vowel = MATRAS[ch]!;
    k = skipJoiners(chars, k + 1);
    // Legacy composition: ೆ + ೕ is how ೇ used to be encoded, and ೆ + ೖ how ೈ was.
    while (chars[k] === LENGTH_MARK || chars[k] === AI_LENGTH) {
      if (chars[k] === AI_LENGTH) vowel = 'ai';
      k = skipJoiners(chars, k + 1);
    }
    return { vowel, next: k };
  }
  if (ch === VIRAMA) {
    return { vowel: '', next: skipJoiners(chars, k + 1) };
  }
  // Nothing attached — the consonant keeps its inherent vowel. Kannada does not
  // delete it, not even word-finally, which is why there is no schwa logic here.
  return { vowel: 'a', next: k };
}

/**
 * Romanise a single token.
 *
 * Anything that is not Kannada — Latin, digits, punctuation, emoji — passes
 * through byte-identical. That is what keeps code-switched captions ("ಇದು ಒಂದು
 * important meeting") intact, and it is why numbers and symbols need no special
 * case: they simply are not in the tables.
 */
export function transliterateKannadaToken(token: string): string {
  if (!hasKannada(token)) return token;

  const chars = [...token];
  let out = '';
  let i = 0;

  while (i < chars.length) {
    const ch = chars[i]!;

    if (CONSONANTS[ch] !== undefined) {
      out += CONSONANTS[ch]!;
      i = skipJoiners(chars, i + 1);

      // Consonant cluster: each virama binds this consonant to the next, and
      // only the LAST consonant in the run takes a vowel. "ಸ್ತ" is "sta".
      let dangling = false;
      while (chars[i] === VIRAMA) {
        const after = skipJoiners(chars, i + 1);
        const nextCons = chars[after];
        if (nextCons !== undefined && CONSONANTS[nextCons] !== undefined) {
          out += CONSONANTS[nextCons]!;
          i = skipJoiners(chars, after + 1);
        } else {
          // A virama with nothing after it (a written halanta) just kills the
          // inherent vowel: "ಗ್" is "g".
          i = after;
          dangling = true;
          break;
        }
      }

      if (!dangling) {
        const { vowel, next } = readVowel(chars, i);
        out += vowel;
        i = next;
      }

      const coda = consumeCoda(chars, i);
      out += coda.text;
      i = coda.next;
      continue;
    }

    if (VOWELS[ch] !== undefined) {
      out += VOWELS[ch]!;
      i = skipJoiners(chars, i + 1);
      const coda = consumeCoda(chars, i);
      out += coda.text;
      i = coda.next;
      continue;
    }

    if (DIGITS[ch] !== undefined) {
      out += DIGITS[ch]!;
      i++;
      continue;
    }

    if (ch === ANUSVARA || ch === VISARGA) {
      const coda = consumeCoda(chars, i);
      out += coda.text;
      i = coda.next;
      continue;
    }

    if (ch === AVAGRAHA) { i++; continue; }
    if (ch === ZWJ || ch === ZWNJ || ch === NUKTA || ch === VIRAMA) { i++; continue; }

    // Latin, punctuation, whitespace, digits, symbols — untouched.
    out += ch;
    i++;
  }

  return polish(out);
}

/**
 * Tidy the output without changing what it says.
 *
 * Only collapses letter runs that the tables can produce but no Kannada word
 * contains — three or more of the same letter, which comes from a geminate
 * abutting a long vowel. Never touches word boundaries or ordering.
 */
function polish(s: string): string {
  return s.replace(/([a-z])\1{2,}/gi, '$1$1');
}

/** Romanise a whole string, preserving every space and line break exactly. */
export function transliterateKannadaText(text: string): string {
  return text.replace(/\S+/g, (tok) => transliterateKannadaToken(tok));
}
