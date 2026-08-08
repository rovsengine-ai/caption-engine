/**
 * Devanagari → Roman Hinglish.
 *
 * GOAL: what a Hindi speaker would actually type in a WhatsApp message —
 * "Aaj meeting bahut important hai" — not a scholarly transliteration
 * ("Āja mīṭiṅga bahuta impōrṭēṇṭa hai") and not a translation.
 *
 * The single thing that separates readable Hinglish from stiff ISO output is
 * SCHWA DELETION. Every Devanagari consonant carries an inherent 'a'. Sanskrit
 * pronounces it; modern Hindi drops it in predictable places. Without deletion
 * आज becomes "aaja" and बहुत becomes "bahuta" — instantly wrong to any reader.
 * The rules implemented here are the standard ones (Ohala 1983):
 *
 *   1. Word-final schwa is always deleted:            आज → aaj   (not aaja)
 *   2. Medial schwa is deleted in a V C _ C V context, applied right-to-left:
 *                                                     समझना → samajhna
 *   3. A word-initial syllable's schwa is protected:   बहुत → bahut (not bhut)
 *   4. A schwa between two consonants that would leave an unpronounceable
 *      cluster is kept.
 *
 * KNOWN LIMITATION, stated plainly: English loanwords written in Devanagari
 * transliterate phonetically, not back to their English spelling — वीडियो would
 * become "veediyo", not "video". There is no rule that recovers English
 * orthography from Hindi phonology; it needs a lexicon. LOANWORDS below covers
 * the common ones, and it is necessarily incomplete. For text with heavy
 * loanword use, the Sarvam backend (a trained model) does better — see
 * src/transliterate/providers.ts.
 */

// ---------------------------------------------------------------------------
// Character tables
// ---------------------------------------------------------------------------

/** Consonants, WITHOUT the inherent vowel. */
const CONSONANTS: Record<string, string> = {
  क: 'k', ख: 'kh', ग: 'g', घ: 'gh', ङ: 'ng',
  च: 'ch', छ: 'chh', ज: 'j', झ: 'jh', ञ: 'n',
  ट: 't', ठ: 'th', ड: 'd', ढ: 'dh', ण: 'n',
  त: 't', थ: 'th', द: 'd', ध: 'dh', न: 'n',
  प: 'p', फ: 'ph', ब: 'b', भ: 'bh', म: 'm',
  य: 'y', र: 'r', ल: 'l', व: 'v',
  श: 'sh', ष: 'sh', स: 's', ह: 'h',
  ळ: 'l', ऱ: 'r',
  // NOTE: these keys are DECOMPOSED (base + U+093C), i.e. two code points each,
  // so the single-code-point loop in parseUnits() never matches them. They are
  // kept only as documentation of the intended readings; the live paths are the
  // NUKTA table above (decomposed input) and decomposeNukta() (precomposed
  // input). Mistaking these for precomposed forms is what let U+095B ZA reach
  // the output untransliterated.
  क़: 'q', ख़: 'kh', ग़: 'g', ज़: 'z', ड़: 'r', ढ़: 'rh', फ़: 'f', य़: 'y',
};

/** Nukta (़) applied to a base consonant. */
const NUKTA: Record<string, string> = {
  क: 'q', ख: 'kh', ग: 'g', ज: 'z', ड: 'r', ढ: 'rh', फ: 'f', य: 'y',
};

/**
 * Precomposed nukta letters → base consonant + nukta sign.
 *
 * Devanagari writes ZA two ways: U+095B as one code point, or U+091C JA plus
 * U+093C NUKTA as two. They look identical and mean the same thing, and ASR
 * providers emit both — ElevenLabs returned the precomposed form for "आवाज़"
 * in the middle of a transcript that used the decomposed form elsewhere.
 *
 * The parser walks one code point at a time, so without this the precomposed
 * letters match nothing and survive into the output as raw Devanagari inside an
 * otherwise Roman caption ("aavaaज़"). Decomposing first means there is exactly
 * one representation to handle.
 *
 * These are the canonical NFD decompositions; a test asserts this table agrees
 * with Unicode's own, so it cannot silently drift or miss a code point.
 */
