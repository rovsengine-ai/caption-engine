/**
 * Filler-word lexicons, per language.
 *
 * ⚠️ ACTION REQUIRED BEFORE LAUNCH: these lists are a STARTING POINT assembled
 * from general knowledge, not from native-speaker review. Filler words are
 * dialect- and region-specific, and a wrong list is visible to users in the most
 * embarrassing way — either it misses obvious fillers, or it cuts real words.
 *
 * Budget one day per language with 2-3 native speakers: play them real creator
 * audio, have them mark what they'd cut. That's a day of work that makes the
 * difference between "this tool understands Telugu" and "this tool is English
 * software with Telugu bolted on."
 *
 * Notable traps already handled:
 *  - Hindi "matlab" (मतलब) and Telugu "ante" (అంటే) are BOTH fillers AND real
 *    words meaning "meaning/that is". Cutting every instance destroys sentences.
 *    See `ambiguous` — these are only cut with additional evidence (see index.ts).
 *
 * ---------------------------------------------------------------------------
 * THE RULE FOR `always`
 * ---------------------------------------------------------------------------
 * A token belongs in `always` only if it is **not a word in the language**.
 * "um", "hmm", "erm" qualify: they are noises. A token that is a real word in
 * ANY of the lexicons loaded for a language does not qualify, no matter how
 * often it is also used as a hesitation.
 *
 * This rule exists because it was broken. An audit found these in `always`,
 * being cut with no evidence whatsoever:
 *
 *   हूँ   (hi)  "am"          — मैं ठीक हूँ  →  मैं ठीक
 *   आ/આ/ఆ/ಆ/ആ  "this"/"that" — આ ઘર બહુ સરસ છે  →  ઘર બહુ સરસ છે
 *   haan  (hi)  "yes"
 *   এ     (bn)  "this"
 *   ਆ     (pa)  "come"
 *
 * The English list was correct — "a" was never in it — which is exactly why the
 * bug survived: the language everyone tests in was fine. Every entry below now
 * carries a note when it is ambiguous, so the next person to edit this file has
 * to think about it.
 */

export interface FillerLexicon {
  /**
   * Pure hesitation noises. Cut on sight — these are not words.
   * Adding a real word here is a bug: see the rule above.
   */
  always: string[];
  /** Real words that are ALSO used as fillers. Require extra evidence to cut. */
  ambiguous: string[];
  /**
   * Structurally required words that must NEVER be removed automatically,
   * whatever the evidence says.
   *
   * `ambiguous` says "needs corroboration"; `never` says "not negotiable".
   * The distinction exists because corroboration can be manufactured by
   * accident: an English article "a" before a dramatic pause has a long gap
   * after it, low ASR confidence (it is 40 ms of schwa), and short duration —
   * three signals agreeing on a cut that destroys the sentence.
   *
   * Entries here are still reported as candidates and can still be cut by an
   * explicit human decision in the review file. Only the automatic path is
   * closed.
   */
  never?: string[];
}

const EN: FillerLexicon = {
  always: ['um', 'umm', 'uh', 'uhh', 'er', 'erm', 'ah', 'ahh', 'hmm', 'mmm', 'uhm'],
  ambiguous: ['like', 'so', 'basically', 'actually', 'literally', 'right', 'okay', 'you know', 'i mean'],
  // "a" is the case this tier was built for. It is one phoneme, frequently
  // low-confidence, and routinely precedes a pause ("that was a... disaster").
  // Removing it turns "a meeting" into "meeting" in every caption on screen.
  never: [
    'a', 'an', 'the', 'i', 'is', 'am', 'are', 'was', 'be', 'to', 'of',
    'in', 'it', 'on', 'at', 'we', 'he', 'my', 'no', 'not', 'and', 'or',
  ],
};

const HI: FillerLexicon = {
  always: ['हम्म', 'अं', 'उम', 'एर'],
  ambiguous: [
    'अ', // bare vowel letter; ASR emits it for hesitation but it can be a fragment
    'आ', // "come" (imperative), also a hesitation drawl
    'मतलब', 'यानी', 'वो', 'तो', 'बस', 'अच्छा', 'ठीक है', 'क्या बोलते हैं',
  ],
  // Copulas, postpositions and negation. Removing any of these does not
  // shorten a sentence, it breaks it. हूँ was previously only `ambiguous`,
  // which meant a pause on either side was enough to delete "am".
  never: [
    'हूँ', 'हूं', 'है', 'हैं', 'था', 'थी', 'थे', 'हो',
    'में', 'को', 'का', 'की', 'के', 'से', 'पर',
    'और', 'नहीं', 'ना', 'मैं', 'ये', 'यह',
  ],
};