const NUKTA_COMPOSED: Record<string, string> = {
  '\u0929': '\u0928\u093C', // NNNA   = NA + NUKTA
  '\u0931': '\u0930\u093C', // RRA    = RA + NUKTA
  '\u0934': '\u0933\u093C', // LLLA   = LLA + NUKTA
  '\u0958': '\u0915\u093C', // QA     = KA + NUKTA
  '\u0959': '\u0916\u093C', // KHHA   = KHA + NUKTA
  '\u095A': '\u0917\u093C', // GHHA   = GA + NUKTA
  '\u095B': '\u091C\u093C', // ZA     = JA + NUKTA
  '\u095C': '\u0921\u093C', // DDDHA  = DDA + NUKTA
  '\u095D': '\u0922\u093C', // RHA    = DDHA + NUKTA
  '\u095E': '\u092B\u093C', // FA     = PHA + NUKTA
  '\u095F': '\u092F\u093C', // YYA    = YA + NUKTA
};

/** No /g flag: a global regex carries lastIndex between .test() calls. */
const NUKTA_COMPOSED_RE = /[\u0929\u0931\u0934\u0958-\u095F]/;

/**
 * Rewrite precomposed nukta letters to base + nukta.
 *
 * Deliberately narrower than calling `.normalize('NFD')` on the whole string:
 * NFD would also pull apart Latin accented characters in code-switched text,
 * changing bytes we promised to leave untouched.
 */
export function decomposeNukta(s: string): string {
  if (!NUKTA_COMPOSED_RE.test(s)) return s;
  let out = '';
  for (const c of s) out += NUKTA_COMPOSED[c] ?? c;
  return out;
}

/** Independent vowels. */
const VOWELS: Record<string, string> = {
  अ: 'a', आ: 'aa', इ: 'i', ई: 'ee', उ: 'u', ऊ: 'oo',
  ऋ: 'ri', ॠ: 'ri', ऌ: 'li',
  ए: 'e', ऐ: 'ai', ओ: 'o', औ: 'au',
  ऑ: 'o', ऒ: 'o', ऍ: 'e', ऎ: 'e',
};

/** Dependent vowel signs (matras). */
const MATRAS: Record<string, string> = {
  'ा': 'aa', // ा
  'ि': 'i',  // ि
  'ी': 'ee', // ी
  'ु': 'u',  // ु
  'ू': 'oo', // ू
  'ृ': 'ri', // ृ
  'ॄ': 'ri', // ॄ
  'े': 'e',  // े
  'ै': 'ai', // ै
  'ो': 'o',  // ो
  'ौ': 'au', // ौ
  'ॉ': 'o',  // ॉ
  'ॅ': 'e',  // ॅ
  'ॆ': 'e',  // ॆ
  'ॊ': 'o',  // ॊ
};

const VIRAMA = '्';   // ्
const NUKTA_SIGN = '़'; // ़
const ANUSVARA = 'ं';  // ं
const CHANDRABINDU = 'ँ'; // ँ
const VISARGA = 'ः';   // ः
const AVAGRAHA = 'ऽ';  // ऽ
const ZWJ = '‍';
const ZWNJ = '‌';

/** Devanagari digits → ASCII. */
const DIGITS: Record<string, string> = {
  '०': '0', '१': '1', '२': '2', '३': '3', '४': '4',
  '५': '5', '६': '6', '७': '7', '८': '8', '९': '9',
};

/** Punctuation that has an obvious Latin equivalent. */
const PUNCT: Record<string, string> = {
  '।': '.', '॥': '.',
};

/**
 * Words whose conventional Hinglish spelling is NOT what the rules produce.
 *
 * Two kinds:
 *   - Grammatical words everyone spells a particular way (है → hai, not hei).
 *   - English loanwords written in Devanagari, where phonetic transliteration
 *     would not recover the English spelling (वीडियो → video, not veediyo).
 *
 * Deliberately small and high-frequency. This is not a dictionary and does not
 * pretend to be — see the module header.
 */
const LOANWORDS: Record<string, string> = {
  // High-frequency grammatical words
  है: 'hai', हैं: 'hain', हूँ: 'hoon', हूं: 'hoon', हो: 'ho', था: 'tha',
  थी: 'thi', थे: 'the', और: 'aur', नहीं: 'nahi', नही: 'nahi',
  मैं: 'main', मुझे: 'mujhe', मेरा: 'mera', मेरी: 'meri',
  तुम: 'tum', आप: 'aap', आपको: 'aapko', हम: 'hum', हमें: 'humein',
  यह: 'yeh', ये: 'ye', वह: 'woh', वो: 'wo', क्या: 'kya', क्यों: 'kyun',
  कैसे: 'kaise', कहाँ: 'kahan', कहां: 'kahan', जब: 'jab', तब: 'tab',
  लेकिन: 'lekin', क्योंकि: 'kyunki', अगर: 'agar', तो: 'toh',
  भी: 'bhi', ही: 'hi', का: 'ka', के: 'ke', की: 'ki', को: 'ko',
  में: 'mein', से: 'se', पर: 'par', बहुत: 'bahut', बड़ा: 'bada',
  अच्छा: 'accha', ठीक: 'theek', मतलब: 'matlab', यानी: 'yaani',
  लिए: 'liye', साथ: 'saath', बात: 'baat', काम: 'kaam', लोग: 'log',
  दिन: 'din', समय: 'samay', घर: 'ghar', नाम: 'naam', आज: 'aaj',
  कल: 'kal', अभी: 'abhi', फिर: 'phir', सब: 'sab', कुछ: 'kuch',
  करना: 'karna', करते: 'karte', किया: 'kiya', होता: 'hota', होती: 'hoti',
  चाहिए: 'chahiye', सकते: 'sakte', रहा: 'raha', रही: 'rahi', गया: 'gaya',

  // English loanwords commonly written in Devanagari
  वीडियो: 'video', मीटिंग: 'meeting', इंपोर्टेंट: 'important',
  इम्पोर्टेंट: 'important', ऑफिस: 'office', फोन: 'phone', मोबाइल: 'mobile',
  कंप्यूटर: 'computer', इंटरनेट: 'internet', ईमेल: 'email',
  प्रोजेक्ट: 'project', टीम: 'team', क्लाइंट: 'client', मार्केट: 'market',
  बिजनेस: 'business', कंपनी: 'company', चैनल: 'channel',
  सब्सक्राइब: 'subscribe', लाइक: 'like', कमेंट: 'comment', शेयर: 'share',
  स्टार्ट: 'start', प्रोडक्ट: 'product', सर्विस: 'service',
};

// ---------------------------------------------------------------------------
// Syllable model
// ---------------------------------------------------------------------------

interface Unit {
  /** Roman consonant cluster for this unit, '' for a bare vowel. */
  cons: string;
  /** Roman vowel, or null when the inherent schwa was suppressed by virama. */
  vowel: string | null;
  /** True when `vowel` is the INHERENT schwa (a candidate for deletion). */
  inherent: boolean;
  /** Nasal / visarga trailing this unit. */
  coda: string;
}

/** Parse a Devanagari word into consonant+vowel units. */
function parseUnits(word: string): Unit[] {
  const chars = [...word];
  const units: Unit[] = [];
  let i = 0;

  while (i < chars.length) {
    const ch = chars[i]!;

    if (ch === ZWJ || ch === ZWNJ || ch === AVAGRAHA) { i++; continue; }

    // Independent vowel
    if (VOWELS[ch]) {
      units.push({ cons: '', vowel: VOWELS[ch]!, inherent: false, coda: '' });
      i++;
      i = consumeCoda(chars, i, units);
      continue;
    }

    // Consonant (possibly + nukta), then a run of virama+consonant for conjuncts
    if (CONSONANTS[ch]) {
      let cons = CONSONANTS[ch]!;
      i++;
      if (chars[i] === NUKTA_SIGN) {
        cons = NUKTA[ch] ?? cons;
        i++;
      }

      // Conjunct: virama binds this consonant to the next.
      while (chars[i] === VIRAMA && i + 1 < chars.length && CONSONANTS[chars[i + 1]!]) {
        i++; // virama
        let next = CONSONANTS[chars[i]!]!;
        const base = chars[i]!;
        i++;
        if (chars[i] === NUKTA_SIGN) {
          next = NUKTA[base] ?? next;
          i++;
        }
        cons += next;
      }

      // A trailing virama with nothing after it also suppresses the schwa.
      if (chars[i] === VIRAMA) {
        i++;
        units.push({ cons, vowel: null, inherent: false, coda: '' });
        i = consumeCoda(chars, i, units);
        continue;
      }

      const matra = chars[i] !== undefined ? MATRAS[chars[i]!] : undefined;
      if (matra) {
        i++;
        units.push({ cons, vowel: matra, inherent: false, coda: '' });
      } else {
        units.push({ cons, vowel: 'a', inherent: true, coda: '' });
      }
      i = consumeCoda(chars, i, units);
      continue;
    }

    // Anything else (stray sign, punctuation inside the word) passes through.
    units.push({ cons: PUNCT[ch] ?? DIGITS[ch] ?? ch, vowel: null, inherent: false, coda: '' });
    i++;
  }

  return units;
}