/** Romanised Hindi — what Hinglish transcripts actually look like. */
const HI_ROMAN: FillerLexicon = {
  always: ['hmm', 'umm', 'um', 'uh'],
  ambiguous: [
    'haan', 'haa', // "yes" — an answer, not a noise
    'arre', // interjection, but carries emphasis
    'aa', // "come", and the romanisation of आ
    'matlab', 'yaani', 'yaar', 'toh', 'bas', 'accha', 'theek hai', 'kya bolte hain', 'woh',
  ],
  never: [
    'hai', 'hain', 'hoon', 'hun', 'hu', 'tha', 'thi', 'the', 'ho',
    'mein', 'ko', 'ka', 'ki', 'ke', 'se', 'par',
    'aur', 'nahi', 'nahin', 'na', 'main', 'ye', 'yeh',
  ],
};

const TE: FillerLexicon = {
  always: ['హ్మ్', 'అమ్', 'ఉమ్'],
  ambiguous: [
    'ఆ', // "that" — ఆ పుస్తకం = that book. Extremely common demonstrative.
    'అంటే', 'ఏంటంటే', 'అది', 'కదా', 'మరి', 'సరే',
  ],
};

const TE_ROMAN: FillerLexicon = {
  always: ['hmm', 'umm', 'um'],
  ambiguous: ['aa', 'ante', 'antey', 'entante', 'adi', 'kada', 'mari', 'sare'],
  never: ['nenu', 'meeru', 'undi', 'ledu', 'kaadu', 'ki', 'lo', 'tho', 'na'],
};

const KN: FillerLexicon = {
  always: ['ಹ್ಮ್', 'ಅಂ', 'ಉಮ್'],
  ambiguous: [
    'ಆ', // "that" — demonstrative
    'ಅಂದರೆ', 'ಅದು', 'ಅಲ್ವಾ', 'ಸರಿ', 'ಮತ್ತೆ',
  ],
};

const KN_ROMAN: FillerLexicon = {
  always: ['hmm', 'umm', 'um'],
  ambiguous: ['aa', 'andre', 'adu', 'alva', 'sari', 'matte'],
  never: ['naanu', 'neevu', 'ide', 'illa', 'alla', 'ge', 'alli', 'inda', 'na'],
};

const TA: FillerLexicon = {
  always: ['ஹ்ம்', 'அம்', 'உம்'],
  ambiguous: [
    'ஆ', // interjection, but also a question/affirmation particle
    'அப்புறம்', 'அது', 'இல்ல', 'சரி', 'என்னன்னா', 'அப்படி',
  ],
};

const TA_ROMAN: FillerLexicon = {
  always: ['hmm', 'umm', 'um'],
  ambiguous: ['aa', 'appuram', 'adhu', 'illa', 'sari', 'ennanna', 'appadi'],
  never: ['naan', 'neenga', 'irukku', 'illai', 'ku', 'la', 'oda', 'na'],
};

const ML: FillerLexicon = {
  always: ['ഹ്മ്', 'അം', 'ഉം'],
  ambiguous: [
    'ആ', // "that" — demonstrative
    'അതായത്', 'അത്', 'എന്നുവച്ചാൽ', 'ശരി', 'പിന്നെ',
  ],
};

const ML_ROMAN: FillerLexicon = {
  always: ['hmm', 'umm', 'um'],
  ambiguous: ['aa', 'athayath', 'athu', 'ennuvachal', 'sari', 'pinne'],
};

const BN: FillerLexicon = {
  always: ['হুম', 'উম', 'আহ'],
  ambiguous: [
    'এ', // "this" / "he" — a pronoun, not a noise
    'মানে', 'যেটা', 'তো', 'আচ্ছা', 'ঠিক আছে',
  ],
};

const BN_ROMAN: FillerLexicon = {
  always: ['hmm', 'umm', 'um', 'ah'],
  ambiguous: ['mane', 'jeta', 'toh', 'accha', 'thik ache'],
};

const GU: FillerLexicon = {
  always: ['હમ્મ', 'ઉમ'],
  ambiguous: [
    'આ', // "this" — આ ઘર = this house. Among the most common words in Gujarati.
    'મતલબ', 'એટલે', 'પછી', 'સારું', 'તો',
  ],
};

const GU_ROMAN: FillerLexicon = {
  always: ['hmm', 'umm', 'um'],
  ambiguous: ['aa', 'matlab', 'etle', 'pachhi', 'saru', 'toh'],
};