/** Attach anusvara / chandrabindu / visarga to the unit just produced. */
function consumeCoda(chars: string[], i: number, units: Unit[]): number {
  const last = units[units.length - 1];
  while (i < chars.length) {
    const ch = chars[i]!;
    if (ch === ANUSVARA || ch === CHANDRABINDU) {
      if (last) {
        // Anusvara assimilates to the following consonant's place of
        // articulation. Before a labial it is 'm' (कंपनी → kampani); elsewhere
        // 'n' reads more naturally in Hinglish.
        const nextCons = nextConsonantRoman(chars, i + 1);
        last.coda += nextCons && /^[pbm]/.test(nextCons) ? 'm' : 'n';
      }
      i++;
      continue;
    }
    if (ch === VISARGA) {
      if (last) last.coda += 'h';
      i++;
      continue;
    }
    break;
  }
  return i;
}

function nextConsonantRoman(chars: string[], i: number): string | null {
  while (i < chars.length) {
    const ch = chars[i]!;
    if (CONSONANTS[ch]) return CONSONANTS[ch]!;
    if (VOWELS[ch] || (MATRAS[ch] !== undefined)) return null;
    i++;
  }
  return null;
}

/**
 * Apply Hindi schwa deletion.
 *
 * Right-to-left, because deleting a schwa changes the context for the schwa to
 * its left — the rule is defined on the surface form after later deletions.
 */
function deleteSchwas(units: Unit[]): void {
  // Rule 1: word-final inherent schwa always goes.
  for (let i = units.length - 1; i >= 0; i--) {
    const u = units[i]!;
    if (u.cons === '' && u.vowel === null) continue; // skip punctuation units
    if (u.inherent && u.coda === '') {
      u.vowel = null;
      u.inherent = false;
    }
    break;
  }

  // Rule 2: medial schwa in V C _ C V, right-to-left.
  // Never touch the first unit — dropping its schwa mangles the word onset
  // (बहुत would become "bhut").
  for (let i = units.length - 2; i >= 1; i--) {
    const u = units[i]!;
    if (!u.inherent || u.coda !== '') continue;

    const prev = units[i - 1]!;
    const next = units[i + 1]!;

    // Need a vowel before and a vowel after for the VC_CV context to hold.
    const hasVowelBefore = prev.vowel !== null;
    const hasVowelAfter = next.vowel !== null;
    if (!hasVowelBefore || !hasVowelAfter) continue;

    // Deleting would create a 3+ consonant pile-up; keep it pronounceable.
    const cluster = u.cons + next.cons;
    if (cluster.replace(/h/g, '').length > 2) continue;

    u.vowel = null;
    u.inherent = false;
  }
}

function unitsToRoman(units: Unit[]): string {
  let out = '';
  for (const u of units) {
    out += u.cons;
    if (u.vowel) out += u.vowel;
    out += u.coda;
  }
  return out;
}

/**
 * Tidy up sequences the rules produce but nobody actually types.
 *
 * Word-final long vowels are the main one. Hindi orthography keeps them, casual
 * Hinglish shortens them:
 *
 *   दुनिया  duniyaa  → duniya
 *   विद्या  vidyaa   → vidya
 *   हिन्दी  hindee   → hindi
 *
 * Crucially this is FINAL position only. Medially the long vowel is what makes
 * the word readable and is written out: बात → "baat" (not "bat"), ख़ास →
 * "khaas", ठीक → "theek". Applying the shortening everywhere would wreck those.
 */
function polish(s: string): string {
  let out = s
    .replace(/aaa+/g, 'aa')
    .replace(/([aeiou])\1{2,}/g, '$1$1')
    .replace(/nn+/g, 'n')
    .replace(/mm+/g, 'm');

  // Future-tense endings -ऊंगा / -ऊंगी. Phonetically "oonga", but universally
  // typed "unga": करूंगा → karunga, जाऊंगा → jaunga.
  out = out.replace(/oonga/g, 'unga').replace(/oongee/g, 'ungi').replace(/oongi/g, 'ungi');

  const endedAa = /aa$/.test(out);
  const endedEe = /ee$/.test(out);
  out = out.replace(/aa$/, 'a').replace(/ee$/, 'i');

  // A word that ENDS in an open vowel also shortens its medial long 'aa':
  //   दिखाता  dikhaata → dikhata
  //   कहानी   kahaani  → kahani
  //
  // Guards, each protecting a real case:
  //   - word-INITIAL 'aa' is untouched: आजा stays "aaja", never "aja"
  //   - words ending in a CONSONANT keep medial length: बात "baat", ख़ास "khaas"
  //   - for 'ee' endings the word must have 3+ syllables, so short words keep
  //     their length (बारी stays "baari", not "bari")
  const syllables = (out.match(/[aeiou]+/g) ?? []).length;
  if (endedAa || (endedEe && syllables >= 3)) {
    out = out.replace(/(.)aa/g, (_m, prev: string) => `${prev}a`);
  }
  return out;
}

/** True if the string contains any Devanagari. */
export function hasDevanagari(s: string): boolean {
  return /[ऀ-ॿ꣠-ꣿ]/.test(s);
}

/**
 * The lexicon keyed by its nukta-decomposed form.
 *
 * Source literals for words like बड़ा may be stored either way depending on the
 * editor that last touched this file, and the lookup key is always decomposed.
 * Normalising both sides removes that coincidence from the correctness story.
 */
const LOANWORDS_NORMALISED: Record<string, string> = Object.fromEntries(
  Object.entries(LOANWORDS).map(([k, v]) => [decomposeNukta(k), v]),
);

/**
 * Transliterate ONE token.
 *
 * A token already in Latin script is returned untouched — that is what keeps
 * "meeting" and "important" intact in code-switched text.
 */
export function transliterateToken(token: string): string {
  if (!hasDevanagari(token)) return token;

  // A "token" from the ASR can hold more than one word: audio-event labels such
  // as "[गाड़ियों के हॉर्न की आवाज़]" arrive whole. Treating that as a single
  // word would apply the word-final schwa rule only to the very last syllable,
  // giving "horna kee" instead of "horn ki". Split on whitespace and let each
  // real word get the word-level rules; spacing is preserved exactly.
  if (/\s/.test(token.trim())) {
    return token.split(/(\s+)/)
      .map((p) => (/^\s*$/.test(p) ? p : transliterateToken(p)))
      .join('');
  }

  // Precomposed nukta letters (U+0958–U+095F) are folded to base + nukta first,
  // so the parser below only ever has to handle one representation. Without
  // this they match nothing and survive as Devanagari in Roman output.
  token = decomposeNukta(token);

  // Split leading/trailing punctuation so the lexicon can match the bare word
  // and the punctuation survives in place.
  //
  // \p{M} is essential and easy to miss: Devanagari matras, virama, anusvara and
  // nukta are Unicode category MARK, not LETTER. Without it, "है" splits into
  // core "ह" + trailing "ै", the lexicon misses, and the matra passes through
  // unconverted as "hै".
  const m = token.match(/^([^\p{L}\p{N}\p{M}]*)(.*?)([^\p{L}\p{N}\p{M}]*)$/u);
  const lead = m?.[1] ?? '';
  const core = m?.[2] ?? token;
  const trail = m?.[3] ?? '';

  const mappedLead = [...lead].map((c) => PUNCT[c] ?? c).join('');
  const mappedTrail = [...trail].map((c) => PUNCT[c] ?? c).join('');

  if (!core) return mappedLead + mappedTrail;

  const lex = LOANWORDS_NORMALISED[core];
  if (lex) return mappedLead + lex + mappedTrail;

  // Pure digits
  if ([...core].every((c) => DIGITS[c] !== undefined)) {
    return mappedLead + [...core].map((c) => DIGITS[c]!).join('') + mappedTrail;
  }

  const units = parseUnits(core);
  deleteSchwas(units);
  return mappedLead + polish(unitsToRoman(units)) + mappedTrail;
}

/**
 * Transliterate a whole string, preserving spacing and word order.
 * Used for previews and tests; the pipeline works per-word to keep timestamps.
 */
export function transliterateText(text: string): string {
  return text.split(/(\s+)/).map((p) => (/\s/.test(p) ? p : transliterateToken(p))).join('');
}