const PA: FillerLexicon = {
  always: ['ਹਮ੍ਮ', 'ਉਮ'],
  ambiguous: [
    'ਆ', // "come" (imperative)
    'ਮਤਲਬ', 'ਯਾਨੀ', 'ਫਿਰ', 'ਚੰਗਾ', 'ਤਾਂ',
  ],
};

const PA_ROMAN: FillerLexicon = {
  always: ['hmm', 'umm', 'um'],
  ambiguous: ['aa', 'matlab', 'yaani', 'phir', 'changa', 'taan'],
};

const MR: FillerLexicon = {
  always: ['हम्म', 'अं', 'उम'],
  ambiguous: [
    'आ', // hesitation drawl, but also a real form
    'म्हणजे', 'तर', 'बरं', 'असं', 'काय',
  ],
};

const MR_ROMAN: FillerLexicon = {
  always: ['hmm', 'umm', 'um'],
  ambiguous: ['aa', 'mhanje', 'tar', 'bara', 'asa', 'kay'],
  never: ['mi', 'tu', 'aahe', 'nahi', 'la', 'cha', 'chi', 'che', 'ani', 'na'],
};

/**
 * Language → lexicon sets, most specific first.
 *
 * Indic entries deliberately include the romanised set AND English, because
 * code-switched speech mixes all three inside a single sentence: a Hindi
 * transcript legitimately contains "matlab", "matlab" romanised, and "um".
 * Matching only the native-script list would miss most real fillers.
 */
const LEXICONS: Record<string, FillerLexicon[]> = {
  en: [EN],
  hi: [HI, HI_ROMAN, EN],
  mr: [MR, MR_ROMAN, EN],
  ne: [HI, HI_ROMAN, EN], // Nepali shares much Devanagari filler vocabulary
  te: [TE, TE_ROMAN, EN],
  kn: [KN, KN_ROMAN, EN],
  ta: [TA, TA_ROMAN, EN],
  ml: [ML, ML_ROMAN, EN],
  bn: [BN, BN_ROMAN, EN],
  as: [BN, BN_ROMAN, EN], // Assamese uses the Bengali script
  gu: [GU, GU_ROMAN, EN],
  pa: [PA, PA_ROMAN, EN],
};

/** Normalise for comparison: lowercase, strip punctuation, collapse repeats. */
export function normaliseToken(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.,!?;:"'`।॥]/g, '') // includes Devanagari danda । ॥
    .trim();
}

export interface FillerMatch {
  isFiller: boolean;
  /** Ambiguous fillers need corroborating evidence before we cut them. */
  ambiguous: boolean;
  /**
   * The token is in the `never` tier. Always accompanied by `isFiller: false`,
   * so every existing caller is protected without changing its logic.
   */
  protectedWord?: boolean;
}

/**
 * Is this token in the `never` tier for this language?
 *
 * Checked independently of `matchFiller` by the two-pass analyser, which still
 * wants to *report* protected tokens as candidates so a human reviewer can see
 * them — it just refuses to cut them automatically.
 */
export function matchNeverCut(token: string, language = 'en'): boolean {
  const base = (language.split('-')[0] ?? 'en').toLowerCase();
  const sets = LEXICONS[base] ?? [EN];
  const t = normaliseToken(token);
  if (!t) return false;
  return sets.some((set) => set.never?.includes(t) ?? false);
}

/**
 * Is this token a filler in the given language context?
 * Falls back to English-only when the language is unknown — deliberately
 * conservative, since over-cutting is far worse than under-cutting.
 *
 * The `never` tier is checked FIRST and short-circuits to "not a filler". That
 * ordering is the whole point: a word can appear in both `never` and, via a
 * romanisation collision, some other language's `ambiguous` list. Protection
 * has to win, and it has to win here rather than at every call site, so that
 * callers written before this tier existed inherit the guard for free.
 */
export function matchFiller(token: string, language = 'en'): FillerMatch {
  const base = (language.split('-')[0] ?? 'en').toLowerCase();
  const sets = LEXICONS[base] ?? [EN];
  const t = normaliseToken(token);
  if (!t) return { isFiller: false, ambiguous: false };

  if (sets.some((set) => set.never?.includes(t) ?? false)) {
    return { isFiller: false, ambiguous: false, protectedWord: true };
  }
  for (const set of sets) {
    if (set.always.includes(t)) return { isFiller: true, ambiguous: false };
  }
  for (const set of sets) {
    if (set.ambiguous.includes(t)) return { isFiller: true, ambiguous: true };
  }
  return { isFiller: false, ambiguous: false };
}

export function supportedFillerLanguages(): string[] {
  return Object.keys(LEXICONS);
}
